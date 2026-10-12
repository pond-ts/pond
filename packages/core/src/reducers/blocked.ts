/**
 * Blocked (reassociated) summation kernels.
 *
 * A sequential `s += values[i]` loop is latency-bound, not
 * throughput-bound: every add waits on the previous one, so a modern
 * core's several floating-point pipelines sit idle. Summing into eight
 * independent accumulators and combining at the end breaks that
 * dependency chain — the adds issue in parallel and the loop runs at
 * throughput instead.
 *
 * Measured on 500k dense `f64` (node 24, Apple silicon):
 *
 * | path                          | sequential | blocked-8 |       |
 * | ----------------------------- | ---------- | --------- | ----- |
 * | dense, no validity            |   0.472 ms |   0.188 ms | 2.51× |
 * | validity bitmap, 4% missing   |   0.620 ms |   0.279 ms | 2.22× |
 *
 * (Measured before [PND-NANREP] replaced the bitmap with `NaN` gaps; the
 * gappy case is now {@link blockedSumFinite}.)
 *
 * ## This changes the answer
 *
 * Floating-point addition is **not associative**, so a blocked sum can
 * differ from a sequential one in the last ulp. That is a deliberate,
 * documented trade — see `docs/notes/blocked-summation.md` — and it is
 * worth being precise about the direction: the blocked result is
 * *generally more accurate*, not less. Sequential summation accumulates
 * rounding error as O(n·ε); summing into k independent accumulators
 * accumulates it as O((n/k)·ε + k·ε). Eight partial sums each carry a
 * shorter error chain than one long one.
 *
 * So this is not "faster but sloppier". It is faster **and** tighter.
 * What it is not is *bit-identical to what pond-ts returned before*, and
 * that is the property callers may have been relying on.
 *
 * ## Why the threshold
 *
 * {@link BLOCKED_MIN} exists because blocking is not free at every size.
 * Eight accumulator inits plus seven combining adds is ~15 fixed
 * operations, and below ~8 elements the blocked loop does not execute at
 * all — every cell falls to the scalar tail, so the fixed cost is pure
 * loss. Measured over 4096 sliding windows:
 *
 * |    n | speedup |
 * | ---- | ------- |
 * |    4 |   0.26× |  ← 3.8× *regression*
 * |    8 |   1.11× |
 * |   16 |   1.20× |
 * |   32 |   1.51× |
 * |   64 |   1.68× |
 * |  256 |   2.12× |
 * | 4096 |   2.40× |
 *
 * At 32 the win is unambiguous, and every bucket small enough to check
 * by hand stays on the sequential path and so stays bit-identical to
 * what it returned before. That is what keeps the exact-equality
 * row-path parity tests (`aggregate() columnar fast path — parity with
 * the row path`, which compare 3–4 element buckets) meaningful rather
 * than merely passing.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

/**
 * Minimum run length before blocked accumulation is used. Shorter runs
 * take the sequential path, which is both faster at that size and
 * bit-identical to pond-ts's historical result.
 *
 * "Run length" is `end - start` — **range positions, not defined
 * cells**. On the finite-guarded path a 32-cell range with gaps blocks
 * even though fewer than 32 values contribute. Deliberate: the gate must be
 * O(1), a defined count would cost a scan, and the threshold is a perf
 * crossover, not a semantic boundary — the guarded kernel is correct at
 * any density.
 */
export const BLOCKED_MIN = 32;

/**
 * Sum `values[start, end)` with eight accumulators. Every cell is a
 * contributor — the caller has established the column is `allFinite`
 * (no missing cell).
 *
 * Callers must check {@link BLOCKED_MIN} first; this is correct at any
 * length but slower than sequential below it.
 */
export function blockedSum(
  values: Float64Array,
  start: number,
  end: number,
): number {
  let a0 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  let a4 = 0;
  let a5 = 0;
  let a6 = 0;
  let a7 = 0;
  const lim = start + (((end - start) >> 3) << 3);
  for (let i = start; i < lim; i += 8) {
    a0 += values[i]!;
    a1 += values[i + 1]!;
    a2 += values[i + 2]!;
    a3 += values[i + 3]!;
    a4 += values[i + 4]!;
    a5 += values[i + 5]!;
    a6 += values[i + 6]!;
    a7 += values[i + 7]!;
  }
  let s = a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7;
  for (let i = lim; i < end; i += 1) s += values[i]!;
  return s;
}

/**
 * Sum the **finite** cells of `values[start, end)` with eight
 * accumulators, skipping missing ones — a missing number is a non-finite
 * value in the buffer ([PND-NANREP]), so the finite test is also the
 * defined test. For a column that is not `allFinite`.
 *
 * Each lane adds `v` when finite and `0` otherwise, so the eight adds
 * still issue independently. Adding `+0` is exact (the accumulators start
 * at `+0` and cannot become `-0`), so this is the same reassociated sum
 * {@link blockedSum} would give over just the finite cells.
 *
 * Callers must check {@link BLOCKED_MIN} first.
 */
export function blockedSumFinite(
  values: Float64Array,
  start: number,
  end: number,
): number {
  let a0 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  let a4 = 0;
  let a5 = 0;
  let a6 = 0;
  let a7 = 0;
  const lim = start + (((end - start) >> 3) << 3);
  for (let i = start; i < lim; i += 8) {
    const v0 = values[i]!;
    const v1 = values[i + 1]!;
    const v2 = values[i + 2]!;
    const v3 = values[i + 3]!;
    const v4 = values[i + 4]!;
    const v5 = values[i + 5]!;
    const v6 = values[i + 6]!;
    const v7 = values[i + 7]!;
    a0 += v0 - v0 === 0 ? v0 : 0;
    a1 += v1 - v1 === 0 ? v1 : 0;
    a2 += v2 - v2 === 0 ? v2 : 0;
    a3 += v3 - v3 === 0 ? v3 : 0;
    a4 += v4 - v4 === 0 ? v4 : 0;
    a5 += v5 - v5 === 0 ? v5 : 0;
    a6 += v6 - v6 === 0 ? v6 : 0;
    a7 += v7 - v7 === 0 ? v7 : 0;
  }
  let s = a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7;
  for (let i = lim; i < end; i += 1) {
    const v = values[i]!;
    if (v - v === 0) s += v;
  }
  return s;
}

/** Count the finite (defined) cells of `values[start, end)`. */
export function countFinite(
  values: Float64Array,
  start: number,
  end: number,
): number {
  let n = 0;
  for (let i = start; i < end; i += 1) {
    const v = values[i]!;
    if (v - v === 0) n += 1;
  }
  return n;
}
