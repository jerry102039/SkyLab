"""申請表單選用範本時的來源驗證。

母範本同時也是 PVE template，所以任何帶 template_id 的申請都必須在建立當下
確認來源的狀態與權限，不能只靠前端清單過濾。
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest

from app.exceptions import BadRequestError
from app.models import VMTemplate, VMTemplateStatus, VMTemplateVisibility
from app.schemas import VMRequestCreate
from app.services.vm import vm_request_service


def make_user(role: str) -> SimpleNamespace:
    return SimpleNamespace(id=uuid.uuid4(), role=role, is_superuser=False)


def make_template(**overrides: Any) -> VMTemplate:
    defaults: dict[str, Any] = dict(
        id=uuid.uuid4(),
        pve_vmid=9001,
        name="n8n-lab",
        owner_id=uuid.uuid4(),
        node="pve1",
        resource_type="qemu",
        status=VMTemplateStatus.ready,
        visibility=VMTemplateVisibility.private,
    )
    defaults.update(overrides)
    return VMTemplate(**defaults)


@pytest.fixture
def registered(monkeypatch: pytest.MonkeyPatch):
    """讓 repo 查詢回傳指定範本（None = 未註冊的基礎映像）。"""

    def _install(template: VMTemplate | None) -> None:
        monkeypatch.setattr(
            vm_request_service.vm_template_repo,
            "get_template_by_pve_vmid",
            lambda **kwargs: template,
        )

    return _install


def _validate(user: SimpleNamespace, *, resource_type: str = "vm") -> VMTemplate | None:
    return vm_request_service._validate_template_source(
        session=None,  # type: ignore[arg-type]
        template_vmid=9001,
        user=user,
        resource_type=resource_type,
    )


def test_unregistered_pve_template_is_a_plain_base_image(registered) -> None:
    registered(None)

    assert _validate(make_user("student")) is None


def test_unregistered_source_is_rejected_for_lxc(registered) -> None:
    registered(None)

    with pytest.raises(BadRequestError, match="尚未註冊"):
        _validate(make_user("student"), resource_type="lxc")


def test_student_cannot_request_a_private_template(registered) -> None:
    registered(make_template())

    with pytest.raises(BadRequestError, match="未開放給學生使用"):
        _validate(make_user("student"))


def test_student_can_request_a_globally_visible_template(registered) -> None:
    template = make_template(visibility=VMTemplateVisibility.global_)
    registered(template)

    assert _validate(make_user("student")) is template


def test_visible_template_still_has_to_be_ready(registered) -> None:
    registered(
        make_template(
            visibility=VMTemplateVisibility.global_,
            status=VMTemplateStatus.creating,
        )
    )

    with pytest.raises(BadRequestError, match="尚未就緒"):
        _validate(make_user("student"))


def test_template_type_must_match_the_request(registered) -> None:
    registered(
        make_template(visibility=VMTemplateVisibility.global_, resource_type="lxc")
    )

    with pytest.raises(BadRequestError, match="不符"):
        _validate(make_user("student"))


def test_teacher_cannot_use_another_teachers_private_template(
    registered, monkeypatch: pytest.MonkeyPatch
) -> None:
    registered(make_template())
    monkeypatch.setattr(
        vm_request_service.vm_template_repo,
        "is_template_visible_to_user",
        lambda **kwargs: False,
    )

    with pytest.raises(BadRequestError, match="沒有權限使用"):
        _validate(make_user("teacher"))


def test_teacher_uses_visibility_rules_instead(
    registered, monkeypatch: pytest.MonkeyPatch
) -> None:
    template = make_template()
    registered(template)
    monkeypatch.setattr(
        vm_request_service.vm_template_repo,
        "is_template_visible_to_user",
        lambda **kwargs: True,
    )

    assert _validate(make_user("teacher")) is template


def _catalog_request(**overrides: Any) -> VMRequestCreate:
    payload: dict[str, Any] = dict(
        reason="I want to try n8n",
        resource_type="vm",
        hostname="n8n-test",
        cores=8,
        memory=32768,
        disk_size=200,
        password="Secret123",
        username="student",
        template_id=9001,
    )
    payload.update(overrides)
    return VMRequestCreate(**payload)


def test_a_template_request_keeps_the_requested_cpu_and_memory() -> None:
    template = make_template(
        visibility=VMTemplateVisibility.global_,
        default_cores=4,
        default_memory=8192,
        default_disk=40,
    )
    request_in = _catalog_request()

    vm_request_service._apply_template_floor(request_in, template)

    assert (request_in.cores, request_in.memory, request_in.disk_size) == (
        8,
        32768,
        200,
    )


def test_disk_cannot_be_smaller_than_the_template() -> None:
    template = make_template(visibility=VMTemplateVisibility.global_, default_disk=40)
    request_in = _catalog_request(disk_size=20)

    vm_request_service._apply_template_floor(request_in, template)

    assert request_in.disk_size == 40


def test_template_that_requires_gpu_rejects_request_without_gpu() -> None:
    template = make_template(
        visibility=VMTemplateVisibility.global_, requires_gpu=True
    )

    with pytest.raises(BadRequestError, match="需要 GPU"):
        vm_request_service._require_template_gpu(_catalog_request(), template)


def test_template_that_requires_gpu_accepts_request_with_gpu() -> None:
    template = make_template(
        visibility=VMTemplateVisibility.global_, requires_gpu=True
    )
    request_in = _catalog_request(gpu_mapping_id="gpu-a100")

    vm_request_service._require_template_gpu(request_in, template)

    assert request_in.gpu_mapping_id == "gpu-a100"


def test_template_without_gpu_policy_ignores_gpu_field() -> None:
    vm_request_service._require_template_gpu(
        _catalog_request(), make_template(visibility=VMTemplateVisibility.global_)
    )


def test_lxc_rootfs_is_raised_to_the_template_floor() -> None:
    template = make_template(
        visibility=VMTemplateVisibility.global_, resource_type="lxc", default_disk=16
    )
    request_in = _catalog_request(
        resource_type="lxc", disk_size=None, rootfs_size=8, username=None
    )

    vm_request_service._apply_template_floor(request_in, template)

    assert request_in.rootfs_size == 16
