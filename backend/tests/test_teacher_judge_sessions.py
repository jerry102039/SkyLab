from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, create_engine, select

from app.ai.teacher_judge import attachment_service, file_service, session_service
from app.ai.teacher_judge.schemas import (
    TeacherJudgeRubricAnalysis,
    TeacherJudgeSessionCreateRequest,
    TeacherJudgeSessionMessageCreateRequest,
)
from app.api.routes import teacher_judge_sessions
from app.models.teacher_judge_file import TeacherJudgeFile
from app.models.teacher_judge_script_artifact import TeacherJudgeScriptArtifact
from app.models.teacher_judge_script_run import TeacherJudgeScriptRun
from app.models.teacher_judge_session import (
    TeacherJudgeMessageRole,
    TeacherJudgeSession,
    TeacherJudgeSessionMessage,
    TeacherJudgeSessionStatus,
)


def _session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _file(db: Session, class_id: uuid.UUID) -> TeacherJudgeFile:
    item = TeacherJudgeFile(
        teaching_class_id=class_id,
        original_filename="rubric.pdf",
        file_hash="a" * 64,
        template_key="linux",
        analysis_json={"items": [], "summary": "rubric"},
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def test_selected_file_must_belong_to_same_teaching_class() -> None:
    db = _session()
    foreign_file = _file(db, uuid.uuid4())

    with pytest.raises(HTTPException) as exc_info:
        session_service.validate_selected_file(db, uuid.uuid4(), foreign_file.id)

    assert exc_info.value.status_code == 400


def test_archived_session_is_read_only() -> None:
    item = TeacherJudgeSession(
        teaching_class_id=uuid.uuid4(),
        title="Archived",
        status=TeacherJudgeSessionStatus.archived,
    )

    with pytest.raises(HTTPException) as exc_info:
        session_service.ensure_active(item)

    assert exc_info.value.status_code == 409


def test_clear_messages_keeps_session(monkeypatch: pytest.MonkeyPatch) -> None:
    db = _session()
    class_id = uuid.uuid4()
    item = TeacherJudgeSession(
        teaching_class_id=class_id,
        title="Clear chat",
        summary="過時摘要",
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    db.add_all(
        [
            TeacherJudgeSessionMessage(
                session_id=item.id,
                role=TeacherJudgeMessageRole.user,
                content="問題",
            ),
            TeacherJudgeSessionMessage(
                session_id=item.id,
                role=TeacherJudgeMessageRole.assistant,
                content="回答",
            ),
        ]
    )
    db.commit()
    monkeypatch.setattr(teacher_judge_sessions, "_access", lambda *args: None)

    result = teacher_judge_sessions.clear_messages(
        class_id,
        item.id,
        db,
        SimpleNamespace(id=uuid.uuid4()),
    )

    assert result.id == str(item.id)
    assert result.message_count == 0
    assert result.title == "Clear chat"
    refreshed = db.get(TeacherJudgeSession, item.id)
    assert refreshed is not None
    assert refreshed.summary == ""
    assert db.exec(select(TeacherJudgeSessionMessage)).all() == []


def test_session_creation_mode_contract_is_explicit() -> None:
    with pytest.raises(ValueError):
        TeacherJudgeSessionCreateRequest(
            title="Blank without rubric",
            creation_mode="blank",
            environment_keys=["linux"],
        )

    with pytest.raises(ValueError):
        TeacherJudgeSessionCreateRequest(
            title="Existing without file",
            creation_mode="existing",
        )

    with pytest.raises(ValueError):
        TeacherJudgeSessionCreateRequest(
            title="Existing with blank fields",
            creation_mode="existing",
            selected_file_id=uuid.uuid4(),
            rubric_name="should not be sent",
        )


def test_chat_can_start_without_selected_file() -> None:
    db = _session()
    item = TeacherJudgeSession(teaching_class_id=uuid.uuid4(), title="Chat first")
    db.add(item)
    db.commit()
    db.refresh(item)

    assert session_service.selected_file_for_chat(db, item) is None


def test_delete_session_data_removes_owned_records_and_private_file() -> None:
    db = _session()
    class_id = uuid.uuid4()
    rubric_file = _file(db, class_id)
    item = TeacherJudgeSession(
        teaching_class_id=class_id,
        title="Delete me",
        selected_file_id=rubric_file.id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)

    artifact = TeacherJudgeScriptArtifact(
        teaching_class_id=class_id,
        session_id=item.id,
        name="Delete script",
        template_key="linux",
        script_content="print('ok')",
    )
    db.add(artifact)
    db.commit()
    db.refresh(artifact)
    db.add_all(
        [
            TeacherJudgeScriptRun(
                teaching_class_id=class_id,
                artifact_id=artifact.id,
            ),
            TeacherJudgeSessionMessage(
                session_id=item.id,
                role=TeacherJudgeMessageRole.user,
                content="remove this",
            ),
        ]
    )
    db.commit()

    session_service.delete_session_data(db, item)

    assert db.get(TeacherJudgeSession, item.id) is None
    assert db.get(TeacherJudgeScriptArtifact, artifact.id) is None
    assert not db.exec(select(TeacherJudgeScriptRun)).all()
    assert not db.exec(select(TeacherJudgeSessionMessage)).all()
    assert db.get(TeacherJudgeFile, rubric_file.id) is None


def test_selected_file_cannot_be_claimed_by_another_session() -> None:
    db = _session()
    class_id = uuid.uuid4()
    rubric_file = _file(db, class_id)
    owner = TeacherJudgeSession(
        teaching_class_id=class_id,
        title="Owner",
        selected_file_id=rubric_file.id,
    )
    db.add(owner)
    db.commit()
    db.refresh(owner)

    with pytest.raises(HTTPException) as exc_info:
        session_service.ensure_selected_file_available(db, rubric_file.id)

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "teacher_judge_file_in_use"
    assert "重構" in exc_info.value.detail["message"]


def test_create_session_rejects_a_source_owned_by_another_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _session()
    class_id = uuid.uuid4()
    rubric_file = _file(db, class_id)
    db.add(
        TeacherJudgeSession(
            teaching_class_id=class_id,
            title="Owner",
            selected_file_id=rubric_file.id,
        )
    )
    db.commit()
    monkeypatch.setattr(teacher_judge_sessions, "_access", lambda *args: None)

    with pytest.raises(HTTPException) as exc_info:
        teacher_judge_sessions.create_session(
            class_id,
            TeacherJudgeSessionCreateRequest(
                title="Should fail",
                creation_mode="existing",
                selected_file_id=rubric_file.id,
            ),
            db,
            SimpleNamespace(id=uuid.uuid4()),
        )

    assert exc_info.value.status_code == 409
    assert "重構" in exc_info.value.detail["message"]
    assert len(db.exec(select(TeacherJudgeSession)).all()) == 1


def test_selected_file_unique_index_allows_only_one_session_owner() -> None:
    db = _session()
    class_id = uuid.uuid4()
    rubric_file = _file(db, class_id)
    db.add(
        TeacherJudgeSession(
            teaching_class_id=class_id,
            title="First",
            selected_file_id=rubric_file.id,
        )
    )
    db.commit()
    db.add(
        TeacherJudgeSession(
            teaching_class_id=class_id,
            title="Second",
            selected_file_id=rubric_file.id,
        )
    )

    with pytest.raises(IntegrityError):
        db.commit()


def test_fork_created_session_clones_rubric_without_history() -> None:
    db = _session()
    class_id = uuid.uuid4()
    owner_id = uuid.uuid4()
    rubric_file = file_service.create_blank_file(
        session=db,
        teaching_class_id=class_id,
        created_by=owner_id,
        display_name="原始評分表",
        environment_keys=["python"],
    )
    db.commit()
    source = TeacherJudgeSession(
        teaching_class_id=class_id,
        title="原始檢查",
        selected_file_id=rubric_file.id,
        summary="不要複製這段摘要",
        status=TeacherJudgeSessionStatus.archived,
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    db.add(
        TeacherJudgeSessionMessage(
            session_id=source.id,
            role=TeacherJudgeMessageRole.user,
            content="歷史對話",
        )
    )
    db.commit()

    clone = session_service.fork_session_data(
        db,
        source,
        title=None,
        created_by=uuid.uuid4(),
    )

    assert clone.id != source.id
    assert clone.title == "原始檢查（副本）"
    assert clone.status == TeacherJudgeSessionStatus.active
    assert clone.summary == ""
    assert clone.selected_file_id != source.selected_file_id
    cloned_file = db.get(TeacherJudgeFile, clone.selected_file_id)
    source_file = db.get(TeacherJudgeFile, source.selected_file_id)
    assert cloned_file is not None and source_file is not None
    assert cloned_file.id != source_file.id
    assert cloned_file.source_type == "created"
    assert cloned_file.analysis_json == source_file.analysis_json
    assert session_service.session_public(db, clone).message_count == 0
    assert session_service.session_public(db, clone).script_count == 0
    assert session_service.session_public(db, clone).run_count == 0

    file_service.update_file_analysis(
        session=db,
        teaching_class_id=class_id,
        file_id=cloned_file.id,
        analysis=TeacherJudgeRubricAnalysis(
            items=[],
            total_items=0,
            summary="只改副本",
        ),
        expected_revision=1,
    )
    source_file_after = db.get(TeacherJudgeFile, source_file.id)
    assert source_file_after is not None
    assert source_file_after.analysis_json["summary"] == ""


@pytest.mark.asyncio
async def test_message_without_rubric_is_saved_and_uses_general_chat(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _session()
    class_id = uuid.uuid4()
    item = TeacherJudgeSession(teaching_class_id=class_id, title="Chat first")
    db.add(item)
    db.commit()
    db.refresh(item)

    async def fake_chat(messages, rubric_context, **kwargs):
        assert messages[-1].content == "先討論檢查需求"
        assert rubric_context == "{}"
        assert kwargs["is_refine"] is False
        assert kwargs["template_key"] == "linux"
        return "可以，先描述目標環境。", None, {}

    monkeypatch.setattr(teacher_judge_sessions, "_access", lambda *args: None)
    monkeypatch.setattr(teacher_judge_sessions, "chat_with_rubric", fake_chat)
    monkeypatch.setattr(
        teacher_judge_sessions, "get_enabled_template_commands", lambda *args, **kwargs: []
    )

    result = await teacher_judge_sessions.create_message(
        class_id,
        item.id,
        TeacherJudgeSessionMessageCreateRequest(content="先討論檢查需求"),
        db,
        SimpleNamespace(id=uuid.uuid4()),
    )

    assert result.user_message.content == "先討論檢查需求"
    assert result.assistant_message.content == "可以，先描述目標環境。"
    assert result.rubric_proposal is None
    assert len(db.exec(select(TeacherJudgeSessionMessage)).all()) == 2


@pytest.mark.asyncio
async def test_message_can_send_parsed_attachment_without_text(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    db = _session()
    class_id = uuid.uuid4()
    item = TeacherJudgeSession(teaching_class_id=class_id, title="Attachment chat")
    db.add(item)
    db.commit()
    db.refresh(item)
    monkeypatch.setattr(teacher_judge_sessions, "_access", lambda *args: None)
    monkeypatch.setattr(attachment_service, "ATTACHMENT_ROOT", tmp_path)
    attachment = attachment_service.create_attachment(
        db,
        session_id=item.id,
        uploaded_by=None,
        filename="requirements.md",
        media_type="text/markdown",
        file_bytes=b"# Requirements\nExpose port 8080.",
    )

    async def fake_chat(messages, rubric_context, **kwargs):
        assert messages[-1].content == ""
        assert "requirements.md" in kwargs["attachment_context"]
        assert "port 8080" in kwargs["attachment_context"]
        return "已讀取附件。", None, {}

    monkeypatch.setattr(teacher_judge_sessions, "chat_with_rubric", fake_chat)
    monkeypatch.setattr(
        teacher_judge_sessions, "get_enabled_template_commands", lambda *args, **kwargs: []
    )

    result = await teacher_judge_sessions.create_message(
        class_id,
        item.id,
        TeacherJudgeSessionMessageCreateRequest(attachment_ids=[attachment.id]),
        db,
        SimpleNamespace(id=uuid.uuid4()),
    )

    assert result.user_message.content == ""
    assert [row.original_filename for row in result.user_message.attachments] == [
        "requirements.md"
    ]
    db.refresh(attachment)
    assert attachment.message_id == uuid.UUID(result.user_message.id)


@pytest.mark.asyncio
async def test_refine_message_uses_the_rubric_polish_prompt_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _session()
    class_id = uuid.uuid4()
    rubric_file = _file(db, class_id)
    item = TeacherJudgeSession(
        teaching_class_id=class_id,
        title="Polish rubric",
        selected_file_id=rubric_file.id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)

    async def fake_chat(messages, rubric_context, **kwargs):
        assert messages[-1].content == "請審核並潤飾目前的評分表"
        assert '"items": []' in rubric_context
        assert kwargs["is_refine"] is True
        return "檢查完畢，評分表目前狀態良好。", None, {}

    monkeypatch.setattr(teacher_judge_sessions, "_access", lambda *args: None)
    monkeypatch.setattr(teacher_judge_sessions, "chat_with_rubric", fake_chat)
    monkeypatch.setattr(
        teacher_judge_sessions, "get_enabled_template_commands", lambda *args, **kwargs: []
    )

    result = await teacher_judge_sessions.create_message(
        class_id,
        item.id,
        TeacherJudgeSessionMessageCreateRequest(
            content="請審核並潤飾目前的評分表",
            is_refine=True,
        ),
        db,
        SimpleNamespace(id=uuid.uuid4()),
    )

    assert result.assistant_message.content == "檢查完畢，評分表目前狀態良好。"
    assert result.rubric_proposal is None
    assert result.user_message.metadata_json["ui_hidden"] is True


@pytest.mark.asyncio
async def test_message_rejects_stale_rubric_revision_before_ai_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _session()
    class_id = uuid.uuid4()
    rubric_file = _file(db, class_id)
    item = TeacherJudgeSession(
        teaching_class_id=class_id,
        title="Revision guard",
        selected_file_id=rubric_file.id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    monkeypatch.setattr(teacher_judge_sessions, "_access", lambda *args: None)

    async def should_not_call_ai(*args, **kwargs):
        raise AssertionError("stale requests must fail before AI call")

    monkeypatch.setattr(teacher_judge_sessions, "chat_with_rubric", should_not_call_ai)

    with pytest.raises(HTTPException) as exc_info:
        await teacher_judge_sessions.create_message(
            class_id,
            item.id,
            TeacherJudgeSessionMessageCreateRequest(
                content="請更新評分表",
                analysis_revision=99,
            ),
            db,
            SimpleNamespace(id=uuid.uuid4()),
        )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "teacher_judge_analysis_revision_conflict"
    assert db.exec(select(TeacherJudgeSessionMessage)).all() == []


def test_message_content_redacts_common_secrets() -> None:
    content = session_service.redact_message_content(
        "token=abc123 password: hunter2\n"
        "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"
    )

    assert "abc123" not in content
    assert "hunter2" not in content
    assert "\nsecret\n" not in content
    assert content.count("[REDACTED]") == 2


def test_bounded_history_keeps_latest_messages_in_stable_order() -> None:
    db = _session()
    item = TeacherJudgeSession(teaching_class_id=uuid.uuid4(), title="History")
    db.add(item)
    db.commit()
    db.refresh(item)
    started_at = datetime(2026, 7, 31, tzinfo=timezone.utc)
    for index in range(25):
        db.add(
            TeacherJudgeSessionMessage(
                session_id=item.id,
                role=(
                    TeacherJudgeMessageRole.user
                    if index % 2 == 0
                    else TeacherJudgeMessageRole.assistant
                ),
                content=f"message-{index:02d}",
                created_at=started_at + timedelta(seconds=index),
            )
        )
    db.commit()

    history = session_service.bounded_history(db, item.id)

    assert len(history) == session_service.HISTORY_MESSAGE_LIMIT
    assert history[0].content == "message-05"
    assert history[-1].content == "message-24"


@pytest.mark.asyncio
async def test_summary_runs_only_on_tenth_completed_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _session()
    class_id = uuid.uuid4()
    rubric_file = _file(db, class_id)
    item = TeacherJudgeSession(
        teaching_class_id=class_id,
        title="Summary",
        selected_file_id=rubric_file.id,
        summary="old",
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    calls = 0

    async def fake_chat(*args, **kwargs):
        nonlocal calls
        calls += 1
        return "new summary", None, {}

    monkeypatch.setattr(session_service, "chat_with_rubric", fake_chat)
    monkeypatch.setattr(
        session_service, "get_enabled_template_commands", lambda *args, **kwargs: []
    )

    for index in range(9):
        db.add(
            TeacherJudgeSessionMessage(
                session_id=item.id,
                role=TeacherJudgeMessageRole.assistant,
                content=f"assistant-{index}",
            )
        )
    db.commit()
    await session_service.maybe_summarize(db, item, rubric_file)
    assert calls == 0
    assert item.summary == "old"

    db.add(
        TeacherJudgeSessionMessage(
            session_id=item.id,
            role=TeacherJudgeMessageRole.assistant,
            content="assistant-10",
        )
    )
    db.commit()
    await session_service.maybe_summarize(db, item, rubric_file)

    assert calls == 1
    assert item.summary == "new summary"


@pytest.mark.asyncio
async def test_summary_failure_preserves_previous_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = _session()
    class_id = uuid.uuid4()
    rubric_file = _file(db, class_id)
    item = TeacherJudgeSession(
        teaching_class_id=class_id,
        title="Summary failure",
        selected_file_id=rubric_file.id,
        summary="keep me",
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    for index in range(10):
        db.add(
            TeacherJudgeSessionMessage(
                session_id=item.id,
                role=TeacherJudgeMessageRole.assistant,
                content=f"assistant-{index}",
            )
        )
    db.commit()

    async def fail_chat(*args, **kwargs):
        raise RuntimeError("model unavailable")

    monkeypatch.setattr(session_service, "chat_with_rubric", fail_chat)
    monkeypatch.setattr(
        session_service, "get_enabled_template_commands", lambda *args, **kwargs: []
    )
    await session_service.maybe_summarize(db, item, rubric_file)

    assert item.summary == "keep me"
