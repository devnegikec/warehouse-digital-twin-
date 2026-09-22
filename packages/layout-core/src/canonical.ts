/**
 * Canonical JSON and the layout content hash (P3, P4, §6).
 *
 * `doc_hash` must be byte-identical between this TypeScript implementation and
 * `server/app/layout/canonical.py`, or Publish will reject itself. The rules are
 * deliberately spelled out rather than relying on each runtime's default JSON:
 *
 *   1. Object keys are sorted by UTF-16 code unit.
 *   2. Numbers use fixed notation, rounded to 6 decimals, trailing zeros stripped,
 *      negative zero normalised to "0". No exponents, ever.
 *   3. Strings use standard JSON escaping.
 *   4. Array order is preserved — it is semantic here.
 *   5. `undefined` members are dropped, matching `JSON.stringify`.
 *   6. sha256 over the UTF-8 bytes, lowercase hex.
 *
 * Keys and values in a LayoutDoc are identifiers and numbers, so the UTF-8 vs
 * UTF-16 sort-order difference (astral-plane characters only) cannot bite.
 */
import { PRECISION, round } from './units.js';

/** Fixed-notation formatter matching Python's `format_number`. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`Cannot canonicalise a non-finite number: ${n}`);
  }

  const value = round(n, PRECISION);

  // Number.prototype.toFixed switches to exponential notation at 1e21, which would
  // break cross-language hashing. Every double at that magnitude is already an
  // integer (spacing far exceeds 2), so BigInt renders the exact digits.
  if (Math.abs(value) >= 1e21) {
    return BigInt(value).toString();
  }

  const fixed = value.toFixed(PRECISION);
  const [intPart = '0', fraction = ''] = fixed.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const out = trimmed.length > 0 ? `${intPart}.${trimmed}` : intPart;
  return out === '-0' ? '0' : out;
}

/** Deterministic serialisation. Two structurally equal docs produce equal strings. */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return formatNumber(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error(`Unsupported value in layout document: ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();

  const members = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`);
  return `{${members.join(',')}}`;
}

// --- SHA-256 -----------------------------------------------------------------
// A dependency-free implementation so the same synchronous code path runs in the
// browser (for live preview) and in Node. `crypto.subtle` would force async and
// behave differently across runtimes.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

export function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const length = bytes.length;
  const paddedLength = Math.ceil((length + 9) / 64) * 64;

  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[length] = 0x80;

  const view = new DataView(buffer.buffer);
  const bitLengthHi = Math.floor((length * 8) / 0x100000000);
  const bitLengthLo = (length * 8) >>> 0;
  view.setUint32(paddedLength - 8, bitLengthHi);
  view.setUint32(paddedLength - 4, bitLengthLo);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);

    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = H[0] ?? 0;
    let b = H[1] ?? 0;
    let c = H[2] ?? 0;
    let d = H[3] ?? 0;
    let e = H[4] ?? 0;
    let f = H[5] ?? 0;
    let g = H[6] ?? 0;
    let h = H[7] ?? 0;

    for (let i = 0; i < 64; i++) {
      const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + bigS1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigS0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = ((H[0] ?? 0) + a) >>> 0;
    H[1] = ((H[1] ?? 0) + b) >>> 0;
    H[2] = ((H[2] ?? 0) + c) >>> 0;
    H[3] = ((H[3] ?? 0) + d) >>> 0;
    H[4] = ((H[4] ?? 0) + e) >>> 0;
    H[5] = ((H[5] ?? 0) + f) >>> 0;
    H[6] = ((H[6] ?? 0) + g) >>> 0;
    H[7] = ((H[7] ?? 0) + h) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i++) hex += (H[i] ?? 0).toString(16).padStart(8, '0');
  return hex;
}

/** Content hash of a normalised layout document. */
export function docHash(normalizedDoc: unknown): string {
  return sha256Hex(canonicalize(normalizedDoc));
}
