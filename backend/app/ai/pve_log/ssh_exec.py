"""SSH 遠端執行服務

流程（兩條路徑）：
  內部路徑（主後端內嵌模組，傳入 session）：
      a. _resolve_vm_info_from_db → 直接查 DB 取 IP / SSH key
      b. paramiko SSH 連線並執行指令
  HTTP 回呼路徑（獨立 ai-pve-log 子服務，不傳 session）：
      a. POST /api/v1/login/access-token → 取得 SkyLab JWT
      b. GET  /api/v1/resources/{vmid}   → 取得 VM IP
      c. GET  /api/v1/resources/{vmid}/ssh-key → 取得 SSH private key
      d. paramiko SSH 連線並執行指令
  共用流程：
      1. 黑名單過濾（ssh_guard）
      2. 若 require_confirm=True → 產生 pending token，等待使用者確認
      3. 回傳 SSHExecResult

設計重點：
  - 內部路徑不依賴 AI_API_PUBLIC_BASE_URL，避免變數名稱衝突
  - pending token 存於內存 dict，TTL 5 分鐘（適合 dev 環境）
  - 使用 asyncio.to_thread 包裝同步 paramiko，不阻塞 event loop
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from typing import Any

import httpx
from sqlmodel import Session

from app.ai.pve_log.config import settings
from app.ai.pve_log.schemas import SSHConfirmRequest, SSHExecRequest, SSHExecResult
from app.ai.pve_log.ssh_guard import check_command
from app.core.i18n import t
from app.core.security import decrypt_value
from app.infrastructure.ssh import create_key_client
from app.repositories import resource as resource_repo
from app.services.proxmox import proxmox_service

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Pending token 暫存（內存，TTL 5 分鐘）
# ---------------------------------------------------------------------------

_PENDING_TTL = 300  # 秒
_MAX_OUTPUT_CHARS = 16 * 1024
_SENSITIVE_OUTPUT_PATTERNS = (
    re.compile(
        r"(?i)(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*([^\s,;]+)"
    ),
    re.compile(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----.+?-----END [A-Z ]*PRIVATE KEY-----",
        re.DOTALL,
    ),
)
_pending_store: dict[str, dict[str, Any]] = {}  # token → {request, created_at}


def _store_pending(
    req: SSHExecRequest,
    *,
    allowed_vmids: set[int] | None = None,
    requester_id: uuid.UUID | None = None,
    scope_type: str | None = None,
    scope_id: uuid.UUID | None = None,
) -> str:
    """儲存待確認請求，回傳 token。"""
    token = str(uuid.uuid4())
    _pending_store[token] = {
        "request": req,
        "created_at": time.monotonic(),
        "allowed_vmids": set(allowed_vmids) if allowed_vmids is not None else None,
        "requester_id": requester_id,
        "scope_type": scope_type,
        "scope_id": scope_id,
    }
    _cleanup_expired()
    return token


def _pop_pending(token: str) -> dict[str, Any] | None:
    """取出待確認請求（同時從 store 移除）。"""
    _cleanup_expired()
    return _pending_store.pop(token, None)


def _peek_pending(token: str) -> dict[str, Any] | None:
    _cleanup_expired()
    return _pending_store.get(token)


def peek_pending_scope(token: str) -> tuple[str | None, uuid.UUID | None]:
    """Read token scope without consuming it."""
    entry = _peek_pending(token)
    if entry is None:
        return None, None
    return entry.get("scope_type"), entry.get("scope_id")


def peek_pending_request(token: str) -> SSHExecRequest | None:
    """Read a pending request so the caller can re-authorize its VMID."""
    entry = _peek_pending(token)
    if entry is None:
        return None
    request = entry.get("request")
    return request if isinstance(request, SSHExecRequest) else None


def _cleanup_expired() -> None:
    now = time.monotonic()
    expired = [k for k, v in _pending_store.items() if now - v["created_at"] > _PENDING_TTL]
    for k in expired:
        _pending_store.pop(k, None)


# ---------------------------------------------------------------------------
# SkyLab API 呼叫
# ---------------------------------------------------------------------------


async def _get_campus_token(client: httpx.AsyncClient) -> str:
    """取得 SkyLab JWT access token。"""
    url = f"{settings.skylab_api_base}/login/access-token"
    resp = await client.post(
        url,
        data={
            "username": settings.skylab_api_user,
            "password": settings.skylab_api_password,
        },
    )
    if not resp.is_success:
        raise RuntimeError(
            t("pveLog.skylabLoginFailed", status=resp.status_code, detail=resp.text[:200])
        )
    data = resp.json()
    token = data.get("access_token")
    if not isinstance(token, str) or not token:
        raise RuntimeError(t("pveLog.skylabTokenMissing"))
    return token


async def _get_vm_ip(client: httpx.AsyncClient, token: str, vmid: int) -> str:
    """取得 VM/LXC 的 IP 位址。"""
    url = f"{settings.skylab_api_base}/resources/{vmid}"
    resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
    if not resp.is_success:
        raise RuntimeError(
            t(
                "pveLog.resourceFetchFailed",
                vmid=vmid,
                status=resp.status_code,
                detail=resp.text[:200],
            )
        )
    data = resp.json()
    # /resources/{vmid} 回傳 {summary, status, config, network_interfaces}
    # ip_address 在 summary 層
    summary = data.get("summary") or data
    ip = summary.get("ip_address") if isinstance(summary, dict) else None
    if not ip:
        # 嘗試從 network_interfaces 取第一個非 lo 的 inet
        for iface in data.get("network_interfaces") or []:
            inet = iface.get("inet", "")
            if inet and not inet.startswith("127."):
                ip = inet.split("/")[0]
                break
    if not ip:
        raise RuntimeError(t("pveLog.noIpAddress", vmid=vmid))
    return ip


async def _get_ssh_private_key(client: httpx.AsyncClient, token: str, vmid: int) -> str:
    """取得 VM/LXC 的 SSH private key（PEM 格式）。"""
    url = f"{settings.skylab_api_base}/resources/{vmid}/ssh-key"
    resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
    if not resp.is_success:
        detail = ""
        try:
            detail = resp.json().get("detail", "")
        except Exception:
            detail = resp.text[:200]
        if resp.status_code in {404, 502} and "not found" in detail.lower():
            raise RuntimeError(t("pveLog.sshKeyNotRegistered", vmid=vmid))
        raise RuntimeError(
            t(
                "pveLog.sshKeyFetchFailed",
                status=resp.status_code,
                detail=detail or resp.text[:200],
            )
        )
    data = resp.json()
    key = data.get("ssh_private_key") if isinstance(data, dict) else None
    if not isinstance(key, str) or not key.strip():
        raise RuntimeError(t("pveLog.sshKeyEmpty", vmid=vmid))
    return key


# ---------------------------------------------------------------------------
# SSH 執行（同步，供 asyncio.to_thread 包裝）
# ---------------------------------------------------------------------------


def _ssh_exec_sync(
    host: str,
    port: int,
    username: str,
    private_key_pem: str,
    command: str,
    timeout: int,
) -> tuple[int, str, str]:
    """建立 SSH 連線並執行指令，回傳 (exit_code, stdout, stderr)。

    使用 infrastructure 共用的 create_key_client：
    首次連線記錄 host key（trust-on-first-use），之後 key 變更會拒絕連線。
    """
    client = create_key_client(
        host,
        port,
        username,
        private_key_pem,
        timeout=timeout,
    )
    try:
        _, stdout, stderr = client.exec_command(command, timeout=timeout)
        exit_code = stdout.channel.recv_exit_status()
        out_text = stdout.read().decode(errors="replace")
        err_text = stderr.read().decode(errors="replace")
        return exit_code, out_text, err_text
    finally:
        client.close()


def _redact_and_truncate(value: str) -> tuple[str, bool]:
    redacted = value
    for pattern in _SENSITIVE_OUTPUT_PATTERNS:
        if pattern.pattern.startswith("(?i)(password"):
            redacted = pattern.sub(
                lambda match: f"{match.group(1)}=[REDACTED]",
                redacted,
            )
        else:
            redacted = pattern.sub("[REDACTED PRIVATE KEY]", redacted)
    if len(redacted) <= _MAX_OUTPUT_CHARS:
        return redacted, False
    return redacted[:_MAX_OUTPUT_CHARS] + "\n...[truncated]", True


# ---------------------------------------------------------------------------
# 內部 VM 資訊解析（主後端內嵌模組用，不經 HTTP 回呼）
# ---------------------------------------------------------------------------

def _resolve_vm_info_from_db(session: Session, vmid: int) -> tuple[str, str]:
    """從資料庫直接取得 VM IP 與 SSH private key。

    回傳 (host_ip, private_key_pem)。
    僅供主後端內部使用；獨立 ai-pve-log 子服務請沿用 HTTP 回呼路徑。
    """
    resource = resource_repo.get_resource_by_vmid(session=session, vmid=vmid)
    if not resource:
        raise RuntimeError(t("pveLog.vmNotRegistered", vmid=vmid))

    host = (resource_repo.get_cached_ip_address(session=session, vmid=vmid) or "").strip()
    if not host:
        # 對齊 /resources/{vmid} 行為：DB 無快取時，向 Proxmox 取即時 IP。
        try:
            vm_info = proxmox_service.find_resource(vmid)
            vm_node = str(vm_info.get("node") or "")
            vm_type = str(vm_info.get("type") or "")
            if vm_node and vm_type in {"qemu", "lxc"}:
                live_ip = proxmox_service.get_ip_address(vm_node, vmid, vm_type)
                if live_ip:
                    host = live_ip
                    try:
                        resource_repo.update_ip_address(
                            session=session,
                            vmid=vmid,
                            ip_address=live_ip,
                        )
                    except Exception:
                        session.rollback()
                        logger.warning(
                            "更新 VMID=%s IP 快取失敗（ip=%s）",
                            vmid,
                            live_ip,
                            exc_info=True,
                        )
        except Exception as exc:
            logger.warning("VMID=%s 即時 IP 解析失敗：%s", vmid, exc)

    if not host:
        raise RuntimeError(t("pveLog.noIpAddressCached", vmid=vmid))

    if not resource.ssh_private_key_encrypted:
        raise RuntimeError(t("pveLog.sshKeyNotRegistered", vmid=vmid))
    private_key = decrypt_value(resource.ssh_private_key_encrypted)
    return host, private_key


# ---------------------------------------------------------------------------
# 主要公開函式
# ---------------------------------------------------------------------------

async def ssh_exec(
    req: SSHExecRequest,
    *,
    session: Session | None = None,
    allowed_vmids: set[int] | None = None,
    requester_id: uuid.UUID | None = None,
    scope_type: str | None = None,
    scope_id: uuid.UUID | None = None,
) -> SSHExecResult:
    """SSH 執行主入口。

    呼叫端透過 SSHExecRequest.require_confirm 控制是否需要二次確認：
    - False（預設）：直接執行
    - True：回傳 pending=True + confirm_token，等待 /ssh/confirm 確認
    """
    # ── 層一：黑名單過濾 ──────────────────────────────────────────────────
    guard = check_command(req.command)
    if not guard.allowed:
        logger.warning("指令被黑名單攔截 vmid=%d cmd=%r reason=%s", req.vmid, req.command, guard.reason)
        return SSHExecResult(
            vmid=req.vmid,
            host="",
            ssh_user=req.ssh_user,
            command=req.command,
            blocked=True,
            block_reason=guard.reason,
        )

    if allowed_vmids is not None and req.vmid not in allowed_vmids:
        return SSHExecResult(
            vmid=req.vmid,
            host="",
            ssh_user=req.ssh_user,
            command=req.command,
            blocked=True,
            block_reason=t("pveLog.scopeRestricted"),
        )

    # ── 層二：執行前確認（AI 呼叫時） ────────────────────────────────────
    if req.require_confirm:
        token = _store_pending(
            req,
            allowed_vmids=allowed_vmids,
            requester_id=requester_id,
            scope_type=scope_type,
            scope_id=scope_id,
        )
        logger.info("SSH 待確認 vmid=%d cmd=%r token=%s", req.vmid, req.command, token)
        return SSHExecResult(
            vmid=req.vmid,
            host="",
            ssh_user=req.ssh_user,
            command=req.command,
            pending=True,
            confirm_token=token,
        )

    return await _do_exec(req, session=session, allowed_vmids=allowed_vmids)


async def confirm_exec(
    confirm_req: SSHConfirmRequest,
    *,
    session: Session | None = None,
    requester_id: uuid.UUID | None = None,
    scope_type: str | None = None,
    scope_id: uuid.UUID | None = None,
    allowed_vmids: set[int] | None = None,
) -> SSHExecResult:
    """處理使用者確認（允許 or 拒絕）。"""
    token = confirm_req.token or confirm_req.confirm_token
    if not token:
        return SSHExecResult(
            vmid=0,
            host="",
            ssh_user="",
            command="",
            error=t("pveLog.missingConfirmToken"),
        )
    entry = _peek_pending(token)
    if entry is None:
        return SSHExecResult(
            vmid=0,
            host="",
            ssh_user="",
            command="",
            error=t("pveLog.confirmTokenInvalid"),
        )
    req = entry["request"]
    stored_vmids = entry.get("allowed_vmids")
    if (
        entry.get("requester_id") != requester_id
        or entry.get("scope_type") != scope_type
        or entry.get("scope_id") != scope_id
        or (
            allowed_vmids is not None
            and stored_vmids is not None
            and set(allowed_vmids) != set(stored_vmids)
        )
    ):
        return SSHExecResult(
            vmid=req.vmid,
            command=req.command,
            error=t("pveLog.confirmTokenScopeMismatch"),
        )
    # Only a successfully re-authorized caller may consume the one-time token.
    entry = _pop_pending(token)
    if entry is None:
        return SSHExecResult(
            vmid=req.vmid,
            command=req.command,
            error=t("pveLog.confirmTokenInvalid"),
        )
    allowed_vmids = stored_vmids

    if not confirm_req.approved:
        logger.info("使用者拒絕執行 vmid=%d cmd=%r", req.vmid, req.command)
        return SSHExecResult(
            vmid=req.vmid,
            host="",
            ssh_user=req.ssh_user,
            command=req.command,
            error=t("pveLog.userRejected"),
        )

    override_command = (confirm_req.command or "").strip()
    if override_command:
        guard = check_command(override_command)
        if not guard.allowed:
            logger.warning(
                "使用者覆寫指令被黑名單攔截 vmid=%d cmd=%r reason=%s",
                req.vmid,
                override_command,
                guard.reason,
            )
            return SSHExecResult(
                vmid=req.vmid,
                host="",
                ssh_user=req.ssh_user,
                command=override_command,
                blocked=True,
                block_reason=guard.reason,
            )
        req = req.model_copy(update={"command": override_command})

    return await _do_exec(req, session=session, allowed_vmids=allowed_vmids)


async def _do_exec(
    req: SSHExecRequest,
    *,
    session: Session | None = None,
    allowed_vmids: set[int] | None = None,
) -> SSHExecResult:
    """實際執行 SSH 指令（通過安全檢查後）。

    當 session 傳入時走內部 DB 查詢路徑（主後端內嵌模組用）；
    未傳入時走 HTTP 回呼路徑（獨立 ai-pve-log 子服務用）。
    """
    timeout = settings.ssh_timeout
    host = ""

    try:
        if allowed_vmids is not None and req.vmid not in allowed_vmids:
            return SSHExecResult(
                vmid=req.vmid,
                host="",
                ssh_user=req.ssh_user,
                command=req.command,
                blocked=True,
                block_reason=t("pveLog.scopeRestricted"),
            )

        if session is not None:
            host, private_key = _resolve_vm_info_from_db(session, req.vmid)
        else:
            if not settings.skylab_api_user or not settings.skylab_api_password:
                return SSHExecResult(
                    vmid=req.vmid,
                    host="",
                    ssh_user=req.ssh_user,
                    command=req.command,
                    error=t("pveLog.skylabCredentialsMissing"),
                )
            async with httpx.AsyncClient(timeout=timeout) as client:
                token = await _get_campus_token(client)
                host = await _get_vm_ip(client, token, req.vmid)
                private_key = await _get_ssh_private_key(client, token, req.vmid)

        # 4. SSH 連線執行（同步操作放進 thread）
        logger.info(
            "SSH 執行 vmid=%d host=%s user=%s cmd=%r",
            req.vmid, host, req.ssh_user, req.command,
        )
        exit_code, stdout, stderr = await asyncio.to_thread(
            _ssh_exec_sync,
            host,
            req.ssh_port,
            req.ssh_user,
            private_key,
            req.command,
            timeout,
        )

        stdout, stdout_truncated = _redact_and_truncate(stdout)
        stderr, stderr_truncated = _redact_and_truncate(stderr)
        return SSHExecResult(
            vmid=req.vmid,
            host=host,
            ssh_user=req.ssh_user,
            command=req.command,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            stdout_truncated=stdout_truncated,
            stderr_truncated=stderr_truncated,
        )

    except Exception as exc:
        logger.error("SSH 執行失敗 vmid=%d host=%s: %s", req.vmid, host, exc)
        return SSHExecResult(
            vmid=req.vmid,
            host=host,
            ssh_user=req.ssh_user,
            command=req.command,
            error=str(exc),
        )
