"""Write the FastAPI OpenAPI schema to ``openapi.json`` at the repository root.

The schema is the single source of the wire contract: ``openapi-typescript`` turns it
into ``src/design/persistence/apiTypes.ts``, so the client can never drift from the
routes. Run via ``npm run gen:api-types``.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.main import app

TARGET = Path(__file__).resolve().parents[1] / "openapi.json"


def main() -> None:
    TARGET.write_text(json.dumps(app.openapi(), indent=2) + "\n", encoding="utf-8")
    print(f"wrote {TARGET}")


if __name__ == "__main__":
    main()
