"""FastAPI application.

The compiler endpoints (``/api/layout/*``) are the cross-language contract made
executable. The persistence endpoints (``/api/warehouses``) arrive in Phase 7 on top
of the models in ``app.models``.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from .api import inventory, warehouses
from .config import settings
from .db import get_session
from .layout import DocumentInvalid, LayoutGraph, build_layout, validate_document

SessionDep = Annotated[Session, Depends(get_session)]

app = FastAPI(
    title="Warehouse Designer API",
    version="0.0.0",
    description=(
        "Authoritative layout compiler and persistence for the 3D warehouse designer. "
        "The TypeScript compiler in packages/layout-core is the interactive mirror of "
        "the compiler used here; both are pinned by fixtures/layout-conformance."
    ),
)


class LayoutPayload(BaseModel):
    doc: dict[str, Any]
    clientDocHash: str | None = None
    """The TypeScript-computed hash. A mismatch means the compilers have diverged (P9)."""


class CompileResponse(BaseModel):
    docHash: str
    publishable: bool
    binCount: int
    bayCount: int
    errorCount: int
    warningCount: int
    diagnostics: list[dict[str, Any]]
    bins: list[dict[str, Any]] | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/db")
def health_db(session: SessionDep) -> dict[str, str]:
    session.execute(text("SELECT 1"))
    return {"status": "ok", "database": "reachable"}


def _compile(payload: LayoutPayload, *, include_bins: bool) -> CompileResponse:
    try:
        validate_document(payload.doc)
    except DocumentInvalid as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "DOCUMENT_INVALID", "errors": exc.errors},
        ) from exc

    graph: LayoutGraph = build_layout(payload.doc)

    # The drift alarm that makes the dual implementation safe (P9). Without this,
    # a divergence would silently write wrong bins into the database.
    if payload.clientDocHash and payload.clientDocHash != graph.hash:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "COMPILER_DRIFT",
                "message": "The TypeScript and Python compilers disagree on this document",
                "clientDocHash": payload.clientDocHash,
                "serverDocHash": graph.hash,
            },
        )

    return CompileResponse(
        docHash=graph.hash,
        publishable=graph.publishable,
        binCount=len(graph.bins),
        bayCount=len(graph.bays),
        errorCount=graph.error_count,
        warningCount=graph.warning_count,
        diagnostics=[diagnostic.to_json() for diagnostic in graph.diagnostics],
        bins=[bin_.to_json() for bin_ in graph.bins] if include_bins else None,
    )


@app.post("/api/layout/validate")
def validate_layout(payload: LayoutPayload) -> CompileResponse:
    """Run the rules without writing anything. Used by the editor's diagnostics panel."""
    return _compile(payload, include_bins=False)


@app.post("/api/layout/compile")
def compile_layout(payload: LayoutPayload) -> CompileResponse:
    """Compile and return the derived bins, checking the client hash if supplied."""
    return _compile(payload, include_bins=True)


app.include_router(warehouses.router, prefix=settings.api_prefix)
app.include_router(inventory.router, prefix=settings.api_prefix)
