/**
 * Emits `schema/layout-doc.v1.json` from the Zod source in `src/schema.ts`.
 *
 * The emitted file is the canonical cross-language contract: Python validates
 * incoming documents against it with the `jsonschema` library. Run via
 * `npm run gen:schema` and commit the result.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { LayoutDocSchema } from '../src/schema.js';
import { RULES, RULE_CODES } from '../src/rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../schema/layout-doc.v1.json');

type ToJsonSchema = (schema: unknown, options?: unknown) => unknown;

function emit(): Record<string, unknown> {
  const maybe = (z as unknown as { toJSONSchema?: ToJsonSchema }).toJSONSchema;
  if (typeof maybe !== 'function') {
    throw new Error(
      'This zod build does not expose z.toJSONSchema(). Upgrade to zod v4 or add zod-to-json-schema.',
    );
  }

  // `io: 'input'` matters: fields carrying defaults must be optional on the wire.
  try {
    return maybe(LayoutDocSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
  } catch {
    return maybe(LayoutDocSchema) as Record<string, unknown>;
  }
}

const schema = emit();
const stamped = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://warehouse-3d.local/schema/layout-doc.v1.json',
  title: 'LayoutDoc v1',
  $comment:
    'GENERATED FILE — do not edit by hand. Source: packages/layout-core/src/schema.ts. ' +
    'Regenerate with `npm run gen:schema`.',
  ...schema,
};

mkdirSync(dirname(outPath), { recursive: true });
const json = `${JSON.stringify(stamped, null, 2)}\n`;
writeFileSync(outPath, json);

const bytes = Buffer.byteLength(json, 'utf8');
console.log(`Wrote ${outPath} (${bytes} bytes)`);

// The rule registry is part of the cross-language contract too: Python loads this
// file so the two runtimes cannot disagree about which rules exist or how severe
// they are (P6, P9).
const rulesPath = resolve(here, '../schema/rule-codes.json');
const ruleCodes = {
  $comment:
    'GENERATED FILE — do not edit by hand. Source: packages/layout-core/src/rules.ts. ' +
    'Regenerate with `npm run gen:schema`.',
  rules: RULE_CODES.map((code) => RULES[code]),
};
writeFileSync(rulesPath, `${JSON.stringify(ruleCodes, null, 2)}\n`);
console.log(`Wrote ${rulesPath} (${RULE_CODES.length} rules)`);
