"""跨節點克隆失敗時的 GPU 退回把關。

背景：VM 範本跨節點只能 full clone，失敗時舊行為是直接退回範本節點建立。
但 `_select_request_placement` 事前做過的 GPU 節點相容性檢查在這條退回路徑上
不會重跑 —— 範本節點未必有這張卡，卻仍會被套上 hostpci0，等於繞過約束。

這裡固定新行為：需要 GPU 且範本節點拿不到該 mapping 時，明確失敗，
不得退回範本節點。
"""

from types import SimpleNamespace

import pytest

from app.exceptions import ProxmoxError
from app.services.proxmox import provisioning_service

MAPPING_ID = "gpu-a100"


def _mapping(*nodes: str) -> SimpleNamespace:
    return SimpleNamespace(maps=[SimpleNamespace(node=node) for node in nodes])


# ---------------------------------------------------------------------------
# _template_node_accepts_gpu：退回前的判斷本體
# ---------------------------------------------------------------------------

class TestTemplateNodeAcceptsGpu:
    def test_no_gpu_requirement_allows_fallback(self):
        assert provisioning_service._template_node_accepts_gpu({}, "pve1") is True

    def test_template_node_with_mapping_allows_fallback(self, monkeypatch):
        monkeypatch.setattr(
            provisioning_service.gpu_service,
            "get_gpu_mapping",
            lambda mapping_id: _mapping("pve1", "pve2"),
        )
        plan = {"gpu_mapping_id": MAPPING_ID}
        assert provisioning_service._template_node_accepts_gpu(plan, "pve1") is True

    def test_template_node_without_mapping_blocks_fallback(self, monkeypatch):
        monkeypatch.setattr(
            provisioning_service.gpu_service,
            "get_gpu_mapping",
            lambda mapping_id: _mapping("pve2"),
        )
        plan = {"gpu_mapping_id": MAPPING_ID}
        assert provisioning_service._template_node_accepts_gpu(plan, "pve1") is False

    def test_lookup_failure_blocks_fallback(self, monkeypatch):
        def _boom(mapping_id):
            raise RuntimeError("PVE unreachable")

        monkeypatch.setattr(
            provisioning_service.gpu_service, "get_gpu_mapping", _boom
        )
        plan = {"gpu_mapping_id": MAPPING_ID}
        # 無法確認就不退回：寧可失敗，也不要建出一台掛不上 GPU 的機器
        assert provisioning_service._template_node_accepts_gpu(plan, "pve1") is False


# ---------------------------------------------------------------------------
# execute_provision：跨節點克隆失敗後的實際行為
# ---------------------------------------------------------------------------

def _vm_plan() -> dict:
    return {
        "vmid": 9001,
        "target_node": "pve2",
        "template_node": "pve1",
        "template_id": 100,
        "resource_type": "vm",
        "hostname": "gpu-box",
        "target_storage": "local-lvm",
        "gpu_mapping_id": MAPPING_ID,
        "cores": 4,
        "memory": 8192,
        "password": "pw",
        "start_immediately": False,
        "allocated_ip": "10.0.0.10",
        "net_cfg": {
            "bridge_name": "vmbr0",
            "prefix_len": 24,
            "gateway": "10.0.0.1",
        },
    }


class TestCrossNodeCloneFallbackGuard:
    @pytest.fixture(autouse=True)
    def _stub_pool(self, monkeypatch):
        monkeypatch.setattr(
            provisioning_service,
            "get_proxmox_settings_for_node",
            lambda node: SimpleNamespace(pool_name="pool"),
        )

    def test_gpu_incompatible_template_node_raises_without_fallback(
        self, monkeypatch
    ):
        calls: list[dict] = []

        def _clone_vm(node, template_id, **kwargs):
            calls.append({"node": node, **kwargs})
            raise RuntimeError("cross-node clone failed")

        monkeypatch.setattr(
            provisioning_service.proxmox_service, "clone_vm", _clone_vm
        )
        # 範本節點 pve1 沒有這張卡，只有 pve2 有
        monkeypatch.setattr(
            provisioning_service.gpu_service,
            "get_gpu_mapping",
            lambda mapping_id: _mapping("pve2"),
        )

        with pytest.raises(ProxmoxError, match=MAPPING_ID):
            provisioning_service.execute_provision(_vm_plan())

        # 關鍵斷言：只嘗試過跨節點那一次，沒有退回範本節點再 clone 一次
        assert len(calls) == 1
        assert calls[0]["target"] == "pve2"
