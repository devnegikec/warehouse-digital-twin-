"""Canonical serialisation and the layout content hash.

Python mirror of ``layout-core/src/canonical.ts``. The output must be
byte-identical to the TypeScript implementation, otherwise Publish rejects
itself with ``409 COMPILER_DRIFT``.

Rules (see §6 of the design document):
  1. Object keys sorted by code point (keys here are ASCII identifiers).
  2. Numbers in fixed notation, 6 decimals, trailing zeros stripped, ``-0`` -> ``0``.
  3. Strings JSON-escaped, non-ASCII passed through (``ensure_ascii=False``).
  4. Array order preserved.
  5. ``None`` members dropped, mirroring ``JSON.stringify`` dropping ``undefined``.
  6. sha256 over the UTF-8 bytes, lowercase hex.
"""

from __future__ import annotations

import hashlib
import json
import math

from .units import PRECISION, js_round

_TO_FIXED_CUTOFF = 1e21


def format_number(value: float) -> str:
    """Fixed-notation formatter matching TypeScript's ``formatNumber``."""
    if not math.isfinite(value):
        raise ValueError(f"Cannot canonicalise a non-finite number: {value}")

    rounded = js_round(value, PRECISION)

    # Python's 'f' formatting already avoids exponentials at any magnitude, but
    # going through int() keeps the large-magnitude path obviously exact and
    # symmetric with the BigInt branch on the TypeScript side.
    if abs(rounded) >= _TO_FIXED_CUTOFF:
        return str(int(rounded))

    int_part, _, fraction = f"{rounded:.{PRECISION}f}".partition(".")
    trimmed = fraction.rstrip("0")
    out = f"{int_part}.{trimmed}" if trimmed else int_part
    return "0" if out == "-0" else out


def canonicalize(value: object) -> str:
    """Deterministic serialisation. Structurally equal documents produce equal strings."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return format_number(float(value))
    if isinstance(value, float):
        return format_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        members = []
        for key in sorted(value.keys()):
            item = value[key]
            if item is None:
                continue
            members.append(f"{json.dumps(key, ensure_ascii=False)}:{canonicalize(item)}")
        return "{" + ",".join(members) + "}"

    raise TypeError(f"Unsupported value in layout document: {type(value).__name__}")


def sha256_hex(message: str) -> str:
    return hashlib.sha256(message.encode("utf-8")).hexdigest()


def doc_hash(normalized_doc: object) -> str:
    """Content hash of a normalised layout document."""
    return sha256_hex(canonicalize(normalized_doc))
