/**
 * `WasmFloat64Column` — a drop-in-shaped stand-in for pond-ts's
 * `Float64Column`, backed by WASM linear memory.
 *
 * This is the shape the real integration would take, so the benchmark
 * measures the thing we'd actually ship rather than a microbenchmark
 * harness. Two residency modes, because they have completely different
 * cost structures and the go/no-go turns on which one is achievable:
 *
 * - **Resident** (`WasmFloat64Column.from`) — the values live in WASM
 *   linear memory for the column's lifetime. Every reduction is a bare
 *   call with pointer arguments; nothing is copied. This is the regime
 *   where WASM can win, and it requires the substrate to *own*
 *   allocation — intake writes into WASM memory, not into a JS
 *   `Float64Array` that gets handed over.
 *
 * - **Bridged** (`bridged.*`) — the values live in a JS `Float64Array`
 *   and are copied into WASM for the duration of one call. This is what
 *   a naive "just call into Rust for the hot bit" integration gets, and
 *   it is the honest cost of adding WASM *underneath* an existing JS
 *   column rather than *replacing* it.
 *
 * **Nullable reductions read a status flag, not a NaN sentinel.** The
 * first cut of this wrapper mapped a returned `NaN` to `undefined`,
 * which is wrong: pond-ts's `stdev` can genuinely *return* `NaN` (the
 * Welford recurrence overflows on extreme inputs) and `NaN` is an
 * ordinary inhabitant of `number`. So `mean`/`stdev`/`percentile`/
 * `minMax` return a `u32` status and write the value through an
 * out-pointer, and this layer reads both. The extra memory round-trip
 * is noise against a whole-column scan; getting it wrong was a silent
 * wrong answer.
 *
 * Note the asymmetry with `bin` output: there, `NaN` *is* the correct
 * empty-bucket sentinel, because the output type is a `Float64Array`
 * with a documented "NaN means no data here" convention (canvas breaks
 * the sub-path on a NaN vertex). Same value, opposite meaning, one
 * layer apart.
 */

/** Rust `R_*` reducer codes — mirrors the consts in `src/lib.rs`. */
const REDUCER_CODE = {
  min: 0,
  max: 1,
  sum: 2,
  mean: 3,
  stdev: 4,
  count: 5,
  percentile: 6,
};

export class WasmFloat64Column {
  /** @type {ReturnType<typeof import('./loader.mjs').loadSubstrate> extends Promise<infer T> ? T : never} */
  #rt;
  #valuesPtr;
  #valuesBytes;
  #validityPtr; // 0 ⇒ no bitmap ⇒ every cell defined (pond-ts convention)
  #validityBytes;
  /** Scratch for percentile densify+select. Lazily allocated. */
  #scratchPtr = 0;
  #scratchBytes = 0;
  /** Reused output buffers for `bin`/`binBy`. Sized on demand. */
  #boundsPtr = 0;
  #boundsBytes = 0;
  #outPtr = 0;
  #outBytes = 0;

  length;
  allFinite;
  kind = 'number';
  storage = 'packed-wasm';

  constructor(
    rt,
    valuesPtr,
    valuesBytes,
    length,
    validityPtr,
    validityBytes,
    allFinite,
  ) {
    this.#rt = rt;
    this.#valuesPtr = valuesPtr;
    this.#valuesBytes = valuesBytes;
    this.#validityPtr = validityPtr;
    this.#validityBytes = validityBytes;
    this.length = length;
    this.allFinite = allFinite;
  }

  /**
   * Copies a JS array/typed-array into WASM memory once. After this the
   * column is resident — every subsequent operation is zero-copy.
   *
   * @param rt        the loaded substrate
   * @param values    Float64Array (or array-like) of length `length`
   * @param validity  Uint8Array bitmap, or `undefined` for "all defined"
   * @param allFinite producer's promise that every defined cell is finite
   */
  static from(rt, values, validity, allFinite = false) {
    const n = values.length;
    const { exports, mem } = rt;
    const valuesBytes = n * 8;
    const valuesPtr = exports.pond_alloc(valuesBytes);
    mem.sync().f64.set(values, valuesPtr >>> 3);

    let validityPtr = 0;
    let validityBytes = 0;
    if (validity) {
      validityBytes = validity.length;
      validityPtr = exports.pond_alloc(validityBytes);
      mem.sync().u8.set(validity, validityPtr);
    }
    return new WasmFloat64Column(
      rt,
      valuesPtr,
      valuesBytes,
      n,
      validityPtr,
      validityBytes,
      allFinite,
    );
  }

