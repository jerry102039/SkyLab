"""Add per-item student completion state.

Revision ID: tjsub02
Revises: tjsub01
"""

import sqlalchemy as sa
from alembic import op

revision = "tjsub02"
down_revision = "tjsub01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "teacher_judge_student_submissions",
        sa.Column(
            "completed_item_ids",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'::json"),
        ),
    )
    op.alter_column(
        "teacher_judge_student_submissions",
        "is_ready",
        server_default=sa.false(),
    )


def downgrade() -> None:
    op.alter_column(
        "teacher_judge_student_submissions",
        "is_ready",
        server_default=sa.true(),
    )
    op.drop_column(
        "teacher_judge_student_submissions",
        "completed_item_ids",
    )
