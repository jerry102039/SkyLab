"""課程內容管理 API（老師/管理員）。"""

import uuid

from fastapi import APIRouter

from app.api.deps import InstructorUser, SessionDep
from app.core.authorizers import (
    can_bypass_teaching_ownership,
    require_teaching_access,
)
from app.core.i18n import t
from app.exceptions import BadRequestError, NotFoundError
from app.models import TeachingClass
from app.schemas.course import (
    CoursePathCreate,
    CoursePathPublic,
    CoursePathPublish,
    CoursePathUpdate,
    CourseQuestionCreate,
    CourseQuestionPublic,
    CourseQuestionUpdate,
    CourseRoomCreate,
    CourseRoomPublic,
    CourseRoomUpdate,
    CourseTaskCreate,
    CourseTaskPublic,
    CourseTaskUpdate,
    PathProgressReport,
)
from app.services.course import course_service, progress_service

router = APIRouter(prefix="/admin/courses", tags=["course-admin"])


def _require_path(session: SessionDep, current_user, path_id: uuid.UUID):
    path = course_service.get_path_or_404(session, path_id)
    require_teaching_access(current_user, path.created_by)
    return path


def _require_room_path(session: SessionDep, current_user, room_id: uuid.UUID):
    room = course_service.get_room_or_404(session, room_id)
    _require_path(session, current_user, room.path_id)
    return room


def _require_task_path(session: SessionDep, current_user, task_id: uuid.UUID):
    task = course_service.get_task_or_404(session, task_id)
    _require_room_path(session, current_user, task.room_id)
    return task


def _require_question_path(
    session: SessionDep, current_user, question_id: uuid.UUID
):
    question = course_service.get_question_or_404(session, question_id)
    _require_task_path(session, current_user, question.task_id)
    return question


def _require_linkable_class(
    session: SessionDep,
    current_user,
    teaching_class_id: uuid.UUID,
) -> TeachingClass:
    teaching_class = session.get(TeachingClass, teaching_class_id)
    if teaching_class is None:
        raise NotFoundError(t("course_admin.class_not_found"))
    require_teaching_access(current_user, teaching_class.owner_id)
    return teaching_class

# ── 路徑 ───────────────────────────────────────────────────────────────────


@router.get("/paths", response_model=list[CoursePathPublic])
def list_paths(
    session: SessionDep, current_user: InstructorUser
) -> list[CoursePathPublic]:
    owner_id = (
        None if can_bypass_teaching_ownership(current_user) else current_user.id
    )
    return course_service.list_paths(session, owner_id=owner_id)


@router.post("/paths", response_model=CoursePathPublic, status_code=201)
def create_path(
    session: SessionDep, current_user: InstructorUser, data: CoursePathCreate
) -> CoursePathPublic:
    owner_id = current_user.id
    if data.teaching_class_id is not None:
        owner_id = _require_linkable_class(
            session,
            current_user,
            data.teaching_class_id,
        ).owner_id
    return course_service.create_path(session, user_id=owner_id, data=data)


@router.put("/paths/{path_id}", response_model=CoursePathPublic)
def update_path(
    session: SessionDep,
    current_user: InstructorUser,
    path_id: uuid.UUID,
    data: CoursePathUpdate,
) -> CoursePathPublic:
    path = _require_path(session, current_user, path_id)
    if data.teaching_class_id is not None:
        teaching_class = _require_linkable_class(
            session,
            current_user,
            data.teaching_class_id,
        )
        if teaching_class.owner_id != path.created_by:
            raise BadRequestError(t("course_admin.owner_mismatch"))
    return course_service.update_path(session, path_id=path_id, data=data)


@router.put("/paths/{path_id}/publish", response_model=CoursePathPublic)
def publish_path(
    session: SessionDep,
    current_user: InstructorUser,
    path_id: uuid.UUID,
    data: CoursePathPublish,
) -> CoursePathPublic:
    _require_path(session, current_user, path_id)
    return course_service.set_path_published(
        session, path_id=path_id, published=data.published
    )


@router.delete("/paths/{path_id}", status_code=204)
def delete_path(
    session: SessionDep, current_user: InstructorUser, path_id: uuid.UUID
) -> None:
    _require_path(session, current_user, path_id)
    course_service.delete_path(session, path_id=path_id)


