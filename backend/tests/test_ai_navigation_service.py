from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.ai.navigation import service as navigation_service
from app.models.user import UserRole


def _user(role: UserRole, *, is_superuser: bool = False) -> SimpleNamespace:
    return SimpleNamespace(role=role, is_superuser=is_superuser)


@pytest.mark.asyncio
async def test_resolve_navigation_uses_keyword_fallback_when_model_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(navigation_service.system_ai_env, "vllm_model_name", "")

    result = await navigation_service.resolve_navigation(
        "我要看 AI API token 用量",
        _user(UserRole.student),
    )

    assert result.primary is not None
    assert result.primary.path == "/ai-api"
    assert result.action in {"navigate", "suggest"}


@pytest.mark.asyncio
async def test_resolve_navigation_filters_out_inaccessible_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _fake_create_chat_completion(_payload, *, timeout: float):
        return {
            "choices": [
                {
                    "message": {
                        "content": (
                            '{"intent":"看管理頁","confidence":0.91,'
                            '"action":"navigate","primary_path":"/admin/domains",'
                            '"suggested_paths":["/my-resources"],'
                            '"reason":"看管理設定","clarification_question":""}'
                        )
                    }
                }
            ]
        }

    monkeypatch.setattr(
        navigation_service.system_ai_env,
        "vllm_model_name",
        "Qwen/test-model",
    )
    monkeypatch.setattr(
        navigation_service.navigation_client,
        "create_chat_completion",
        _fake_create_chat_completion,
    )

    result = await navigation_service.resolve_navigation(
        "我要看管理設定",
        _user(UserRole.student),
    )

    assert result.action == "suggest"
    assert result.primary is not None
    assert result.primary.path == "/my-resources"
    assert all(not item.path.startswith("/admin") for item in result.suggestions)

