/**
 * Deterministic bin codes (P3).
 *
 * Bin identity derives from structural position, not from a random UUID, so
 * re-publishing a layout never orphans inventory. The database still uses a
 * surrogate UUID primary key; `code` is the natural unique key.
 */
import type { LaneSide } from './schema.js';

export const DEFAULT_BIN_CODE_PATTERN = '{warehouse}/{aisle}/{side}/B{bay:03}/L{level}';

/** Tokens the bin code pattern may reference. Anything else is a schema error. */
export const ALLOWED_CODE_TOKENS = ['warehouse', 'aisle', 'lane', 'side', 'bay', 'level'] as const;

const TOKEN_RE = /\{(\w+)(?::0?(\d+))?\}/g;

export type BinCodeParts = {
  warehouse: string;
  aisle: string;
  lane: string;
  side: LaneSide;
  /** 1-based bay number, as humans count. */
  baySeq: number;
  /** 0-based level index; rendered with +1 so ground level reads as `L1`. */
  levelIndex: number;
};

export function sideLetter(side: LaneSide): 'L' | 'R' {
  return side === 'LEFT' ? 'L' : 'R';
}

export function tokensInPattern(pattern: string): string[] {
  return [...pattern.matchAll(TOKEN_RE)].map((m) => m[1] ?? '');
}

export function isValidCodePattern(pattern: string): boolean {
  const tokens = tokensInPattern(pattern);
  if (tokens.length === 0) return false;
  return tokens.every((t) => (ALLOWED_CODE_TOKENS as readonly string[]).includes(t));
}

/**
 * Render a bin code. Unknown tokens render as empty strings, but the schema
 * rejects unknown tokens up front so this stays a pure formatter.
 */
export function formatBinCode(pattern: string, parts: BinCodeParts, warehouseCodeFallback = 'WH'): string {
  return pattern.replace(TOKEN_RE, (_match, name: string, width?: string) => {
    let raw: string;
    switch (name) {
      case 'warehouse':
        raw = parts.warehouse || warehouseCodeFallback;
        break;
      case 'aisle':
        raw = parts.aisle;
        break;
      case 'lane':
        raw = parts.lane;
        break;
      case 'side':
        raw = sideLetter(parts.side);
        break;
      case 'bay':
        raw = String(parts.baySeq);
        break;
      case 'level':
        raw = String(parts.levelIndex + 1);
        break;
      default:
        raw = '';
    }
    return width ? raw.padStart(Number(width), '0') : raw;
  });
}
