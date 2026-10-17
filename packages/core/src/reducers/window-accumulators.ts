/**
 * Running accumulators for sliding windows that do not drift ([PND-ROLLSTD]).
 *
 * A rolling `sum` / `avg` / `stdev` keeps a running total: add a value when
 * it enters the window, subtract it when it leaves. With plain doubles every
 * add and subtract rounds, and those rounding errors are never taken back —
 * they pile up for as long as the window stays non-empty (the rest of a
 * batch series, the rest of a live stream). The pile-up is sized by the
 * values that passed *through* the window, not the ones in it now, so it is
 * worst exactly when a window drains to a few close-together values: on a
 * 1M-row price series a two-value window read stdev 0.000442 for a true
 * 0.000354 (25% off) under the old Welford add/delete state.
 *
 * Both accumulators here keep their totals as an unevaluated sum of two
 * doubles, `hi + lo` (double-double), using error-free transforms — Knuth's
 * twoSum (`s = a + b` plus its exact rounding error) and Dekker's twoProd
 * (the same for `a · b`) — so each step's rounding error is captured in `lo`
 * instead of being dropped. A step's residual error is then about
 * 2^-104 of the running total rather than 2^-53, so after a value is added
 * and later removed what is left is the remaining values' total to ~32
 * significant digits — the pile-up still exists but is ~1e16× smaller, far
 * below what a double result can show. The arithmetic is still O(1) per add
 * / remove with no buffer, and removal is still **by value** (any order),
 * which the live layer's `reorder`-mode eviction needs.
 *
 * These are the plain, single-lane accumulators: callers that must survive
 * an overflow put huge values in the exact big lanes of
 * `./overflow-lanes.ts` first. Callers pass finite numbers only.
 */

/** Dekker's split constant, 2^27 + 1. */
const SPLIT = 134217729;

/**
 * A running sum of doubles held as `hi + lo`. `hi` alone is the sum rounded
 * to a double (`lo` is kept below half an ulp of `hi`), so {@link total} is
 * just `hi`. `n` counts contributors so the empty window resets to exactly 0.
 */
export class WindowSum {
  hi = 0;
  lo = 0;
  n = 0;

  add(v: number): void {
    this.n += 1;
    this.#acc(v);
  }

  remove(v: number): void {
    this.n -= 1;
    if (this.n === 0) {
      this.hi = 0;
      this.lo = 0;
      return;
    }
    this.#acc(-v);
  }

  /** The window's sum, rounded once. */
  total(): number {
    return this.hi;
  }

  #acc(v: number): void {
    // twoSum(hi, v), fold in lo, renormalise.
    const h = this.hi;
    const s = h + v;
    const z = s - h;
    const e = h - (s - z) + (v - z) + this.lo;
    const t = s + e;
    this.lo = e - (t - s);
    this.hi = t;
  }
}

/**
 * A sliding-window population variance from double-double sums of shifted
 * values: `Σd` and `Σd²` with `d = v − k`.
 *
 * - **Exact inputs.** `d = v − k` is split exactly into `dh + dl` (twoSum)
 *   and `dh²` exactly into `p + e` (Dekker's twoProd), so what a value adds
 *   is exactly what the same value later removes, at any magnitude.
 * - **The shift `k`** keeps `Σd²` close to the window's own spread so the
 *   final `Σd² − (Σd)²/n` does not cancel. It starts at the first value of a
 *   non-empty run and is moved to the window mean whenever the mean has
 *   wandered more than about one standard deviation from it (checked when the
 *   result is read — see {@link m2}). Moving it is an exact-to-2^-104
 *   rewrite of the two sums (`Σ(d−δ) = Σd − nδ`, `Σ(d−δ)² = Σd² − δ(Σd +
 *   Σ(d−δ))`), not a recompute, and needs no stored values.
 *
 * Values must stay below 2^480 in magnitude (the stdev overflow split): then
 * `|d| < 2^481`, `Σd² < 2^1015` for any window under 2^53 values, and no
 * product here can overflow. Extremely small values (below ~1e-150) lose the
 * low half of `d²` to underflow, as any squared-deviation method does.
 */
export class WindowStdev {
  n = 0;
  /** The shift. Meaningful only while `n > 0`. */
  k = 0;
  s1h = 0;
  s1l = 0;
  s2h = 0;
  s2l = 0;

  add(v: number): void {
    if (this.n === 0) {
      // A fresh run: shift to this value, so it contributes d = 0 exactly.
      this.n = 1;
      this.k = v;
      this.s1h = 0;
      this.s1l = 0;
      this.s2h = 0;
      this.s2l = 0;
      return;
    }
    this.n += 1;
    this.#acc(v, 1);
  }

