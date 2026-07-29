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
 * cells**. On the masked path a 32-cell range with gaps blocks even
 * though fewer than 32 values contribute. Deliberate: the gate must be
 * O(1), a defined-count popcount would cost a scan, and the threshold
 * is a perf crossover, not a semantic boundary — the masked kernel is
 * correct at any density.
 */
export const BLOCKED_MIN = 32;

/**
 * Sum `values[start, end)` with eight accumulators. Every cell is a
 * contributor — the caller has established there is no validity bitmap
 * and the column is `allFinite`.
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
 * Sum the **defined** cells of `values[start, end)` with eight
 * accumulators, reading the validity bitmap one byte per eight cells.
 * The caller has established the column is `allFinite`, so every defined
 * cell is a contributor.
 *
 * The byte-at-a-time read is why this stays close to the dense speedup
 * despite the gap check: a fully-defined byte (`0xff`) — the common case
 * even in a column with gaps — costs one load and one compare for eight
 * cells, and the eight adds still issue independently.
 *
 * `start` is aligned up to a byte boundary first so `bits[i >> 3]` is
 * a whole byte of the block; the head and tail run scalar.
 *
 * Callers must check {@link BLOCKED_MIN} first.
 */
export function blockedSumMasked(
  values: Float64Array,
  bits: Uint8Array,
  start: number,
  end: number,
): number {
  let s = 0;
  // Head: up to the first byte boundary, scalar.
  const head = Math.min(end, (start + 7) & ~7);
  for (let i = start; i < head; i += 1) {
    if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) s += values[i]!;
  }
  let a0 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  let a4 = 0;
  let a5 = 0;
  let a6 = 0;
  let a7 = 0;
  const lim = end & ~7;
  for (let i = head; i < lim; i += 8) {
    const m = bits[i >> 3]!;
    if (m === 255) {
      a0 += values[i]!;
      a1 += values[i + 1]!;
      a2 += values[i + 2]!;
      a3 += values[i + 3]!;
      a4 += values[i + 4]!;
      a5 += values[i + 5]!;
      a6 += values[i + 6]!;
      a7 += values[i + 7]!;
    } else if (m !== 0) {
      if ((m & 1) !== 0) a0 += values[i]!;
      if ((m & 2) !== 0) a1 += values[i + 1]!;
      if ((m & 4) !== 0) a2 += values[i + 2]!;
      if ((m & 8) !== 0) a3 += values[i + 3]!;
      if ((m & 16) !== 0) a4 += values[i + 4]!;
      if ((m & 32) !== 0) a5 += values[i + 5]!;
      if ((m & 64) !== 0) a6 += values[i + 6]!;
      if ((m & 128) !== 0) a7 += values[i + 7]!;
    }
  }
  s += a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7;
  // Tail: past the last whole byte, scalar.
  for (let i = Math.max(head, lim); i < end; i += 1) {
    if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) s += values[i]!;
  }
  return s;
}
