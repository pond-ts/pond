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
 * `rollingState` adds `remove` for its sliding window via Welford's
 * **order-independent delete** (the reverse recurrence). It works in the same
 * deviation space — no `sq/n − mean²` cancellation, no shift drift — and
 * removes *by value*, so it stays correct under the live layer's reorder-mode
 * eviction (which removes the sorted-prefix, not the oldest-arrived event).
 * See its inline note for the mechanics.
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
    // Numerically-stable sliding-window population stdev: Welford's online
    // variance with an **order-independent delete**. `add(v)` is the standard
    // recurrence; `remove(v)` reverses it, both working in deviation space — so
    // unlike the old one-pass `sq/n − mean²` there is no catastrophic
    // cancellation on near-equal large values (`[1e10, 1e10+1, …]` → 0, or a
    // negative variance → NaN; the audit-§1.1 failure mode, previously still
    // live on this path) and no drift on trending data (cumulative distance,
    // elevation). Stable wherever the running mean stays representable (~1e15,
    // vs the one-pass's ~sqrt(2^52) ≈ 6.7e7 squaring ceiling — pond's domain
    // data sits far below that).
    //
    // Removal is **by value, not by position**. That is load-bearing for the
    // live layer: `LiveReduce` shares this state, and a `reorder`-mode source
    // with retention evicts the sorted-prefix — which may be a later arrival,
    // not the oldest — so a positional (FIFO) remove would corrupt the window.
    // A value-based delete is correct regardless of eviction order (the
    // documented contract; see live-reduce.ts and live-buffer-as-window.test).
    // The batch rolling driver removes strictly oldest-first — a special case.
    //
    // Non-finite / missing cells arrive as `undefined` (the factory wrapper
    // applies the non-finite policy); `add`/`remove` both skip them symmetrically
    // so they never enter `n`.
    let n = 0;
    let mean = 0;
    let m2 = 0;
    return {
      add(_i, v) {
        if (typeof v !== 'number') return;
        n += 1;
        const delta = v - mean;
        mean += delta / n;
        m2 += delta * (v - mean);
      },
      remove(_i, v) {
        if (typeof v !== 'number') return;
        if (n <= 1) {
          // Removing the final contributor — reset exactly (no 0/0, no drift).
          n = 0;
          mean = 0;
          m2 = 0;
          return;
        }
        const meanWith = mean;
        n -= 1;
        // Deviation-space mean update (mean − (v − mean)/n): avoids the large
        // `n·mean − v` product, staying precise at large magnitudes.
        mean = meanWith - (v - meanWith) / n;
        // Reverse Welford: M2 −= (v − meanNew)·(v − meanOld).
        m2 -= (v - mean) * (v - meanWith);
        if (m2 < 0) m2 = 0; // clamp FP round-off (never a gross negative)
      },
      snapshot() {
        return n === 0 ? undefined : Math.sqrt(Math.max(0, m2 / n));
      },
    };
  },
};
