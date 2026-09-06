from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel

BACKEND_ROOT = Path(__file__).resolve().parents[3]
CONFIG_FILE = BACKEND_ROOT / "config" / "placement.json"


class PlacementConfig(BaseModel):
    source_cache_ttl_seconds: int = 20
    guest_pressure_threshold: float = 0.85
    guest_per_core_limit: float = 2.0
    placement_headroom_ratio: float = 0.1


def load_placement_config() -> PlacementConfig:
    if not CONFIG_FILE.exists():
        return PlacementConfig()

    payload = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("placement.json must be a JSON object")

    return PlacementConfig.model_validate(payload)


class PlacementSettings:
    def __init__(self, section: PlacementConfig | None = None) -> None:
        self.section = section or load_placement_config()

    @property
    def source_cache_ttl_seconds(self) -> int:
        return int(self.section.source_cache_ttl_seconds)

    @property
    def guest_pressure_threshold(self) -> float:
        return float(self.section.guest_pressure_threshold)

    @property
    def guest_per_core_limit(self) -> float:
        return float(self.section.guest_per_core_limit)

    @property
    def placement_headroom_ratio(self) -> float:
        return float(self.section.placement_headroom_ratio)


settings = PlacementSettings()
