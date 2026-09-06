"""Teacher Judge uploaded rubric file API routes."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.ai.monitoring import CALL_TJ_RUBRIC, record_ai_template_call
from app.ai.teacher_judge.config import settings
from app.ai.teacher_judge.file_service import (
    _file_to_public,
    create_blank_file,
    delete_file,
    get_file_download,
    list_files,
    parse_conflict_strategy,
    prepare_file_payload,
    raise_if_file_name_conflict,
    save_analyzed_file,
    update_file_analysis,
    update_file_metadata,
)
from app.ai.teacher_judge.schemas import (
    TeacherJudgeFileAnalysisUpdateRequest,
    TeacherJudgeFileCreateRequest,
    TeacherJudgeFileMetadataUpdateRequest,
    TeacherJudgeFilePublic,
    TeacherJudgeFileUploadResponse,
)
from app.ai.teacher_judge.service import analyze_rubric
from app.ai.teacher_judge.template_command_service import (
    SUPPORTED_TEMPLATE_KEYS,
    get_enabled_template_commands,
)
from app.api.deps import InstructorUser, SessionDep
from app.core.authorizers import require_teaching_access
from app.core.i18n import t
from app.models import TeachingClass

router = APIRouter(
    prefix="/teaching-classes/{teaching_class_id}/judge/files",
    tags=["teacher-judge"],
)


def _ensure_class_access(
    *,
    session: SessionDep,
    teaching_class_id: uuid.UUID,
    current_user: InstructorUser,
) -> None:
    teaching_class = session.get(TeachingClass, teaching_class_id)
    if not teaching_class:
        raise HTTPException(status_code=404, detail=t("teacherJudgeFiles.classNotFound"))
    require_teaching_access(current_user, teaching_class.owner_id)


def _normalize_supported_template_key(template_key: str) -> str:
    normalized = template_key.strip().lower() or "linux"
    if normalized not in SUPPORTED_TEMPLATE_KEYS:
        raise HTTPException(
            status_code=400, detail=t("teacherJudgeFiles.unknownTemplate")
        )
    return normalized


def _normalize_supported_environment_keys(
    environment_keys: list[str] | None,
    primary_template_key: str,
) -> list[str]:
    values = environment_keys or [primary_template_key]
    normalized = list(
        dict.fromkeys(str(key).strip().lower() for key in values if str(key).strip())
    )
    if any(key not in SUPPORTED_TEMPLATE_KEYS for key in normalized):
        raise HTTPException(
            status_code=400, detail=t("teacherJudgeFiles.unknownTemplate")
        )
    return [
        primary_template_key,
        *[key for key in normalized if key != primary_template_key],
    ]


@router.get("/", response_model=list[TeacherJudgeFilePublic])
def list_class_teacher_judge_files(
    teaching_class_id: uuid.UUID,
    session: SessionDep,
    current_user: InstructorUser,
) -> list[TeacherJudgeFilePublic]:
    _ensure_class_access(
        session=session, teaching_class_id=teaching_class_id, current_user=current_user
    )
    return list_files(session=session, teaching_class_id=teaching_class_id)


@router.post("/", response_model=TeacherJudgeFileUploadResponse)
async def upload_class_teacher_judge_file(
    teaching_class_id: uuid.UUID,
    session: SessionDep,
    current_user: InstructorUser,
    file: UploadFile = File(...),
    template_key: str = Form(default="linux"),
    environment_keys: list[str] | None = Form(default=None),
    conflict_strategy: str | None = Form(default=None),
) -> TeacherJudgeFileUploadResponse:
    _ensure_class_access(
        session=session, teaching_class_id=teaching_class_id, current_user=current_user
    )
    template_key = _normalize_supported_template_key(template_key)
    environment_keys = _normalize_supported_environment_keys(
        environment_keys, template_key
    )
    conflict_strategy = parse_conflict_strategy(conflict_strategy)
    file_bytes = await file.read()

    try:
        original_filename, file_hash, raw_text = prepare_file_payload(
            filename=file.filename or "unknown",
            file_bytes=file_bytes,
            allowed_suffixes={".md", ".txt", ".doc", ".docx", ".pdf"},
            max_upload_size_bytes=settings.VLLM_MAX_UPLOAD_SIZE_MB * 1024 * 1024,
        )
    except ValueError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc

    raise_if_file_name_conflict(
        session=session,
        teaching_class_id=teaching_class_id,
        original_filename=original_filename,
        conflict_strategy=conflict_strategy,
    )

    template_commands = get_enabled_template_commands(
        session, template_key, include_cross_template=True
    )
    try:
        analysis, metrics = await analyze_rubric(
            raw_text,
            template_key=template_key,
            template_commands=template_commands,
            environment_keys=environment_keys,
        )
    except HTTPException as exc:
        record_ai_template_call(
            session=session,
            user_id=current_user.id,
            call_type=CALL_TJ_RUBRIC,
            model_name=settings.VLLM_MODEL_NAME,
            preset=template_key,
            status="error",
            error_message=str(exc.detail),
        )
        raise
    saved_file = save_analyzed_file(
        session=session,
        teaching_class_id=teaching_class_id,
        uploaded_by=current_user.id,
        original_filename=original_filename,
        file_hash=file_hash,
        template_key=template_key,
        file_bytes=file_bytes,
        analysis=analysis,
        conflict_strategy=conflict_strategy,
        environment_keys=environment_keys,
    )
    record_ai_template_call(
        session=session,
        user_id=current_user.id,
        call_type=CALL_TJ_RUBRIC,
        model_name=settings.VLLM_MODEL_NAME,
        preset=template_key,
        metrics=metrics,
    )
    return TeacherJudgeFileUploadResponse(
        file=saved_file,
        analysis=analysis,
        ai_metrics=dict(metrics),
        template_key=template_key,
    )


@router.post("/blank", response_model=TeacherJudgeFilePublic)
def create_blank_class_teacher_judge_file(
    teaching_class_id: uuid.UUID,
    payload: TeacherJudgeFileCreateRequest,
    session: SessionDep,
    current_user: InstructorUser,
) -> TeacherJudgeFilePublic:
    _ensure_class_access(
        session=session, teaching_class_id=teaching_class_id, current_user=current_user
    )
    file = create_blank_file(
        session=session,
        teaching_class_id=teaching_class_id,
        created_by=current_user.id,
        display_name=payload.display_name,
        environment_keys=payload.environment_keys,
    )
    session.commit()
    session.refresh(file)
    return _file_to_public(file)


@router.get("/{file_id}/download")
def download_class_teacher_judge_file(
    teaching_class_id: uuid.UUID,
    file_id: uuid.UUID,
    session: SessionDep,
    current_user: InstructorUser,
) -> FileResponse:
    _ensure_class_access(
        session=session, teaching_class_id=teaching_class_id, current_user=current_user
    )
    path, filename = get_file_download(
        session=session,
        teaching_class_id=teaching_class_id,
        file_id=file_id,
    )
    return FileResponse(path, filename=filename)


@router.patch("/{file_id}/analysis", response_model=TeacherJudgeFilePublic)
def update_class_teacher_judge_file_analysis(
    teaching_class_id: uuid.UUID,
    file_id: uuid.UUID,
    payload: TeacherJudgeFileAnalysisUpdateRequest,
    session: SessionDep,
    current_user: InstructorUser,
) -> TeacherJudgeFilePublic:
    _ensure_class_access(
        session=session, teaching_class_id=teaching_class_id, current_user=current_user
    )
    return update_file_analysis(
        session=session,
        teaching_class_id=teaching_class_id,
        file_id=file_id,
        analysis=payload.analysis,
        expected_revision=payload.expected_revision,
    )


@router.patch("/{file_id}", response_model=TeacherJudgeFilePublic)
def update_class_teacher_judge_file_metadata(
    teaching_class_id: uuid.UUID,
    file_id: uuid.UUID,
    payload: TeacherJudgeFileMetadataUpdateRequest,
    session: SessionDep,
    current_user: InstructorUser,
) -> TeacherJudgeFilePublic:
    _ensure_class_access(
        session=session, teaching_class_id=teaching_class_id, current_user=current_user
    )
    return update_file_metadata(
        session=session,
        teaching_class_id=teaching_class_id,
        file_id=file_id,
        payload=payload,
    )


@router.delete("/{file_id}", status_code=204)
def delete_class_teacher_judge_file(
    teaching_class_id: uuid.UUID,
    file_id: uuid.UUID,
    session: SessionDep,
    current_user: InstructorUser,
) -> None:
    _ensure_class_access(
        session=session, teaching_class_id=teaching_class_id, current_user=current_user
    )
    delete_file(session=session, teaching_class_id=teaching_class_id, file_id=file_id)
