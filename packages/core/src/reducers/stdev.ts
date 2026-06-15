import type { ReducerDef } from './types.js';

/**
 * Population standard deviation, computed by **Welford's online variance** in
 * every batch path so the result is independent of which path runs.
 *
 * `aggregate('stdev')` takes the columnar fast path (`reduceColumn`) or falls
 * back to the row path (`bucketState`) depending on whether *every* mapped
 * column qualifies — an all-or-nothing decision. If those paths used different
 * formulas they would disagree on the same data:
 * - the original `bucketState` one-pass `sq/n − mean²` cancels catastrophically
 *   on near-equal large values (`[1e10, 1e10+1, 1e10+2, 1e10+3]` → 0 instead of
 *   ≈1.118, or a negative variance → `sqrt` → NaN the constructor then threw on);
 * - even the textbook two-pass `Σv/n`-then-deviations disagrees with Welford
 *   once `Σv` loses precision — at `2^52` the summed mean rounds and the two-pass
 *   stdev drifts ~8.7% from the true value.
 *
 * Welford's running mean avoids both, is O(1) per element with no buffer (so the
 * live layer that shares `bucketState` stays O(1)), and `m2 ≥ 0` by construction
 * (the `Math.max(0, …)` only absorbs FP round-off, never a gross negative). Using
 * the one recurrence in `reduce`, `reduceColumn`, and `bucketState` makes them
 * agree to floating-point noise — bit-for-bit when they see the values in the
 * same order, which the bucketed paths do.
 *
 * `rollingState` needs `remove` for its sliding window, which plain Welford
 * can't do stably. It uses a **two-stack FIFO aggregator** that merges Welford
 * partitions via Chan's parallel formula (variance is a mergeable monoid) — so
 * it is just as stable as the other paths (no cancellation, no shift drift),
 * O(1) amortized, and agrees with them to floating-point noise. See its inline
 * note for the mechanics.
 */

// Welford accumulator: `add` each value, then read `result()` for the
// population stdev (`undefined` if nothing was added). Shared by `reduce` and
// `bucketState`; `reduceColumn` inlines the same recurrence over its typed
// array (a hot fast path) — the cross-path tests guard the two against drift.
function welfordStdev() {
  let n = 0;
  let mean = 0;
  let m2 = 0;
  return {
    add(v: number): void {
      n += 1;
      const delta = v - mean;
      mean += delta / n;
      m2 += delta * (v - mean);
    },
    result(): number | undefined {
      return n === 0 ? undefined : Math.sqrt(Math.max(0, m2 / n));
    },
  };
}

