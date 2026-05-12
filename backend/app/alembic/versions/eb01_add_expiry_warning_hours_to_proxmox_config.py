"""add expiry_warning_hours to proxmox_config

Revision ID: eb01_add_expiry_warning_hours
Revises: ea01_add_resource_extend_session
Create Date: 2026-05-12 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

revision = 'eb01_add_expiry_warning_hours'
down_revision = 'ea01_add_resource_extend_session'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('proxmox_config', sa.Column('expiry_warning_hours', sa.Integer(), nullable=False, server_default='24'))


def downgrade():
    op.drop_column('proxmox_config', 'expiry_warning_hours')
