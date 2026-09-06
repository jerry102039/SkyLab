"""Proxmox 連線（多入口）資料庫操作"""

from datetime import datetime, timezone

from cryptography.fernet import InvalidToken
from sqlmodel import Session, select

from app.core.i18n import t
from app.core.security import decrypt_value, encrypt_value
from app.exceptions import AppError
from app.models.proxmox_connection import ProxmoxConnection


def get_all_connections(
    session: Session, *, enabled_only: bool = False
) -> list[ProxmoxConnection]:
    """取得所有連線，預設連線優先，其餘按名稱排序。"""
    stmt = select(ProxmoxConnection)
    if enabled_only:
        stmt = stmt.where(ProxmoxConnection.enabled == True)  # noqa: E712
    stmt = stmt.order_by(
        ProxmoxConnection.is_default.desc(),  # type: ignore[attr-defined]
        ProxmoxConnection.name,
    )
    return list(session.exec(stmt).all())


def get_connection(session: Session, connection_id: int) -> ProxmoxConnection | None:
    return session.get(ProxmoxConnection, connection_id)


def get_default_connection(session: Session) -> ProxmoxConnection | None:
    """取得預設連線；沒有標記時退回第一筆啟用的連線。"""
    stmt = (
        select(ProxmoxConnection)
        .where(ProxmoxConnection.is_default == True)  # noqa: E712
        .limit(1)
    )
    conn = session.exec(stmt).first()
    if conn is not None:
        return conn
    connections = get_all_connections(session, enabled_only=True)
    return connections[0] if connections else None


def create_connection(
    session: Session,
    *,
    name: str,
    host: str,
    port: int,
    user: str,
    password: str,
    verify_ssl: bool,
    ca_cert: str | None,
    api_timeout: int,
    pool_name: str,
    iso_storage: str,
    data_storage: str,
    task_check_interval: int,
    gateway_ip: str | None = None,
    local_subnet: str | None = None,
    default_node: str | None = None,
    enabled: bool = True,
    is_default: bool = False,
) -> ProxmoxConnection:
    if is_default:
        _clear_default(session)
    conn = ProxmoxConnection(
        name=name,
        host=host,
        port=port,
        user=user,
        encrypted_password=encrypt_value(password),
        verify_ssl=verify_ssl,
        ca_cert=ca_cert or None,
        api_timeout=api_timeout,
        pool_name=pool_name,
        iso_storage=iso_storage,
        data_storage=data_storage,
        task_check_interval=task_check_interval,
        gateway_ip=gateway_ip or None,
        local_subnet=local_subnet or None,
        default_node=default_node or None,
        enabled=enabled,
        is_default=is_default,
    )
    session.add(conn)
    session.commit()
    session.refresh(conn)
    return conn


def update_connection(
    session: Session,
    connection_id: int,
    *,
    name: str,
    host: str,
    port: int,
    user: str,
    password: str | None,  # None = 不更新密碼
    verify_ssl: bool,
    ca_cert: str | None,  # None = 不更新；空字串 = 清除
    api_timeout: int,
    pool_name: str,
    iso_storage: str,
    data_storage: str,
    task_check_interval: int,
    gateway_ip: str | None,
    local_subnet: str | None,
    default_node: str | None,
    enabled: bool,
    is_default: bool,
) -> ProxmoxConnection | None:
    conn = session.get(ProxmoxConnection, connection_id)
    if conn is None:
        return None
    if is_default and not conn.is_default:
        _clear_default(session)
    conn.name = name
    conn.host = host
    conn.port = port
    conn.user = user
    if password is not None:
        conn.encrypted_password = encrypt_value(password)
    conn.verify_ssl = verify_ssl
    if ca_cert is not None:
        conn.ca_cert = ca_cert if ca_cert else None
    conn.api_timeout = api_timeout
    conn.pool_name = pool_name
    conn.iso_storage = iso_storage
    conn.data_storage = data_storage
    conn.task_check_interval = task_check_interval
    conn.gateway_ip = gateway_ip or None
    conn.local_subnet = local_subnet or None
    conn.default_node = default_node or None
    conn.enabled = enabled
    conn.is_default = is_default
    conn.updated_at = datetime.now(timezone.utc)
    session.add(conn)
    session.commit()
    session.refresh(conn)
    return conn


def delete_connection(session: Session, connection_id: int) -> bool:
    conn = session.get(ProxmoxConnection, connection_id)
    if conn is None:
        return False
    session.delete(conn)
    session.commit()
    return True


def get_decrypted_password(conn: ProxmoxConnection) -> str:
    try:
        return decrypt_value(conn.encrypted_password)
    except InvalidToken as e:
        raise AppError(
            t("proxmox.connection_decrypt_password_failed", name=conn.name),
            status_code=400,
        ) from e


def _clear_default(session: Session) -> None:
    stmt = select(ProxmoxConnection).where(
        ProxmoxConnection.is_default == True  # noqa: E712
    )
    for conn in session.exec(stmt).all():
        conn.is_default = False
        session.add(conn)


__all__ = [
    "get_all_connections",
    "get_connection",
    "get_default_connection",
    "create_connection",
    "update_connection",
    "delete_connection",
    "get_decrypted_password",
]
