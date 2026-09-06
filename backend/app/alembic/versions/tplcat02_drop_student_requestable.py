"""Drop VMTemplate.student_requestable.

Whether a student may pick a template in the request form is now decided by
visibility alone (global = open to students, private = owner only), so the
separate flag goes away. Idempotent in both directions because shared dev
databases may drift from this chain.

Revision ID: tplcat02_student_requestable
Revises: tplicon01_drop_icon_url
Create Date: 2026-09-02
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "tplcat02_student_requestable"
down_revision = "tplicon01_drop_icon_url"
branch_labels = None
depends_on = None

_TABLE = "vm_templates"
_COLUMN = "student_requestable"


def _has_column() -> bool:
    inspector = sa.inspect(op.get_bind())
    return any(col["name"] == _COLUMN for col in inspector.get_columns(_TABLE))


def upgrade() -> None:
    if not _has_column():
        return
    op.drop_column(_TABLE, _COLUMN)


def downgrade() -> None:
    if _has_column():
        return
    op.add_column(
        _TABLE,
        sa.Column(_COLUMN, sa.Boolean(), nullable=False, server_default=sa.false()),
    )
