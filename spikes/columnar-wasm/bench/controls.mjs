/**
 * Algorithmic controls — the experiment the go/no-go actually turns on.
 *
 * The kernel sweep says WASM beats pond-ts by 2× on `bin`, 5× on a
 * multi-accumulator `sum`, and 25× on `median`. Read naively that is an
 * argument for porting the substrate to Rust.
 *
 * But three of those wins are *algorithm* changes that happen to have
 * been written in Rust, not properties of Rust:
 *
 *   - `sum`  — 8 independent accumulators instead of one, breaking the
 *              serial FP-add latency chain.
 *   - `minMax` — 4 lanes of running extrema instead of one.
 *   - `median` — quickselect instead of a full sort.
 *   - `gather` — one fused pass over the index array instead of two.
 *
 * Nothing about any of those requires leaving JavaScript. This file
 * implements each one in plain JS over the same `Float64Array`, so the
 * report can split the measured speedup into:
 *
 *     total win  =  (algorithm win, available in JS today)
 *                 × (language win, requires the port)
 *
 * If the language term is ~1.0, the port is not what buys the
 * performance — and a spike that skipped this control would have
 * recommended a rewrite to get something a same-day PR could deliver.
 *
 * Every control is checked against pond-ts's own answer before it is
 * timed; a faster wrong loop is not a control.
 */

/* ── sum: break the accumulator dependency chain ──────────────────── */

/**
 * 8-accumulator sum. Sequential `acc += v[i]` is limited by
 * floating-point add *latency* (~3–4 cycles on Apple silicon), not
 * throughput — the next add can't start until the previous finishes.
 * Eight independent chains keep the FP pipeline busy.
 *
 * Same caveat as the Rust version: this is **not** bit-identical to the
 * sequential sum. FP addition isn't associative. Adopting it in pond-ts
 * would be a semantic change requiring its own decision (the cross-path
 * tests assert the columnar and row paths agree).
 */
export function sumJsReassociated(values, n) {
  let a0 = 0,
    a1 = 0,
    a2 = 0,
    a3 = 0,
    a4 = 0,
    a5 = 0,
    a6 = 0,
    a7 = 0;
  const lim = n - (n % 8);
  for (let i = 0; i < lim; i += 8) {
    a0 += values[i];
    a1 += values[i + 1];
    a2 += values[i + 2];
    a3 += values[i + 3];
    a4 += values[i + 4];
    a5 += values[i + 5];
    a6 += values[i + 6];
    a7 += values[i + 7];
  }
  let acc = a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7;
  for (let i = lim; i < n; i += 1) acc += values[i];
  return acc;
}

/* ── minMax: lane-parallel extrema ───────────────────────────────── */

/**
 * 4-lane fused min/max. Unlike `sum`, this **is** bit-identical to the
 * sequential version — min and max are associative over a finite
 * domain, so regrouping can't change the answer. Adoptable with no
 * semantic decision at all.
 *
 * Keeps the NaN-laundered comparison form (`lo <= x ? lo : x`) that
 * `Float64Column.minMax` uses, so contract-violating NaN input stays
 * bug-for-bug identical.
 */
export function minMaxJsLanes(values, n) {
  if (n === 0) return undefined;
  if (n < 8) {
    let lo = values[0];
    let hi = lo;
    for (let i = 1; i < n; i += 1) {
      const x = values[i];
      lo = lo <= x ? lo : x;
      hi = hi >= x ? hi : x;
    }
    return [lo, hi];
  }
  let l0 = values[0],
    l1 = values[1],
    l2 = values[2],
    l3 = values[3];
  let h0 = l0,
    h1 = l1,
    h2 = l2,
    h3 = l3;
  const lim = n - (n % 4);
  for (let i = 4; i < lim; i += 4) {
    const x0 = values[i],
      x1 = values[i + 1],
      x2 = values[i + 2],
      x3 = values[i + 3];
    l0 = l0 <= x0 ? l0 : x0;
    h0 = h0 >= x0 ? h0 : x0;
    l1 = l1 <= x1 ? l1 : x1;
    h1 = h1 >= x1 ? h1 : x1;
    l2 = l2 <= x2 ? l2 : x2;
    h2 = h2 >= x2 ? h2 : x2;
    l3 = l3 <= x3 ? l3 : x3;
    h3 = h3 >= x3 ? h3 : x3;
  }
  let lo = l0 <= l1 ? l0 : l1;
  const lb = l2 <= l3 ? l2 : l3;
  lo = lo <= lb ? lo : lb;
  let hi = h0 >= h1 ? h0 : h1;
  const hb = h2 >= h3 ? h2 : h3;
  hi = hi >= hb ? hi : hb;
  for (let i = lim; i < n; i += 1) {
    const x = values[i];
    lo = lo <= x ? lo : x;
    hi = hi >= x ? hi : x;
  }
  return [lo, hi];
}

/* ── percentile: quickselect instead of full sort ────────────────── */