  remove(v: number): void {
    if (this.n <= 1) {
      this.n = 0;
      this.s1h = 0;
      this.s1l = 0;
      this.s2h = 0;
      this.s2l = 0;
      return;
    }
    this.n -= 1;
    this.#acc(v, -1);
  }

  /** Window mean (`undefined` when empty). */
  mean(): number | undefined {
    const n = this.n;
    if (n === 0) return undefined;
    return this.k + (this.s1h + this.s1l) / n;
  }

  /** Population stdev (`undefined` when empty, exactly 0 for one value). */
  stdev(): number | undefined {
    const n = this.n;
    if (n === 0) return undefined;
    if (n === 1) return 0;
    const m2 = this.m2();
    return Math.sqrt(Math.max(0, m2 / n));
  }

  /**
   * Sum of squared deviations from the mean, `Σd² − (Σd)²/n`. Computed in
   * plain doubles from the double-double sums, which is accurate to a few
   * ulps of the answer while `(Σd)²/n ≤ ½·Σd²` (the shift is within about
   * one stdev of the mean); otherwise the shift is moved to the mean first.
   */
  m2(): number {
    const n = this.n;
    if (n <= 1) return 0;
    let mh = this.s1h / n;
    let q = this.s1h * mh;
    if (q > 0.5 * this.s2h) {
      this.#reshift(mh);
      mh = this.s1h / n;
      q = this.s1h * mh;
    }
    return this.s2h - q + this.s2l - 2 * mh * this.s1l;
  }

  #acc(v: number, sign: 1 | -1): void {
    const k = this.k;
    // d = v − k exactly, as dh + dl.
    const dh = v - k;
    const bb = dh - v;
    const dl = v - (dh - bb) + (-k - bb);
    // dh² exactly, as p + e; the cross term 2·dh·dl is ~2^-53 of p, so its
    // own rounding is ~2^-106 of p (dl² is below that and dropped).
    const c = SPLIT * dh;
    const ah = c - (c - dh);
    const al = dh - ah;
    const p = dh * dh;
    const e = ah * ah - p + 2 * ah * al + al * al + 2 * dh * dl;
    // Σd += sign·(dh + dl), then Σd² += sign·(p + e): twoSum the high
    // parts, fold in the low parts, renormalise (so |lo| ≤ ½ ulp(hi)).
    let h = this.s1h;
    let x = sign * dh;
    let s = h + x;
    let z = s - h;
    let er = h - (s - z) + (x - z) + this.s1l + sign * dl;
    h = s + er;
    this.s1l = er - (h - s);
    this.s1h = h;
    h = this.s2h;
    x = sign * p;
    s = h + x;
    z = s - h;
    er = h - (s - z) + (x - z) + this.s2l + sign * e;
    h = s + er;
    this.s2l = er - (h - s);
    this.s2h = h;
  }

  /**
   * Move the shift by ≈ `delta` (the current mean of `d`), exactly. Written
   * out without helpers or tuples: on short, fast-moving windows this runs
   * on most reads.
   */
  #reshift(delta: number): void {
    const k = this.k;
    const n = this.n;
    const kNew = k + delta;
    // δ = kNew − k exactly, as gh + gl (twoSum).
    const gh = kNew - k;
    let bb = gh - kNew;
    const gl = kNew - (gh - bb) + (-k - bb);
    // n·gh exactly, as nh + nl (twoProd; n is an integer < 2^53).
    let c = SPLIT * gh;
    const ah = c - (c - gh);
    const al = gh - ah;
    c = SPLIT * n;
    const bh = c - (c - n);
    const bl = n - bh;
    const nh = n * gh;
    const nl = ah * bh - nh + ah * bl + al * bh + al * bl + n * gl;
    // S1' = S1 − n·δ
    const s1h = this.s1h;
    const s1l = this.s1l;
    let s = s1h - nh;
    bb = s - s1h;
    let e = s1h - (s - bb) + (-nh - bb) + s1l - nl;
    const u1h = s + e;
    const u1l = e - (u1h - s);
    // T = S1 + S1'
    s = s1h + u1h;
    bb = s - s1h;
    e = s1h - (s - bb) + (u1h - bb) + s1l + u1l;
    const th = s + e;
    const tl = e - (th - s);
    // δ·T, as ph + pl (twoProd on the high parts, cross terms rounded).
    c = SPLIT * th;
    const ch = c - (c - th);
    const cl = th - ch;
    const ph = gh * th;
    const pl = ah * ch - ph + ah * cl + al * ch + al * cl + gh * tl + gl * th;
    // S2' = S2 − δ·T
    const s2h = this.s2h;
    s = s2h - ph;
    bb = s - s2h;
    e = s2h - (s - bb) + (-ph - bb) + this.s2l - pl;
    const u2h = s + e;
    this.s2l = e - (u2h - s);
    this.s2h = u2h;
    this.s1h = u1h;
    this.s1l = u1l;
    this.k = kNew;
  }
}
