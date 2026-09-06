"""Add student completion signals.

Revision ID: tjsub01
Revises: wgpeer01
"""

import sqlalchemy as sa
from alembic import op

revision = "tjsub01"
down_revision = "wgpeer01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "teacher_judge_student_submissions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("teaching_class_id", sa.Uuid(), nullable=False),
        sa.Column("artifact_id", sa.Uuid(), nullable=False),
        sa.Column("student_id", sa.Uuid(), nullable=False),
        sa.Column("is_ready", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["artifact_id"], ["teacher_judge_script_artifacts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["student_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["teaching_class_id"], ["teaching_classes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "artifact_id",
            "student_id",
            name="uq_teacher_judge_student_submission_artifact_student",
        ),
    )
    op.create_index(
        "ix_teacher_judge_student_submissions_artifact_id",
        "teacher_judge_student_submissions",
        ["artifact_id"],
    )
    op.create_index(
        "ix_teacher_judge_student_submissions_student_id",
        "teacher_judge_student_submissions",
        ["student_id"],
    )
    op.create_index(
        "ix_teacher_judge_student_submissions_teaching_class_id",
        "teacher_judge_student_submissions",
        ["teaching_class_id"],
    )
    op.create_index(
        "ix_teacher_judge_student_submissions_class_artifact_ready",
        "teacher_judge_student_submissions",
        ["teaching_class_id", "artifact_id", "is_ready"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_teacher_judge_student_submissions_class_artifact_ready",
        table_name="teacher_judge_student_submissions",
    )
    op.drop_index(
        "ix_teacher_judge_student_submissions_teaching_class_id",
        table_name="teacher_judge_student_submissions",
    )
    op.drop_index(
        "ix_teacher_judge_student_submissions_student_id",
        table_name="teacher_judge_student_submissions",
    )
    op.drop_index(
        "ix_teacher_judge_student_submissions_artifact_id",
        table_name="teacher_judge_student_submissions",
    )
    op.drop_table("teacher_judge_student_submissions")
