"""Orchestration for the isolated AI PVE template test feature."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlmodel import Session

from app.ai.pve_log.chat import chat as pve_chat
from app.ai.pve_log.schemas import ChatResponse, SSHExecResult
from app.ai.pve_log.ssh_exec import (
    confirm_exec,
    peek_pending_request,
    peek_pending_scope,
)
from app.ai.pve_template.prompts import compose_system_prompt
from app.ai.pve_template.repository import get_by_id, get_by_key
from app.ai.pve_template.repository import list_enabled as list_enabled_templates
from app.ai.pve_template.schemas import (
    AIPVETemplateChatRequest,
    AIPVETemplateChatResponse,
    AIPVETemplateRead,
    AIPVETemplateSSHConfirmRequest,
    AIPVETemplateTargetRead,
)
from app.core.authorizers import require_resource_access
from app.core.i18n import t
from app.exceptions import BadRequestError, NotFoundError
from app.models import AIPVETemplate
from app.repositories import resource as resource_repo

_PENDING_CONTEXT_TTL = 300


@dataclass(slots=True)
class _PendingContext:
    created_at: float
    scope_id: uuid.UUID
    targets: tuple[tuple[int, AIPVETemplate], ...]
    allowed_vmids: frozenset[int]
    template_keys_by_vmid: dict[int, str]
    messages: list[dict[str, Any]]


_pending_context: dict[str, _PendingContext] = {}


def _cleanup_pending_context() -> None:
    now = time.monotonic()
    for token, context in list(_pending_context.items()):
        if now - context.created_at > _PENDING_CONTEXT_TTL:
            _pending_context.pop(token, None)


def _authorize_vmid(*, session: Session, current_user: Any, vmid: int) -> Any:
    resource = resource_repo.get_resource_by_vmid(session=session, vmid=vmid)
    if resource is None:
        raise NotFoundError(t("pveTemplate.vmidNotRegistered", vmid=vmid))
    require_resource_access(
        current_user,
        resource.user_id,
        detail=t("pveTemplate.noAccessPermission"),
    )
    return resource


def list_templates(*, session: Session) -> list[AIPVETemplateRead]:
    return [
        AIPVETemplateRead.model_validate(item, from_attributes=True)
        for item in list_enabled_templates(session=session)
    ]


def _resolve_targets(
    *, request: AIPVETemplateChatRequest, session: Session
) -> tuple[tuple[int, AIPVETemplate], ...]:
    resolved: list[tuple[int, AIPVETemplate]] = []
    for target in request.targets:
        template = get_by_key(session=session, template_key=target.template_key)
        if template is None or not template.enabled:
            raise NotFoundError(
                t("pveTemplate.templateNotFound", key=target.template_key)
            )
        resolved.append((target.vmid, template))
    return tuple(resolved)


def _authorize_targets(
    *,
    session: Session,
    current_user: Any,
    targets: Sequence[tuple[int, AIPVETemplate]],
) -> None:
    # Authorize every target before the LLM or any runtime tool is reached.
    for vmid, _template in targets:
        _authorize_vmid(session=session, current_user=current_user, vmid=vmid)


def _target_reads(
    targets: Sequence[tuple[int, AIPVETemplate]],
) -> list[AIPVETemplateTargetRead]:
    return [
        AIPVETemplateTargetRead(
            vmid=vmid,
            template_key=template.template_key,
            display_name=template.display_name,
        )
        for vmid, template in targets
    ]


def _response(
    *,
    targets: Sequence[tuple[int, AIPVETemplate]],
    response: ChatResponse,
    confirmation_result: SSHExecResult | None = None,
) -> AIPVETemplateChatResponse:
    return AIPVETemplateChatResponse(
        targets=_target_reads(targets),
        reply=response.reply,
        tools_called=response.tools_called,
        needs_confirmation=response.needs_confirmation,
        messages=response.messages,
        error=response.error,
        confirmation_result=confirmation_result,
    )


def _remember_pending(
    *,
    targets: Sequence[tuple[int, AIPVETemplate]],
    scope_id: uuid.UUID,
    response: ChatResponse,
) -> None:
    _cleanup_pending_context()
    target_tuple = tuple(targets)
    allowed_vmids = frozenset(vmid for vmid, _template in target_tuple)
    template_keys_by_vmid = {
        vmid: template.template_key for vmid, template in target_tuple
    }
    for record in response.tools_called:
        result = record.result or {}
        token = result.get("confirm_token")
        if token and result.get("pending"):
            stored_scope_type, stored_scope_id = peek_pending_scope(str(token))
            effective_scope_id = (
                stored_scope_id
                if stored_scope_type == "template" and stored_scope_id is not None
                else scope_id
            )
            _pending_context[str(token)] = _PendingContext(
                created_at=time.monotonic(),
                scope_id=effective_scope_id,
                targets=target_tuple,
                allowed_vmids=allowed_vmids,
                template_keys_by_vmid=template_keys_by_vmid,
                messages=[dict(message) for message in response.messages],
            )


async def chat(
    *, request: AIPVETemplateChatRequest, current_user: Any, session: Session
) -> AIPVETemplateChatResponse:
    targets = _resolve_targets(request=request, session=session)
    _authorize_targets(session=session, current_user=current_user, targets=targets)
    allowed_vmids = {vmid for vmid, _template in targets}
    template_keys_by_vmid = {
        vmid: template.template_key for vmid, template in targets
    }
    scope_id = uuid.uuid4()

    response = await pve_chat(
        message=request.message,
        history=request.messages,
        session=session,
        allowed_vmids=allowed_vmids,
        requester_id=current_user.id,
        scope_type="template_batch",
        scope_id=scope_id,
        system_prompt=compose_system_prompt(targets=targets),
        template_keys_by_vmid=template_keys_by_vmid,
        auto_execute_known_ssh=True,
    )
    _remember_pending(targets=targets, scope_id=scope_id, response=response)
    return _response(targets=targets, response=response)


def _replace_pending_tool_result(
    messages: list[dict[str, Any]],
    result: SSHExecResult,
    *,
    approved: bool,
) -> list[dict[str, Any]]:
    replaced = [dict(message) for message in messages]
    for message in reversed(replaced):
        if message.get("role") != "tool":
            continue
        try:
            content = json.loads(str(message.get("content", "")))
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(content, dict) and content.get("pending"):
            resumed_result = result.model_dump(mode="json")
            resumed_result["confirmation_decision"] = (
                "approved" if approved else "rejected"
            )
            message["content"] = json.dumps(
                resumed_result,
                ensure_ascii=False,
            )
            break
    return replaced


async def confirm_ssh(
    *,
    request: AIPVETemplateSSHConfirmRequest,
    current_user: Any,
    session: Session,
) -> AIPVETemplateChatResponse:
    token = request.token or request.confirm_token or ""
    pending_request = peek_pending_request(token)
    scope_type, scope_id = peek_pending_scope(token)
    context = _pending_context.get(token)
    if (
        pending_request is None
        or scope_type not in {"template", "template_batch"}
        or scope_id is None
        or context is None
        or context.scope_id != scope_id
    ):
        raise BadRequestError(t("pveTemplate.confirmTokenInvalidOrNotTemplate"))

    targets = _resolve_targets_from_context(context=context, session=session)
    _authorize_targets(session=session, current_user=current_user, targets=targets)
    if pending_request.vmid not in context.allowed_vmids:
        raise BadRequestError(t("pveTemplate.vmidNotInScope"))
    effective_scope_type = scope_type or "template_batch"

    result = await confirm_exec(
        request,
        session=session,
        requester_id=current_user.id,
        scope_type=effective_scope_type,
        scope_id=scope_id,
        allowed_vmids=set(context.allowed_vmids),
    )
    _cleanup_pending_context()
    # Token still exists means confirm_exec rejected the caller/scope before
    # consuming it. Keep both stores intact so the legitimate owner can retry.
    if peek_pending_request(token) is not None:
        return AIPVETemplateChatResponse(
            targets=_target_reads(targets),
            reply=t("pveTemplate.confirmationNotEffective"),
            error=result.error or result.block_reason,
            confirmation_result=result,
        )

    context = _pending_context.pop(token, None)
    if context is None or result.pending:
        return AIPVETemplateChatResponse(
            targets=_target_reads(targets),
            reply=t("pveTemplate.conversationExpired"),
            error=result.error
            or result.block_reason
            or t("pveTemplate.conversationExpiredShort"),
            confirmation_result=result,
        )

    resumed = await pve_chat(
        history=_replace_pending_tool_result(
            context.messages,
            result,
            approved=request.approved,
        ),
        session=session,
        allowed_vmids=set(context.allowed_vmids),
        requester_id=current_user.id,
        scope_type=effective_scope_type,
        scope_id=context.scope_id,
        system_prompt=compose_system_prompt(targets=context.targets),
        template_keys_by_vmid=context.template_keys_by_vmid,
        auto_execute_known_ssh=True,
        resume_deferred_ssh=True,
    )
    _remember_pending(
        targets=context.targets,
        scope_id=context.scope_id,
        response=resumed,
    )
    return _response(
        targets=context.targets,
        response=resumed,
        confirmation_result=result,
    )


def _resolve_targets_from_context(
    *, context: _PendingContext, session: Session
) -> tuple[tuple[int, AIPVETemplate], ...]:
    resolved: list[tuple[int, AIPVETemplate]] = []
    for vmid, template in context.targets:
        current = get_by_id(session=session, template_id=template.id)
        if (
            current is None
            or not current.enabled
            or current.template_key != template.template_key
        ):
            raise NotFoundError(
                t("pveTemplate.templateNotFound", key=template.template_key)
            )
        resolved.append((vmid, current))
    return tuple(resolved)


__all__ = ["chat", "confirm_ssh", "list_templates"]
