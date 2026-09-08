"""課程環境的「外網 → 機器」宣告：每位學生各配一個網址。

網域是全域唯一的資源，模板上不可能填一個全班共用的網址，所以老師只宣告
主機名樣板，實際網域在開課／開練習時逐人組出來。
"""

import uuid
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.api.routes.course_environments import EnvironmentPublicationIn
from app.models import CourseEnvironmentPublication
from app.services.teaching import course_publication_service as cps


def _user(email: str) -> SimpleNamespace:
    return SimpleNamespace(id=uuid.UUID("11111111-2222-3333-4444-555555555555"), email=email)


def _publication(**overrides) -> CourseEnvironmentPublication:
    values = {
        "version_id": uuid.uuid4(),
        "node_key": "n8n",
        "mode": "domain",
        "port": 5678,
        "protocol": "tcp",
        "hostname_prefix": "{student}-n8n",
        "zone_id": "zone-1",
        "enable_https": True,
    }
    values.update(overrides)
    return CourseEnvironmentPublication(**values)


# ── 學生識別片段 ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "email,expected",
    [
        ("alice@school.edu", "alice"),
        ("Alice.Wang@school.edu", "alice-wang"),
        ("a_b+c@school.edu", "a-b-c"),
        ("--weird--@school.edu", "weird"),
    ],
)
def test_student_token_is_dns_safe(email: str, expected: str) -> None:
    assert cps.student_token(_user(email)) == expected


def test_student_token_falls_back_to_user_id() -> None:
    """帳號清完是空的（例如全形字元）時仍要產生合法的主機名片段。"""
    token = cps.student_token(_user("測試@school.edu"))
    assert token.startswith("u") and token[1:].isalnum()


# ── 網域組合 ────────────────────────────────────────────────────────────


def _patch_zone_and_availability(monkeypatch, *, available: bool):
    monkeypatch.setattr(
        cps.cloudflare_service,
        "get_zone",
        lambda **_kwargs: SimpleNamespace(name="lab.example.edu"),
    )
    monkeypatch.setattr(
        cps.reverse_proxy_service,
        "check_domain_availability",
        lambda *_args, **_kwargs: SimpleNamespace(available=available, reason="system"),
    )


def test_each_student_gets_their_own_domain(monkeypatch) -> None:
    _patch_zone_and_availability(monkeypatch, available=True)

    domain = cps.resolve_domain(
        Mock(), publication=_publication(), user=_user("alice@school.edu"), vmid=101
    )

    assert domain == "alice-n8n.lab.example.edu"


def test_collision_falls_back_to_a_suffixed_hostname(monkeypatch) -> None:
    """兩個帳號清完可能撞在一起（alice.wang 與 alice_wang），補短碼區分。"""
    _patch_zone_and_availability(monkeypatch, available=False)

    domain = cps.resolve_domain(
        Mock(), publication=_publication(), user=_user("alice@school.edu"), vmid=101
    )

    assert domain.startswith("alice-1111-n8n.") or domain == "alice-1111-n8n.lab.example.edu"


# ── 模板驗證 ────────────────────────────────────────────────────────────


def _publication_in(**overrides) -> dict:
    values = {
        "node_key": "n8n",
        "mode": "domain",
        "port": 5678,
        "protocol": "tcp",
        "hostname_prefix": "{student}-n8n",
        "zone_id": "zone-1",
    }
    values.update(overrides)
    return values


def test_domain_mode_requires_the_student_placeholder() -> None:
    """少了 {student}，全班會搶同一個網址，只有第一位學生拿得到。"""
    with pytest.raises(ValueError):
        EnvironmentPublicationIn(**_publication_in(hostname_prefix="n8n"))


def test_domain_mode_requires_a_zone() -> None:
    with pytest.raises(ValueError):
        EnvironmentPublicationIn(**_publication_in(zone_id=None))


def test_domain_mode_rejects_udp() -> None:
    with pytest.raises(ValueError):
        EnvironmentPublicationIn(**_publication_in(protocol="udp"))


def test_firewall_only_mode_drops_domain_fields() -> None:
    publication = EnvironmentPublicationIn(
        **_publication_in(mode="firewall_only", protocol="udp")
    )

    assert publication.hostname_prefix is None
    assert publication.zone_id is None
