"""Ensure `app` is importable when pytest runs from `server/`."""

import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))
