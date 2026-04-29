from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


NavigationAction = Literal["navigate", "suggest", "clarify"]


class NavigationResolveRequest(BaseModel):
    query: str = Field(..., min_length=2, max_length=2000)


class NavigationTarget(BaseModel):
    title: str
    path: str
    reason: str = ""


class NavigationResolveResponse(BaseModel):
    intent: str
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    action: NavigationAction
    primary: NavigationTarget | None = None
    suggestions: list[NavigationTarget] = Field(default_factory=list)
    clarification_question: str | None = None

