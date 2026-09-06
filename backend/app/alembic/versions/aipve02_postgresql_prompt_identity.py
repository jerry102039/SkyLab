"""Tell the PostgreSQL AI template to use the postgres OS identity for DB access.

Revision ID: aipve02_pg_prompt_identity
Revises: tjmerge03_all_heads
Create Date: 2026-08-31
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "aipve02_pg_prompt_identity"
down_revision = "tjmerge03_all_heads"
branch_labels = None
depends_on = None


_PROMPT_MARKER = "PostgreSQL 資料庫登入身份："
POSTGRESQL_DATABASE_ACCESS_INSTRUCTION = (
    f"{_PROMPT_MARKER}執行需要登入 PostgreSQL 或執行 SQL 查詢的資料庫指令時，"
    "預設先使用 `su - postgres` 切換到作業系統的 `postgres` 使用者，再執行資料庫指令，"
    "例如 `su - postgres -c \"psql ...\"`。不要直接以 SSH 登入的 `root` 身份執行 "
    "`psql` 登入資料庫，因為 PostgreSQL 的 peer authentication 可能拒絕 root。"
    "SSH 仍可由後端以 root 連入 guest，但資料庫指令的執行身份必須是 `postgres`。"
    "若 `su - postgres` 或資料庫指令失敗，請依 exit code、stdout、stderr 回報原因，"
    "不要改用 root 繞過登入，也不要索取或輸出密碼、連線字串或其他敏感資料。"
)
_PROMPT_SUFFIX = f"\n\n{POSTGRESQL_DATABASE_ACCESS_INSTRUCTION}"


def _template_table() -> sa.TableClause:
    return sa.table(
        "ai_pve_templates",
        sa.column("template_key", sa.String()),
        sa.column("system_prompt", sa.Text()),
    )


def upgrade() -> None:
    """Append the instruction without overwriting administrator prompt edits."""
    table = _template_table()
    op.execute(
        sa.update(table)
        .where(table.c.template_key == "postgresql")
        .where(~table.c.system_prompt.contains(_PROMPT_MARKER))
        .values(system_prompt=table.c.system_prompt + sa.literal(_PROMPT_SUFFIX))
    )


def downgrade() -> None:
    """Remove only the exact paragraph added by this migration."""
    table = _template_table()
    op.execute(
        sa.update(table)
        .where(table.c.template_key == "postgresql")
        .where(table.c.system_prompt.contains(_PROMPT_SUFFIX))
        .values(
            system_prompt=sa.func.replace(
                table.c.system_prompt,
                sa.literal(_PROMPT_SUFFIX),
                sa.literal(""),
            )
        )
    )
