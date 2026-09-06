"""Add placement_group_id to vm_requests for group affinity.

同一組機器（快速練習 Session、課堂班級、課程部署）共用一個
placement_group_id。placement 以此把整組約束在同一個 connection
（硬約束，跨叢集 L2 不通）與同一個節點（連貫環境需求）。

NULL = 不屬於任何群組，行為與過去完全相同。

Revision ID: pgrp01_placement_group
Revises: tplmrg01_join_tjsub02
Create Date: 2026-09-03 00:00:00.000000

"""

import sqlalchemy as sa
from alembic import op

revision = "pgrp01_placement_group"
down_revision = "tplmrg01_join_tjsub02"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "vm_requests",
        sa.Column("placement_group_id", sa.Uuid(), nullable=True),
    )
    # 群組查詢一律帶時間窗（找同組已落點的機器），複合索引直接服務該查詢
    op.create_index(
        "ix_vm_requests_placement_group",
        "vm_requests",
        ["placement_group_id", "start_at", "end_at"],
    )


def downgrade():
    op.drop_index("ix_vm_requests_placement_group", table_name="vm_requests")
    op.drop_column("vm_requests", "placement_group_id")