@router.get("/paths/{path_id}/progress", response_model=PathProgressReport)
def path_progress(
    session: SessionDep, current_user: InstructorUser, path_id: uuid.UUID
) -> PathProgressReport:
    _require_path(session, current_user, path_id)
    return progress_service.path_progress_report(session, path_id=path_id)


# ── 房間 ───────────────────────────────────────────────────────────────────


@router.get("/paths/{path_id}/rooms", response_model=list[CourseRoomPublic])
def list_rooms(
    session: SessionDep, current_user: InstructorUser, path_id: uuid.UUID
) -> list[CourseRoomPublic]:
    _require_path(session, current_user, path_id)
    return course_service.list_rooms(session, path_id=path_id)


@router.post("/rooms", response_model=CourseRoomPublic, status_code=201)
def create_room(
    session: SessionDep, current_user: InstructorUser, data: CourseRoomCreate
) -> CourseRoomPublic:
    _require_path(session, current_user, data.path_id)
    return course_service.create_room(session, data=data)


@router.put("/rooms/{room_id}", response_model=CourseRoomPublic)
def update_room(
    session: SessionDep,
    current_user: InstructorUser,
    room_id: uuid.UUID,
    data: CourseRoomUpdate,
) -> CourseRoomPublic:
    _require_room_path(session, current_user, room_id)
    return course_service.update_room(session, room_id=room_id, data=data)


@router.delete("/rooms/{room_id}", status_code=204)
def delete_room(
    session: SessionDep, current_user: InstructorUser, room_id: uuid.UUID
) -> None:
    _require_room_path(session, current_user, room_id)
    course_service.delete_room(session, room_id=room_id)


# ── 任務 ───────────────────────────────────────────────────────────────────


@router.get("/rooms/{room_id}/tasks", response_model=list[CourseTaskPublic])
def list_tasks(
    session: SessionDep, current_user: InstructorUser, room_id: uuid.UUID
) -> list[CourseTaskPublic]:
    _require_room_path(session, current_user, room_id)
    return course_service.list_tasks(session, room_id=room_id)


@router.post("/tasks", response_model=CourseTaskPublic, status_code=201)
def create_task(
    session: SessionDep, current_user: InstructorUser, data: CourseTaskCreate
) -> CourseTaskPublic:
    _require_room_path(session, current_user, data.room_id)
    return course_service.create_task(session, data=data)


@router.put("/tasks/{task_id}", response_model=CourseTaskPublic)
def update_task(
    session: SessionDep,
    current_user: InstructorUser,
    task_id: uuid.UUID,
    data: CourseTaskUpdate,
) -> CourseTaskPublic:
    _require_task_path(session, current_user, task_id)
    return course_service.update_task(session, task_id=task_id, data=data)


@router.delete("/tasks/{task_id}", status_code=204)
def delete_task(
    session: SessionDep, current_user: InstructorUser, task_id: uuid.UUID
) -> None:
    _require_task_path(session, current_user, task_id)
    course_service.delete_task(session, task_id=task_id)


# ── 題目 ───────────────────────────────────────────────────────────────────


@router.get(
    "/tasks/{task_id}/questions", response_model=list[CourseQuestionPublic]
)
def list_questions(
    session: SessionDep, current_user: InstructorUser, task_id: uuid.UUID
) -> list[CourseQuestionPublic]:
    _require_task_path(session, current_user, task_id)
    return course_service.list_questions(session, task_id=task_id)


@router.post("/questions", response_model=CourseQuestionPublic, status_code=201)
def create_question(
    session: SessionDep, current_user: InstructorUser, data: CourseQuestionCreate
) -> CourseQuestionPublic:
    _require_task_path(session, current_user, data.task_id)
    return course_service.create_question(session, data=data)


@router.put("/questions/{question_id}", response_model=CourseQuestionPublic)
def update_question(
    session: SessionDep,
    current_user: InstructorUser,
    question_id: uuid.UUID,
    data: CourseQuestionUpdate,
) -> CourseQuestionPublic:
    _require_question_path(session, current_user, question_id)
    return course_service.update_question(
        session, question_id=question_id, data=data
    )


@router.delete("/questions/{question_id}", status_code=204)
def delete_question(
    session: SessionDep, current_user: InstructorUser, question_id: uuid.UUID
) -> None:
    _require_question_path(session, current_user, question_id)
    course_service.delete_question(session, question_id=question_id)
