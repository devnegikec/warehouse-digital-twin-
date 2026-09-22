/**
 * Rule registry and diagnostic-collector behaviour (P6).
 *
 * The registry is the single source of truth for which rules exist and how severe
 * they are. These tests protect the properties the fixture suite relies on.
 */
import { describe, expect, it } from 'vitest';

import { DiagnosticCollector, blocksPublish, codesOf, summarizeDiagnostic } from '../diagnostics.js';
import { BLOCKING_RULE_CODES, RULES, RULE_CODES, ruleSeverity } from '../rules.js';
import { MAX_DIAGNOSTICS_PER_CODE } from '../units.js';

describe('RULE registry', () => {
  it('has a code field matching its own key', () => {
    for (const [key, definition] of Object.entries(RULES)) {
      expect(definition.code, `RULES.${key}.code`).toBe(key);
    }
  });

  it('exposes a sorted, unique code list', () => {
    expect(RULE_CODES).toEqual([...new Set(RULE_CODES)].sort());
    expect(RULE_CODES.length).toBe(Object.keys(RULES).length);
  });

  it('uses only the two defined severities', () => {
    for (const code of RULE_CODES) {
      expect(['error', 'warning']).toContain(ruleSeverity(code));
    }
  });

  it('gives every rule a non-empty description', () => {
    for (const code of RULE_CODES) {
      expect(RULES[code].description.length, `${code} needs a description`).toBeGreaterThan(10);
    }
  });

  it('derives blocking codes from severity', () => {
    expect(BLOCKING_RULE_CODES).toEqual(
      RULE_CODES.filter((code) => RULES[code].severity === 'error'),
    );
    expect(BLOCKING_RULE_CODES).not.toContain('DIAGNOSTICS_TRUNCATED');
  });

  it('keeps all four placement rules registered as errors', () => {
    expect(ruleSeverity('QTY_NOT_POSITIVE')).toBe('error');
    expect(ruleSeverity('ITEM_DOES_NOT_FIT_OPENING')).toBe('error');
    expect(ruleSeverity('EXCEEDS_BIN_VOLUME')).toBe('error');
    expect(ruleSeverity('EXCEEDS_BIN_WEIGHT')).toBe('error');
  });
});

describe('DiagnosticCollector', () => {
  it('takes severity from the registry, not the call site', () => {
    const collector = new DiagnosticCollector();
    collector.report('AISLE_TOO_NARROW', 'narrow');
    collector.report('LANE_OVERLAP', 'overlap');

    expect(collector.all().map((d) => d.severity)).toEqual(['warning', 'error']);
  });

  it('refuses to report a warning rule through error()', () => {
    const collector = new DiagnosticCollector();
    expect(() => collector.error('AISLE_TOO_NARROW', 'narrow')).toThrow(/registered as 'warning'/);
  });

  it('refuses to report an error rule through warn()', () => {
    const collector = new DiagnosticCollector();
    expect(() => collector.warn('LANE_OVERLAP', 'overlap')).toThrow(/registered as 'error'/);
  });

  it('preserves insertion order for deterministic output', () => {
    const collector = new DiagnosticCollector();
    collector.report('LANE_OVERLAP', 'b');
    collector.report('AISLE_TOO_NARROW', 'a');
    collector.report('LANE_OVERLAP', 'c');

    expect(collector.all().map((d) => d.message)).toEqual(['b', 'a', 'c']);
    expect(codesOf(collector.all())).toEqual(['AISLE_TOO_NARROW', 'LANE_OVERLAP']);
  });

  it('caps a repeated code and summarises the remainder', () => {
    const collector = new DiagnosticCollector();
    const overflow = 3;
    for (let i = 0; i < MAX_DIAGNOSTICS_PER_CODE + overflow; i++) {
      collector.report('BAY_OBSTACLE_OVERLAP', `bay ${i}`);
    }

    const all = collector.all();
    expect(all).toHaveLength(MAX_DIAGNOSTICS_PER_CODE + 1);

    const summary = all.at(-1);
    expect(summary?.code).toBe('DIAGNOSTICS_TRUNCATED');
    expect(summary?.severity).toBe('warning');
    expect(summary?.data).toEqual({
      originalCode: 'BAY_OBSTACLE_OVERLAP',
      suppressed: overflow,
    });
  });

  it('counts severities and blocks publish only on errors', () => {
    const collector = new DiagnosticCollector();
    collector.report('AISLE_TOO_NARROW', 'a');
    collector.report('AISLE_TOO_NARROW', 'b');

    expect(collector.count('warning')).toBe(2);
    expect(collector.count('error')).toBe(0);
    expect(collector.hasErrors).toBe(false);
    expect(blocksPublish(collector.all())).toBe(false);

    collector.report('LANE_OVERLAP', 'c');
    expect(collector.hasErrors).toBe(true);
    expect(blocksPublish(collector.all())).toBe(true);
  });

  it('summarises a diagnostic without dropping data', () => {
    const collector = new DiagnosticCollector();
    collector.report('LEVEL_STACK_EXCEEDS_HEIGHT', 'too tall', [], { stackHeightM: 5.04 });

    const summary = summarizeDiagnostic(collector.all()[0]!);
    expect(summary).toEqual({
      severity: 'error',
      code: 'LEVEL_STACK_EXCEEDS_HEIGHT',
      entityRefs: [],
      data: { stackHeightM: 5.04 },
    });
  });
});
