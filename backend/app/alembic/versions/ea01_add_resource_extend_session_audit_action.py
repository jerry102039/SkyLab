"""add resource_extend_session audit action

Revision ID: ea01_add_resource_extend_session
Revises: d4f05b0e324a
Create Date: 2026-05-12 00:00:00.000000

"""
from alembic import op

revision = 'ea01_add_resource_extend_session'
down_revision = 'd4f05b0e324a'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TYPE auditaction ADD VALUE IF NOT EXISTS 'resource_extend_session'")


def downgrade():
    pass
