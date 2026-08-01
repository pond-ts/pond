import { ProcessError } from '../errors.js';
import type { Registry } from './registry.js';
import { isFold, type Params, type Spec } from './types.js';

/**
 * The minimum safe tail for a plan, in rows — [PND-PROCHIST].
 *
 * ## Why this is not the consumer's call
 *
 * The hot leading edge is the design's worst cliff: an 8-study stack over
 * 500k rows costs **765 ms/tick**, saturating at ~1.3 ticks/sec. The same
 * stack over a 5,000-row tail runs at **5.4 ms/tick**. So a consumer
 * watching a live edge should slice, and the only question is where.
 *
 * The RFC left that to the consumer. It should not be a guess in either
 * direction: too short silently truncates a study's warm-up and reports
 * `undefined` where a value exists, too long gives the cliff back. The
 * registry already knows every op's lookback, so `display range +
 * requiredHistory(plan)` is *provably* sufficient.
 *
 * ## Lookbacks sum along a chain; they do not max
 *
 * This is the part worth getting right. `sma(20)` over `sma(50)` does not
 * need 50 rows of history — it needs 50 for the inner study to produce
 * anything, and then a further 19 rows of *that output* before the outer
 * one does. 69, not 50. Taking the max across a nested chain
 * under-provisions by exactly the amount that makes the bug subtle: the
 * answer is defined, plausible, and computed from a truncated window.
 *
 * Across *independent* specs in a plan it is a max, because the plan
 * needs whichever branch reaches furthest back.
 *
 * ## Unknown is not zero
 *
 * An op that does not declare `lookback` makes this return
 * `{ known: false }` with the offending ops named, rather than a number.
 * A missing declaration and a genuinely element-wise op are the same
 * value and opposite meanings, and defaulting to zero would hand back a
 * confidently wrong slice. An element-wise op should declare `() => 0`.
 */
export interface HistoryResult {
  /** False when any op in the plan does not declare a lookback. */
  readonly known: boolean;
  /**
   * Rows of history the plan needs before a requested range. Present
   * only when {@link known} — there is no safe default to report.
   */
  readonly rows?: number;
  /** Ops with no declared lookback, deduplicated, in encounter order. */
  readonly undeclared: readonly string[];
  /** Per-spec depth, for `explain`-style output. Keyed by op name. */
  readonly byOp: Readonly<Record<string, number>>;
}

export function requiredHistory(
  registry: Registry,
  plan: readonly Spec[],
): HistoryResult {
  const undeclared: string[] = [];
  const seen = new Set<string>();
  const byOp: Record<string, number> = {};
  // A plan is a DAG of shared specs, so the same subtree is reachable by
  // many paths. Memoize on identity — two structurally equal specs are
  // separate objects here, and both give the same answer anyway.
  const depth = new Map<Spec, number>();

  const of = (spec: Spec): number => {
    const cached = depth.get(spec);
    if (cached !== undefined) return cached;

    const def = registry.get(spec.op);
    let own = 0;
    if (isFold(def)) {
      // A fold reads a whole column and emits a fact. It adds no warm-up
      // of its own — but a truncated tail still changes its answer, which
      // is a windowing question rather than a history one.
      own = 0;
    } else if (def.lookback === undefined) {
      if (!seen.has(spec.op)) {
        seen.add(spec.op);
        undeclared.push(spec.op);
      }
    } else {
      own = def.lookback(paramsOf(registry, spec));
      if (!Number.isFinite(own) || own < 0) {
        throw new ProcessError(
          `op '${spec.op}' declared a lookback of ${String(own)}; ` +
            `it must be a non-negative finite row count`,
        );
      }
      own = Math.ceil(own);
    }

    // Sum along nesting, max across sibling inputs: a spec with two
    // nested inputs waits for whichever arrives latest, and then needs
    // its own warm-up on top of that.
    let deepest = 0;
    for (const input of spec.inputs ?? []) {
      if (typeof input === 'string') continue; // a source column: no warm-up
      const nested = of(specOf(input));
      if (nested > deepest) deepest = nested;
    }

    const total = own + deepest;
    depth.set(spec, total);
    byOp[spec.op] = Math.max(byOp[spec.op] ?? 0, total);
    return total;
  };

  let rows = 0;
  for (const spec of plan) {
    const d = of(spec);
    if (d > rows) rows = d;
  }

  return undeclared.length > 0
    ? { known: false, undeclared, byOp }
    : { known: true, rows, undeclared: [], byOp };
}

/** A nested input is either a spec or a `{ spec, output }` selection. */
function specOf(input: unknown): Spec {
  const raw = input as { op?: string; spec?: Spec };
  return raw.op !== undefined ? (raw as Spec) : raw.spec!;
}

/**
 * Params with defaults applied, which is what a lookback must see: `sma`
 * with no `period` still has one, and reading `spec.params` directly
 * would hand the lookback an `undefined` to multiply.
 */
function paramsOf(registry: Registry, spec: Spec): Params {
  const def = registry.get(spec.op);
  return registry.resolveParams(def, spec.params);
}
