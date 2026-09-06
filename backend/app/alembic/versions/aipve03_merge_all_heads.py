"""Merge the PostgreSQL prompt and quick-practice migration heads.

Revision ID: aipve03_merge_all_heads
Revises: aipve02_pg_prompt_identity, ce04_env_concurrency
Create Date: 2026-08-31

Both parent revisions already contain their own changes.  This revision only
joins the graph so ``alembic upgrade head`` has one deterministic target.
"""

from __future__ import annotations

revision = "aipve03_merge_all_heads"
down_revision = ("aipve02_pg_prompt_identity", "ce04_env_concurrency")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
