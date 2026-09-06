import threading
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.core.security import encrypt_value
from app.domain.placement.schemas import NodeCapacity, PlacementRequest
from app.exceptions import BadRequestError, ProvisioningError, ProxmoxError
from app.infrastructure.proxmox import operations as proxmox_service
from app.models import (
    ProxmoxConfig,
    ProxmoxNode,
    ProxmoxStorage,
    Resource,
    SpecChangeRequest,
    SpecChangeRequestStatus,
    SpecChangeType,
    SubnetConfig,
    User,
    UserRole,
    VMProvisioningStatus,
    VMRequest,
    VMRequestStatus,
    VMTemplate,
    VMTemplateStatus,
    VMTemplateVisibility,
)
from app.repositories import user as user_repo
from app.schemas import (
    SpecChangeRequestReview,
    UserCreate,
    VMCreateRequest,
    VMRequestCreate,
    VMRequestReview,
)
from app.services.proxmox import gpu_service, provisioning_service
from app.services.scheduling import support as scheduling_support
from app.services.scheduling import vm_request_schedule_service
from app.services.user import user_service
from app.services.vm import (
    spec_change_service,
    vm_request_placement_service,
    vm_request_service,
)


@pytest.fixture()
def db() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def _create_user(
    session: Session,
    *,
    is_superuser: bool = False,
    role: UserRole | None = None,
) -> User:
    user = user_repo.create_user(
        session=session,
        user_create=UserCreate(
            email=f"{'admin' if is_superuser else 'user'}-{datetime.now(timezone.utc).timestamp()}@example.com",
            password="strongpass123",
            role=role or (UserRole.admin if is_superuser else UserRole.student),
            is_superuser=is_superuser,
        ),
    )
    session.commit()
    session.refresh(user)
    return user


def _seed_managed_storage(
    session: Session,
    *,
    node_name: str,
    storage: str,
    speed_tier: str,
    user_priority: int,
    can_vm: bool = True,
    can_lxc: bool = True,
    avail_gb: float = 200.0,
    total_gb: float = 400.0,
) -> None:
    session.add(
        ProxmoxStorage(
            node_name=node_name,
            storage=storage,
            storage_type="dir",
            total_gb=total_gb,
            used_gb=max(total_gb - avail_gb, 0.0),
            avail_gb=avail_gb,
            can_vm=can_vm,
            can_lxc=can_lxc,
            can_iso=False,
            can_backup=False,
            is_shared=False,
            active=True,
            enabled=True,
            speed_tier=speed_tier,
            user_priority=user_priority,
        )
    )


def _seed_subnet_config(session: Session) -> None:
    """Seed the singleton SubnetConfig so provisioning_service.create_vm can
    run its IP-management steps in tests that don't exercise IP allocation."""
    if session.get(SubnetConfig, 1) is not None:
        return
    session.add(
        SubnetConfig(
            id=1,
            cidr="10.0.0.0/24",
            gateway="10.0.0.1",
            bridge_name="vmbr0",
            gateway_vm_ip="10.0.0.2",
        )
    )
    session.commit()


def test_gpu_node_counts_are_loaded_from_proxmox_mappings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw_mappings = [
        {
            "id": "gpu-a",
            "map": [
                "node=pve-a,path=0000:01:00.0",
                "node=pve-a,path=0000:02:00.0",
            ],
        },
        {
            "id": "gpu-b",
            "map": "node=pve-b,path=0000:03:00.0",
        },
    ]

    class FakePciMappings:
        def get(self):
            return raw_mappings

        def __call__(self, mapping_id: str):
            return SimpleNamespace(
                get=lambda: next(item for item in raw_mappings if item["id"] == mapping_id)
            )

    proxmox = SimpleNamespace(
        cluster=SimpleNamespace(mapping=SimpleNamespace(pci=FakePciMappings()))
    )
    monkeypatch.setattr(
        gpu_service, "iter_connection_clients", lambda: [(None, proxmox)]
    )

    assert gpu_service.get_gpu_node_counts() == {"pve-a": 2, "pve-b": 1}
    assert gpu_service.get_gpu_node_counts(mapping_id="gpu-b") == {"pve-b": 1}


