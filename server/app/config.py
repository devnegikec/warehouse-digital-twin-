"""Application settings. Credentials come from the environment, never from alembic.ini."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql+psycopg://warehouse:warehouse@localhost:5433/warehouse"
    api_prefix: str = "/api"
    """Port 5433 matches docker-compose.yml, so a Homebrew Postgres on 5432 is untouched."""


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
