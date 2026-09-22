"""warehouse draft revision counter

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-22

Adds ``warehouse.draft_revision``: the optimistic-locking token for draft autosave.

Why a counter rather than a timestamp or the version number:

  * The draft is a *single* row per warehouse, so its ``version`` number does not
    change on save. Using it as an ``If-Match`` token would make every save look
    valid, which is last-write-wins rather than optimistic locking — two people
    editing the same draft would silently overwrite each other.
  * ``updated_at`` has no guaranteed resolution and its timezone handling would leak
    into the comparison.
  * A monotonic integer is unambiguous, cheap to compare, and trivial to assert in a
    concurrency test.

``server_default="0"`` is paired with the model's ``server_default`` so
``alembic check`` stays clean (§5.5 gotcha: a model default without a matching
server default makes autogenerate compare a Python default against NULL forever).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "warehouse",
        sa.Column("draft_revision", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )


def downgrade() -> None:
    op.drop_column("warehouse", "draft_revision")
