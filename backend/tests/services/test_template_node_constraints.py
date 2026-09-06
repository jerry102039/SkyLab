"""模板節點約束：placement 只能選「拿得到模板」的節點。

背景：vztmpl 只存在部分節點（各連線 iso_storage 未必共享）、VM 克隆
不可跨連線、-GPU 模板需要有 GPU 的節點。placement / availability /
pinned 節點驗證都必須尊重這些約束。
"""

from types import SimpleNamespace

import pytest

from app.domain.placement.schemas import NodeCapacity, PlacementRequest
from app.exceptions import NotFoundError, ProxmoxError
from app.services.vm import placement_support


def _node(name: str, **overrides) -> NodeCapacity:
    defaults = dict(
        node=name,
        status="online",
        gpu_count=0,
        running_resources=0,
        guest_soft_limit=100,
        total_cpu_cores=32.0,
        allocatable_cpu_cores=16.0,
        total_memory_bytes=64 * 1024**3,
        allocatable_memory_bytes=32 * 1024**3,
        total_disk_bytes=2 * 1024**4,
        allocatable_disk_bytes=1024**4,
    )
    defaults.update(overrides)
    return NodeCapacity(**defaults)


def _can_host(node: NodeCapacity, **overrides) -> bool:
    kwargs = dict(
        cores=2.0,
        memory_bytes=2 * 1024**3,
        disk_bytes=8 * 1024**3,
        gpu_required=0,
        has_managed_storage=True,
    )
    kwargs.update(overrides)
    return placement_support.node_can_host_request(node, **kwargs)


@pytest.fixture(autouse=True)
def _clear_template_nodes_cache():
    with placement_support._template_nodes_cache_lock:
        placement_support._template_nodes_cache.clear()
    yield
    with placement_support._template_nodes_cache_lock:
        placement_support._template_nodes_cache.clear()


# ---------------------------------------------------------------------------
# node_can_host_request：allowed_nodes 白名單
# ---------------------------------------------------------------------------

class TestNodeCanHostAllowedNodes:
    def test_none_means_unconstrained(self):
        assert _can_host(_node("pve201"), allowed_nodes=None)

    def test_node_in_whitelist_passes(self):
        assert _can_host(_node("pve201"), allowed_nodes={"pve201", "pve202"})

    def test_node_outside_whitelist_rejected(self):
        assert not _can_host(_node("pve201"), allowed_nodes={"pve202"})

    def test_empty_whitelist_rejects_everything(self):
        assert not _can_host(_node("pve201"), allowed_nodes=set())


# ---------------------------------------------------------------------------
# to_placement_request：模板欄位帶入規則
# ---------------------------------------------------------------------------

class TestToPlacementRequestTemplateFields:
    def _db_request(self, **overrides):
        defaults = dict(
            resource_type="lxc",
            cores=2,
            memory=2048,
            disk_size=None,
            rootfs_size=8,
            gpu_mapping_id=None,
            ostemplate="ISO:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst",
            template_id=None,
        )
        defaults.update(overrides)
        return SimpleNamespace(**defaults)

    def test_lxc_plain_carries_ostemplate(self):
        request = placement_support.to_placement_request(self._db_request())
        assert request.ostemplate == (
            "ISO:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst"
        )
        assert request.template_vmid is None

    def test_lxc_clone_carries_template_vmid_not_ostemplate(self):
        # 克隆路徑不帶 ostemplate，改以 template_vmid 表示「必須在範本節點」——
        # 少了這個約束，placement 會選出一個之後被建機端覆寫掉的節點
        request = placement_support.to_placement_request(
            self._db_request(template_id=9001)
        )
        assert request.ostemplate is None
        assert request.template_vmid == 9001

    def test_vm_carries_template_vmid(self):
        request = placement_support.to_placement_request(
            self._db_request(
                resource_type="vm",
                disk_size=20,
                template_id=9001,
                ostemplate=None,
            )
        )
        assert request.ostemplate is None
        assert request.template_vmid == 9001


# ---------------------------------------------------------------------------
# allowed_template_nodes_for_request
# ---------------------------------------------------------------------------

VOLID = "ISO:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst"
GPU_VOLID = "ISO:vztmpl/ubuntu-22.04-standard-GPU_22.04-1_amd64.tar.zst"


