"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-09-22

Hand-reviewed rather than taken straight from autogenerate. Two things autogenerate
handles badly and that are done explicitly here:

  * the native ``version_status`` enum type, created before it is referenced and
    dropped after its last user;
  * the partial unique index enforcing one PUBLISHED layout per warehouse, which
    autogenerate does not detect at all.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# `create_type=False` is essential: without it, op.create_table() emits CREATE TYPE
# as a side effect of creating the column, which collides with the explicit
# CREATE TYPE below and fails with DuplicateObject. Autogenerate gets this wrong
# routinely, which is why every migration here is hand-reviewed.
version_status = postgresql.ENUM(
    "DRAFT", "PUBLISHED", "ARCHIVED", name="version_status", create_type=False
)


def _uuid_pk() -> sa.Column:
    return sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True)


def _timestamps() -> tuple[sa.Column, sa.Column]:
    return (
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )


def _metadata_column() -> sa.Column:
    return sa.Column(
        "metadata", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False
    )


def upgrade() -> None:
    op.execute("CREATE TYPE version_status AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED')")

    op.create_table(
        "warehouse",
        _uuid_pk(),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("code", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("length_m", sa.Float(), nullable=False),
        sa.Column("width_m", sa.Float(), nullable=False),
        sa.Column("height_m", sa.Float(), nullable=False),
        _metadata_column(),
        *_timestamps(),
    )
    op.create_index("ix_warehouse_tenant_id", "warehouse", ["tenant_id"])

    op.create_table(
        "layout_version",
        _uuid_pk(),
        sa.Column("warehouse_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", version_status, nullable=False, server_default="DRAFT"),
        sa.Column("doc", postgresql.JSONB(), nullable=False),
        sa.Column("doc_hash", sa.String(64), nullable=False),
        sa.Column(
            "diagnostics", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
        sa.Column(
            "orphaned_placements",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("created_by", sa.String(255), nullable=True),
        sa.Column("published_at", sa.DateTime(), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(["warehouse_id"], ["warehouse.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("warehouse_id", "version"),
    )
    op.create_index(
        "ix_layout_version_warehouse_id_status", "layout_version", ["warehouse_id", "status"]
    )
    # Exactly one PUBLISHED layout per warehouse — enforced by the database.
    op.create_index(
        "uq_layout_version_one_published",
        "layout_version",
        ["warehouse_id"],
        unique=True,
        postgresql_where=sa.text("status = 'PUBLISHED'"),
    )

    op.create_table(
        "aisle",
        _uuid_pk(),
        sa.Column("warehouse_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("orientation", sa.String(1), nullable=False),
        sa.Column("x1", sa.Float(), nullable=False),
        sa.Column("z1", sa.Float(), nullable=False),
        sa.Column("x2", sa.Float(), nullable=False),
        sa.Column("z2", sa.Float(), nullable=False),
        sa.Column("width_m", sa.Float(), nullable=False),
        sa.Column("travel_direction", sa.String(8), nullable=False, server_default="BOTH"),
        sa.Column("seq", sa.Integer(), nullable=False),
        _metadata_column(),
        *_timestamps(),
        sa.ForeignKeyConstraint(["warehouse_id"], ["warehouse.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("warehouse_id", "code"),
    )

    op.create_table(
        "lane",
        _uuid_pk(),
        sa.Column("aisle_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("side", sa.String(5), nullable=False),
        sa.Column("rack_type_code", sa.String(32), nullable=True),
        sa.Column("start_offset_m", sa.Float(), nullable=False),
        sa.Column("length_m", sa.Float(), nullable=False),
        sa.Column("levels", postgresql.JSONB(), nullable=False),
        sa.Column("segments", postgresql.JSONB(), nullable=False),
        sa.Column("bin_code_pattern", sa.String(128), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False, server_default="0"),
        _metadata_column(),
        *_timestamps(),
        sa.ForeignKeyConstraint(["aisle_id"], ["aisle.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("aisle_id", "code"),
    )

    op.create_table(
        "bay",
        _uuid_pk(),
        sa.Column("lane_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("start_m", sa.Float(), nullable=False),
        sa.Column("width_m", sa.Float(), nullable=False),
        sa.Column("is_skipped", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.ForeignKeyConstraint(["lane_id"], ["lane.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("lane_id", "seq"),
    )

    op.create_table(
        "bin",
        _uuid_pk(),
        sa.Column("warehouse_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("bay_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("code", sa.String(128), nullable=False),
        sa.Column("level_index", sa.Integer(), nullable=False),
        sa.Column("center_x", sa.Float(), nullable=False),
        sa.Column("center_y", sa.Float(), nullable=False),
        sa.Column("center_z", sa.Float(), nullable=False),
        sa.Column("width_m", sa.Float(), nullable=False),
        sa.Column("height_m", sa.Float(), nullable=False),
        sa.Column("depth_m", sa.Float(), nullable=False),
        sa.Column("rotation_deg", sa.Float(), nullable=False, server_default=sa.text("0")),
        sa.Column("capacity_m3", sa.Float(), nullable=False),
        sa.Column("max_weight_kg", sa.Float(), nullable=True),
        _metadata_column(),
        sa.ForeignKeyConstraint(["warehouse_id"], ["warehouse.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["bay_id"], ["bay.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("warehouse_id", "code"),
    )
    op.create_index("ix_bin_warehouse_id", "bin", ["warehouse_id"])

    op.create_table(
        "sku_template",
        _uuid_pk(),
        sa.Column("warehouse_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sku", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("width_m", sa.Float(), nullable=False),
        sa.Column("height_m", sa.Float(), nullable=False),
        sa.Column("depth_m", sa.Float(), nullable=False),
        sa.Column("weight_kg", sa.Float(), nullable=False),
        sa.Column("stackable", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("rotatable", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("hazmat", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        _metadata_column(),
        *_timestamps(),
        sa.ForeignKeyConstraint(["warehouse_id"], ["warehouse.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("warehouse_id", "sku"),
    )

    op.create_table(
        "placement",
        _uuid_pk(),
        sa.Column("bin_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sku_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("qty", sa.Integer(), nullable=False),
        sa.Column("volume_used_m3", sa.Float(), nullable=False),
        sa.Column("weight_used_kg", sa.Float(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["bin_id"], ["bin.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sku_id"], ["sku_template.id"], ondelete="RESTRICT"),
        sa.UniqueConstraint("bin_id", "sku_id"),
    )
    op.create_index("ix_placement_sku_id", "placement", ["sku_id"])


def downgrade() -> None:
    op.drop_index("ix_placement_sku_id", table_name="placement")
    op.drop_table("placement")
    op.drop_table("sku_template")
    op.drop_index("ix_bin_warehouse_id", table_name="bin")
    op.drop_table("bin")
    op.drop_table("bay")
    op.drop_table("lane")
    op.drop_table("aisle")
    op.drop_index("uq_layout_version_one_published", table_name="layout_version")
    op.drop_index("ix_layout_version_warehouse_id_status", table_name="layout_version")
    op.drop_table("layout_version")
    op.drop_index("ix_warehouse_tenant_id", table_name="warehouse")
    op.drop_table("warehouse")
    op.execute("DROP TYPE version_status")
