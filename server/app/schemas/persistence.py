"""Pydantic DTOs for the persistence wire contract (Phase 7).

Field names are camelCase to match the TypeScript client and the existing
``CompileResponse``; the API surface is mirrored on the TS side from this app's
OpenAPI schema, so the names are part of the contract rather than cosmetic.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class FootprintIn(BaseModel):
    """The physical envelope. Mirrored into the ``warehouse`` table on every write."""

    code: str = Field(min_length=1, max_length=64)
    name: str = ""
    lengthM: float = Field(gt=0)
    widthM: float = Field(gt=0)
    heightM: float = Field(gt=0)
    origin: dict[str, float] | None = None


class WarehouseCreate(FootprintIn):
    """A warehouse starts from a footprint, with an optional first document.

    Supplying ``doc`` lets the client seed a new warehouse from the layout it already
    has open instead of round-tripping a blank one through a draft save.
    """

    doc: dict[str, Any] | None = None


class VersionOut(BaseModel):
    version: int
    status: str
    docHash: str
    createdAt: datetime
    publishedAt: datetime | None = None
    createdBy: str | None = None
    errorCount: int = 0
    warningCount: int = 0
    orphanedPlacements: list[dict[str, Any]] = Field(default_factory=list)


class WarehouseOut(BaseModel):
    id: UUID
    code: str
    name: str
    lengthM: float
    widthM: float
    heightM: float
    draftRevision: int
    """The ``If-Match`` token the client must echo on the next draft save."""
    draft: VersionOut | None = None
    published: VersionOut | None = None


class DraftPut(BaseModel):
    doc: dict[str, Any]
    clientDocHash: str | None = None
    """The TypeScript hash. A mismatch is refused as COMPILER_DRIFT rather than stored."""


class DraftOut(BaseModel):
    warehouseId: UUID
    version: int
    draftRevision: int
    docHash: str
    publishable: bool
    errorCount: int
    warningCount: int
    diagnostics: list[dict[str, Any]]
    savedAt: datetime


class PublishRequest(BaseModel):
    doc: dict[str, Any]
    clientDocHash: str | None = None
    createdBy: str | None = None


class PublishOut(BaseModel):
    warehouseId: UUID
    version: int
    docHash: str
    status: str
    changed: bool
    """False when the same document was already published — publishing is idempotent."""
    binCount: int
    bayCount: int
    errorCount: int
    warningCount: int
    diagnostics: list[dict[str, Any]]
    orphanedPlacements: list[dict[str, Any]]


class PublishedLayoutOut(BaseModel):
    """What Operate mode reads.

    Bins come from the materialised rows rather than from a fresh compile, because
    those rows carry the surrogate ids that placements reference. ``docHash`` and
    ``recompiledDocHash`` are both returned so drift between the snapshot and the
    current compiler is visible instead of assumed away.
    """

    warehouseId: UUID
    code: str
    version: int
    docHash: str
    recompiledDocHash: str
    publishedAt: datetime | None
    bins: list[dict[str, Any]]
    conflicts: list[str] = Field(default_factory=list)
