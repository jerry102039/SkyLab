"""開機選項與標籤：Proxmox config 的解析與寫回。"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from app.exceptions import BadRequestError
from app.schemas.resource_settings import BootOptionsUpdate, ResourceMetadataUpdate
from app.services.resource import settings_service as svc

_QEMU_CONFIG = {
    "cores": 2,
    "memory": 2048,
    "onboot": 1,
    "boot": "order=scsi0;net0",
    "scsi0": "local-lvm:vm-150-disk-0,size=32G",
    "ide2": "local-lvm:vm-150-cloudinit,media=cdrom",
    "ide0": "local:iso/ubuntu.iso,media=cdrom",
    "net0": "virtio=AA:BB,bridge=vmbr1,firewall=1",
    "tags": "db;final",
    "description": "期末專題",
}


@pytest.fixture()
def fake_proxmox(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    calls = SimpleNamespace(updates=[])
    fake = SimpleNamespace(
        get_config=lambda node, vmid, rtype, **kw: dict(_QEMU_CONFIG),
        update_config=lambda node, vmid, rtype, **params: calls.updates.append(params),
        list_iso_images=lambda node: [{"volid": "local:iso/ubuntu.iso", "size": 1}],
        get_current_specs=lambda node, vmid, rtype: {
            "cpu": 2,
            "memory": 2048,
            "disk": 32,
        },
    )
    monkeypatch.setattr(svc, "proxmox_service", fake)
    monkeypatch.setattr(
        svc,
        "get_proxmox_settings_for_node",
        lambda node: SimpleNamespace(iso_storage="local"),
    )
    monkeypatch.setattr(svc.audit_service, "log_action", lambda **kwargs: None)
    return calls


def _info(rtype: str = "qemu") -> dict[str, Any]:
    return {"node": "pve1", "type": rtype, "vmid": 150, "status": "running"}


def test_boot_options_skip_cloudinit_and_find_cdrom(
    fake_proxmox: SimpleNamespace,
) -> None:
    opts = svc.get_boot_options(vmid=150, resource_info=_info(), can_edit_onboot=False)

    keys = {d.key for d in opts.boot_devices}
    assert keys == {"scsi0", "ide0", "net0"}  # ide2 是 cloud-init 磁碟，不列
    assert opts.cdrom_slot == "ide0"
    assert opts.cdrom_iso == "local:iso/ubuntu.iso"
    assert opts.boot_order == ["scsi0", "net0"]
    assert opts.onboot is True
    assert opts.can_edit_onboot is False


def test_update_boot_order_and_eject(fake_proxmox: SimpleNamespace) -> None:
    svc.update_boot_options(
        session=None,
        vmid=150,
        resource_info=_info(),
        user_id=None,
        data=BootOptionsUpdate(boot_order=["ide0", "scsi0"], eject_cdrom=True),
        can_edit_onboot=False,
    )
    assert fake_proxmox.updates == [
        {"boot": "order=ide0;scsi0", "ide0": "none,media=cdrom"}
    ]


def test_onboot_requires_permission(fake_proxmox: SimpleNamespace) -> None:
    with pytest.raises(BadRequestError):
        svc.update_boot_options(
            session=None,
            vmid=150,
            resource_info=_info(),
            user_id=None,
            data=BootOptionsUpdate(onboot=False),
            can_edit_onboot=False,
        )


def test_unknown_boot_device_rejected(fake_proxmox: SimpleNamespace) -> None:
    with pytest.raises(BadRequestError):
        svc.update_boot_options(
            session=None,
            vmid=150,
            resource_info=_info(),
            user_id=None,
            data=BootOptionsUpdate(boot_order=["scsi9"]),
            can_edit_onboot=True,
        )


def test_lxc_has_no_boot_order(fake_proxmox: SimpleNamespace) -> None:
    opts = svc.get_boot_options(
        vmid=150, resource_info=_info("lxc"), can_edit_onboot=True
    )
    assert opts.supports_boot_order is False
    assert opts.supports_cdrom is False
    with pytest.raises(BadRequestError):
        svc.update_boot_options(
            session=None,
            vmid=150,
            resource_info=_info("lxc"),
            user_id=None,
            data=BootOptionsUpdate(boot_order=[]),
            can_edit_onboot=True,
        )


def test_metadata_roundtrip(fake_proxmox: SimpleNamespace) -> None:
    meta = svc.get_metadata(vmid=150, resource_info=_info())
    assert meta.tags == ["db", "final"]

    svc.update_metadata(
        session=None,
        vmid=150,
        resource_info=_info(),
        user_id=None,
        data=ResourceMetadataUpdate(tags=["Web", "web", "db"]),
    )
    svc.update_metadata(
        session=None,
        vmid=150,
        resource_info=_info(),
        user_id=None,
        data=ResourceMetadataUpdate(tags=[]),
    )
    assert fake_proxmox.updates == [{"tags": "web;db"}, {"delete": "tags"}]


def test_metadata_tag_validation() -> None:
    with pytest.raises(ValueError):
        ResourceMetadataUpdate(tags=["bad tag"])
    with pytest.raises(ValueError):
        ResourceMetadataUpdate()
