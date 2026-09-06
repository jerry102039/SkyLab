"""
AI Monitoring Routes — Admin 全局 AI 使用監控

掛載在 /ai-api/monitoring/ 前綴下
"""

import asyncio
import logging
import uuid
from datetime import datetime

import httpx
from fastapi import APIRouter, HTTPException, Query

from app.api.deps import AIAPIViewAllUser, SessionDep
from app.core.i18n import t
from app.features.ai.config import settings as ai_api_settings
from app.schemas.ai_monitoring import (
    AIMonitoringStats,
    AIProxyCallsResponse,
    AITemplateCallsResponse,
    AIUsersUsageResponse,
)
from app.services.llm_gateway import ai_gateway_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ai-api/monitoring", tags=["ai-monitoring"])
@router.get(
    "/stats",
    response_model=AIMonitoringStats,
    summary="全局 AI 統計卡片",
)
def get_stats(
    session: SessionDep,
    _current_user: AIAPIViewAllUser,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
):
    """全局 AI 使用統計（Admin only）"""
    return ai_gateway_service.get_monitoring_stats(
        session=session,
        start_date=start_date,
        end_date=end_date,
    )


@router.get(
    "/api-calls",
    response_model=AIProxyCallsResponse,
    summary="Proxy 呼叫清單",
)
def list_api_calls(
    session: SessionDep,
    _current_user: AIAPIViewAllUser,
    user_id: uuid.UUID | None = None,
    model_name: str | None = Query(default=None, max_length=255),
    status: str | None = Query(default=None, max_length=50),
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
):
    """列出所有 Proxy 呼叫紀錄，支援篩選（Admin only）"""
    return ai_gateway_service.list_proxy_calls(
        session=session,
        user_id=user_id,
        model_name=model_name,
        call_status=status,
        start_date=start_date,
        end_date=end_date,
        skip=skip,
        limit=limit,
    )


@router.get(
    "/template-calls",
    response_model=AITemplateCallsResponse,
    summary="Template 呼叫清單",
)
def list_template_calls(
    session: SessionDep,
    _current_user: AIAPIViewAllUser,
    user_id: uuid.UUID | None = None,
    call_type: str | None = Query(default=None, max_length=30),
    preset: str | None = Query(default=None, max_length=50),
    status: str | None = Query(default=None, max_length=50),
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
):
    """列出所有 Template 呼叫紀錄，支援篩選（Admin only）"""
    return ai_gateway_service.list_template_calls(
        session=session,
        user_id=user_id,
        call_type=call_type,
        preset=preset,
        call_status=status,
        start_date=start_date,
        end_date=end_date,
        skip=skip,
        limit=limit,
    )


@router.get(
    "/users",
    response_model=AIUsersUsageResponse,
    summary="使用者用量彙總",
)
def list_users_usage(
    session: SessionDep,
    _current_user: AIAPIViewAllUser,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
):
    """每個使用者的 AI 用量彙總（Admin only）"""
    return ai_gateway_service.list_users_usage(
        session=session,
        start_date=start_date,
        end_date=end_date,
        skip=skip,
        limit=limit,
    )


@router.get(
    "/litellm-runtime",
    summary="LiteLLM runtime snapshot",
)
async def get_litellm_runtime_snapshot(_current_user: AIAPIViewAllUser):
    """Return staging LiteLLM health to an authorised Campus administrator.

    The public `ai-proxy` relay never exposes LiteLLM health or management
    endpoints. This deliberately returns a compact, secret-free snapshot and
    fails closed when the optional internal observation credential is absent.
    """
    api_key = ai_api_settings.litellm_runtime_api_key
    if not api_key:
        raise HTTPException(
            status_code=503, detail=t("aiMonitoring.runtimeNotConfigured")
        )

    base_url = ai_api_settings.litellm_runtime_base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            liveliness, readiness, deployments = await asyncio.gather(
                client.get(f"{base_url}/health/liveliness"),
                client.get(f"{base_url}/health/readiness"),
                client.get(f"{base_url}/health", headers=headers),
            )
    except httpx.RequestError:
        logger.warning("LiteLLM runtime snapshot request failed")
        raise HTTPException(
            status_code=503, detail=t("aiMonitoring.runtimeUnavailable")
        ) from None

    try:
        deployment_health = deployments.json() if deployments.is_success else {}
    except ValueError:
        deployment_health = {}

    # `/health` has changed shape across LiteLLM versions. Preserve only the
    # status counts here, never a raw upstream response that could reveal an
    # internal URL or a future sensitive field.
    healthy = deployment_health.get("healthy_endpoints", [])
    unhealthy = deployment_health.get("unhealthy_endpoints", [])
    return {
        "liveliness": liveliness.is_success,
        "readiness": readiness.is_success,
        "healthy_deployment_count": len(healthy) if isinstance(healthy, list) else 0,
        "unhealthy_deployment_count": len(unhealthy) if isinstance(unhealthy, list) else 0,
        "deployment_status_code": deployments.status_code,
    }
