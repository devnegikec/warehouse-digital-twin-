"""Materialised structure: aisle -> lane -> bay -> bin.

Written in one transaction on Publish from the output of ``build_layout``.
Geometry columns are a denormalised snapshot; ``layout_version.doc`` remains the
source of truth and everything here can be recomputed (P2, P5).
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ForeignKey, Index, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, new_uuid


class Aisle(Base, TimestampMixin):
    __tablename__ = "aisle"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    warehouse_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("warehouse.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(32))
    orientation: Mapped[str] = mapped_column(String(1))
    """Derived from the centerline: 'X' or 'Z'."""
    x1: Mapped[float]
    z1: Mapped[float]
    x2: Mapped[float]
    z2: Mapped[float]
    width_m: Mapped[float]
    travel_direction: Mapped[str] = mapped_column(String(8), default="BOTH", server_default="BOTH")
    seq: Mapped[int]
    metadata_: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, default=dict, server_default=text("'{}'::jsonb")
    )

    warehouse: Mapped[Warehouse] = relationship(back_populates="aisles")  # noqa: F821
    lanes: Mapped[list[Lane]] = relationship(
        back_populates="aisle", cascade="all, delete-orphan", order_by="Lane.seq"
    )

    __table_args__ = (UniqueConstraint("warehouse_id", "code"),)


class Lane(Base, TimestampMixin):
    __tablename__ = "lane"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    aisle_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("aisle.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(32))
    side: Mapped[str] = mapped_column(String(5))
    """'LEFT' or 'RIGHT'."""
    rack_type_code: Mapped[str | None] = mapped_column(String(32))
    start_offset_m: Mapped[float]
    length_m: Mapped[float]
    levels: Mapped[list[Any]] = mapped_column(JSONB)
    """RackLevel[] — small and structural, so JSONB rather than its own table."""
    segments: Mapped[list[Any]] = mapped_column(JSONB)
    """LaneSegment[] — RACK | GAP runs, which is how doorways and splits are modelled."""
    bin_code_pattern: Mapped[str] = mapped_column(String(128))
    seq: Mapped[int] = mapped_column(default=0, server_default=text("0"))
    metadata_: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, default=dict, server_default=text("'{}'::jsonb")
    )

    aisle: Mapped[Aisle] = relationship(back_populates="lanes")
    bays: Mapped[list[Bay]] = relationship(
        back_populates="lane", cascade="all, delete-orphan", order_by="Bay.seq"
    )

    __table_args__ = (UniqueConstraint("aisle_id", "code"),)


class Bay(Base):
    __tablename__ = "bay"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    lane_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("lane.id", ondelete="CASCADE"))
    #: Named `seq`, not `index`: avoids both the SQL keyword and a declarative clash.
    seq: Mapped[int]
    """1-based bay number, as humans count and as bin codes render it."""
    start_m: Mapped[float]
    width_m: Mapped[float]
    is_skipped: Mapped[bool] = mapped_column(default=False, server_default=text("false"))

    lane: Mapped[Lane] = relationship(back_populates="bays")
    bins: Mapped[list[Bin]] = relationship(back_populates="bay", cascade="all, delete-orphan")

    __table_args__ = (UniqueConstraint("lane_id", "seq"),)


class Bin(Base):
    __tablename__ = "bin"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    warehouse_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("warehouse.id", ondelete="CASCADE"))
    bay_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bay.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(128))
    """Natural key, e.g. 'WH1/A03/L/B012/L2'. Stable across re-publishes (P3)."""
    level_index: Mapped[int]
    """0-based internally; bin codes render level_index + 1."""

    center_x: Mapped[float]
    center_y: Mapped[float]
    center_z: Mapped[float]
    width_m: Mapped[float]
    height_m: Mapped[float]
    depth_m: Mapped[float]
    rotation_deg: Mapped[float] = mapped_column(default=0.0, server_default=text("0"))
    """0 when the aisle runs along X, 90 when along Z."""

    capacity_m3: Mapped[float]
    """Usable volume, utilisation factor applied."""
    max_weight_kg: Mapped[float | None]
    """Beam UDL for this level (§1 row 13)."""
    metadata_: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, default=dict, server_default=text("'{}'::jsonb")
    )

    bay: Mapped[Bay] = relationship(back_populates="bins")
    placements: Mapped[list[Placement]] = relationship(  # noqa: F821
        back_populates="bin", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("warehouse_id", "code"),
        Index("ix_bin_warehouse_id", "warehouse_id"),
    )
