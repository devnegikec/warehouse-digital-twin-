"""SKU templates and inventory placements.

``Placement`` is inventory state, never authored by the designer's geometry tools
(P5). Capacity checks live in ``app.layout.capacity`` and run on both sides.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ForeignKey, Index, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, new_uuid


class SkuTemplate(Base, TimestampMixin):
    __tablename__ = "sku_template"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    warehouse_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("warehouse.id", ondelete="CASCADE"))
    sku: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(255))
    width_m: Mapped[float]
    height_m: Mapped[float]
    depth_m: Mapped[float]
    weight_kg: Mapped[float]
    stackable: Mapped[bool] = mapped_column(default=True, server_default=text("true"))
    rotatable: Mapped[bool] = mapped_column(default=True, server_default=text("true"))
    """When false, only the authored orientation is legal in a bin."""
    hazmat: Mapped[bool] = mapped_column(default=False, server_default=text("false"))
    metadata_: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, default=dict, server_default=text("'{}'::jsonb")
    )

    warehouse: Mapped[Warehouse] = relationship(back_populates="skus")  # noqa: F821
    placements: Mapped[list[Placement]] = relationship(back_populates="sku")

    __table_args__ = (UniqueConstraint("warehouse_id", "sku"),)


class Placement(Base, TimestampMixin):
    __tablename__ = "placement"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    bin_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bin.id", ondelete="CASCADE"))
    sku_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sku_template.id", ondelete="RESTRICT"))
    qty: Mapped[int]
    volume_used_m3: Mapped[float]
    """Cached so utilisation queries do not need to re-derive item dims."""
    weight_used_kg: Mapped[float]

    bin: Mapped[Bin] = relationship(back_populates="placements")  # noqa: F821
    sku: Mapped[SkuTemplate] = relationship(back_populates="placements")

    __table_args__ = (
        UniqueConstraint("bin_id", "sku_id"),
        Index("ix_placement_sku_id", "sku_id"),
    )
