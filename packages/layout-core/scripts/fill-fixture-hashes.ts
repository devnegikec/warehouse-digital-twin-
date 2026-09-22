/**
 * Generates every `expected` block in the conformance fixture sets, then asserts
 * that every rule in the registry is covered by at least one case.
 *
 * This is the authoring tool for the fixture suite — run it after changing the
 * compiler, then REVIEW THE DIFF. A changed hash, bin count or diagnostic set
 * means the compiler changed behaviour, which is exactly what the Python side
 * will then disagree with. Treat a non-trivial diff here as a bug to justify,
 * not a number to accept.
 *
 *   npm run gen:hashes
 *
 * Exits non-zero if a rule has no coverage, so adding a rule to `rules.ts`
 * without a fixture fails the tool rather than silently going untested.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { itemFits } from '../src/capacity.js';
import { buildLayout } from '../src/compile.js';
import { codesOf, summarizeDiagnostic } from '../src/diagnostics.js';
import { RULE_CODES } from '../src/rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../../../fixtures/layout-conformance');
const placementPath = resolve(here, '../../../fixtures/placement-conformance/cases.json');

type Fixture = {
  name: string;
  description?: string;
  targets?: string[];
  doc: unknown;
  expected: Record<string, unknown>;
};

type PlacementCase = {
  name: string;
  bin: { widthM: number; heightM: number; depthM: number; capacityM3: number; maxWeightKg: number | null };
  item: { widthM: number; heightM: number; depthM: number; weightKg: number; rotatable: boolean };
  qty: number;
  expected: Record<string, unknown>;
};

const covered = new Set<string>();

const files = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

if (files.length === 0) {
  console.error(`No fixtures found in ${fixturesDir}`);
  process.exit(1);
}

console.log('--- layout fixtures ---');

for (const file of files) {
  const path = join(fixturesDir, file);
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
  const graph = buildLayout(fixture.doc);

  const codes = codesOf(graph.diagnostics);
  for (const code of codes) covered.add(code);

  fixture.expected = {
    publishable: graph.publishable,
    binCount: graph.bins.length,
    bayCount: graph.bays.length,
    diagnosticCodes: codes,
    diagnostics: graph.diagnostics.map(summarizeDiagnostic),
    docHash: graph.hash,
    firstBinCode: graph.bins[0]?.code ?? null,
    lastBinCode: graph.bins.at(-1)?.code ?? null,
  };

  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `${file.padEnd(40)} bins=${String(graph.bins.length).padStart(4)}  ` +
      `diags=${String(graph.diagnostics.length).padStart(3)}  hash=${graph.hash.slice(0, 12)}…`,
  );
}

console.log('--- placement cases ---');

const placement = JSON.parse(readFileSync(placementPath, 'utf8')) as {
  description: string;
  cases: PlacementCase[];
};

for (const testCase of placement.cases) {
  const result = itemFits(testCase.bin, testCase.item, testCase.qty);
  const code = result.failure?.code ?? null;
  if (code) covered.add(code);

  testCase.expected = {
    fits: result.fits,
    code,
    orientation: result.orientation ?? null,
  };
  console.log(
    `${testCase.name.padEnd(40)} fits=${String(result.fits).padEnd(5)} code=${code ?? '-'}`,
  );
}

writeFileSync(placementPath, `${JSON.stringify(placement, null, 2)}\n`);

console.log('--- rule coverage ---');

const uncovered = RULE_CODES.filter((code) => !covered.has(code));
const unusedEntries = [...covered].filter((code) => !(RULE_CODES as readonly string[]).includes(code));

console.log(`${covered.size}/${RULE_CODES.length} rules covered by fixtures or placement cases`);

if (unusedEntries.length > 0) {
  console.error(`Codes emitted but not in rules.ts: ${unusedEntries.join(', ')}`);
  process.exitCode = 1;
}

if (uncovered.length > 0) {
  console.error(`Rules with no coverage — add a fixture for: ${uncovered.join(', ')}`);
  process.exitCode = 1;
}
