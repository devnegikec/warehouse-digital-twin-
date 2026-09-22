/**
 * Cross-language conformance suite (P9).
 *
 * These fixtures are the contract between `compile.ts` and `compile.py`.
 * `server/tests/conformance/test_fixtures.py` runs the identical files. If either
 * implementation drifts, one of the two suites fails.
 *
 * Regenerate expected values with `npm run gen:hashes`, then review the diff.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { itemFits } from '../capacity.js';
import { buildLayout } from '../compile.js';
import { codesOf, summarizeDiagnostic } from '../diagnostics.js';
import { RULE_CODES } from '../rules.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(here, '../../../../fixtures/layout-conformance');
export const PLACEMENT_FILE = resolve(
  here,
  '../../../../fixtures/placement-conformance/cases.json',
);

type Fixture = {
  name: string;
  description?: string;
  targets?: string[];
  doc: unknown;
  expected: Record<string, unknown>;
};

type PlacementCase = {
  name: string;
  bin: {
    widthM: number;
    heightM: number;
    depthM: number;
    capacityM3: number;
    maxWeightKg: number | null;
  };
  item: {
    widthM: number;
    heightM: number;
    depthM: number;
    weightKg: number;
    rotatable: boolean;
  };
  qty: number;
  expected: { fits: boolean; code: string | null; orientation: [number, number, number] | null };
};

const fixtures = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({
    file,
    fixture: JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as Fixture,
  }));

const placement = JSON.parse(readFileSync(PLACEMENT_FILE, 'utf8')) as {
  cases: PlacementCase[];
};

/**
 * Must match `summarize()` in `server/tests/conformance/test_fixtures.py` exactly.
 * The full diagnostic list — not just a set of codes — is compared, so ordering,
 * severity, entityRefs and computed `data` are all pinned across runtimes.
 */
function summarise(graph: ReturnType<typeof buildLayout>): Record<string, unknown> {
  return {
    publishable: graph.publishable,
    binCount: graph.bins.length,
    bayCount: graph.bays.length,
    diagnosticCodes: codesOf(graph.diagnostics),
    diagnostics: graph.diagnostics.map(summarizeDiagnostic),
    docHash: graph.hash,
    firstBinCode: graph.bins[0]?.code ?? null,
    lastBinCode: graph.bins.at(-1)?.code ?? null,
  };
}

describe('layout conformance fixtures', () => {
  it('found the fixture set', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(19);
  });

  it.each(fixtures.map((entry) => entry.file))('%s', (file) => {
    const entry = fixtures.find((candidate) => candidate.file === file);
    if (!entry) throw new Error(`fixture ${file} disappeared`);

    expect(
      Object.keys(entry.fixture.expected ?? {}).length,
      `${file} has an empty "expected" block — run: npm run gen:hashes`,
    ).toBeGreaterThan(0);

    expect(summarise(buildLayout(entry.fixture.doc))).toEqual(entry.fixture.expected);
  });

  it('every fixture genuinely triggers the rules it claims to target', () => {
    for (const { file, fixture } of fixtures) {
      const emitted = new Set(buildLayout(fixture.doc).diagnostics.map((d) => d.code as string));
      for (const target of fixture.targets ?? []) {
        expect(emitted, `${file} declares target '${target}' but does not emit it`).toContain(
          target,
        );
      }
    }
  });
});

describe('rule coverage', () => {
  it('every registered rule is covered by a fixture or a placement case', () => {
    const covered = new Set<string>();

    for (const { fixture } of fixtures) {
      for (const diagnostic of buildLayout(fixture.doc).diagnostics) covered.add(diagnostic.code);
    }
    for (const testCase of placement.cases) {
      const result = itemFits(testCase.bin, testCase.item, testCase.qty);
      if (result.failure) covered.add(result.failure.code);
    }

    const uncovered = RULE_CODES.filter((code) => !covered.has(code));
    expect(uncovered, `rules with no test coverage: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('no fixture emits a code outside the registry', () => {
    const known = new Set<string>(RULE_CODES);
    for (const { file, fixture } of fixtures) {
      for (const diagnostic of buildLayout(fixture.doc).diagnostics) {
        expect(known, `${file} emitted unknown code ${diagnostic.code}`).toContain(
          diagnostic.code,
        );
      }
    }
  });
});

describe('placement conformance cases', () => {
  it('found the case set', () => {
    expect(placement.cases.length).toBeGreaterThanOrEqual(11);
  });

  it.each(placement.cases.map((testCase) => testCase.name))('%s', (name) => {
    const testCase = placement.cases.find((candidate) => candidate.name === name);
    if (!testCase) throw new Error(`placement case ${name} disappeared`);

    expect(
      Object.keys(testCase.expected ?? {}).length,
      `${name} has an empty "expected" block — run: npm run gen:hashes`,
    ).toBeGreaterThan(0);

    const result = itemFits(testCase.bin, testCase.item, testCase.qty);

    expect({
      fits: result.fits,
      code: result.failure?.code ?? null,
      orientation: result.orientation ?? null,
    }).toEqual(testCase.expected);
  });
});