export const stdev: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    const w = welfordStdev();
    for (let i = 0; i < numeric.length; i += 1) w.add(numeric[i]!);
    return w.result();
  },
  reduceColumn(col) {
    // Inlined Welford (mirrors `welfordStdev`) over the packed array — a single
    // pass, skipping gaps via the validity bitmask and skipping non-finite
    // cells (reducer non-finite policy, docs/notes/reducer-nan-policy.md). One
    // division per finite element vs the old two-pass's two divisionless scans,
    // but identical to the other paths' recurrence so the fast path and row
    // path cannot diverge. `n` counts only finite contributors, so `n === 0`
    // (no finite cells) → `undefined`.
    const values = col._values;
    const validity = col.validity;
    let n = 0;
    let mean = 0;
    let m2 = 0;
    // Fast path: every defined cell is finite (`Float64Column.allFinite`),
    // so the Welford recurrence runs over every defined cell with no
    // per-element `Number.isFinite` guard (reducer non-finite policy,
    // docs/notes/reducer-nan-policy.md). Same recurrence as the guarded
    // path → identical result.
    if (col.allFinite) {
      const len = col.length;
      if (validity === undefined) {
        for (let i = 0; i < len; i += 1) {
          const v = values[i]!;
          n += 1;
          const delta = v - mean;
          mean += delta / n;
          m2 += delta * (v - mean);
        }
      } else {
        const bits = validity.bits;
        for (let i = 0; i < len; i += 1) {
          if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
          const v = values[i]!;
          n += 1;
          const delta = v - mean;
          mean += delta / n;
          m2 += delta * (v - mean);
        }
      }
      return n === 0 ? undefined : Math.sqrt(Math.max(0, m2 / n));
    }
    // Guarded path: skip non-finite cells; `n` counts only finite
    // contributors so `n === 0` (no finite cells) → `undefined`.
    if (validity === undefined) {
      const len = col.length;
      for (let i = 0; i < len; i += 1) {
        const v = values[i]!;
        if (!Number.isFinite(v)) continue;
        n += 1;
        const delta = v - mean;
        mean += delta / n;
        m2 += delta * (v - mean);
      }
    } else {
      const bits = validity.bits;
      const len = col.length;
      for (let i = 0; i < len; i += 1) {
        if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
        const v = values[i]!;
        if (!Number.isFinite(v)) continue;
        n += 1;
        const delta = v - mean;
        mean += delta / n;
        m2 += delta * (v - mean);
      }
    }
    return n === 0 ? undefined : Math.sqrt(Math.max(0, m2 / n));
  },
  bucketState() {
    const w = welfordStdev();
    return {
      add(v) {
        if (typeof v === 'number') w.add(v);
      },
      snapshot() {
        return w.result();
      },
    };
  },
  rollingState() {
    // Numerically-stable sliding-window population stdev. Variance is a
    // **mergeable monoid** — two Welford partitions `(n, mean, m2)` combine via
    // Chan's parallel formula — so a **two-stack FIFO aggregator** maintains the
    // window's combined `m2` with O(1) amortized `add`/`remove` and **no**
    // catastrophic cancellation (unlike the old one-pass `sq/n − mean²`, which
    // collapsed on near-equal large values — `[1e10, 1e10+1, …]` → 0 or a
    // negative variance → NaN; the audit-§1.1 failure mode, previously still
    // live here) and **no** shift-reference drift on trending data (cumulative
    // distance, elevation). Replaces the deferred one-pass.
    //
    // The rolling driver advances a strict FIFO window (adds at the tail,
    // removes the oldest first), so the classic two-stack queue applies: `back`
    // collects adds, `front` serves removes; flipping `back` into `front`
    // reverses order so the oldest is on top. Each stack position carries the
    // running merge of itself with everything below it, so the two tops give
    // each half's aggregate in O(1) and `merge(frontTop, backTop)` is the whole
    // window. Non-finite / missing cells arrive as `undefined` (the factory
    // wrapper applies the non-finite policy) and contribute the identity
    // partition, so they occupy a window slot without affecting the result.
    //
    // Each stack entry is a plain Welford object (`{n, mean, m2}`). A
    // struct-of-arrays variant (parallel `number[]`, zero per-element
    // allocation) was benchmarked and is no faster at the median
    // (scripts/perf-rolling-stdev.mjs): the ~25% cost over the old one-pass is
    // the stable algorithm's extra arithmetic + the flip, not GC pressure — so
    // the readable object form stands. That ~25% buys correctness: the old
    // one-pass returned 0 / NaN on near-equal large values (audit §1.1, the
    // same hole the bucket path already closed).
    type Welford = { n: number; mean: number; m2: number };
    const IDENTITY: Welford = { n: 0, mean: 0, m2: 0 };
    const merge = (a: Welford, b: Welford): Welford => {
      if (a.n === 0) return b;
      if (b.n === 0) return a;
      const n = a.n + b.n;
      const delta = b.mean - a.mean;
      const mean = a.mean + (delta * b.n) / n;
      const m2 = a.m2 + b.m2 + (delta * delta * a.n * b.n) / n;
      return { n, mean, m2 };
    };
    const singleton = (v: unknown): Welford =>
      typeof v === 'number' ? { n: 1, mean: v, m2: 0 } : IDENTITY;
    const back: Array<{ value: Welford; agg: Welford }> = [];
    const front: Array<{ value: Welford; agg: Welford }> = [];
    const topAgg = (stack: Array<{ value: Welford; agg: Welford }>): Welford =>
      stack.length === 0 ? IDENTITY : stack[stack.length - 1]!.agg;
    return {
      add(_i, v) {
        const value = singleton(v);
        back.push({ value, agg: merge(topAgg(back), value) });
      },
      remove() {
        if (front.length === 0) {
          // Flip `back` onto `front`, reversing so the oldest ends up on top.
          while (back.length > 0) {
            const { value } = back.pop()!;
            front.push({ value, agg: merge(value, topAgg(front)) });
          }
        }
        front.pop();
      },
      snapshot() {
        const { n, m2 } = merge(topAgg(front), topAgg(back));
        return n === 0 ? undefined : Math.sqrt(Math.max(0, m2 / n));
      },
    };
  },
};
