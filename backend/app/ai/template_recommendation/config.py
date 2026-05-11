from __future__ import annotations

from pathlib import Path

from app.ai.system_config import (
    BACKEND_ROOT,
    PROJECT_ROOT,
    system_ai_config,
    system_ai_env,
)


class TemplateRecommendationSettings:
    @property
    def section(self):
        return system_ai_config.template_recommendation

    @property
    def resolved_templates_dir(self) -> Path:
        path = Path(self.section.templates_dir)
        if path.is_absolute():
            return path

        backend_relative = (BACKEND_ROOT / path).resolve()
        if backend_relative.exists():
            return backend_relative

        return (PROJECT_ROOT / path).resolve()

    @property
    def parsed_backend_node_gpu_map(self) -> dict[str, int]:
        parsed: dict[str, int] = {}
        for key, value in self.section.backend_node_gpu_map.items():
            try:
                parsed[str(key)] = max(int(value), 0)
            except (TypeError, ValueError):
                continue
        return parsed

    @property
    def VLLM_BASE_URL(self) -> str:
        return system_ai_env.vllm_base_url

    @property
    def VLLM_API_KEY(self) -> str:
        return system_ai_env.vllm_api_key

    @property
    def VLLM_MODEL_NAME(self) -> str:
        return system_ai_env.vllm_model_name.strip()

    @property
    def VLLM_ENABLE_THINKING(self) -> bool:
        return bool(self.section.vllm.enable_thinking)

    @property
    def VLLM_TIMEOUT(self) -> int:
        return int(self.section.vllm.timeout)

    @property
    def VLLM_TEMPERATURE(self) -> float:
        return float(self.section.vllm.temperature)

    @property
    def VLLM_CHAT_TEMPERATURE(self) -> float:
        if self.section.vllm.chat_temperature is not None:
            return float(self.section.vllm.chat_temperature)
        return self.VLLM_TEMPERATURE

    @property
    def VLLM_TOP_P(self) -> float:
        return float(self.section.vllm.top_p)

    @property
    def VLLM_TOP_K(self) -> int:
        return int(self.section.vllm.top_k)

    @property
    def VLLM_MIN_P(self) -> float:
        return float(self.section.vllm.min_p)

    @property
    def VLLM_MAX_TOKENS(self) -> int:
        return int(self.section.vllm.max_tokens)

    @property
    def VLLM_CHAT_MAX_TOKENS(self) -> int:
        if self.section.vllm.chat_max_tokens is not None:
            return int(self.section.vllm.chat_max_tokens)
        return self.VLLM_MAX_TOKENS

    @property
    def VLLM_PRESENCE_PENALTY(self) -> float:
        if self.section.vllm.presence_penalty is not None:
            return float(self.section.vllm.presence_penalty)
        return 0.0

    @property
    def VLLM_REPETITION_PENALTY(self) -> float:
        return float(self.section.vllm.repetition_penalty)


settings = TemplateRecommendationSettings()
