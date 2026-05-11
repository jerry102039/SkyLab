from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from app.models import User
from app.models.user import UserRole


@dataclass(frozen=True)
class NavigationRoute:
    path: str
    title: str
    summary: str
    keywords: tuple[str, ...]
    allow_student: bool = True
    allow_teacher: bool = True
    allow_admin: bool = True


_ROUTES: tuple[NavigationRoute, ...] = (
    NavigationRoute(
        path="/",
        title="儀表板",
        summary="查看總覽與快速入口。",
        keywords=("首頁", "儀表板", "dashboard", "總覽", "主頁"),
    ),
    NavigationRoute(
        path="/my-resources",
        title="我的資源",
        summary="查看我名下的 VM/LXC 資源。",
        keywords=("我的資源", "我的機器", "我有哪些機器", "my resource", "my vm"),
    ),
    NavigationRoute(
        path="/resources",
        title="所有資源",
        summary="管理全站資源列表。",
        keywords=("所有資源", "全部資源", "資源清單", "resources"),
        allow_student=False,
        allow_teacher=False,
    ),
    NavigationRoute(
        path="/resources-create",
        title="快速建立資源",
        summary="直接建立 VM/LXC。",
        keywords=("建立資源", "快速建立", "create vm", "create lxc"),
        allow_student=False,
        allow_teacher=False,
    ),
    NavigationRoute(
        path="/applications",
        title="申請列表",
        summary="提交與查看資源申請。",
        keywords=("申請", "申請單", "request", "applications", "vm 申請"),
    ),
    NavigationRoute(
        path="/applications-create",
        title="新增申請",
        summary="建立新的資源申請。",
        keywords=("新增申請", "申請 vm", "申請 lxc", "create request"),
    ),
    NavigationRoute(
        path="/approvals",
        title="審核中心",
        summary="審核資源申請。",
        keywords=("審核", "approval", "審批", "簽核"),
        allow_student=False,
        allow_teacher=False,
    ),
    NavigationRoute(
        path="/groups",
        title="群組",
        summary="管理課程或專案群組。",
        keywords=("群組", "group", "班級", "團隊"),
        allow_student=False,
    ),
    NavigationRoute(
        path="/firewall",
        title="防火牆",
        summary="設定網路連線與規則。",
        keywords=("防火牆", "firewall", "網路規則", "連線規則"),
    ),
    NavigationRoute(
        path="/reverse-proxy",
        title="反向代理",
        summary="管理反向代理規則與 Runtime。",
        keywords=("反向代理", "reverse proxy", "網域轉發", "traefik"),
    ),
    NavigationRoute(
        path="/gpu-management",
        title="GPU 管理",
        summary="查看 GPU 映射與使用狀態。",
        keywords=("gpu", "顯卡", "cuda", "gpu 管理"),
    ),
    NavigationRoute(
        path="/jobs",
        title="背景任務",
        summary="查看任務執行進度與結果。",
        keywords=("任務", "job", "背景任務", "排程"),
    ),
    NavigationRoute(
        path="/ai-api",
        title="AI API",
        summary="管理 AI API 金鑰與個人用量。",
        keywords=("ai api", "token 用量", "金鑰", "ai 用量"),
    ),
    NavigationRoute(
        path="/admin",
        title="管理主頁",
        summary="系統管理總覽。",
        keywords=("admin", "管理主頁", "後台"),
        allow_student=False,
        allow_teacher=False,
    ),
    NavigationRoute(
        path="/admin/ai-management",
        title="AI 管理中心",
        summary="管理 AI API 申請、憑證與流程。",
        keywords=("ai 管理", "ai management", "ai 審核"),
        allow_student=False,
        allow_teacher=False,
    ),
    NavigationRoute(
        path="/admin/ai-monitoring",
        title="AI 監控",
        summary="查看全局 AI 使用統計。",
        keywords=("ai 監控", "ai monitoring", "全局用量"),
        allow_student=False,
        allow_teacher=False,
    ),
    NavigationRoute(
        path="/admin/configuration",
        title="系統設定",
        summary="設定平台系統參數。",
        keywords=("系統設定", "configuration", "設定"),
        allow_student=False,
        allow_teacher=False,
    ),
    NavigationRoute(
        path="/admin/domains",
        title="網域管理",
        summary="管理 Cloudflare / DNS 網域設定。",
        keywords=("網域", "dns", "domain", "cloudflare"),
        allow_student=False,
        allow_teacher=False,
    ),
    NavigationRoute(
        path="/admin/gateway",
        title="Gateway VM",
        summary="管理 Gateway VM 與網路服務。",
        keywords=("gateway", "網關", "gateway vm"),
        allow_student=False,
        allow_teacher=False,
    ),
    NavigationRoute(
        path="/admin/ip-management",
        title="IP 管理",
        summary="配置子網與 IP 配置。",
        keywords=("ip 管理", "子網", "subnet"),
        allow_student=False,
        allow_teacher=False,
    ),
    NavigationRoute(
        path="/admin/audit-logs",
        title="Audit Logs",
        summary="查詢系統操作稽核紀錄。",
        keywords=("audit", "稽核", "操作紀錄"),
        allow_student=False,
        allow_teacher=False,
    ),
)


def resolve_user_role(user: User) -> UserRole:
    if bool(getattr(user, "is_superuser", False)):
        return UserRole.admin
    role = getattr(user, "role", UserRole.student)
    if isinstance(role, UserRole):
        return role
    try:
        return UserRole(str(role))
    except ValueError:
        return UserRole.student


def get_routes_for_user(user: User) -> tuple[NavigationRoute, ...]:
    role = resolve_user_role(user)
    routes: list[NavigationRoute] = []
    for route in _ROUTES:
        if role == UserRole.admin and route.allow_admin:
            routes.append(route)
        elif role == UserRole.teacher and route.allow_teacher:
            routes.append(route)
        elif role == UserRole.student and route.allow_student:
            routes.append(route)
    return tuple(routes)


def find_route_by_path(path: str, routes: Iterable[NavigationRoute]) -> NavigationRoute | None:
    target = path.strip()
    for route in routes:
        if route.path == target:
            return route
    return None

