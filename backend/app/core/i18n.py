"""API-facing message translation.

Message catalogs live under app/locales/<lang>/<namespace>.json — one flat
dict of message_key -> template per namespace file, merged per language.
Call sites resolve the current request's language via the ContextVar set by
RequestContextMiddleware (parsed from the frontend's Accept-Language header)
and translate a key at raise time:

    from app.core.i18n import t
    raise AppError(t("resource.not_found"), 404)
    raise HTTPException(status_code=409, detail=t("vm.name_conflict", name=name))

Templates use str.format placeholders, e.g. "找不到 VM {vmid}"。
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

from app.core.request_context import (
    DEFAULT_LANGUAGE,
    SUPPORTED_LANGUAGES,
    get_request_context,
    resolve_language,
)

__all__ = [
    "DEFAULT_LANGUAGE",
    "SUPPORTED_LANGUAGES",
    "get_current_language",
    "resolve_language",
    "t",
    "translate",
]

_LOCALES_DIR = Path(__file__).resolve().parent.parent / "locales"


@cache
def _catalog(lang: str) -> dict[str, str]:
    lang_dir = _LOCALES_DIR / lang
    if not lang_dir.is_dir():
        return {}
    merged: dict[str, str] = {}
    for path in sorted(lang_dir.glob("*.json")):
        merged.update(json.loads(path.read_text(encoding="utf-8")))
    return merged


def get_current_language() -> str:
    return get_request_context().language


def translate(key: str, lang: str, **params: object) -> str:
    catalog = _catalog(lang if lang in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE)
    template = catalog.get(key)
    if template is None:
        template = _catalog(DEFAULT_LANGUAGE).get(key, key)
    if not params:
        return template
    try:
        return template.format(**params)
    except (KeyError, IndexError):
        return template


def t(key: str, **params: object) -> str:
    """Translate `key` using the current request's language (from ContextVar)."""
    return translate(key, get_current_language(), **params)
