/**
 * Structured diagnostics (P6).
 *
 * Validators never throw and never render UI. They emit data that the editor can
 * click, focus, and link back to the offending entity.
 *
 * Severity comes from the rule registry rather than from the call site, so a rule
 * cannot be an error in one place and a warning in another.
 */
import { RULES, ruleSeverity, type RuleCode, type RuleSeverity } from './rules.js';
import { MAX_DIAGNOSTICS_PER_CODE } from './units.js';

export type EntityKind =
  | 'warehouse'
  | 'rackType'
  | 'aisle'
  | 'lane'
  | 'level'
  | 'bay'
  | 'bin'
  | 'obstacle'
  | 'sku';

export type EntityRef = {
  kind: EntityKind;
  id: string;
  label?: string;
};

export type DiagnosticSeverity = RuleSeverity;

export type Diagnostic = {
  severity: RuleSeverity;
  /** Stable machine-readable code. Branch on this in the UI, never on `message`. */
  code: RuleCode;
  message: string;
  entityRefs: EntityRef[];
  data?: Record<string, unknown>;
};

/**
 * Guards the `error()` / `warn()` helpers against the registry. A rule's severity
 * is declared exactly once, in `rules.ts`.
 */
function assertSeverity(code: RuleCode, expected: RuleSeverity): void {
  const actual = ruleSeverity(code);
  if (actual !== expected) {
    throw new Error(
      `Rule '${code}' is registered as '${actual}' but was reported through ${expected}(); ` +
        'fix the call site or the registry entry in rules.ts',
    );
  }
}

/**
 * Collects diagnostics, de-duplicating floods. One bad parameter on a 1,500-bin
 * layout must not emit 1,500 identical messages.
 */
export class DiagnosticCollector {
  private readonly items: Diagnostic[] = [];
  private readonly counts = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();

  report(
    code: RuleCode,
    message: string,
    entityRefs: EntityRef[] = [],
    data?: Record<string, unknown>,
  ): void {
    const seen = this.counts.get(code) ?? 0;
    this.counts.set(code, seen + 1);

    if (seen >= MAX_DIAGNOSTICS_PER_CODE) {
      this.suppressed.set(code, (this.suppressed.get(code) ?? 0) + 1);
      return;
    }

    this.items.push({ severity: ruleSeverity(code), code, message, entityRefs, data });
  }

  /**
   * Report an error-severity rule. The severity still comes from the registry;
   * the method name is a readability aid, and a mismatch is a programming error
   * rather than a silent reclassification.
   */
  error(
    code: RuleCode,
    message: string,
    entityRefs: EntityRef[] = [],
    data?: Record<string, unknown>,
  ): void {
    assertSeverity(code, 'error');
    this.report(code, message, entityRefs, data);
  }

  /** Report a warning-severity rule. See `error()`. */
  warn(
    code: RuleCode,
    message: string,
    entityRefs: EntityRef[] = [],
    data?: Record<string, unknown>,
  ): void {
    assertSeverity(code, 'warning');
    this.report(code, message, entityRefs, data);
  }

  /** Insertion-ordered, so output is deterministic for a given document. */
  all(): Diagnostic[] {
    const truncated: Diagnostic[] = [...this.suppressed.entries()].map(([code, n]) => ({
      severity: RULES.DIAGNOSTICS_TRUNCATED.severity,
      code: 'DIAGNOSTICS_TRUNCATED' as const,
      message: `${n} further '${code}' issue(s) suppressed`,
      entityRefs: [],
      data: { originalCode: code, suppressed: n },
    }));
    return [...this.items, ...truncated];
  }

  count(severity: RuleSeverity): number {
    return this.items.filter((d) => d.severity === severity).length;
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === 'error');
  }
}

/** Errors block Publish. Warnings do not (P6). */
export function blocksPublish(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

/**
 * The comparable projection used by the cross-language fixture suite.
 * `data` is included because it carries computed floats, which are exactly the
 * kind of value that can drift between runtimes.
 */
export type DiagnosticSummary = {
  severity: RuleSeverity;
  code: RuleCode;
  entityRefs: EntityRef[];
  data?: Record<string, unknown>;
};

export function summarizeDiagnostic(diagnostic: Diagnostic): DiagnosticSummary {
  const summary: DiagnosticSummary = {
    severity: diagnostic.severity,
    code: diagnostic.code,
    entityRefs: diagnostic.entityRefs,
  };
  if (diagnostic.data !== undefined) summary.data = diagnostic.data;
  return summary;
}

/** All rule codes that appear across a set of diagnostics, sorted and unique. */
export function codesOf(diagnostics: Diagnostic[]): RuleCode[] {
  return [...new Set(diagnostics.map((d) => d.code))].sort();
}
