from __future__ import annotations

from typing import Any

import httpx

from app.ai.system_config import system_ai_env


class NavigationClient:
    async def create_chat_completion(
        self,
        payload: dict[str, Any],
        *,
        timeout: float,
    ) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {system_ai_env.vllm_api_key}",
            "Content-Type": "application/json",
        }
        base_url = system_ai_env.vllm_base_url.rstrip("/")
        async with httpx.AsyncClient(timeout=timeout) as http_client:
            response = await http_client.post(
                f"{base_url}/chat/completions",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
            return response.json()


client = NavigationClient()

