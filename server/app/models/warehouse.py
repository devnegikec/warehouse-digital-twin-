"""Warehouse and its versioned layout documents."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Enum, ForeignKey, Index, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, VersionStatus, new_uuid


class Warehouse(Base, TimestampMixin):
    __tablename__ = "warehouse"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    #: Tenancy seam (§1 row 11). Nullable and unpopulated in v1; threading it through
    #: every table is unnecessary because it is derivable via warehouse_id.
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(255))
    length_m: Mapped[float]
    width_m: Mapped[float]
    height_m: Mapped[float]
    draft_revision: Mapped[int] = mapped_column(default=0, server_default=text("0"))
    """Optimistic-locking token for draft autosave.

    The draft is one row per warehouse, so its ``version`` number does not change on
    save and cannot serve as an ``If-Match`` token — every save would look valid and
    two editors would silently overwrite each other. This counter increments on every
    accepted draft write, so a stale client is detected instead of believed.
    """
    metadata_: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, default=dict, server_default=text("'{}'::jsonb")
    )

    versions: Mapped[list[LayoutVersion]] = relationship(
        back_populates="warehouse", cascade="all, delete-orphan"
    )
    aisles: Mapped[list[Aisle]] = relationship(  # noqa: F821
        back_populates="warehouse", cascade="all, delete-orphan"
    )
    skus: Mapped[list[SkuTemplate]] = relationship(  # noqa: F821
        back_populates="warehouse", cascade="all, delete-orphan"
    )


class LayoutVersion(Base, TimestampMixin):
    __tablename__ = "layout_version"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    warehouse_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("warehouse.id", ondelete="CASCADE"))
    version: Mapped[int]
    status: Mapped[VersionStatus] = mapped_column(
        Enum(VersionStatus, name="version_status", values_callable=lambda e: [m.value for m in e]),
        default=VersionStatus.DRAFT,
        server_default="DRAFT",
    )
    doc: Mapped[dict[str, Any]] = mapped_column(JSONB)
    """The LayoutDoc exactly as compiled — the reproducible compiler input."""
    doc_hash: Mapped[str] = mapped_column(String(64))
    """sha256 of canonical JSON. Idempotency key for publish (P4)."""
    diagnostics: Mapped[list[Any]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    orphaned_placements: Mapped[list[Any]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    """Placements whose bin disappeared in this version — flagged, never deleted (§1 row 14)."""
    created_by: Mapped[str | None] = mapped_column(String(255))
    published_at: Mapped[datetime | None]

    warehouse: Mapped[Warehouse] = relationship(back_populates="versions")

    __table_args__ = (
        UniqueConstraint("warehouse_id", "version"),
        Index("ix_layout_version_warehouse_id_status", "warehouse_id", "status"),
        # Exactly one PUBLISHED layout per warehouse, enforced by the database
        # rather than by application code (§5).
        Index(
            "uq_layout_version_one_published",
            "warehouse_id",
            unique=True,
            postgresql_where=text("status = 'PUBLISHED'"),
        ),
    )
