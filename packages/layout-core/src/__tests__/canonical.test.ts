import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalize, docHash, formatNumber, sha256Hex } from '../canonical.js';
import { buildLayout } from '../compile.js';

describe('sha256', () => {
  // The padding boundary (55/56/57 bytes) is the classic place a hand-rolled
  // SHA-256 goes wrong, so those lengths are tested explicitly.
  const samples = [
    '',
    'a',
    'abc',
    'hello world',
    'The quick brown fox jumps over the lazy dog',
    'a'.repeat(54),
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(57),
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(65),
    'a'.repeat(1000),
    '{"a":1,"b":[1,2,3]}',
    'unicode: ünïcødé — 日本語',
  ];

  it.each(samples)('matches node:crypto for %j', (sample) => {
    const expected = createHash('sha256').update(sample, 'utf8').digest('hex');
    expect(sha256Hex(sample)).toBe(expected);
  });

  it('produces the documented empty-string digest', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('formatNumber', () => {
  const cases: Array<[number, string]> = [
    [0, '0'],
    [1, '1'],
    [-1, '-1'],
    [1.5, '1.5'],
    [2.7, '2.7'],
    [0.1 + 0.2, '0.3'],
    [1 / 3, '0.333333'],
    [2 / 3, '0.666667'],
    [1e-6, '0.000001'],
    [1e-7, '0'],
    [100, '100'],
    [1000.5, '1000.5'],
    [-0, '0'],
    [-0.0000001, '0'],
    [5.04, '5.04'],
    [3.672, '3.672'],
  ];

  it.each(cases)('%d -> %s', (value, expected) => {
    expect(formatNumber(value)).toBe(expected);
  });

  it('never emits exponent notation', () => {
    for (const value of [1e-6, 1e-5, 1e21, 1e22, 1e-21, 1234567890123, -1e21]) {
      expect(formatNumber(value)).not.toMatch(/e/i);
    }
  });

  it('renders magnitudes at and beyond the toFixed cutoff exactly', () => {
    // Number.prototype.toFixed(6) returns "1e+21" from 1e21 upwards; the hash must not.
    expect(formatNumber(1e21)).toBe('1000000000000000000000');
    expect(formatNumber(-1e21)).toBe('-1000000000000000000000');
  });

  it('rejects non-finite numbers', () => {
    expect(() => formatNumber(NaN)).toThrow();
    expect(() => formatNumber(Infinity)).toThrow();
  });
});

describe('canonicalize', () => {
  it('sorts object keys', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('is insensitive to key insertion order', () => {
    const a = { z: 1, a: { y: 2, b: [{ d: 4, c: 3 }] } };
    const b = { a: { b: [{ c: 3, d: 4 }], y: 2 }, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('drops undefined members like JSON.stringify', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('normalises equivalent float representations', () => {
    expect(canonicalize({ v: 0.1 + 0.2 })).toBe(canonicalize({ v: 0.3 }));
  });
});

describe('docHash', () => {
  const doc = {
    schemaVersion: 1,
    warehouse: { code: 'WH1', lengthM: 10, widthM: 10, heightM: 6 },
    rackTypes: [],
    aisles: [],
  };

  it('is stable across repeated calls', () => {
    expect(docHash(doc)).toBe(docHash(doc));
  });

  it('is stable regardless of input key order', () => {
    const reordered = {
      aisles: [],
      rackTypes: [],
      warehouse: { heightM: 6, widthM: 10, code: 'WH1', lengthM: 10 },
      schemaVersion: 1,
    };
    // Hashing raw input that has not been through normalization differs, because
    // defaults legitimate differently. Compare the normalized forms instead.
    expect(docHash(buildLayout(doc).doc)).toBe(docHash(buildLayout(reordered).doc));
  });

  it('changes when a real value changes', () => {
    const longer = { ...doc, warehouse: { ...doc.warehouse, lengthM: 11 } };
    expect(docHash(buildLayout(doc).doc)).not.toBe(docHash(buildLayout(longer).doc));
  });
});