class TestAllowedTemplateNodes:
    def test_no_template_returns_none(self):
        request = PlacementRequest(resource_type="lxc")
        assert placement_support.allowed_template_nodes_for_request(request) is None

    def test_lxc_template_restricted_to_visible_nodes(self, monkeypatch):
        monkeypatch.setattr(
            placement_support.proxmox_service,
            "get_lxc_template_node_map",
            lambda: {VOLID: {"pve202"}},
        )
        request = PlacementRequest(resource_type="lxc", ostemplate=VOLID)
        assert placement_support.allowed_template_nodes_for_request(request) == {
            "pve202"
        }

    def test_lxc_template_missing_everywhere_returns_empty(self, monkeypatch):
        monkeypatch.setattr(
            placement_support.proxmox_service,
            "get_lxc_template_node_map",
            lambda: {"ISO:vztmpl/other.tar.zst": {"pve201"}},
        )
        request = PlacementRequest(resource_type="lxc", ostemplate=VOLID)
        assert placement_support.allowed_template_nodes_for_request(request) == set()

    def test_empty_map_treated_as_unconstrained(self, monkeypatch):
        # 整張映射為空多半是所有節點查詢都失敗，不應把排程判成不可行
        monkeypatch.setattr(
            placement_support.proxmox_service,
            "get_lxc_template_node_map",
            lambda: {},
        )
        request = PlacementRequest(resource_type="lxc", ostemplate=VOLID)
        assert placement_support.allowed_template_nodes_for_request(request) is None

    def test_query_failure_treated_as_unconstrained(self, monkeypatch):
        def _boom():
            raise RuntimeError("PVE down")

        monkeypatch.setattr(
            placement_support.proxmox_service,
            "get_lxc_template_node_map",
            _boom,
        )
        request = PlacementRequest(resource_type="lxc", ostemplate=VOLID)
        assert placement_support.allowed_template_nodes_for_request(request) is None

    def test_vm_template_restricted_to_connection_nodes(self, monkeypatch):
        monkeypatch.setattr(
            placement_support.proxmox_service,
            "find_vm_template",
            lambda template_id: {"vmid": template_id, "node": "pve201", "name": "ubuntu"},
        )
        monkeypatch.setattr(
            placement_support, "get_connection_id_for_node", lambda node: 3
        )
        monkeypatch.setattr(
            placement_support,
            "get_nodes_for_connection",
            lambda connection_id: {"pve201", "pve202"},
        )
        request = PlacementRequest(resource_type="vm", template_vmid=9001)
        assert placement_support.allowed_template_nodes_for_request(request) == {
            "pve201",
            "pve202",
        }

    def test_vm_template_not_found_returns_empty(self, monkeypatch):
        def _missing(template_id):
            raise NotFoundError(f"VM template {template_id} not found")

        monkeypatch.setattr(
            placement_support.proxmox_service, "find_vm_template", _missing
        )
        request = PlacementRequest(resource_type="vm", template_vmid=9001)
        assert placement_support.allowed_template_nodes_for_request(request) == set()

    def test_gpu_marked_lxc_template_intersects_gpu_nodes(self, monkeypatch):
        monkeypatch.setattr(
            placement_support.proxmox_service,
            "get_lxc_template_node_map",
            lambda: {GPU_VOLID: {"pve201", "pve202"}},
        )
        monkeypatch.setattr(
            placement_support.gpu_service,
            "get_gpu_node_counts",
            lambda mapping_id=None: {"pve202": 2, "pve203": 1},
        )
        request = PlacementRequest(resource_type="lxc", ostemplate=GPU_VOLID)
        assert placement_support.allowed_template_nodes_for_request(request) == {
            "pve202"
        }

    def test_gpu_marked_vm_template_with_mapping_skips_gpu_narrowing(
        self, monkeypatch
    ):
        # 已指定 mapping 時交由 allowed_gpu_nodes 過濾，不在此重複縮限
        monkeypatch.setattr(
            placement_support.proxmox_service,
            "find_vm_template",
            lambda template_id: {
                "vmid": template_id,
                "node": "pve201",
                "name": "win11-GPU",
            },
        )
        monkeypatch.setattr(
            placement_support, "get_connection_id_for_node", lambda node: None
        )
        monkeypatch.setattr(
            placement_support,
            "get_nodes_for_connection",
            lambda connection_id: {"pve201", "pve202"},
        )

        def _unexpected(mapping_id=None):
            raise AssertionError("should not query GPU nodes when mapping is set")

        monkeypatch.setattr(
            placement_support.gpu_service, "get_gpu_node_counts", _unexpected
        )
        request = PlacementRequest(
            resource_type="vm",
            template_vmid=9001,
            gpu_required=1,
            gpu_mapping_id="mapping-a",
        )
        assert placement_support.allowed_template_nodes_for_request(request) == {
            "pve201",
            "pve202",
        }

    def test_result_cached_within_ttl(self, monkeypatch):
        calls = {"count": 0}

        def _map():
            calls["count"] += 1
            return {VOLID: {"pve202"}}

        monkeypatch.setattr(
            placement_support.proxmox_service, "get_lxc_template_node_map", _map
        )
        request = PlacementRequest(resource_type="lxc", ostemplate=VOLID)
        placement_support.allowed_template_nodes_for_request(request)
        placement_support.allowed_template_nodes_for_request(request)
        assert calls["count"] == 1


# ---------------------------------------------------------------------------
# _select_request_placement：pinned 節點必須拿得到模板
# ---------------------------------------------------------------------------

class TestPinnedNodeTemplateGuard:
    def test_pinned_node_without_template_raises(self, monkeypatch):
        from app.services.proxmox import provisioning_service

        monkeypatch.setattr(
            placement_support,
            "allowed_template_nodes_for_request",
            lambda request: {"pve202"},
        )
        db_request = SimpleNamespace(
            gpu_mapping_id=None,
            desired_node="pve201",
            assigned_node=None,
            ostemplate=VOLID,
            template_id=None,
        )
        request = PlacementRequest(resource_type="lxc", ostemplate=VOLID)
        with pytest.raises(ProxmoxError, match="無法存取範本"):
            provisioning_service._select_request_placement(
                session=None,
                db_request=db_request,
                placement_request=request,
                placement_strategy="balanced",
            )
