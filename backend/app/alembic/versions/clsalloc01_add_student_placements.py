"""Add student_placements to class_capacity_reservations.

整班的建機落點：{machine_node_id: {user_id: 節點名}}。

一堂課的所有學生固定在同一個叢集（跨叢集 L2 不通、同名 bridge 指向不同的
實體網路），但叢集內會依容量把學生分散到不同節點 —— 同一個叢集不代表同一
台 server。分配在容量預留時定案並存下來，建機時直接查表，避免兩個時間點
各自重算而讓落點與預留不一致。

空字典 = 未分配（舊資料），建機端沿用既有的單一節點行為。

Revision ID: clsalloc01_student_placements
Revises: pgrp01_placement_group
Create Date: 2026-09-03 00:00:00.000000

"""

import sqlalchemy as sa
from alembic import op

revision = "clsalloc01_student_placements"
down_revision = "pgrp01_placement_group"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "class_capacity_reservations",
        sa.Column(
            "student_placements",
            sa.Text(),
            nullable=False,
            server_default="{}",
        ),
    )


def downgrade():
    op.drop_column("class_capacity_reservations", "student_placements")
