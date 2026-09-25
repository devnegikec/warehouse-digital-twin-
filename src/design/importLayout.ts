/**
 * Reading a layout out of JSON.
 *
 * Exactly two shapes are accepted:
 *
 *  - the document itself — what the editor holds and the API stores;
 *  - `{ name, description, doc }` — the wrapper the conformance fixtures use, so those
 *    files can be opened directly instead of being copied by hand.
 *
 * The unwrapping is deliberately a shape check rather than a schema validation:
 * `document.replace` already parses the document through Zod and normalizes it, and a
 * second list of what a document may contain is a second thing to keep in sync.
 */
export type LayoutImportResult = { ok: true; doc: unknown } | { ok: false; reason: string };

export function readLayoutJson(text: string): LayoutImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `Not valid JSON — ${(error as Error).message}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'A layout must be a JSON object.' };
  }

  const record = parsed as Record<string, unknown>;
  if ('schemaVersion' in record) return { ok: true, doc: parsed };

  if (typeof record.doc === 'object' && record.doc !== null && 'schemaVersion' in record.doc) {
    return { ok: true, doc: record.doc };
  }

  return {
    ok: false,
    reason:
      'No layout found. Expected a document with a "schemaVersion", or a wrapper object with a "doc" inside it.',
  };
}
