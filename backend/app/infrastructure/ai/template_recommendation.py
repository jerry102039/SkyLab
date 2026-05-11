from __future__ import annotations

from app.ai.template_recommendation.config import settings
from app.infrastructure.ai.vllm_client import VLLMClient

client = VLLMClient(
    base_url=settings.VLLM_BASE_URL,
    api_key=settings.VLLM_API_KEY,
    default_timeout=float(settings.VLLM_TIMEOUT),
)
