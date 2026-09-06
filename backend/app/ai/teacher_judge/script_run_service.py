"""Teacher Judge managed script run service."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session, col, select

from app.ai.teacher_judge.schemas import TeacherJudgeScriptRunPublic
from app.ai.teacher_judge.script_artifact_service import get_artifact
from app.ai.teacher_judge.target_ip_resolver import resolve_target_ip_address
from app.core.i18n import t
from app.infrastructure.proxmox import operations as proxmox_ops
from app.models.teacher_judge_script_artifact import TeacherJudgeScriptStatus
from app.models.teacher_judge_script_run import (
    TeacherJudgeScriptRun,
    TeacherJudgeScriptRunStatus,
    TeacherJudgeScriptRunTargetScope,
)
from app.models.teaching_class import (
    TeachingClassStudent,
    TeachingClassStudentMachine,
)
from app.models.user import User
from app.repositories import resource as resource_repo

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _run_to_public(run: TeacherJudgeScriptRun) -> TeacherJudgeScriptRunPublic:
    return TeacherJudgeScriptRunPublic(
        id=str(run.id),
        teaching_class_id=str(run.teaching_class_id),
        artifact_id=str(run.artifact_id),
        target_scope=run.target_scope.value,
        target_snapshot_json=run.target_snapshot_json,
        status=run.status.value,
        progress_json=run.progress_json,
        result_summary_json=run.result_summary_json,
        target_results_json=run.target_results_json,
        started_by=str(run.started_by) if run.started_by else None,
        started_at=run.started_at.isoformat() if run.started_at else None,
        finished_at=run.finished_at.isoformat() if run.finished_at else None,
        created_at=run.created_at.isoformat(),
        updated_at=run.updated_at.isoformat(),
    )


def get_script_run_public(
    *,
    session: Session,
    teaching_class_id: uuid.UUID,
    artifact_id: uuid.UUID,
    run_id: uuid.UUID,
) -> TeacherJudgeScriptRunPublic:
    run = session.get(TeacherJudgeScriptRun, run_id)
    if (
        run is None
        or run.teaching_class_id != teaching_class_id
        or run.artifact_id != artifact_id
    ):
        raise HTTPException(status_code=404, detail="Script run not found")
    return _run_to_public(run)


def _class_member_by_vmid(
    *,
    session: Session,
    teaching_class_id: uuid.UUID,
) -> dict[int, dict[str, Any]]:
    enrollments = list(
        session.exec(
            select(TeachingClassStudent).where(
                TeachingClassStudent.class_id == teaching_class_id
            )
        ).all()
    )
    if not enrollments:
        return {}

    enrollments_by_id = {row.id: row for row in enrollments}
    users = list(
        session.exec(
            select(User).where(col(User.id).in_([row.user_id for row in enrollments]))
        ).all()
    )
    users_by_id = {user.id: user for user in users}
    machines = list(
        session.exec(
            select(TeachingClassStudentMachine).where(
                col(TeachingClassStudentMachine.class_student_id).in_(
                    list(enrollments_by_id)
                ),
                TeachingClassStudentMachine.vmid.is_not(None),
            )
        ).all()
    )

    result: dict[int, dict[str, Any]] = {}
    for machine in machines:
        enrollment = enrollments_by_id.get(machine.class_student_id)
        if enrollment is None or machine.vmid is None:
            continue
        user = users_by_id.get(enrollment.user_id)
        if user is None:
            continue
        result[int(machine.vmid)] = {
            "user_id": str(user.id),
            "email": user.email,
            "full_name": user.full_name,
        }
    return result


def _running_resources_by_vmid() -> dict[int, dict[str, Any]]:
    try:
        resources = proxmox_ops.list_all_resources()
    except Exception as exc:
        logger.warning("Teacher Judge run target status lookup failed", exc_info=True)
        raise HTTPException(
            status_code=503,
            detail=t("run.status_lookup_failed"),
        ) from exc

    result: dict[int, dict[str, Any]] = {}
    for resource in resources:
        try:
            raw_vmid = resource.get("vmid")
            if raw_vmid is None:
                continue
            vmid = int(raw_vmid)
        except (TypeError, ValueError):
            continue
        result[vmid] = dict(resource)
    return result


def _resolve_running_targets(
    *,
    session: Session,
    teaching_class_id: uuid.UUID,
    target_vmids: list[int],
) -> list[dict[str, Any]]:
    member_by_vmid = _class_member_by_vmid(
        session=session,
        teaching_class_id=teaching_class_id,
    )
    live_by_vmid = _running_resources_by_vmid()

    targets: list[dict[str, Any]] = []
    for vmid in target_vmids:
        member = member_by_vmid.get(vmid)
        if member is None:
            raise HTTPException(
                status_code=400,
                detail=t("run.vmid_not_in_class", vmid=vmid),
            )

        live = live_by_vmid.get(vmid)
        live_type = str(live.get("type") or "") if live else ""
        live_status = str(live.get("status") or "") if live else ""
        if live is None or live_type not in {"qemu", "lxc"}:
            raise HTTPException(
                status_code=400,
                detail=t("run.vmid_not_runnable", vmid=vmid),
            )
        if live_status != "running":
            raise HTTPException(
                status_code=400,
                detail=t("run.vmid_not_running", vmid=vmid),
            )

        resource = resource_repo.get_resource_by_vmid(session=session, vmid=vmid)
        if resource is None:
            raise HTTPException(
                status_code=400, detail=t("run.vmid_not_registered", vmid=vmid)
            )
        if str(resource.user_id) != member["user_id"]:
            raise HTTPException(
                status_code=400,
                detail=t("run.owner_mismatch", vmid=vmid),
            )
        ip_address = resolve_target_ip_address(
            session=session,
            vmid=vmid,
            live_resource=live,
        )
        if not ip_address:
            raise HTTPException(status_code=400, detail=t("run.no_ip", vmid=vmid))
        if not resource.ssh_private_key_encrypted:
            raise HTTPException(
                status_code=400, detail=t("run.no_ssh_key", vmid=vmid)
            )

        targets.append(
            {
                "vmid": vmid,
                "name": str(vmid),
                "resource_type": live_type,
                "status_at_selection": live_status,
                "proxmox_node": live.get("node"),
                "ip_address": ip_address,
                "ssh_user": "root",
                "has_ssh_key": True,
                "user": {
                    "id": member["user_id"],
                    "email": member["email"],
                    "full_name": member["full_name"],
                },
            }
        )

    return targets


def create_script_run(
    *,
    session: Session,
    teaching_class_id: uuid.UUID,
    artifact_id: uuid.UUID,
    target_scope: TeacherJudgeScriptRunTargetScope,
    target_vmids: list[int],
    started_by: uuid.UUID | None,
    requested_item_id: str | None = None,
) -> TeacherJudgeScriptRunPublic:
    if target_scope != TeacherJudgeScriptRunTargetScope.manual:
        raise HTTPException(status_code=400, detail=t("run.manual_scope_only"))

    artifact = get_artifact(
        session=session,
        teaching_class_id=teaching_class_id,
        artifact_id=artifact_id,
    )
    if artifact.status != TeacherJudgeScriptStatus.approved:
        raise HTTPException(status_code=400, detail=t("run.artifact_not_approved"))

    targets = _resolve_running_targets(
        session=session,
        teaching_class_id=teaching_class_id,
        target_vmids=target_vmids,
    )
    if not targets:
        raise HTTPException(status_code=400, detail=t("run.no_target_selected"))
    if len(targets) > 5:
        raise HTTPException(status_code=400, detail=t("run.too_many_targets"))

    run = TeacherJudgeScriptRun(
        teaching_class_id=teaching_class_id,
        artifact_id=artifact.id,
        target_scope=target_scope,
        target_snapshot_json={
            "script": {
                "id": str(artifact.id),
                "name": artifact.name,
                "version": artifact.version,
                "template_key": artifact.template_key,
            },
            "targets": targets,
            "requested_item_id": requested_item_id,
        },
        status=TeacherJudgeScriptRunStatus.pending,
        progress_json={
            "stage": "pending_executor",
            "total": len(targets),
            "done": 0,
            "targets": [
                {
                    "vmid": target["vmid"],
                    "name": target["name"],
                    "proxmox_node": target["proxmox_node"],
                    "resource_type": target["resource_type"],
                    "user": target["user"],
                    "status": "queued",
                    "reason_code": None,
                }
                for target in targets
            ],
        },
        result_summary_json={},
        target_results_json={},
        started_by=started_by,
        started_at=None,
        updated_at=_now(),
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    return _run_to_public(run)
