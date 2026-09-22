"""Deterministic bin codes — Python mirror of ``layout-core/src/ids.ts``."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

DEFAULT_BIN_CODE_PATTERN = "{warehouse}/{aisle}/{side}/B{bay:03}/L{level}"

ALLOWED_CODE_TOKENS = ("warehouse", "aisle", "lane", "side", "bay", "level")

_TOKEN_RE = re.compile(r"\{(\w+)(?::0?(\d+))?\}")

LaneSide = Literal["LEFT", "RIGHT"]


@dataclass(frozen=True, slots=True)
class BinCodeParts:
    warehouse: str
    aisle: str
    lane: str
    side: LaneSide
    bay_seq: int
    """1-based bay number, as humans count."""

    level_index: int
    """0-based level index; rendered with +1 so ground level reads as ``L1``."""


def side_letter(side: LaneSide) -> str:
    return "L" if side == "LEFT" else "R"


def tokens_in_pattern(pattern: str) -> list[str]:
    return [match.group(1) for match in _TOKEN_RE.finditer(pattern)]


def is_valid_code_pattern(pattern: str) -> bool:
    tokens = tokens_in_pattern(pattern)
    if not tokens:
        return False
    return all(token in ALLOWED_CODE_TOKENS for token in tokens)


def format_bin_code(pattern: str, parts: BinCodeParts) -> str:
    """Render a bin code. Unknown tokens render empty; the schema rejects them first."""

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        width = match.group(2)
        raw = {
            "warehouse": parts.warehouse,
            "aisle": parts.aisle,
            "lane": parts.lane,
            "side": side_letter(parts.side),
            "bay": str(parts.bay_seq),
            "level": str(parts.level_index + 1),
        }.get(name, "")
        return raw.zfill(int(width)) if width else raw

    return _TOKEN_RE.sub(replace, pattern)