  /** Releases every buffer this column owns. Without this, resident
   *  columns leak — WASM linear memory never shrinks, so a leak here is
   *  a permanent RSS increase, not a GC-recoverable one. That's a real
   *  operational difference from the JS substrate and is called out in
   *  the report. */
  free() {
    const { exports } = this.#rt;
    exports.pond_free(this.#valuesPtr, this.#valuesBytes);
    if (this.#validityPtr)
      exports.pond_free(this.#validityPtr, this.#validityBytes);
    if (this.#scratchPtr)
      exports.pond_free(this.#scratchPtr, this.#scratchBytes);
    if (this.#boundsPtr) exports.pond_free(this.#boundsPtr, this.#boundsBytes);
    if (this.#outPtr) exports.pond_free(this.#outPtr, this.#outBytes);
    this.#valuesPtr = 0;
    this.#validityPtr = 0;
    this.#scratchPtr = 0;
    this.#boundsPtr = 0;
    this.#outPtr = 0;
  }

  #scratch(bytes) {
    if (this.#scratchBytes >= bytes) return this.#scratchPtr;
    const { exports } = this.#rt;
    if (this.#scratchPtr)
      exports.pond_free(this.#scratchPtr, this.#scratchBytes);
    this.#scratchPtr = exports.pond_alloc(bytes);
    this.#scratchBytes = bytes;
    return this.#scratchPtr;
  }

  #bounds(bytes) {
    if (this.#boundsBytes >= bytes) return this.#boundsPtr;
    const { exports } = this.#rt;
    if (this.#boundsPtr) exports.pond_free(this.#boundsPtr, this.#boundsBytes);
    this.#boundsPtr = exports.pond_alloc(bytes);
    this.#boundsBytes = bytes;
    return this.#boundsPtr;
  }

  #out(bytes) {
    if (this.#outBytes >= bytes) return this.#outPtr;
    const { exports } = this.#rt;
    if (this.#outPtr) exports.pond_free(this.#outPtr, this.#outBytes);
    this.#outPtr = exports.pond_alloc(bytes);
    this.#outBytes = bytes;
    return this.#outPtr;
  }

  /* ── scalar reductions ─────────────────────────────────────────── */

  sum() {
    const { exports } = this.#rt;
    return exports.col_sum(
      this.#valuesPtr,
      this.length,
      this.#validityPtr,
      this.allFinite ? 1 : 0,
    );
  }

  /** Reassociated (8-accumulator) sum — faster, and *not* bit-identical
   *  to `sum()`. See the Rust doc comment. */
  sumReassociated() {
    const { exports } = this.#rt;
    return exports.col_sum_simd(
      this.#valuesPtr,
      this.length,
      this.#validityPtr,
      this.allFinite ? 1 : 0,
    );
  }

  count() {
    const { exports } = this.#rt;
    return exports.col_count(
      this.#valuesPtr,
      this.length,
      this.#validityPtr,
      this.allFinite ? 1 : 0,
    );
  }

  /** Reads the out-param written by a status-returning kernel. */
  #readOut(ok, ptr) {
    if (!ok) return undefined;
    return this.#rt.mem.sync().f64[ptr >>> 3];
  }

  mean() {
    const { exports } = this.#rt;
    const out = this.#out(16);
    const ok = exports.col_mean(
      this.#valuesPtr,
      this.length,
      this.#validityPtr,
      this.allFinite ? 1 : 0,
      out,
    );
    return this.#readOut(ok, out);
  }

  stdev() {
    const { exports } = this.#rt;
    const out = this.#out(16);
    const ok = exports.col_stdev(
      this.#valuesPtr,
      this.length,
      this.#validityPtr,
      this.allFinite ? 1 : 0,
      out,
    );
    return this.#readOut(ok, out);
  }

  minMax(simd = false) {
    const { exports, mem } = this.#rt;
    const out = this.#out(16);
    const fn = simd ? exports.col_min_max_simd : exports.col_min_max;
    const ok = fn(
      this.#valuesPtr,
      this.length,
      this.#validityPtr,
      this.allFinite ? 1 : 0,
      out,
    );
    if (!ok) return undefined;
    const f = mem.sync().f64;
    const i = out >>> 3;
    return [f[i], f[i + 1]];
  }

  min() {
    const mm = this.minMax();
    return mm ? mm[0] : undefined;
  }

  max() {
    const mm = this.minMax();
    return mm ? mm[1] : undefined;
  }

  /** Quickselect. `sorted: true` uses the full-sort variant, which is
   *  the apples-to-apples comparison against the JS path. */
  percentile(q, { sorted = false } = {}) {
    const { exports } = this.#rt;
    const scratch = this.#scratch(this.length * 8);
    const out = this.#out(16);
    const fn = sorted ? exports.col_percentile_sorted : exports.col_percentile;
    const ok = fn(
      this.#valuesPtr,
      this.length,
      this.#validityPtr,
      this.allFinite ? 1 : 0,
      q,
      scratch,
      out,
    );
    return this.#readOut(ok, out);
  }

  median(opts) {
    return this.percentile(50, opts);
  }

  /* ── binning ───────────────────────────────────────────────────── */

  /**
   * Equal-index binning. Output buffers are freshly allocated on the JS
   * side per call — matching pond-ts's contract that `bin` returns
   * caller-owned `Float64Array`s, and deliberately *not* optimised into
   * a reuse pool, because the JS baseline allocates too. Comparing a
   * pooled WASM path against an allocating JS path would flatter the
   * WASM number for a reason that has nothing to do with WASM.
   */
  bin(bins, reducer) {
    const { exports } = this.#rt;
    const boundsPtr = this.#bounds((bins + 1) * 4);
    exports.bin_bounds(this.length, bins, boundsPtr);
    return this.#reduceByBounds(boundsPtr, bins, reducer);
  }

  /**
   * Key-domain binning. `key` and `edges` must already be resident
   * (pointers), which is the realistic chart case: the key column lives
   * in WASM alongside the value column, and `edges` is a small per-frame
   * array the chart writes into a reusable WASM buffer.
   */
  binBy(keyPtr, edgesPtr, w, reducer) {
    const { exports } = this.#rt;
    const boundsPtr = this.#bounds((w + 1) * 4);
    const rc = exports.bin_by_bounds(
      keyPtr,
      this.length,
      edgesPtr,
      w,
      boundsPtr,
    );
    if (rc === -1) throw new RangeError('binBy: edges must be ascending');
    return this.#reduceByBounds(boundsPtr, w, reducer);
  }

  #reduceByBounds(boundsPtr, w, reducer) {
    const { exports, mem } = this.#rt;
    const af = this.allFinite ? 1 : 0;

    if (reducer === 'minMax') {
      const p = this.#out(w * 16);
      exports.reduce_bounds_min_max(
        this.#valuesPtr,
        this.#validityPtr,
        af,
        boundsPtr,
        w,
        p,
        p + w * 8,
      );
      const f = mem.sync().f64;
      return {
        lo: f.slice(p >>> 3, (p >>> 3) + w),
        hi: f.slice((p >>> 3) + w, (p >>> 3) + 2 * w),
      };
    }
    if (reducer === 'minMaxFirstLast') {
      const p = this.#out(w * 32);
      exports.reduce_bounds_m4(
        this.#valuesPtr,
        this.#validityPtr,
        af,
        boundsPtr,
        w,
        p,
        p + w * 8,
        p + w * 16,
        p + w * 24,
      );
      const f = mem.sync().f64;
      const b = p >>> 3;
      return {
        lo: f.slice(b, b + w),
        hi: f.slice(b + w, b + 2 * w),
        first: f.slice(b + 2 * w, b + 3 * w),
        last: f.slice(b + 3 * w, b + 4 * w),
      };
    }

    // Scalar reducers. `p${q}` follows pond-ts's percentile convention.
    let code = REDUCER_CODE[reducer];
    let q = 0;
    if (code === undefined) {
      if (reducer === 'median') {
        code = REDUCER_CODE.percentile;
        q = 50;
      } else if (/^p\d+(\.\d+)?$/.test(reducer)) {
        code = REDUCER_CODE.percentile;
        q = Number(reducer.slice(1));
      } else {
        throw new TypeError(`unsupported bin reducer: ${reducer}`);
      }
    }
    const p = this.#out(w * 8);
    const scratch = this.#scratch(this.length * 8);
    exports.reduce_bounds_scalar(
      this.#valuesPtr,
      this.#validityPtr,
      af,
      boundsPtr,
      w,
      code,
      q,
      p,
      scratch,
    );
    const f = mem.sync().f64;
    return f.slice(p >>> 3, (p >>> 3) + w);
  }

  /* ── views ─────────────────────────────────────────────────────── */

  /**
   * Gather by index — `sliceByIndices` fused with
   * `validityGatherByIndices`. `indicesPtr` is resident; the result is a
   * new resident column (the caller owns it and must `free()`).
   */
  gather(indicesPtr, n) {
    const { exports, mem } = this.#rt;
    const outValues = exports.pond_alloc(n * 8);
    const bitmapBytes = (n + 7) >> 3;
    const outValidity = exports.pond_alloc(bitmapBytes);
    mem.sync().u8.fill(0, outValidity, outValidity + bitmapBytes);

    const defined = exports.gather_f64(
      this.#valuesPtr,
      this.length,
      this.#validityPtr,
      indicesPtr,
      n,
      outValues,
      outValidity,
    );
    // pond-ts convention: all-defined ⇒ no bitmap at all.
    if (defined === n) {
      exports.pond_free(outValidity, bitmapBytes);
      return new WasmFloat64Column(
        this.#rt,
        outValues,
        n * 8,
        n,
        0,
        0,
        this.allFinite,
      );
    }
    return new WasmFloat64Column(
      this.#rt,
      outValues,
      n * 8,
      n,
      outValidity,
      bitmapBytes,
      this.allFinite,
    );
  }

  /** Zero-copy `Float64Array` over the column's WASM-resident values.
   *  **Detaches on any subsequent allocation that grows memory** — do
   *  not hold across calls. */
  view() {
    const f = this.#rt.mem.sync().f64;
    return f.subarray(
      this.#valuesPtr >>> 3,
      (this.#valuesPtr >>> 3) + this.length,
    );
  }

  /** Copies out to a JS-owned `Float64Array`. The cost of leaving the
   *  WASM world — measured explicitly in the bench. */
  toFloat64Array() {
    const f = this.#rt.mem.sync().f64;
    return f.slice(
      this.#valuesPtr >>> 3,
      (this.#valuesPtr >>> 3) + this.length,
    );
  }

  get ptr() {
    return this.#valuesPtr;
  }
  get validityPtr() {
    return this.#validityPtr;
  }
}

/* ══════════════════════════════════════════════════════════════════ */
/* Bridged mode — data lives in JS, copied per call                   */
/* ══════════════════════════════════════════════════════════════════ */

/**
 * The naive integration: keep pond-ts's `Float64Array` exactly where it
 * is and call into WASM for the hot kernel. Every call pays a full
 * copy-in (and, for multi-output kernels, a copy-out).
 *
 * Kept as a separate factory rather than a flag on the class so the
 * benchmark can't accidentally measure one while labelling it the other.
 */
export function makeBridge(rt, maxLength) {
  const { exports } = rt;
  const valuesBytes = maxLength * 8;
  const valuesPtr = exports.pond_alloc(valuesBytes);
  // The widest output any bridged kernel writes is `bin`'s two-channel
  // minMax at `bins * 16` bytes. Sized off `maxLength` (bins never
  // exceeds the row count in practice) with a floor so small columns
  // still admit a wide bin request.
  const outBytes = Math.max(maxLength, 8192) * 16;
  const outPtr = exports.pond_alloc(outBytes);
  const scratchPtr = exports.pond_alloc(valuesBytes);
  const boundsBytes = (maxLength + 1) * 4;
  const boundsPtr = exports.pond_alloc(boundsBytes);

  /** Copy `values` into the staging buffer. This is the tax. */
  const upload = (values) => {
    rt.mem.sync().f64.set(values, valuesPtr >>> 3);
    return values.length;
  };

  return {
    free() {
      exports.pond_free(valuesPtr, valuesBytes);
      exports.pond_free(outPtr, outBytes);
      // `boundsBytes` / `scratch` share the values sizing.
      exports.pond_free(scratchPtr, valuesBytes);
      exports.pond_free(boundsPtr, boundsBytes);
    },
    sum(values, allFinite = true) {
      const n = upload(values);
      return exports.col_sum(valuesPtr, n, 0, allFinite ? 1 : 0);
    },
    minMax(values, allFinite = true) {
      const n = upload(values);
      const ok = exports.col_min_max(
        valuesPtr,
        n,
        0,
        allFinite ? 1 : 0,
        outPtr,
      );
      if (!ok) return undefined;
      const f = rt.mem.sync().f64;
      return [f[outPtr >>> 3], f[(outPtr >>> 3) + 1]];
    },
    stdev(values, allFinite = true) {
      const n = upload(values);
      const ok = exports.col_stdev(valuesPtr, n, 0, allFinite ? 1 : 0, outPtr);
      return ok ? rt.mem.sync().f64[outPtr >>> 3] : undefined;
    },
    median(values, allFinite = true) {
      const n = upload(values);
      const ok = exports.col_percentile(
        valuesPtr,
        n,
        0,
        allFinite ? 1 : 0,
        50,
        scratchPtr,
        outPtr,
      );
      return ok ? rt.mem.sync().f64[outPtr >>> 3] : undefined;
    },
    binMinMax(values, bins, allFinite = true) {
      const n = upload(values);
      exports.bin_bounds(n, bins, boundsPtr);
      exports.reduce_bounds_min_max(
        valuesPtr,
        0,
        allFinite ? 1 : 0,
        boundsPtr,
        bins,
        outPtr,
        outPtr + bins * 8,
      );
      const f = rt.mem.sync().f64;
      const b = outPtr >>> 3;
      return { lo: f.slice(b, b + bins), hi: f.slice(b + bins, b + 2 * bins) };
    },
    /** Upload only — isolates the copy cost from any kernel work. */
    uploadOnly(values) {
      return upload(values);
    },
  };
}