def test_vm_request_create_preserves_environment_type(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = _create_user(db)
    now = datetime.now(timezone.utc)
    monkeypatch.setattr(
        "app.services.vm.vm_request_service.vm_request_availability_service.validate_request_window",
        lambda **kwargs: None,
    )
    request_in = VMRequestCreate(
        reason="Need a custom environment for backend testing",
        resource_type="vm",
        hostname="env-check",
        cores=2,
        memory=2048,
        password="strongpass123",
        storage="fast-ssd",
        environment_type="ML Lab",
        template_id=9000,
        disk_size=32,
        username="student",
        start_at=now + timedelta(hours=1),
        end_at=now + timedelta(hours=3),
    )

    result = vm_request_service.create(session=db, request_in=request_in, user=user)

    db.expire_all()
    saved = db.exec(select(VMRequest).where(VMRequest.id == result.id)).first()
    assert saved is not None
    assert result.environment_type == "ML Lab"
    assert saved.environment_type == "ML Lab"
    assert saved.storage == "fast-ssd"


def test_admin_scheduled_request_stays_pending(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    admin = _create_user(db, role=UserRole.admin)
    now = datetime.now(timezone.utc)
    monkeypatch.setattr(
        "app.services.vm.vm_request_service.vm_request_availability_service.validate_request_window",
        lambda **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.vm.vm_request_service._approve_and_place",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("should not auto approve")),
    )

    request_in = VMRequestCreate(
        reason="Need a scheduled VM for a reviewed admin request",
        resource_type="vm",
        hostname="admin-scheduled-review",
        cores=2,
        memory=2048,
        password="strongpass123",
        storage="fast-ssd",
        template_id=9000,
        disk_size=32,
        username="admin",
        mode="scheduled",
        start_at=now + timedelta(hours=1),
        end_at=now + timedelta(hours=3),
    )

    result = vm_request_service.create(session=db, request_in=request_in, user=admin)

    db.expire_all()
    saved = db.exec(select(VMRequest).where(VMRequest.id == result.id)).first()
    assert saved is not None
    assert saved.status == VMRequestStatus.pending
    assert saved.reviewer_id is None
    assert saved.assigned_node is None


def test_admin_immediate_request_is_auto_approved(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    admin = _create_user(db, role=UserRole.admin)
    calls: list[uuid.UUID] = []

    def fake_approve_and_place(*, session: Session, db_request: VMRequest, reviewer_id: uuid.UUID):
        db_request.status = VMRequestStatus.approved
        db_request.reviewer_id = reviewer_id
        db_request.assigned_node = "pve-a"
        db_request.desired_node = "pve-a"
        session.add(db_request)
        session.flush()
        return None

    monkeypatch.setattr(
        "app.services.vm.vm_request_service._approve_and_place",
        fake_approve_and_place,
    )
    monkeypatch.setattr(
        "app.services.vm.vm_request_service.submit_sync",
        lambda _fn, request_id, **_kwargs: calls.append(request_id),
    )

    request_in = VMRequestCreate(
        reason="Need an immediate VM for admin maintenance",
        resource_type="vm",
        hostname="admin-immediate",
        cores=2,
        memory=2048,
        password="strongpass123",
        storage="fast-ssd",
        template_id=9000,
        disk_size=32,
        username="admin",
        mode="immediate",
    )

    result = vm_request_service.create(session=db, request_in=request_in, user=admin)

    db.expire_all()
    saved = db.exec(select(VMRequest).where(VMRequest.id == result.id)).first()
    assert saved is not None
    assert saved.status == VMRequestStatus.approved
    assert saved.reviewer_id == admin.id
    assert saved.start_at is not None
    assert calls == [saved.id]


def test_vm_request_create_rejects_unavailable_window(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = _create_user(db)
    now = datetime.now(timezone.utc)
    request_in = VMRequestCreate(
        reason="Need a custom environment for backend testing",
        resource_type="vm",
        hostname="env-check-blocked",
        cores=2,
        memory=2048,
        password="strongpass123",
        storage="fast-ssd",
        environment_type="ML Lab",
        template_id=9000,
        disk_size=32,
        username="student",
        start_at=now + timedelta(hours=1),
        end_at=now + timedelta(hours=3),
    )

    monkeypatch.setattr(
        "app.services.vm.vm_request_service.vm_request_availability_service.validate_request_window",
        lambda **kwargs: (_ for _ in ()).throw(
            BadRequestError("No node is available for the requested time window.")
        ),
    )

    with pytest.raises(BadRequestError):
        vm_request_service.create(session=db, request_in=request_in, user=user)


def _seed_lxc_template(
    session: Session,
    *,
    pve_vmid: int = 9100,
    status: VMTemplateStatus = VMTemplateStatus.ready,
) -> VMTemplate:
    template = VMTemplate(
        pve_vmid=pve_vmid,
        name=f"lab-template-{pve_vmid}",
        node="pve-a",
        resource_type="lxc",
        status=status,
        visibility=VMTemplateVisibility.global_,
    )
    session.add(template)
    session.commit()
    return template


def test_legacy_quick_template_mode_is_rejected(db: Session) -> None:
    """舊的自助模式會自動核准，已停用；學生只能走快速練習或一般申請。"""
    user = _create_user(db, role=UserRole.student)
    _seed_lxc_template(db, pve_vmid=9100)
    request_in = VMRequestCreate(
        reason="Need a short PostgreSQL lab environment",
        resource_type="lxc",
        hostname="quick-pg",
        cores=2,
        memory=2048,
        password="strongpass123",
        template_id=9100,
        rootfs_size=16,
        mode="quick_template",
    )

    with pytest.raises(BadRequestError, match="已停用"):
        vm_request_service.create(session=db, request_in=request_in, user=user)


def test_legacy_quick_template_mode_is_rejected_without_a_template(
    db: Session,
) -> None:
    """停用後不論帶不帶範本都不接受，錯誤訊息一致。"""
    user = _create_user(db, role=UserRole.student)
    request_in = VMRequestCreate(
        reason="Need a short lab without a template",
        resource_type="lxc",
        hostname="quick-bad",
        cores=2,
        memory=2048,
        password="strongpass123",
        ostemplate="local:vztmpl/ubuntu-24.04.tar.zst",
        rootfs_size=16,
        mode="quick_template",
    )

    with pytest.raises(BadRequestError):
        vm_request_service.create(session=db, request_in=request_in, user=user)


def test_legacy_quick_template_mode_is_rejected_for_unready_templates(
    db: Session,
) -> None:
    user = _create_user(db, role=UserRole.student)
    _seed_lxc_template(db, pve_vmid=9200, status=VMTemplateStatus.creating)
    request_in = VMRequestCreate(
        reason="Need a short lab from an unfinished template",
        resource_type="lxc",
        hostname="quick-bad",
        cores=2,
        memory=2048,
        password="strongpass123",
        template_id=9200,
        rootfs_size=16,
        mode="quick_template",
    )

    with pytest.raises(BadRequestError):
        vm_request_service.create(session=db, request_in=request_in, user=user)


def test_quick_template_approval_does_not_rebuild_existing_reservations(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(timezone.utc)
    reviewer_id = uuid.uuid4()
    existing = VMRequest(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        reason="research reservation should stay assigned",
        request_kind="research",
        resource_type="lxc",
        hostname="research-reservation",
        cores=4,
        memory=8192,
        password="encrypted",
        storage="local-lvm",
        environment_type="Research",
        status=VMRequestStatus.approved,
        start_at=now - timedelta(minutes=10),
        end_at=now + timedelta(hours=4),
        assigned_node="research-node",
        desired_node="research-node",
        created_at=now - timedelta(hours=1),
    )
    quick = VMRequest(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        reason="quick template",
        request_kind="quick_template",
        resource_type="lxc",
        hostname="quick-template",
        cores=1,
        memory=1024,
        password="encrypted",
        storage="local-lvm",
        environment_type="Quick",
        rootfs_size=8,
        status=VMRequestStatus.pending,
        start_at=now,
        end_at=now + timedelta(hours=3),
        created_at=now,
    )
    db.add(existing)
    db.add(quick)
    db.commit()
    db.refresh(existing)
    db.refresh(quick)

    def _fail_rebuild(**kwargs):
        raise AssertionError("quick templates must not rebuild existing reservations")

    def _fake_select_reserved_target_node(*, db_request, reserved_requests, **kwargs):
        assert db_request.id == quick.id
        assert [item.assigned_node for item in reserved_requests] == ["research-node"]
        return SimpleNamespace(
            node="quick-node",
            strategy="priority_dominant_share",
            plan=SimpleNamespace(feasible=True),
        )

    monkeypatch.setattr(
        "app.services.vm.vm_request_service.vm_request_placement_service.rebuild_reserved_assignments",
        _fail_rebuild,
    )
    monkeypatch.setattr(
        "app.services.vm.vm_request_service.vm_request_placement_service.select_reserved_target_node",
        _fake_select_reserved_target_node,
    )

    selection = vm_request_service._approve_and_place(
        session=db,
        db_request=quick,
        reviewer_id=reviewer_id,
    )

    assert selection.node == "quick-node"
    assert quick.status == VMRequestStatus.approved
    assert quick.assigned_node == "quick-node"
    assert existing.assigned_node == "research-node"


def test_vm_request_review_rolls_back_and_cleans_up_on_failure(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = _create_user(db)
    reviewer = _create_user(db, is_superuser=True)
    now = datetime.now(timezone.utc)
    request = VMRequest(
        user_id=user.id,
        reason="Need a VM for rollback coverage",
        resource_type="vm",
        hostname="rollback-vm",
        cores=2,
        memory=2048,
        password=encrypt_value("strongpass123"),
        storage="local-lvm",
        environment_type="Rollback Test",
        template_id=123,
        disk_size=20,
        username="student",
        status=VMRequestStatus.pending,
        start_at=now + timedelta(hours=2),
        end_at=now + timedelta(hours=4),
        created_at=now,
    )
    db.add(request)
    db.commit()
    db.refresh(request)

    monkeypatch.setattr(
        "app.services.vm.vm_request_service.vm_request_placement_service.rebuild_reserved_assignments",
        lambda **kwargs: {
            request.id: SimpleNamespace(
                node="pve-a",
                strategy="priority_dominant_share",
                plan=SimpleNamespace(feasible=True),
            )
        },
    )

    def _raise_audit(*args, **kwargs):
        raise RuntimeError("audit failure")

    monkeypatch.setattr(
        "app.services.vm.vm_request_service.audit_service.log_action",
        _raise_audit,
    )

    with pytest.raises(ProvisioningError):
        vm_request_service.review(
            session=db,
            request_id=request.id,
            review_data=VMRequestReview(status=VMRequestStatus.approved),
            reviewer=reviewer,
        )

    db.expire_all()
    refreshed = db.exec(select(VMRequest).where(VMRequest.id == request.id)).first()
    assert refreshed is not None
    assert refreshed.status == VMRequestStatus.pending
    assert refreshed.vmid is None
    assert refreshed.reviewer_id is None
    assert refreshed.assigned_node is None
    assert refreshed.placement_strategy_used is None


def test_vm_request_review_locks_overlapping_requests(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = _create_user(db)
    reviewer = _create_user(db, is_superuser=True)
    now = datetime.now(timezone.utc)
    request = VMRequest(
        user_id=user.id,
        reason="Need a VM for scheduled class usage",
        resource_type="vm",
        hostname="lock-window-vm",
        cores=2,
        memory=2048,
        password=encrypt_value("strongpass123"),
        storage="local-lvm",
        environment_type="Lock Window Test",
        template_id=123,
        disk_size=20,
        username="student",
        status=VMRequestStatus.pending,
        start_at=now + timedelta(hours=2),
        end_at=now + timedelta(hours=4),
        created_at=now,
    )
    db.add(request)
    db.commit()
    db.refresh(request)

    captured: dict[str, datetime] = {}

    def _lock_window(**kwargs):
        captured["start_at"] = kwargs["window_start"]
        captured["end_at"] = kwargs["window_end"]
        return [request]

    monkeypatch.setattr(
        "app.services.vm.vm_request_service.vm_request_repo.lock_overlapping_vm_requests_for_window",
        _lock_window,
    )
    monkeypatch.setattr(
        "app.services.vm.vm_request_service.audit_service.log_action",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.vm.vm_request_service.vm_request_placement_service.rebuild_reserved_assignments",
        lambda **kwargs: {
            request.id: SimpleNamespace(
                node="pve-a",
                strategy="priority_dominant_share",
                plan=SimpleNamespace(feasible=True),
            )
        },
    )

    vm_request_service.review(
        session=db,
        request_id=request.id,
        review_data=VMRequestReview(status=VMRequestStatus.approved),
        reviewer=reviewer,
    )

    assert captured["start_at"] == request.start_at.replace(tzinfo=timezone.utc)
    assert captured["end_at"] == request.end_at.replace(tzinfo=timezone.utc)


def test_vm_request_review_assigns_reserved_node(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = _create_user(db)
    reviewer = _create_user(db, is_superuser=True)
    now = datetime.now(timezone.utc)
    request = VMRequest(
        user_id=user.id,
        reason="Need a VM for scheduled class usage",
        resource_type="vm",
        hostname="reserved-node-vm",
        cores=2,
        memory=2048,
        password=encrypt_value("strongpass123"),
        storage="local-lvm",
        environment_type="Reserved Node Test",
        template_id=123,
        disk_size=20,
        username="student",
        status=VMRequestStatus.pending,
        start_at=now + timedelta(hours=2),
        end_at=now + timedelta(hours=4),
        created_at=now,
    )
    db.add(request)
    db.commit()
    db.refresh(request)

    monkeypatch.setattr(
        "app.services.vm.vm_request_service.audit_service.log_action",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.vm.vm_request_service.vm_request_placement_service.rebuild_reserved_assignments",
        lambda **kwargs: {
            request.id: SimpleNamespace(
                node="pve-a",
                strategy="priority_dominant_share",
                plan=SimpleNamespace(feasible=True),
            )
        },
    )

    result = vm_request_service.review(
        session=db,
        request_id=request.id,
        review_data=VMRequestReview(status=VMRequestStatus.approved),
        reviewer=reviewer,
    )

    db.expire_all()
    refreshed = db.exec(select(VMRequest).where(VMRequest.id == request.id)).first()
    assert refreshed is not None
    assert result.status == VMRequestStatus.approved
    assert result.assigned_node == "pve-a"
    assert result.placement_strategy_used == "priority_dominant_share"
    assert refreshed.status == VMRequestStatus.approved
    assert refreshed.assigned_node == "pve-a"
    assert refreshed.placement_strategy_used == "priority_dominant_share"


def test_vm_request_review_context_includes_runtime_and_projection(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = _create_user(db)
    reviewer = _create_user(db, is_superuser=True)
    now = datetime.now(timezone.utc)
    approved = VMRequest(
        user_id=user.id,
        reason="Approved overlap request",
        resource_type="vm",
        hostname="approved-overlap",
        cores=2,
        memory=2048,
        password=encrypt_value("strongpass123"),
        storage="local-lvm",
        environment_type="Review Context",
        template_id=200,
        disk_size=20,
        username="student",
        status=VMRequestStatus.approved,
        start_at=now + timedelta(hours=1),
        end_at=now + timedelta(hours=3),
        vmid=801,
        assigned_node="pve-a",
        desired_node="pve-a",
        actual_node="pve-a",
        created_at=now - timedelta(minutes=5),
    )
    pending = VMRequest(
        user_id=user.id,
        reason="Pending request for review context",
        resource_type="vm",
        hostname="pending-review",
        cores=2,
        memory=2048,
        password=encrypt_value("strongpass123"),
        storage="local-lvm",
        environment_type="Review Context",
        template_id=201,
        disk_size=20,
        username="student",
        status=VMRequestStatus.pending,
        start_at=now + timedelta(hours=1),
        end_at=now + timedelta(hours=3),
        created_at=now,
    )
    db.add(approved)
    db.add(pending)
    db.commit()
    db.refresh(approved)
    db.refresh(pending)

    monkeypatch.setattr(
        "app.services.vm.vm_request_service.proxmox_service.list_nodes",
        lambda: [
            {"node": "pve-a"},
            {"node": "pve-b"},
            {"node": "pve-c"},
            {"node": "pve-d"},
        ],
    )
    monkeypatch.setattr(
        "app.services.vm.vm_request_service.proxmox_service.list_all_resources",
        lambda: [
            {
                "vmid": 801,
                "name": "approved-overlap",
                "node": "pve-a",
                "type": "qemu",
                "status": "running",
                "pool": "SkyLab",
            }
        ],
    )
    monkeypatch.setattr(
        "app.services.vm.vm_request_service.vm_request_repo.list_active_approved_vm_requests",
        lambda **kwargs: [],
    )
    monkeypatch.setattr(
        "app.services.vm.vm_request_service.vm_request_placement_service.rebuild_reserved_assignments",
        lambda **kwargs: {
            approved.id: SimpleNamespace(
                node="pve-a",
                strategy="priority_dominant_share",
                plan=SimpleNamespace(feasible=True, summary="approved summary", warnings=[]),
            ),
            pending.id: SimpleNamespace(
                node="pve-b",
                strategy="priority_dominant_share",
                plan=SimpleNamespace(
                    feasible=True,
                    summary="pending summary",
                    rationale=["因為可降低 pve-a 的整體負載尖峰風險。"],
                    warnings=["rebalance warning"],
                ),
            ),
        },
    )

    context = vm_request_service.get_review_context(
        session=db,
        request_id=pending.id,
        current_user=reviewer,
    )

    assert context.projected_node == "pve-b"
    assert context.placement_strategy == "priority_dominant_share"
    assert context.summary == "pending summary"
    assert context.reasons == ["因為可降低 pve-a 的整體負載尖峰風險。"]
    assert context.warnings == ["rebalance warning"]
    assert context.cluster_nodes == ["pve-a", "pve-b", "pve-c", "pve-d"]
    assert len(context.current_running_resources) == 1
    assert context.current_running_resources[0].vmid == 801
    assert context.current_running_resources[0].linked_request_id is None
    assert context.overlapping_approved_requests[0].is_current_request is True
    assert context.overlapping_approved_requests[0].projected_node == "pve-b"
    assert context.overlapping_approved_requests[1].hostname == "approved-overlap"
    assert {item.node for item in context.projected_nodes} == {"pve-a", "pve-b"}


def test_rebuild_reserved_assignments_uses_updated_prior_reservations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(timezone.utc)
    request_a = VMRequest(
        id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
        user_id=uuid.UUID("00000000-0000-0000-0000-000000000011"),
        reason="A",
        resource_type="lxc",
        hostname="req-a",
        cores=2,
        memory=2048,
        password="encrypted",
        storage="local-lvm",
        environment_type="Test",
        status=VMRequestStatus.approved,
        start_at=now + timedelta(hours=1),
        end_at=now + timedelta(hours=2),
        created_at=now,
        assigned_node="old-a",
    )
    request_b = VMRequest(
        id=uuid.UUID("00000000-0000-0000-0000-000000000002"),
        user_id=uuid.UUID("00000000-0000-0000-0000-000000000012"),
        reason="B",
        resource_type="lxc",
        hostname="req-b",
        cores=2,
        memory=2048,
        password="encrypted",
        storage="local-lvm",
        environment_type="Test",
        status=VMRequestStatus.approved,
        start_at=now + timedelta(hours=1),
        end_at=now + timedelta(hours=2),
        created_at=now + timedelta(minutes=1),
        assigned_node="old-b",
    )

    seen_reserved_nodes: list[list[str]] = []

    def _fake_select_reserved_target_node(*, db_request, reserved_requests, **kwargs):
        seen_reserved_nodes.append(
            [str(item.assigned_node) for item in reserved_requests]
        )
        node = "new-a" if db_request.hostname == "req-a" else "new-b"
        return SimpleNamespace(
            node=node,
            strategy="priority_dominant_share",
            plan=SimpleNamespace(feasible=True),
        )

    monkeypatch.setattr(
        "app.services.vm.placement_service.select_reserved_target_node",
        _fake_select_reserved_target_node,
    )

    selections = vm_request_placement_service.rebuild_reserved_assignments(
        session=None,
        requests=[request_b, request_a],
    )

    assert seen_reserved_nodes == [[], ["new-a"]]
    assert selections[request_a.id].node == "new-a"
    assert selections[request_b.id].node == "new-b"


def test_select_request_placement_falls_back_when_reserved_node_is_unavailable(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = SimpleNamespace(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        resource_type="lxc",
        password=encrypt_value("strongpass123"),
        start_at=datetime.now(timezone.utc) - timedelta(minutes=5),
        end_at=datetime.now(timezone.utc) + timedelta(hours=1),
        cores=2,
        memory=2048,
        storage="local-lvm",
        hostname="fallback-lxc",
        ostemplate="local:vztmpl/debian-12-standard.tar.zst",
        rootfs_size=8,
        environment_type="Fallback Runtime",
        os_info=None,
        expiry_date=None,
        unprivileged=True,
        assigned_node="pve-a",
        placement_strategy_used="priority_dominant_share",
    )
    placement_request = SimpleNamespace()

    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.placement_support"
        ".allowed_template_nodes_for_request",
        lambda request: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.placement_advisor._load_cluster_state",
        lambda: ([], []),
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.placement_advisor._build_node_capacities",
        lambda **kwargs: [SimpleNamespace(node="pve-a")],
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.placement_advisor._decide_resource_type",
        lambda request: ("lxc", "Prefer LXC for this request."),
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.vm_request_placement_service.build_plan",
        lambda **kwargs: SimpleNamespace(feasible=False),
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.vm_request_repo.get_approved_vm_requests_overlapping_window",
        lambda **kwargs: [],
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.vm_request_placement_service.select_reserved_target_node",
        lambda **kwargs: SimpleNamespace(
            node="pve-b",
            strategy="priority_dominant_share",
            plan=SimpleNamespace(feasible=True),
        ),
    )

    placement = provisioning_service._select_request_placement(
        session=db,
        db_request=request,
        placement_request=placement_request,
        placement_strategy="priority_dominant_share",
    )

    assert placement.node == "pve-b"
    assert placement.strategy == "priority_dominant_share"
    assert placement.plan.feasible is True


def test_reserved_target_node_prefers_admin_storage_profile(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = _create_user(db)
    now = datetime.now(timezone.utc)
    db.add(
        ProxmoxNode(
            name="pve-a",
            host="10.0.0.1",
            port=8006,
            is_primary=True,
            is_online=True,
            priority=5,
        )
    )
    db.add(
        ProxmoxNode(
            name="pve-b",
            host="10.0.0.2",
            port=8006,
            is_primary=False,
            is_online=True,
            priority=5,
        )
    )
    db.add(
        ProxmoxConfig(
            id=1,
            host="pve.local",
            user="root@pam",
            encrypted_password="encrypted",
            verify_ssl=False,
            iso_storage="local",
            data_storage="local-lvm",
            pool_name="SkyLab",
            placement_strategy="priority_dominant_share",
            cpu_overcommit_ratio=2.0,
            disk_overcommit_ratio=1.0,
        )
    )
    _seed_managed_storage(
        db,
        node_name="pve-a",
        storage="data-hdd",
        speed_tier="hdd",
        user_priority=8,
    )
    _seed_managed_storage(
        db,
        node_name="pve-b",
        storage="data-nvme",
        speed_tier="nvme",
        user_priority=1,
    )
    db.commit()

    request = VMRequest(
        user_id=user.id,
        reason="Need a VM with managed storage placement.",
        resource_type="vm",
        hostname="storage-aware",
        cores=2,
        memory=2048,
        password=encrypt_value("strongpass123"),
        storage="local-lvm",
        environment_type="Storage Aware",
        template_id=100,
        disk_size=40,
        username="student",
        status=VMRequestStatus.approved,
        start_at=now + timedelta(hours=1),
        end_at=now + timedelta(hours=2),
        created_at=now,
    )

    monkeypatch.setattr(
        "app.services.vm.placement_service.placement_advisor._load_cluster_state",
        lambda: ([], []),
    )
    monkeypatch.setattr(
        "app.services.vm.placement_service.placement_advisor._build_node_capacities",
        lambda **kwargs: [
            NodeCapacity(
                node="pve-a",
                status="online",
                total_cpu_cores=16,
                allocatable_cpu_cores=16,
                cpu_ratio=0.0,
                total_memory_bytes=64 * 1024**3,
                allocatable_memory_bytes=64 * 1024**3,
                memory_ratio=0.0,
                total_disk_bytes=400 * 1024**3,
                allocatable_disk_bytes=400 * 1024**3,
                disk_ratio=0.0,
                gpu_count=0,
                running_resources=0,
                guest_soft_limit=32,
                guest_pressure_ratio=0.0,
                candidate=True,
            ),
            NodeCapacity(
                node="pve-b",
                status="online",
                total_cpu_cores=16,
                allocatable_cpu_cores=16,
                cpu_ratio=0.0,
                total_memory_bytes=64 * 1024**3,
                allocatable_memory_bytes=64 * 1024**3,
                memory_ratio=0.0,
                total_disk_bytes=400 * 1024**3,
                allocatable_disk_bytes=400 * 1024**3,
                disk_ratio=0.0,
                gpu_count=0,
                running_resources=0,
                guest_soft_limit=32,
                guest_pressure_ratio=0.0,
                candidate=True,
            ),
        ],
    )
    # 此測試只驗證管理員儲存設定的選點優先序；模板節點可見性另有專屬測試。
    monkeypatch.setattr(
        "app.services.vm.placement_service.placement_support"
        ".allowed_template_nodes_for_request",
        lambda request: None,
    )

    selection = vm_request_placement_service.select_reserved_target_node(
        session=db,
        db_request=request,
        reserved_requests=[],
    )

    assert selection.node == "pve-b"
    assert selection.plan.feasible is True


def test_reserved_target_node_uses_managed_storage_instead_of_node_root_disk(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = datetime.now(timezone.utc)
    db.add(
        ProxmoxConfig(
            id=1,
            host="pve.local",
            user="root@pam",
            encrypted_password="encrypted",
            verify_ssl=False,
            iso_storage="local",
            data_storage="local-lvm",
            pool_name="SkyLab",
            placement_strategy="priority_dominant_share",
        )
    )
    _seed_managed_storage(
        db,
        node_name="pve-a",
        storage="local-lvm",
        speed_tier="ssd",
        user_priority=1,
        avail_gb=200,
        total_gb=400,
    )
    db.commit()

    monkeypatch.setattr(
        "app.services.vm.placement_service.placement_advisor._load_cluster_state",
        lambda: ([], []),
    )
    monkeypatch.setattr(
        "app.services.vm.placement_service.placement_advisor._build_node_capacities",
        lambda **kwargs: [
            NodeCapacity(
                node="pve-a",
                status="online",
                total_cpu_cores=16,
                allocatable_cpu_cores=16,
                total_memory_bytes=64 * 1024**3,
                allocatable_memory_bytes=64 * 1024**3,
                total_disk_bytes=10 * 1024**3,
                allocatable_disk_bytes=1 * 1024**3,
                gpu_count=0,
                running_resources=0,
                guest_soft_limit=32,
                candidate=False,
            )
        ],
    )

    selection = vm_request_placement_service.select_reserved_target_node_for_request(
        session=db,
        request=PlacementRequest(
            resource_type="vm",
            cpu_cores=2,
            memory_mb=2048,
            disk_gb=40,
            instance_count=1,
        ),
        start_at=now + timedelta(hours=1),
        end_at=now + timedelta(hours=2),
        reserved_requests=[],
        allow_cohort_optimization=False,
    )

    assert selection.node == "pve-a"
    assert selection.plan.feasible is True


def test_placement_request_with_gpu_mapping_uses_mapping_nodes(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "app.services.vm.placement_support.gpu_service.get_gpu_node_counts",
        lambda mapping_id=None: {"pve-b": 1} if mapping_id == "gpu-b" else {"pve-a": 1, "pve-b": 1},
    )

    plan = vm_request_placement_service.build_plan(
        session=db,
        request=PlacementRequest(
            resource_type="vm",
            cpu_cores=2,
            memory_mb=2048,
            disk_gb=40,
            instance_count=1,
            gpu_required=1,
            gpu_mapping_id="gpu-b",
        ),
        node_capacities=[
            NodeCapacity(
                node="pve-a",
                status="online",
                total_cpu_cores=32,
                allocatable_cpu_cores=32,
                total_memory_bytes=128 * 1024**3,
                allocatable_memory_bytes=128 * 1024**3,
                total_disk_bytes=1000 * 1024**3,
                allocatable_disk_bytes=1000 * 1024**3,
                gpu_count=1,
                running_resources=0,
                guest_soft_limit=64,
                candidate=True,
            ),
            NodeCapacity(
                node="pve-b",
                status="online",
                total_cpu_cores=8,
                allocatable_cpu_cores=8,
                total_memory_bytes=32 * 1024**3,
                allocatable_memory_bytes=32 * 1024**3,
                total_disk_bytes=500 * 1024**3,
                allocatable_disk_bytes=500 * 1024**3,
                gpu_count=1,
                running_resources=0,
                guest_soft_limit=16,
                candidate=True,
            ),
        ],
        effective_resource_type="vm",
        resource_type_reason="VM request uses VM placement.",
        placement_strategy="priority_dominant_share",
    )

    assert plan.feasible is True
    assert plan.recommended_node == "pve-b"


def test_create_vm_prefers_admin_selected_storage(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = _create_user(db)
    _seed_subnet_config(db)
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.next_vmid",
        lambda: 902,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.find_vm_template",
        lambda template_id: {"vmid": template_id, "node": "node-d"},
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.vm_request_placement_service.select_best_storage_name",
        lambda **kwargs: "data-nvme",
    )

    def _resolve_target_storage(node, requested_storage, required_content):
        captured["resolved"] = (node, requested_storage, required_content)
        return requested_storage

    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.resolve_target_storage",
        _resolve_target_storage,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.clone_vm",
        lambda node, template_id, **clone_config: (
            captured.setdefault("clone", (node, template_id, clone_config)),
            "UPID:clone",
        )[1],
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.update_config",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.resize_disk",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.control",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.firewall_service.setup_default_rules",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.audit_service.log_action",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.get_proxmox_settings_for_node",
        lambda _node: SimpleNamespace(pool_name="SkyLab"),
    )

    provisioning_service.create_vm(
        session=db,
        user_id=user.id,
        vm_data=VMCreateRequest(
            hostname="admin-storage-choice",
            template_id=779,
            username="student",
            password="strongpass123",
            cores=2,
            memory=2048,
            disk_size=20,
            storage="user-picked-storage",
            environment_type="Managed Storage",
            start=True,
        ),
    )

    assert captured["resolved"] == ("node-d", "data-nvme", "images")
    assert captured["clone"] == (
        "node-d",
        779,
        {
            "newid": 902,
            "name": "admin-storage-choice",
            "full": 1,
            "storage": "data-nvme",
            "pool": "SkyLab",
        },
    )


















def test_build_plan_avoids_high_loadavg_and_peak_risk_node(
    db: Session,
) -> None:
    db.add(
        ProxmoxConfig(
            id=1,
            host="pve.local",
            user="root@pam",
            encrypted_password="encrypted",
            verify_ssl=False,
            iso_storage="local",
            data_storage="local-lvm",
            pool_name="SkyLab",
            placement_strategy="priority_dominant_share",
            placement_peak_cpu_margin=2.0,
            placement_peak_memory_margin=1.05,
            placement_loadavg_warn_per_core=0.5,
            placement_loadavg_max_per_core=1.0,
            placement_loadavg_penalty_weight=1.5,
        )
    )
    db.commit()

    plan = vm_request_placement_service.build_plan(
        session=db,
        request=PlacementRequest(
            resource_type="vm",
            cpu_cores=1,
            memory_mb=1024,
            disk_gb=10,
            instance_count=1,
        ),
        node_capacities=[
                NodeCapacity(
                    node="pve-a",
                    status="online",
                    candidate=True,
                    guest_soft_limit=100,
                    total_cpu_cores=10,
                    allocatable_cpu_cores=4.2,
                    total_memory_bytes=100 * 1024**3,
                allocatable_memory_bytes=90 * 1024**3,
                total_disk_bytes=500 * 1024**3,
                allocatable_disk_bytes=450 * 1024**3,
                current_loadavg_1=9.0,
            ),
                NodeCapacity(
                    node="pve-b",
                    status="online",
                    candidate=True,
                    guest_soft_limit=100,
                    total_cpu_cores=10,
                    allocatable_cpu_cores=10.0,
                    total_memory_bytes=100 * 1024**3,
                allocatable_memory_bytes=31 * 1024**3,
                total_disk_bytes=500 * 1024**3,
                allocatable_disk_bytes=450 * 1024**3,
                current_loadavg_1=1.0,
            ),
        ],
        effective_resource_type="vm",
        resource_type_reason="vm",
    )

    assert plan.recommended_node == "pve-b"


def test_build_plan_prefers_balance_before_node_priority(
    db: Session,
) -> None:
    db.add(
        ProxmoxConfig(
            id=1,
            host="pve.local",
            user="root@pam",
            encrypted_password="encrypted",
            verify_ssl=False,
            iso_storage="local",
            data_storage="local-lvm",
            pool_name="SkyLab",
            placement_strategy="priority_dominant_share",
        )
    )
    db.commit()

    plan = vm_request_placement_service.build_plan(
        session=db,
        request=PlacementRequest(
            resource_type="vm",
            cpu_cores=1,
            memory_mb=1024,
            disk_gb=10,
            instance_count=1,
        ),
        node_capacities=[
            NodeCapacity(
                node="pve-a",
                status="online",
                candidate=True,
                guest_soft_limit=100,
                total_cpu_cores=10,
                allocatable_cpu_cores=3,
                total_memory_bytes=64 * 1024**3,
                allocatable_memory_bytes=56 * 1024**3,
                total_disk_bytes=500 * 1024**3,
                allocatable_disk_bytes=480 * 1024**3,
            ),
            NodeCapacity(
                node="pve-b",
                status="online",
                candidate=True,
                guest_soft_limit=100,
                total_cpu_cores=10,
                allocatable_cpu_cores=10,
                total_memory_bytes=64 * 1024**3,
                allocatable_memory_bytes=64 * 1024**3,
                total_disk_bytes=500 * 1024**3,
                allocatable_disk_bytes=500 * 1024**3,
            ),
        ],
        effective_resource_type="vm",
        resource_type_reason="vm",
        node_priorities={"pve-a": 1, "pve-b": 5},
    )

    assert plan.recommended_node == "pve-b"


















def test_spec_change_review_stays_pending_when_apply_fails(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = _create_user(db)
    reviewer = _create_user(db, is_superuser=True)
    request = SpecChangeRequest(
        vmid=456,
        user_id=user.id,
        change_type=SpecChangeType.cpu,
        reason="Need more CPU for workload spikes",
        current_cpu=2,
        requested_cpu=4,
        status=SpecChangeRequestStatus.pending,
        created_at=datetime.now(timezone.utc),
    )
    db.add(request)
    db.commit()
    db.refresh(request)

    monkeypatch.setattr(
        "app.services.vm.spec_change_service.proxmox_service.find_resource",
        lambda vmid: {"node": "node-a", "type": "qemu"},
    )
    monkeypatch.setattr(
        "app.services.vm.spec_change_service.proxmox_service.update_config",
        lambda *args, **kwargs: (_ for _ in ()).throw(ProxmoxError("apply failed")),
    )

    with pytest.raises(ProxmoxError):
        spec_change_service.review(
            session=db,
            request_id=request.id,
            review_data=SpecChangeRequestReview(
                status=SpecChangeRequestStatus.approved
            ),
            reviewer=reviewer,
        )

    db.expire_all()
    refreshed = db.exec(
        select(SpecChangeRequest).where(SpecChangeRequest.id == request.id)
    ).first()
    assert refreshed is not None
    assert refreshed.status == SpecChangeRequestStatus.pending
    assert refreshed.applied_at is None
    assert refreshed.reviewer_id is None


def test_create_vm_uses_template_node_and_normalizes_disk_size(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = _create_user(db)
    _seed_subnet_config(db)
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.next_vmid",
        lambda: 900,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.find_vm_template",
        lambda template_id: {"vmid": template_id, "node": "node-b"},
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.resolve_target_storage",
        lambda node, requested_storage, required_content: requested_storage,
    )

    def _clone_vm(node, template_id, **clone_config):
        captured["clone"] = (node, template_id, clone_config)
        return "UPID:clone"

    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.clone_vm",
        _clone_vm,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.update_config",
        lambda node, vmid, resource_type, **config: captured.setdefault(
            "update", (node, vmid, resource_type, config)
        ),
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.resize_disk",
        lambda node, vmid, resource_type, disk, size: captured.setdefault(
            "resize", (node, vmid, resource_type, disk, size)
        ),
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.control",
        lambda node, vmid, resource_type, action: captured.setdefault(
            "control", (node, vmid, resource_type, action)
        ),
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.firewall_service.setup_default_rules",
        lambda node, vmid, resource_type: captured.setdefault(
            "firewall", (node, vmid, resource_type)
        ),
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.audit_service.log_action",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.get_proxmox_settings_for_node",
        lambda _node: SimpleNamespace(pool_name="SkyLab"),
    )

    result = provisioning_service.create_vm(
        session=db,
        user_id=user.id,
        vm_data=VMCreateRequest(
            hostname="template-node-check",
            template_id=777,
            username="student",
            password="strongpass123",
            cores=4,
            memory=4096,
            disk_size=40,
            storage="fast-ssd",
            environment_type="Node Aware",
            start=True,
        ),
    )

    db.expire_all()
    saved = db.exec(select(Resource).where(Resource.vmid == 900)).first()
    assert saved is not None
    assert captured["clone"] == (
        "node-b",
        777,
        {
            "newid": 900,
            "name": "template-node-check",
            "full": 1,
            "storage": "fast-ssd",
            "pool": "SkyLab",
        },
    )
    assert captured["resize"] == ("node-b", 900, "qemu", "scsi0", "40G")
    assert captured["control"] == ("node-b", 900, "qemu", "start")
    assert saved.environment_type == "Node Aware"
    assert result.vmid == 900


def test_create_vm_falls_back_when_requested_storage_is_unavailable(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    user = _create_user(db)
    _seed_subnet_config(db)
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.next_vmid",
        lambda: 901,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.find_vm_template",
        lambda template_id: {"vmid": template_id, "node": "node-c"},
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.resolve_target_storage",
        lambda node, requested_storage, required_content: "fast-ssd",
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.clone_vm",
        lambda node, template_id, **clone_config: (
            captured.setdefault("clone", (node, template_id, clone_config)),
            "UPID:clone",
        )[1],
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.update_config",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.resize_disk",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.proxmox_service.control",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.firewall_service.setup_default_rules",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.audit_service.log_action",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "app.services.proxmox.provisioning_service.get_proxmox_settings_for_node",
        lambda _node: SimpleNamespace(pool_name="SkyLab"),
    )

    provisioning_service.create_vm(
        session=db,
        user_id=user.id,
        vm_data=VMCreateRequest(
            hostname="storage-fallback",
            template_id=778,
            username="student",
            password="strongpass123",
            cores=2,
            memory=2048,
            disk_size=20,
            storage="local-lvm",
            environment_type="Fallback Test",
            start=True,
        ),
    )

    assert captured["clone"] == (
        "node-c",
        778,
        {
            "newid": 901,
            "name": "storage-fallback",
            "full": 1,
            "storage": "fast-ssd",
            "pool": "SkyLab",
        },
    )


def test_user_role_teacher_is_treated_as_regular_user(db: Session) -> None:
    teacher = _create_user(db, role=UserRole.teacher)

    assert teacher.role == UserRole.teacher
    assert teacher.is_superuser is False
    assert teacher.is_instructor is False


def test_delete_user_rejects_owned_resources(db: Session) -> None:
    owner = _create_user(db)
    admin = _create_user(db, is_superuser=True)
    db.add(
        Resource(
            vmid=999,
            user_id=owner.id,
            environment_type="Owned VM",
            created_at=datetime.now(timezone.utc),
        )
    )
    db.commit()

    with pytest.raises(BadRequestError):
        user_service.delete_user(session=db, user_id=owner.id, current_user=admin)

    assert db.get(User, owner.id) is not None






def test_vm_templates_are_filtered_by_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """每個連線各自比對自己的 pool 名稱，不是共用一個。"""
    monkeypatch.setattr(
        "app.infrastructure.proxmox.operations.get_proxmox_settings",
        lambda key=None: SimpleNamespace(
            pool_name={1: "SkyLab", 2: "LabB"}.get(key, "SkyLab")
        ),
    )
    monkeypatch.setattr(
        "app.infrastructure.proxmox.operations._raw_vms_by_connection",
        lambda: [
            (
                1,
                [
                    {"vmid": 100, "name": "allowed", "node": "node-a", "template": 1, "pool": "SkyLab"},
                    {"vmid": 101, "name": "blocked", "node": "node-b", "template": 1, "pool": "OtherPool"},
                    {"vmid": 102, "name": "not-template", "node": "node-c", "template": 0, "pool": "SkyLab"},
                ],
            ),
            (
                2,
                [
                    {"vmid": 200, "name": "allowed-b", "node": "node-d", "template": 1, "pool": "LabB"},
                    {"vmid": 201, "name": "blocked-b", "node": "node-e", "template": 1, "pool": "SkyLab"},
                ],
            ),
        ],
    )

    templates = proxmox_service.get_vm_templates()

    assert templates == [
        {"vmid": 100, "name": "allowed", "node": "node-a", "template": 1, "pool": "SkyLab"},
        {"vmid": 200, "name": "allowed-b", "node": "node-d", "template": 1, "pool": "LabB"},
    ]








def test_storage_selection_penalizes_high_contention_even_with_better_priority() -> None:
    tuning = vm_request_placement_service._PlacementTuning(
        reassignment_cost=0.15,
        peak_cpu_margin=1.1,
        peak_memory_margin=1.05,
        loadavg_warn_per_core=0.8,
        loadavg_max_per_core=1.5,
        loadavg_penalty_weight=0.9,
        disk_contention_warn_share=0.7,
        disk_contention_high_share=0.9,
        disk_penalty_weight=0.75,
    )

    chosen = vm_request_placement_service._select_best_storage_for_request(
        storage_pools=[
            vm_request_placement_service._WorkingStoragePool(
                storage="priority-fast-but-hot",
                total_gb=100.0,
                avail_gb=25.0,
                active=True,
                enabled=True,
                can_vm=True,
                can_lxc=True,
                is_shared=False,
                speed_tier="nvme",
                user_priority=1,
            ),
            vm_request_placement_service._WorkingStoragePool(
                storage="slightly-lower-priority-but-cooler",
                total_gb=500.0,
                avail_gb=300.0,
                active=True,
                enabled=True,
                can_vm=True,
                can_lxc=True,
                is_shared=False,
                speed_tier="nvme",
                user_priority=5,
            ),
        ],
        resource_type="vm",
        disk_gb=20,
        disk_overcommit_ratio=1.0,
        tuning=tuning,
    )

    assert chosen is not None
    assert chosen.pool.storage == "slightly-lower-priority-but-cooler"
