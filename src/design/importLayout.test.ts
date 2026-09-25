import { describe, expect, it } from 'vitest';

import { readLayoutJson } from './importLayout';

const doc = { schemaVersion: 1, warehouse: { code: 'WH1', lengthM: 10, widthM: 10, heightM: 5 } };

describe('readLayoutJson', () => {
  it('accepts a bare document', () => {
    const result = readLayoutJson(JSON.stringify(doc));

    expect(result).toEqual({ ok: true, doc });
  });

  it('accepts the conformance-fixture wrapper', () => {
    const result = readLayoutJson(
      JSON.stringify({ name: '002', description: '…', doc }),
    );

    expect(result).toEqual({ ok: true, doc });
  });

  it('refuses malformed JSON with the parser’s own message', () => {
    const result = readLayoutJson('{ "schemaVersion": 1,');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Not valid JSON/);
  });

  it('refuses JSON that is not an object', () => {
    expect(readLayoutJson('[1, 2, 3]')).toMatchObject({ ok: false });
    expect(readLayoutJson('"hello"')).toMatchObject({ ok: false });
    expect(readLayoutJson('null')).toMatchObject({ ok: false });
  });

  it('refuses an object that holds no layout', () => {
    const result = readLayoutJson(JSON.stringify({ warehouse: { code: 'WH1' } }));

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/No layout found/);
  });

  it('does not unwrap a nested doc that is not a document', () => {
    const result = readLayoutJson(JSON.stringify({ doc: { name: 'not a layout' } }));

    expect(result).toMatchObject({ ok: false });
  });
});
