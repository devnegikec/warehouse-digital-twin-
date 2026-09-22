"""Engine and session factory. Sync psycopg 3 (§1 row 16)."""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Base

engine = create_engine(settings.database_url, pool_pre_ping=True, future=True)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    """FastAPI dependency."""
    with SessionLocal() as session:
        yield session


__all__ = ["Base", "engine", "SessionLocal", "get_session"]