/**
 * In-place Hoare-partition quickselect over a `Float64Array`. Places the
 * `k`th smallest element at index `k` and returns it; everything left of
 * `k` is ≤ it.
 *
 * Median-of-three pivot: the columnar data this runs on is frequently
 * *already sorted or nearly so* (a monotonic key column, a cumulative
 * series, a sorted-by-value materialisation). A naive first-element or
 * middle-element pivot degrades to O(n²) on exactly those inputs, which
 * would turn a chart frame into a hang. This is the one place the
 * control has to be careful rather than merely short.
 */
export function quickselect(a, k, lo = 0, hi = a.length - 1) {
  while (lo < hi) {
    if (hi - lo < 16) {
      // Insertion sort the small tail — cheaper than another partition
      // and it makes the neighbouring rank available for interpolation.
      for (let i = lo + 1; i <= hi; i += 1) {
        const v = a[i];
        let j = i - 1;
        while (j >= lo && a[j] > v) {
          a[j + 1] = a[j];
          j -= 1;
        }
        a[j + 1] = v;
      }
      return a[k];
    }
    const mid = (lo + hi) >> 1;
    // Median-of-three, written as three compare-swaps so `a[mid]` ends
    // up holding the median of the three sampled values.
    if (a[mid] < a[lo]) {
      const t = a[mid];
      a[mid] = a[lo];
      a[lo] = t;
    }
    if (a[hi] < a[lo]) {
      const t = a[hi];
      a[hi] = a[lo];
      a[lo] = t;
    }
    if (a[hi] < a[mid]) {
      const t = a[hi];
      a[hi] = a[mid];
      a[mid] = t;
    }
    const pivot = a[mid];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i += 1;
      while (a[j] > pivot) j -= 1;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/**
 * Percentile via quickselect, matching `reducePercentileColumn`'s
 * densify → select → interpolate shape and its exact interpolation
 * formula. `scratch` is caller-owned so the comparison against the
 * pond-ts path isn't distorted by an extra allocation the WASM side
 * doesn't pay.
 */
export function percentileJsQuickselect(col, q, scratch) {
  const values = col._values;
  const validity = col.validity;
  const n = col.length;
  let k = 0;
  if (validity === undefined && col.allFinite) {
    for (let i = 0; i < n; i += 1) scratch[k++] = values[i];
  } else {
    const bits = validity?.bits;
    for (let i = 0; i < n; i += 1) {
      if (bits !== undefined && (bits[i >> 3] & (1 << (i & 7))) === 0) continue;
      const v = values[i];
      if (!col.allFinite && !Number.isFinite(v)) continue;
      scratch[k++] = v;
    }
  }
  if (k === 0) return undefined;
  const dense = scratch.subarray(0, k);
  const rank = (q / 100) * (k - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return quickselect(dense, lo);
  // Select the upper rank first, then the lower within the left
  // partition — same two-step the Rust does.
  const vHi = quickselect(dense, hi);
  const vLo = quickselect(dense, lo, 0, hi);
  return vLo + (vHi - vLo) * (rank - lo);
}

/* ── gather: one fused pass instead of two ───────────────────────── */

/**
 * Fused gather — values and validity in a single walk of `indices`.
 *
 * pond-ts walks `indices` twice: once in `Float64Column.sliceByIndices`
 * for the values, then again inside `validityGatherByIndices` for the
 * bits. On a gather the index array is the thing missing cache, so the
 * second walk costs close to a full re-traversal for no new information.
 *
 * Returns `{ values, bits, defined }`; `bits === null` means every cell
 * is defined (pond-ts's "all defined ⇒ no bitmap" convention).
 */
export function gatherJsFused(col, indices) {
  const src = col._values;
  const len = col.length;
  const validity = col.validity;
  const bits = validity?.bits;
  const n = indices.length;
  const out = new Float64Array(n);
  const outBits = new Uint8Array((n + 7) >> 3);
  let defined = 0;

  if (bits === undefined) {
    for (let i = 0; i < n; i += 1) {
      const k = indices[i];
      if (k >= 0 && k < len) {
        out[i] = src[k];
        outBits[i >> 3] |= 1 << (i & 7);
        defined += 1;
      }
    }
  } else {
    for (let i = 0; i < n; i += 1) {
      const k = indices[i];
      if (k >= 0 && k < len) {
        out[i] = src[k];
        if ((bits[k >> 3] & (1 << (k & 7))) !== 0) {
          outBits[i >> 3] |= 1 << (i & 7);
          defined += 1;
        }
      }
    }
  }
  return { values: out, bits: defined === n ? null : outBits, defined };
}

/* ── sum, guarded: branchless finite filter ──────────────────────── */

/**
 * Guarded sum written so the finite test feeds a *select* rather than a
 * branch. Included because the Rust port initially **regressed** this
 * path — see the report — and the fix is the same idea in both
 * languages, which is itself the point.
 */
export function sumJsGuardedBranchless(values, n) {
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    const x = values[i];
    acc += Number.isFinite(x) ? x : 0;
  }
  return acc;
}
