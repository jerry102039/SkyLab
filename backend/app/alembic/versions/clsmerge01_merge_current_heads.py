"""Merge the AI-PVE and class-allocation migration heads.

Revision ID: clsmerge01_current_heads
Revises: aipve03_merge_all_heads, clsalloc01_student_placements
Create Date: 2026-09-03

Both parent branches already contain their own schema/data changes.  This
revision only joins the graph so ``alembic upgrade head`` has one deterministic
target for prestart and CI.
"""

from __future__ import annotations

revision = "clsmerge01_current_heads"
down_revision = ("aipve03_merge_all_heads", "clsalloc01_student_placements")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
