"""Merge the template-policy and Teacher Judge submission migration heads.

Revision ID: tplmrg01_join_tjsub02
Revises: tjsub02, tplcat02_student_requestable
Create Date: 2026-09-03

Upstream added ``tjsub01`` → ``tjsub02`` on top of ``wgpeer01`` while this
fork hung ``tplgpu02`` → ``tplicon01`` → ``tplcat02`` off the same parent, so
``alembic upgrade head`` saw two heads.  Both branches already contain their
schema changes; this revision only joins the version graph so ``head`` is a
single deterministic target again.
"""

from __future__ import annotations

revision = "tplmrg01_join_tjsub02"
down_revision = ("tjsub02", "tplcat02_student_requestable")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
