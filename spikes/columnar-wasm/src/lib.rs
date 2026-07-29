//! pond-ts columnar substrate — Rust/WASM spike.
//!
//! Ports the hot `Float64Column` kernels from
//! `packages/core/src/columnar/` + `packages/core/src/column.ts` to
//! Rust, compiled to `wasm32-unknown-unknown` with a hand-rolled
//! `extern "C"` ABI (no wasm-bindgen).
//!
//! **Why no wasm-bindgen.** The whole question this spike answers is
//! "what does the JS↔WASM boundary cost, and does the kernel win pay
//! for it." wasm-bindgen's generated glue hides that boundary behind
//! convenience wrappers that copy typed arrays in and out. Rolling the
//! ABI by hand makes every byte crossing the boundary visible in the
//! benchmark, and drops the toolchain to `cargo build` + a 60-line
//! loader that works unmodified in Node and the browser.
//!
//! **ABI conventions.**
//! - A column is *not* an object here. JS holds the tuple
//!   `(values_ptr, len, validity_ptr, all_finite)` and passes it flat.
//!   `validity_ptr == 0` means "no bitmap ⇒ every cell defined", which
//!   is exactly pond-ts's `validity === undefined` convention.
//! - **Nullable** reductions (`mean`, `stdev`, `percentile`, `minMax`)
//!   write their result through an out-pointer and return a `u32`
//!   status: 1 = has value, 0 = `undefined`. They do *not* use `NaN` as
//!   an in-band sentinel.
//!
//!   That looks like over-engineering until you notice pond-ts's return
//!   type is `number | undefined` and `NaN` is a perfectly ordinary
//!   inhabitant of `number`. It is also *reachable*: Welford's
//!   recurrence overflows to `NaN` on `[MAX_VALUE, -MAX_VALUE, 1]`, and
//!   pond-ts faithfully returns that `NaN`. A NaN sentinel would silently
//!   rewrite it to `undefined` — a wrong answer produced by the
//!   calling convention rather than by the kernel. The parity harness
//!   caught this after the first version shipped the sentinel.
//! - Non-nullable reductions (`sum`, `count`) return directly; their
//!   empty values (`0`) are mathematically well-defined.
//! - Multi-output kernels write into caller-provided output buffers.
//!
//! **Semantics are pinned to pond-ts, not to what's fastest.** In
//! particular:
//! - Non-finite cells (`NaN`/`±Inf`) are treated as *missing* by every
//!   reducer — the reducer non-finite policy
//!   (`docs/notes/reducer-nan-policy.md`).
//! - `all_finite` is the producer's promise that every *defined* cell is
//!   finite; when true, the per-element finite guard is skipped.
//! - `stdev` is the **population** stdev via Welford's recurrence, the
//!   same recurrence the JS path uses, so results agree to FP noise.
//! - `percentile` interpolates linearly between ranks, matching
//!   `reducePercentileColumn`.
//!
//! Where a faster-but-different algorithm exists, it is exposed as a
//! *separate* export rather than silently swapped in — see
//! `col_sum_simd` (reassociated) vs `col_sum` (sequential), and
//! `col_percentile` (quickselect) vs the JS full-sort. The report
//! separates "Rust is faster" from "this is a better algorithm that JS
//! could also adopt."

#![allow(clippy::missing_safety_doc)]

use std::alloc::{alloc as rust_alloc, dealloc as rust_dealloc, Layout};

/// Alignment used for every buffer handed to JS. 8 bytes covers `f64`
/// and `i32`; `Uint8Array` views don't care.
const ALIGN: usize = 8;

/* ══════════════════════════════════════════════════════════════════ */
/* Memory                                                             */
/* ══════════════════════════════════════════════════════════════════ */

/// Allocates `bytes` of linear memory and returns the offset. JS builds
/// a typed-array view over `memory.buffer` at this offset.
///
/// Returns 0 on a zero-byte request (JS treats 0 as the null pointer,
/// which doubles as the "no validity bitmap" sentinel — so a zero-length
/// buffer is never allocated).
#[no_mangle]
pub extern "C" fn pond_alloc(bytes: usize) -> *mut u8 {
    if bytes == 0 {
        return std::ptr::null_mut();
    }
    // SAFETY: `bytes != 0`, ALIGN is a valid power-of-two alignment.
    unsafe { rust_alloc(Layout::from_size_align_unchecked(bytes, ALIGN)) }
}

/// Frees a buffer previously returned by `pond_alloc`. `bytes` must be
/// the same size passed to the allocation (Rust's allocator is sized).
#[no_mangle]
pub unsafe extern "C" fn pond_free(ptr: *mut u8, bytes: usize) {
    if ptr.is_null() || bytes == 0 {
        return;
    }
    rust_dealloc(ptr, Layout::from_size_align_unchecked(bytes, ALIGN));
}

/// Does nothing. Exists to measure the floor cost of one JS→WASM call
/// so the benchmark can subtract the boundary from the kernel.
#[no_mangle]
pub extern "C" fn pond_noop() {}

/// Like `pond_noop` but takes the same argument shape as a reduction,
/// so the measured floor includes argument marshalling.
#[no_mangle]
pub extern "C" fn pond_noop_args(_a: *const f64, _b: u32, _c: *const u8, _d: u32) -> f64 {
    0.0
}

/* ══════════════════════════════════════════════════════════════════ */
/* Validity bitmap                                                    */
/* ══════════════════════════════════════════════════════════════════ */

/// `bits[i >> 3] & (1 << (i & 7))` — the identical layout to
/// `ValidityBitmap` in `packages/core/src/columnar/validity.ts`, which
/// is what makes a zero-copy handoff possible in the first place.
#[inline(always)]
unsafe fn is_defined(bits: *const u8, i: usize) -> bool {
    (*bits.add(i >> 3) & (1u8 << (i & 7))) != 0
}

/// Counts set bits over the first `len` bits. Rust's `count_ones`
/// lowers to `i64.popcnt`, a single wasm instruction — where the JS
/// side has to walk a 256-entry lookup table byte at a time.
#[no_mangle]
pub unsafe extern "C" fn validity_popcount(bits: *const u8, len: usize) -> u32 {
    if len == 0 {
        return 0;
    }
    let full_bytes = len >> 3;
    let mut total: u32 = 0;

    // Chunk the full bytes 8-at-a-time through u64::count_ones.
    let words = full_bytes / 8;
    let mut i = 0usize;
    while i < words {
        let w = (bits.add(i * 8) as *const u64).read_unaligned();
        total += w.count_ones();
        i += 1;
    }
    let mut b = words * 8;
    while b < full_bytes {
        total += (*bits.add(b)).count_ones();
        b += 1;
    }

    let remaining = len & 7;
    if remaining > 0 {
        let mask = (1u8 << remaining) - 1;
        total += (*bits.add(full_bytes) & mask).count_ones();
    }
    total
}

/// Counts set bits in the half-open range `[start, end)`. Mirrors
/// `countBitsInRange`.
#[no_mangle]
pub unsafe extern "C" fn validity_count_range(bits: *const u8, start: usize, end: usize) -> u32 {
    if end <= start {
        return 0;
    }
    let start_byte = start >> 3;
    let end_byte = end >> 3;
    let start_bit = start & 7;
    let end_bit = end & 7;

    if start_byte == end_byte {
        let mask = (((1u16 << end_bit) - 1) & !((1u16 << start_bit) - 1)) as u8;
        return (*bits.add(start_byte) & mask).count_ones();
    }

    let mut total: u32 = if start_bit > 0 {
        let mask = (!((1u16 << start_bit) - 1)) as u8;
        (*bits.add(start_byte) & mask).count_ones()
    } else {
        (*bits.add(start_byte)).count_ones()
    };

    let mut i = start_byte + 1;
    // Wide middle in u64 words.
    while i + 8 <= end_byte {
        let w = (bits.add(i) as *const u64).read_unaligned();
        total += w.count_ones();
        i += 8;
    }
    while i < end_byte {
        total += (*bits.add(i)).count_ones();
        i += 1;
    }

    if end_bit > 0 {
        let mask = ((1u16 << end_bit) - 1) as u8;
        total += (*bits.add(end_byte) & mask).count_ones();
    }
    total
}

/* ══════════════════════════════════════════════════════════════════ */
/* Scalar reductions                                                  */
/* ══════════════════════════════════════════════════════════════════ */

/// Sequential left-to-right summation — the *same* accumulation order
/// as the JS `sum` reducer, so the two agree bit-for-bit. See
/// `col_sum_simd` for the reassociated variant and what it costs.
#[no_mangle]
pub unsafe extern "C" fn col_sum(
    values: *const f64,
    len: usize,
    validity: *const u8,
    all_finite: u32,
) -> f64 {
    let vals = std::slice::from_raw_parts(values, len);
    let mut acc = 0.0f64;
    if validity.is_null() {
        if all_finite != 0 {
            for &x in vals {
                acc += x;
            }
        } else {
            for &x in vals {
                if x.is_finite() {
                    acc += x;
                }
            }
        }
    } else if all_finite != 0 {
        for (i, &x) in vals.iter().enumerate() {
            if is_defined(validity, i) {
                acc += x;
            }
        }
    } else {
        for (i, &x) in vals.iter().enumerate() {
            if is_defined(validity, i) && x.is_finite() {
                acc += x;
            }
        }
    }
    acc
}

/// Guarded sum with the finite test feeding a **select** instead of a
/// branch.
///
/// The straightforward `if x.is_finite() { acc += x }` in `col_sum`
/// measured *slower than the JavaScript it replaces* on finite data with
/// `all_finite: false` — the common shape for computed columns, where no
/// producer can prove finiteness. The branch splits the loop body into
/// two basic blocks and stops the accumulate from staying in one tight
/// chain; V8 compiles the equivalent JS to a branchless select and
/// pipelines it against the FP-add latency for free.
///
/// Adding `0.0` is exact here rather than merely close: `acc` starts at
/// `+0.0` and `+0.0 + -0.0` is `+0.0`, so `acc` can never become `-0.0`
/// and the identity never has a sign to lose. That is what makes this a
/// legal rewrite of the guarded path rather than a second, subtly
/// different reducer.
#[no_mangle]
pub unsafe extern "C" fn col_sum_guarded_branchless(
    values: *const f64,
    len: usize,
    validity: *const u8,
) -> f64 {
    let vals = std::slice::from_raw_parts(values, len);
    let mut acc = 0.0f64;
    if validity.is_null() {
        for &x in vals {
            acc += if x.is_finite() { x } else { 0.0 };
        }
    } else {
        for (i, &x) in vals.iter().enumerate() {
            let keep = is_defined(validity, i) && x.is_finite();
            acc += if keep { x } else { 0.0 };
        }
    }
    acc
}

/// Reassociated summation: 8 independent accumulators, combined at the
/// end. Breaks the serial `addsd` dependency chain so the pipeline can
/// keep several adds in flight (and, with `+simd128`, so LLVM can fuse
/// pairs into `f64x2.add`).
///
/// **This does not return the same bits as `col_sum`.** Floating-point
/// addition is not associative; regrouping the summands changes the
/// rounding. It is *not* automatically worse — multi-accumulator
/// summation has strictly better error bounds than the sequential one —
/// but it is *different*, and pond-ts's cross-path tests assert that the
/// columnar fast path and the row path agree. Exposed separately so the
/// report can price the divergence honestly rather than smuggling it in.
#[no_mangle]
pub unsafe extern "C" fn col_sum_simd(
    values: *const f64,
    len: usize,
    validity: *const u8,
    all_finite: u32,
) -> f64 {
    // Only the dense, provably-finite path is worth vectorizing; the
    // gappy/guarded paths are branch-bound and fall back.
    if !validity.is_null() || all_finite == 0 {
        return col_sum(values, len, validity, all_finite);
    }
    let vals = std::slice::from_raw_parts(values, len);
    let mut a = [0.0f64; 8];
    let chunks = vals.chunks_exact(8);
    let tail = chunks.remainder();
    for c in chunks {
        a[0] += c[0];
        a[1] += c[1];
        a[2] += c[2];
        a[3] += c[3];
        a[4] += c[4];
        a[5] += c[5];
        a[6] += c[6];
        a[7] += c[7];
    }
    let mut acc = ((a[0] + a[1]) + (a[2] + a[3])) + ((a[4] + a[5]) + (a[6] + a[7]));
    for &x in tail {
        acc += x;
    }
    acc
}

/// Count of **defined** cells (validity-aware, and finite-aware on the
/// guarded path) — matches `Float64Column.count()`.
#[no_mangle]
pub unsafe extern "C" fn col_count(
    values: *const f64,
    len: usize,
    validity: *const u8,
    all_finite: u32,
) -> u32 {
    if all_finite != 0 {
        return if validity.is_null() {
            len as u32
        } else {
            validity_popcount(validity, len)
        };
    }
    let vals = std::slice::from_raw_parts(values, len);
    let mut n = 0u32;
    if validity.is_null() {
        for &x in vals {
            if x.is_finite() {
                n += 1;
            }
        }
    } else {
        for (i, &x) in vals.iter().enumerate() {
            if is_defined(validity, i) && x.is_finite() {
                n += 1;
            }
        }
    }
    n
}

/// Arithmetic mean over defined+finite cells. Writes the result to
/// `out`; returns 1 when a result exists, 0 for `undefined` (no
/// contributing cell). See the module doc on why this is an out-param
/// rather than a NaN sentinel.
#[no_mangle]
pub unsafe extern "C" fn col_mean(
    values: *const f64,
    len: usize,
    validity: *const u8,
    all_finite: u32,
    out: *mut f64,
) -> u32 {
    let vals = std::slice::from_raw_parts(values, len);
    let mut acc = 0.0f64;
    let mut n = 0usize;
    if validity.is_null() && all_finite != 0 {
        for &x in vals {
            acc += x;
        }
        n = len;
    } else {
        for (i, &x) in vals.iter().enumerate() {
            if !validity.is_null() && !is_defined(validity, i) {
                continue;
            }
            if all_finite == 0 && !x.is_finite() {
                continue;
            }
            acc += x;
            n += 1;
        }
    }
    if n == 0 {
        return 0;
    }
    *out = acc / n as f64;
    1
}

/// Fused `[min, max]` in one pass — `Float64Column.minMax()`, the
/// chart's per-frame Y-extent primitive. Writes two `f64` to `out`.
/// Returns 1 when a result exists, 0 for "undefined" (empty, or no
/// defined+finite cell).
///
/// The `all_finite` fast path uses the same NaN-laundered comparison
/// form as the JS (`lo = lo <= x ? lo : x`), so on contract-violating
/// NaN-bearing input the two stay bug-for-bug identical.
#[no_mangle]
pub unsafe extern "C" fn col_min_max(
    values: *const f64,
    len: usize,
    validity: *const u8,
    all_finite: u32,
    out: *mut f64,
) -> u32 {
    if len == 0 {
        return 0;
    }
    let vals = std::slice::from_raw_parts(values, len);

    if all_finite != 0 {
        if validity.is_null() {
            let mut lo = vals[0];
            let mut hi = lo;
            for &x in &vals[1..] {
                lo = if lo <= x { lo } else { x };
                hi = if hi >= x { hi } else { x };
            }
            *out = lo;
            *out.add(1) = hi;
            return 1;
        }
        let mut i = 0usize;
        while i < len && !is_defined(validity, i) {
            i += 1;
        }
        if i >= len {
            return 0;
        }
        let mut lo = vals[i];
        let mut hi = lo;
        i += 1;
        while i < len {
            if is_defined(validity, i) {
                let x = vals[i];
                lo = if lo <= x { lo } else { x };
                hi = if hi >= x { hi } else { x };
            }
            i += 1;
        }
        *out = lo;
        *out.add(1) = hi;
        return 1;
    }

    // Guarded: skip missing and non-finite.
    let mut seen = false;
    let mut lo = 0.0f64;
    let mut hi = 0.0f64;
    for (i, &x) in vals.iter().enumerate() {
        if !validity.is_null() && !is_defined(validity, i) {
            continue;
        }
        if !x.is_finite() {
            continue;
        }
        if !seen {
            lo = x;
            hi = x;
            seen = true;
        } else {
            if x < lo {
                lo = x;
            }
            if x > hi {
                hi = x;
            }
        }
    }
    if !seen {
        return 0;
    }
    *out = lo;
    *out.add(1) = hi;
    1
}

/// SIMD-shaped fused min/max: 4 lanes of running extrema, reduced at the
/// end. Unlike `sum`, min/max **are** associative over a finite domain,
/// so this returns bit-identical results to `col_min_max` — the one
/// place vectorization is semantically free.
///
/// Restricted to the dense + provably-finite path; anything else falls
/// back (the branchy paths gain nothing from lane parallelism).
#[no_mangle]
pub unsafe extern "C" fn col_min_max_simd(
    values: *const f64,
    len: usize,
    validity: *const u8,
    all_finite: u32,
    out: *mut f64,
) -> u32 {
    if !validity.is_null() || all_finite == 0 || len < 8 {
        return col_min_max(values, len, validity, all_finite, out);
    }
    let vals = std::slice::from_raw_parts(values, len);
    let mut lo = [vals[0], vals[1], vals[2], vals[3]];
    let mut hi = lo;
    let chunks = vals.chunks_exact(4);
    let tail = chunks.remainder();
    for c in chunks {
        for k in 0..4 {
            let x = c[k];
            lo[k] = if lo[k] <= x { lo[k] } else { x };
            hi[k] = if hi[k] >= x { hi[k] } else { x };
        }
    }
    let mut l = if lo[0] <= lo[1] { lo[0] } else { lo[1] };
    let l2 = if lo[2] <= lo[3] { lo[2] } else { lo[3] };
    l = if l <= l2 { l } else { l2 };
    let mut h = if hi[0] >= hi[1] { hi[0] } else { hi[1] };
    let h2 = if hi[2] >= hi[3] { hi[2] } else { hi[3] };
    h = if h >= h2 { h } else { h2 };
    for &x in tail {
        l = if l <= x { l } else { x };
        h = if h >= x { h } else { x };
    }
    *out = l;
    *out.add(1) = h;
    1
}

/// Population standard deviation via Welford's recurrence — the same
/// recurrence as `reducers/stdev.ts`, chosen there so the columnar fast
/// path, the row path, and the live incremental path cannot drift.
/// Keeping the recurrence identical here is what lets the parity test
/// assert bit-equality rather than a tolerance.
///
/// Writes to `out`; returns 1 on a result, 0 for `undefined` (no finite
/// contributor). The result itself **may legitimately be `NaN`** — the
/// recurrence overflows on extreme inputs and pond-ts propagates that,
/// which is precisely why the status is out-of-band.
#[no_mangle]
pub unsafe extern "C" fn col_stdev(
    values: *const f64,
    len: usize,
    validity: *const u8,
    all_finite: u32,
    out: *mut f64,
) -> u32 {
    let vals = std::slice::from_raw_parts(values, len);
    let mut n = 0f64;
    let mut mean = 0f64;
    let mut m2 = 0f64;

    if validity.is_null() && all_finite != 0 {
        for &x in vals {
            n += 1.0;
            let delta = x - mean;
            mean += delta / n;
            m2 += delta * (x - mean);
        }
    } else {
        for (i, &x) in vals.iter().enumerate() {
            if !validity.is_null() && !is_defined(validity, i) {
                continue;
            }
            if all_finite == 0 && !x.is_finite() {
                continue;
            }
            n += 1.0;
            let delta = x - mean;
            mean += delta / n;
            m2 += delta * (x - mean);
        }
    }
    if n == 0.0 {
        return 0;
    }
    *out = js_max0(m2 / n).sqrt();
    1
}

/// `Math.max(0, x)` with **JavaScript** semantics.
///
/// Rust's `f64::max` implements IEEE-754 `maxNum`: it *ignores* NaN and
/// returns the other operand. JavaScript's `Math.max` *propagates* NaN.
/// So `(m2 / n).max(0.0)` — a literal transliteration of the JS
/// `Math.max(0, m2 / n)` in `reducers/stdev.ts` — silently turns a NaN
/// variance into `0`, and `stdev` then reports `0` where pond-ts reports
/// `NaN`.
///
/// That is not hypothetical: Welford overflows to NaN on
/// `[MAX_VALUE, -MAX_VALUE, 1]` (the intermediate `delta` hits ±∞), and
/// the parity harness caught exactly this. It is the archetypal
/// port-to-Rust bug — the code reads correct, compiles, passes every
/// happy-path test, and disagrees on one edge case in a way no type
/// system flags.
///
/// The clamp exists to absorb FP round-off (`m2` is non-negative by
/// construction), so preserving JS's NaN propagation is the right call:
/// a NaN here means the recurrence genuinely broke down, and reporting
/// `0` would be a lie.
#[inline(always)]
fn js_max0(x: f64) -> f64 {
    if x.is_nan() {
        f64::NAN
    } else if x > 0.0 {
        x
    } else {
        // Covers x <= 0 and ±0 — `Math.max(0, -0)` is `+0`.
        0.0
    }
}

/// Gathers defined+finite cells into `scratch` (caller-allocated,
/// `len` f64 wide) and returns the count. Shared prologue for
/// percentile-family reductions.
#[inline]
unsafe fn densify(
    values: *const f64,
    len: usize,
    validity: *const u8,
    all_finite: u32,
    scratch: *mut f64,
) -> usize {
    let vals = std::slice::from_raw_parts(values, len);
    let out = std::slice::from_raw_parts_mut(scratch, len);
    let mut k = 0usize;
    if validity.is_null() && all_finite != 0 {
        out[..len].copy_from_slice(vals);
        return len;
    }
    for (i, &x) in vals.iter().enumerate() {
        if !validity.is_null() && !is_defined(validity, i) {
            continue;
        }
        if all_finite == 0 && !x.is_finite() {
            continue;
        }
        out[k] = x;
        k += 1;
    }
    k
}

/// Linear-interpolated percentile over defined+finite cells — matches
/// `reducePercentileColumn` (`q` in `[0, 100]`). Writes to `out`;
/// returns 1 on a result, 0 for `undefined`.
///
/// **Algorithmically different from the JS path on purpose.** JS
/// densifies then calls `Float64Array.prototype.sort()` — a full
/// O(n log n) sort to answer a question that needs one or two order
/// statistics. This uses `select_nth_unstable_by` (quickselect,
/// O(n) expected). The report separates that win from the
/// language win, because JS could adopt quickselect too.
///
/// `scratch` must be a caller-allocated `len`-wide f64 buffer.
#[no_mangle]
pub unsafe extern "C" fn col_percentile(
    values: *const f64,
    len: usize,
    validity: *const u8,
    all_finite: u32,
    q: f64,
    scratch: *mut f64,
    out: *mut f64,
) -> u32 {
    let k = densify(values, len, validity, all_finite, scratch);
    if k == 0 {
        return 0;
    }
    let dense = std::slice::from_raw_parts_mut(scratch, k);
    *out = percentile_of_unsorted(dense, q);
    1
}

/// Same, but with a full sort instead of quickselect — the apples-to-
/// apples counterpart to the JS `Float64Array.sort()` path, so the
/// benchmark can attribute the win to the language or to the algorithm.
#[no_mangle]
pub unsafe extern "C" fn col_percentile_sorted(
    values: *const f64,
    len: usize,
    validity: *const u8,
    all_finite: u32,
    q: f64,
    scratch: *mut f64,
    out: *mut f64,
) -> u32 {
    let k = densify(values, len, validity, all_finite, scratch);
    if k == 0 {
        return 0;
    }
    let dense = std::slice::from_raw_parts_mut(scratch, k);
    dense.sort_unstable_by(f64::total_cmp);
    let rank = (q / 100.0) * (k - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    *out = if lo == hi {
        dense[lo]
    } else {
        dense[lo] + (dense[hi] - dense[lo]) * (rank - lo as f64)
    };
    1
}

/// Percentile from an unsorted dense slice via up to two quickselects.
/// `total_cmp` is a total order on `f64` and never panics — the
/// `partial_cmp().unwrap()` idiom would panic on a NaN that slipped
/// through a wrongly-`true` `all_finite` flag, turning a wrong answer
/// into a trap. (In wasm a Rust panic with `panic=abort` is an
/// `unreachable` trap that poisons the whole instance — worth avoiding
/// structurally, not just defensively.)
fn percentile_of_unsorted(dense: &mut [f64], q: f64) -> f64 {
    let k = dense.len();
    let rank = (q / 100.0) * (k - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    if lo == hi {
        let (_, nth, _) = dense.select_nth_unstable_by(lo, f64::total_cmp);
        return *nth;
    }
    // Select the upper rank first; that leaves everything < it in the
    // left partition, so the second select only searches that prefix.
    let (left, nth_hi, _) = dense.select_nth_unstable_by(hi, f64::total_cmp);
    let v_hi = *nth_hi;
    let (_, nth_lo, _) = left.select_nth_unstable_by(lo, f64::total_cmp);
    let v_lo = *nth_lo;
    v_lo + (v_hi - v_lo) * (rank - lo as f64)
}

/* ══════════════════════════════════════════════════════════════════ */
/* Binning — bounds derivation                                        */
/* ══════════════════════════════════════════════════════════════════ */

/// Equal-index bin boundaries: `bounds[b] = floor(b * n / bins)`.
/// Integer math in `u64` — exact where the JS `Math.floor((b * n) /
/// bins)` relies on the product staying under 2^53.
#[no_mangle]
pub unsafe extern "C" fn bin_bounds(n: usize, bins: usize, out: *mut i32) {
    let o = std::slice::from_raw_parts_mut(out, bins + 1);
    o[0] = 0;
    for b in 1..bins {
        o[b] = ((b as u64 * n as u64) / bins as u64) as i32;
    }
    o[bins] = n as i32;
}

/// Key-domain bin boundaries — the `binBy` merge walk. `key` is
/// non-decreasing and `edges` ascending (both caller preconditions,
/// documented not asserted per element: this is a per-pixel hot path).
///
/// `bounds[b]` = first index with `key >= edges[b]`; the final bound uses
/// `key > edges[W]` so a sample exactly on the max edge lands in the last
/// bucket — same inclusivity rule as the JS.
///
/// Returns `-1` if `edges` is non-ascending (the one check the JS also
/// makes, since it's O(W) not O(n)), otherwise 0.
#[no_mangle]
pub unsafe extern "C" fn bin_by_bounds(
    key: *const f64,
    n: usize,
    edges: *const f64,
    w: usize,
    out: *mut i32,
) -> i32 {
    bounds_from_edges(key, n, edges, w, 1, out)
}

/// Same merge walk, with the final edge's inclusivity as a parameter.
///
/// `binBy` and `aggregate` genuinely disagree here, and the difference is
/// one comparison:
///
/// - **`binBy`** (`final_inclusive = 1`) — the last bucket is closed, so a
///   sample sitting exactly on the max edge lands in it rather than falling
///   off the end. Right for a chart: the edges span the visible range, and
///   dropping the final sample leaves a visible notch.
/// - **`aggregate`** (`final_inclusive = 0`) — *every* bucket is half-open
///   `[begin, end)`, including the last, because `tryAggregateColumnarTimeKeyed`
///   scans `begins[i] < bucketEnd` uniformly. Right for time bucketing: an
///   event at exactly `end` belongs to the *next* window, and making the last
///   bucket special would double-count it if the caller aggregated again over
///   an adjoining range.
///
/// Getting this wrong is a one-row-per-call error that only shows up when a
/// timestamp lands exactly on a bucket boundary — which, on a regular grid,
/// is every timestamp.
#[no_mangle]
pub unsafe extern "C" fn bounds_from_edges(
    key: *const f64,
    n: usize,
    edges: *const f64,
    w: usize,
    final_inclusive: u32,
    out: *mut i32,
) -> i32 {
    let keys = std::slice::from_raw_parts(key, n);
    let e = std::slice::from_raw_parts(edges, w + 1);
    let o = std::slice::from_raw_parts_mut(out, w + 1);
    let mut i = 0usize;
    let mut prev = e[0];
    for b in 0..=w {
        let edge = e[b];
        if b > 0 && edge < prev {
            return -1;
        }
        prev = edge;
        if b == w && final_inclusive != 0 {
            while i < n && keys[i] <= edge {
                i += 1;
            }
        } else {
            while i < n && keys[i] < edge {
                i += 1;
            }
        }
        o[b] = i as i32;
    }
    0
}

/* ══════════════════════════════════════════════════════════════════ */
/* Binning — the per-bucket reduction engine                          */
/* ══════════════════════════════════════════════════════════════════ */

/// Fused two-channel min/max per bucket — `bin(W, 'minMax')`, the
/// canvas decimator's inner primitive. Empty buckets are `NaN` on both
/// channels (canvas-friendly: `lineTo(px, NaN)` breaks the sub-path).
///
/// The validity/finiteness branch is hoisted outside the bucket loop
/// exactly as the JS does — it's invariant across buckets, and leaving
/// it inside costs a branch per element on the hottest loop in the
/// library.
#[no_mangle]
pub unsafe extern "C" fn reduce_bounds_min_max(
    values: *const f64,
    validity: *const u8,
    all_finite: u32,
    bounds: *const i32,
    w: usize,
    lo_out: *mut f64,
    hi_out: *mut f64,
) {
    let bd = std::slice::from_raw_parts(bounds, w + 1);
    let lo_o = std::slice::from_raw_parts_mut(lo_out, w);
    let hi_o = std::slice::from_raw_parts_mut(hi_out, w);

    if all_finite == 0 {
        for b in 0..w {
            let (start, end) = (bd[b] as usize, bd[b + 1] as usize);
            let mut seen = false;
            let mut lo = 0.0f64;
            let mut hi = 0.0f64;
            for i in start..end {
                if !validity.is_null() && !is_defined(validity, i) {
                    continue;
                }
                let x = *values.add(i);
                if !x.is_finite() {
                    continue;
                }
                if !seen {
                    lo = x;
                    hi = x;
                    seen = true;
                } else {
                    if x < lo {
                        lo = x;
                    }
                    if x > hi {
                        hi = x;
                    }
                }
            }
            if seen {
                lo_o[b] = lo;
                hi_o[b] = hi;
            } else {
                lo_o[b] = f64::NAN;
                hi_o[b] = f64::NAN;
            }
        }
        return;
    }

    if validity.is_null() {
        for b in 0..w {
            let (start, end) = (bd[b] as usize, bd[b + 1] as usize);
            if end <= start {
                lo_o[b] = f64::NAN;
                hi_o[b] = f64::NAN;
                continue;
            }
            let bucket = std::slice::from_raw_parts(values.add(start), end - start);
            let mut lo = bucket[0];
            let mut hi = lo;
            for &x in &bucket[1..] {
                lo = if lo <= x { lo } else { x };
                hi = if hi >= x { hi } else { x };
            }
            lo_o[b] = lo;
            hi_o[b] = hi;
        }
        return;
    }

    for b in 0..w {
        let (start, end) = (bd[b] as usize, bd[b + 1] as usize);
        let mut i = start;
        while i < end && !is_defined(validity, i) {
            i += 1;
        }
        if i >= end {
            lo_o[b] = f64::NAN;
            hi_o[b] = f64::NAN;
            continue;
        }
        let mut lo = *values.add(i);
        let mut hi = lo;
        i += 1;
        while i < end {
            if is_defined(validity, i) {
                let x = *values.add(i);
                lo = if lo <= x { lo } else { x };
                hi = if hi >= x { hi } else { x };
            }
            i += 1;
        }
        lo_o[b] = lo;
        hi_o[b] = hi;
    }
}

/// Fused four-channel M4 reduction — `bin(W, 'minMaxFirstLast')`
/// (Jugel et al., VLDB 2014). `first`/`last` are the bucket's first and
/// last defined+finite values, which keep a decimated polyline
/// continuous across bucket seams. All four channels agree on which
/// cells count; an empty bucket is `NaN` on all four.
#[no_mangle]
pub unsafe extern "C" fn reduce_bounds_m4(
    values: *const f64,
    validity: *const u8,
    all_finite: u32,
    bounds: *const i32,
    w: usize,
    lo_out: *mut f64,
    hi_out: *mut f64,
    first_out: *mut f64,
    last_out: *mut f64,
) {
    let bd = std::slice::from_raw_parts(bounds, w + 1);
    let lo_o = std::slice::from_raw_parts_mut(lo_out, w);
    let hi_o = std::slice::from_raw_parts_mut(hi_out, w);
    let fi_o = std::slice::from_raw_parts_mut(first_out, w);
    let la_o = std::slice::from_raw_parts_mut(last_out, w);

    let dense_fast = validity.is_null() && all_finite != 0;

    for b in 0..w {
        let (start, end) = (bd[b] as usize, bd[b + 1] as usize);
        if end <= start {
            lo_o[b] = f64::NAN;
            hi_o[b] = f64::NAN;
            fi_o[b] = f64::NAN;
            la_o[b] = f64::NAN;
            continue;
        }
        if dense_fast {
            let bucket = std::slice::from_raw_parts(values.add(start), end - start);
            let mut lo = bucket[0];
            let mut hi = lo;
            for &x in &bucket[1..] {
                lo = if lo <= x { lo } else { x };
                hi = if hi >= x { hi } else { x };
            }
            lo_o[b] = lo;
            hi_o[b] = hi;
            fi_o[b] = bucket[0];
            la_o[b] = bucket[bucket.len() - 1];
            continue;
        }
        let mut seen = false;
        let mut lo = 0.0f64;
        let mut hi = 0.0f64;
        let mut fst = 0.0f64;
        let mut lst = 0.0f64;
        for i in start..end {
            if !validity.is_null() && !is_defined(validity, i) {
                continue;
            }
            let x = *values.add(i);
            if all_finite == 0 && !x.is_finite() {
                continue;
            }
            if !seen {
                lo = x;
                hi = x;
                fst = x;
                seen = true;
            } else {
                if x < lo {
                    lo = x;
                }
                if x > hi {
                    hi = x;
                }
            }
            lst = x;
        }
        if seen {
            lo_o[b] = lo;
            hi_o[b] = hi;
            fi_o[b] = fst;
            la_o[b] = lst;
        } else {
            lo_o[b] = f64::NAN;
            hi_o[b] = f64::NAN;
            fi_o[b] = f64::NAN;
            la_o[b] = f64::NAN;
        }
    }
}

/// Reducer selector for `reduce_bounds_scalar`. Kept as a flat `u32`
/// rather than a string so the boundary carries no encoding cost — the
/// JS wrapper does the name→code mapping once.
pub const R_MIN: u32 = 0;
pub const R_MAX: u32 = 1;
pub const R_SUM: u32 = 2;
pub const R_MEAN: u32 = 3;
pub const R_STDEV: u32 = 4;
pub const R_COUNT: u32 = 5;
pub const R_PERCENTILE: u32 = 6;

/// Single-channel per-bucket reduction. `q` is only read for
/// `R_PERCENTILE` (median is `q = 50`). `scratch` must be at least as
/// wide as the largest bucket; the JS wrapper sizes it at `len`.
///
/// Empty-bucket convention matches the JS: `NaN` where the empty value
/// is mathematically undefined, `0` for sum and count.
#[no_mangle]
pub unsafe extern "C" fn reduce_bounds_scalar(
    values: *const f64,
    validity: *const u8,
    all_finite: u32,
    bounds: *const i32,
    w: usize,
    reducer: u32,
    q: f64,
    out: *mut f64,
    scratch: *mut f64,
) {
    let bd = std::slice::from_raw_parts(bounds, w + 1);
    let o = std::slice::from_raw_parts_mut(out, w);

    for b in 0..w {
        let start = bd[b] as usize;
        let end = bd[b + 1] as usize;
        let n = end.saturating_sub(start);
        o[b] = match reducer {
            R_SUM => sum_range(values, start, end, validity, all_finite),
            R_COUNT => count_range(values, start, end, validity, all_finite) as f64,
            R_MEAN => {
                let c = count_range(values, start, end, validity, all_finite);
                if c == 0 {
                    f64::NAN
                } else {
                    sum_range(values, start, end, validity, all_finite) / c as f64
                }
            }
            R_MIN | R_MAX => {
                let mut mm = [0.0f64; 2];
                let ok = min_max_range(values, start, end, validity, all_finite, mm.as_mut_ptr());
                if ok == 0 {
                    f64::NAN
                } else if reducer == R_MIN {
                    mm[0]
                } else {
                    mm[1]
                }
            }
            R_STDEV => stdev_range(values, start, end, validity, all_finite),
            R_PERCENTILE => {
                if n == 0 {
                    f64::NAN
                } else {
                    let k = densify_range(values, start, end, validity, all_finite, scratch);
                    if k == 0 {
                        f64::NAN
                    } else {
                        let d = std::slice::from_raw_parts_mut(scratch, k);
                        percentile_of_unsorted(d, q)
                    }
                }
            }
            _ => f64::NAN,
        };
    }
}

/* --- range-scoped helpers (bucket bodies) ------------------------- */

#[inline]
unsafe fn sum_range(
    values: *const f64,
    start: usize,
    end: usize,
    validity: *const u8,
    all_finite: u32,
) -> f64 {
    let mut acc = 0.0f64;
    if validity.is_null() && all_finite != 0 {
        for i in start..end {
            acc += *values.add(i);
        }
        return acc;
    }
    for i in start..end {
        if !validity.is_null() && !is_defined(validity, i) {
            continue;
        }
        let x = *values.add(i);
        if all_finite == 0 && !x.is_finite() {
            continue;
        }
        acc += x;
    }
    acc
}

#[inline]
unsafe fn count_range(
    values: *const f64,
    start: usize,
    end: usize,
    validity: *const u8,
    all_finite: u32,
) -> u32 {
    if validity.is_null() && all_finite != 0 {
        return (end - start) as u32;
    }
    if all_finite != 0 {
        return validity_count_range(validity, start, end);
    }
    let mut n = 0u32;
    for i in start..end {
        if !validity.is_null() && !is_defined(validity, i) {
            continue;
        }
        if (*values.add(i)).is_finite() {
            n += 1;
        }
    }
    n
}

/// Min/max over the index range `[start, end)`. Validity is indexed
/// from the *column* origin (bit offsets aren't byte-addressable, so a
/// bucket-relative bitmap would mean a shifted copy per bucket) — hence
/// a range walk here rather than delegating to `col_min_max` on a
/// sub-slice. Writes two `f64` to `out`; returns 1 on a result, 0 for
/// an empty / all-missing range.
#[inline]
unsafe fn min_max_range(
    values: *const f64,
    start: usize,
    end: usize,
    validity: *const u8,
    all_finite: u32,
    out: *mut f64,
) -> u32 {
    if end <= start {
        return 0;
    }
    // Dense + provably finite: seed from the first cell, no per-element
    // guard, NaN-laundered comparison form (matches the JS).
    if validity.is_null() && all_finite != 0 {
        let bucket = std::slice::from_raw_parts(values.add(start), end - start);
        let mut lo = bucket[0];
        let mut hi = lo;
        for &x in &bucket[1..] {
            lo = if lo <= x { lo } else { x };
            hi = if hi >= x { hi } else { x };
        }
        *out = lo;
        *out.add(1) = hi;
        return 1;
    }
    let mut seen = false;
    let mut lo = 0.0f64;
    let mut hi = 0.0f64;
    for i in start..end {
        if !validity.is_null() && !is_defined(validity, i) {
            continue;
        }
        let x = *values.add(i);
        if all_finite == 0 && !x.is_finite() {
            continue;
        }
        if !seen {
            lo = x;
            hi = x;
            seen = true;
        } else {
            if x < lo {
                lo = x;
            }
            if x > hi {
                hi = x;
            }
        }
    }
    if !seen {
        return 0;
    }
    *out = lo;
    *out.add(1) = hi;
    1
}

#[inline]
unsafe fn stdev_range(
    values: *const f64,
    start: usize,
    end: usize,
    validity: *const u8,
    all_finite: u32,
) -> f64 {
    let mut n = 0f64;
    let mut mean = 0f64;
    let mut m2 = 0f64;
    for i in start..end {
        if !validity.is_null() && !is_defined(validity, i) {
            continue;
        }
        let x = *values.add(i);
        if all_finite == 0 && !x.is_finite() {
            continue;
        }
        n += 1.0;
        let delta = x - mean;
        mean += delta / n;
        m2 += delta * (x - mean);
    }
    if n == 0.0 {
        f64::NAN
    } else {
        js_max0(m2 / n).sqrt()
    }
}

#[inline]
unsafe fn densify_range(
    values: *const f64,
    start: usize,
    end: usize,
    validity: *const u8,
    all_finite: u32,
    scratch: *mut f64,
) -> usize {
    let mut k = 0usize;
    for i in start..end {
        if !validity.is_null() && !is_defined(validity, i) {
            continue;
        }
        let x = *values.add(i);
        if all_finite == 0 && !x.is_finite() {
            continue;
        }
        *scratch.add(k) = x;
        k += 1;
    }
    k
}

/* ══════════════════════════════════════════════════════════════════ */
/* Views — gather / slice                                             */
/* ══════════════════════════════════════════════════════════════════ */

/// `Float64Column.sliceByIndices` + `validityGatherByIndices` fused into
/// one pass. Writes gathered values to `out_values` and gathered
/// validity bits to `out_validity` (which must be zeroed, `ceil(n/8)`
/// bytes wide).
///
/// Returns the number of defined output cells. The JS wrapper compares
/// that against `n` to decide whether to keep the bitmap at all —
/// pond-ts's "all defined ⇒ no bitmap" convention.
///
/// Out-of-range indices read `0.0` and are marked invalid, matching the
/// JS. Fusing the two passes is the structural win here: JS walks the
/// index array twice (once for values, once inside
/// `validityGatherByIndices`), and on a gather the index array is the
/// thing blowing the cache, not the values.
#[no_mangle]
pub unsafe extern "C" fn gather_f64(
    values: *const f64,
    len: usize,
    validity: *const u8,
    indices: *const i32,
    n: usize,
    out_values: *mut f64,
    out_validity: *mut u8,
) -> u32 {
    let idx = std::slice::from_raw_parts(indices, n);
    let ov = std::slice::from_raw_parts_mut(out_values, n);
    let mut defined = 0u32;

    if validity.is_null() {
        for i in 0..n {
            let k = idx[i];
            if k >= 0 && (k as usize) < len {
                ov[i] = *values.add(k as usize);
                *out_validity.add(i >> 3) |= 1u8 << (i & 7);
                defined += 1;
            } else {
                ov[i] = 0.0;
            }
        }
        return defined;
    }
    for i in 0..n {
        let k = idx[i];
        if k >= 0 && (k as usize) < len {
            let ki = k as usize;
            ov[i] = *values.add(ki);
            if is_defined(validity, ki) {
                *out_validity.add(i >> 3) |= 1u8 << (i & 7);
                defined += 1;
            }
        } else {
            ov[i] = 0.0;
        }
    }
    defined
}

/// Copies validity bits for `[start, end)` into a fresh bitmap whose
/// bit 0 is source bit `start` — `validitySliceByRange`. Returns the
/// defined count.
#[no_mangle]
pub unsafe extern "C" fn validity_slice_range(
    src: *const u8,
    start: usize,
    end: usize,
    out: *mut u8,
) -> u32 {
    let n = end.saturating_sub(start);
    let mut defined = 0u32;
    for i in 0..n {
        let s = start + i;
        if is_defined(src, s) {
            *out.add(i >> 3) |= 1u8 << (i & 7);
            defined += 1;
        }
    }
    defined
}

/* ══════════════════════════════════════════════════════════════════ */
/* The boundary experiment: a per-element host callback               */
/* ══════════════════════════════════════════════════════════════════ */

// `wasm_import_module` is what turns this from "undefined symbol at
// link time" into a wasm import entry the host satisfies at
// instantiate. It also means the module now *requires* an import
// object — a real packaging consequence, noted in the report.
#[link(wasm_import_module = "env")]
extern "C" {
    /// Supplied by the JS host at instantiate time. Only used by
    /// `col_scan_host`, whose entire purpose is to measure what a
    /// per-element WASM→JS call costs.
    fn host_emit(value: f64, index: u32);
}

/// `Float64Column.scan(fn)` implemented across the boundary — one host
/// call per defined cell.
///
/// This exists to be *measured, not shipped*. pond-ts's row-shaped APIs
/// (`scan`, `events`, custom-function reducers) hand a JS closure to
/// every element; if the data lives in WASM, each of those becomes a
/// boundary crossing. The benchmark quantifies how bad that is so the
/// report can state where the WASM/JS line has to fall rather than
/// hand-wave about it.
#[no_mangle]
pub unsafe extern "C" fn col_scan_host(values: *const f64, len: usize, validity: *const u8) {
    if validity.is_null() {
        for i in 0..len {
            host_emit(*values.add(i), i as u32);
        }
        return;
    }
    for i in 0..len {
        if is_defined(validity, i) {
            host_emit(*values.add(i), i as u32);
        }
    }
}

/* ══════════════════════════════════════════════════════════════════ */
/* Operator-shape kernels                                             */
/*                                                                    */
/* The leaf-kernel benchmarks above cover *reductions* (many cells →  */
/* one value). Most `TimeSeries` operators are a different shape:     */
/* many cells → many cells. Three shapes cover almost all of them,    */
/* and each behaves differently under a port, so each gets a kernel:  */
/*                                                                    */
/*   element-wise   map / shift / diff / rate / fill — output[i]      */
/*                  depends on input[i] (and maybe i-1). Trivially    */
/*                  parallel, memory-bound.                           */
/*   prefix scan    cumulative / ema — output[i] depends on           */
/*                  output[i-1]. A serial dependency chain; no        */
/*                  compiler can break it.                            */
/*   sliding window rolling — output[i] over input[i-w..i]. Bounded   */
/*                  work per cell via an incremental accumulator.     */
/*                                                                    */
/* Bucketed reduce (`aggregate`) and gather (`byValue`/`partitionBy`) */
/* are already covered by `reduce_bounds_*` and `gather_f64`.         */
/* ══════════════════════════════════════════════════════════════════ */

/// Element-wise `a * x + b` — the stand-in for `map` / `mapColumns` with
/// an arithmetic transform, and the same shape as `shift` / `diff`.
///
/// Chosen deliberately as the *most favourable possible* element-wise
/// case: pure arithmetic, no branching, perfectly vectorisable. If a
/// port cannot win here it cannot win on any element-wise operator.
///
/// Note what this is NOT: pond-ts's `map` takes a **JS closure**, so a
/// real port could not use this kernel at all without a declarative
/// expression API. That gap is the finding, not the timing.
#[no_mangle]
pub unsafe extern "C" fn op_map_scale(
    values: *const f64,
    len: usize,
    a: f64,
    b: f64,
    out: *mut f64,
) {
    let src = std::slice::from_raw_parts(values, len);
    let dst = std::slice::from_raw_parts_mut(out, len);
    for i in 0..len {
        dst[i] = a * src[i] + b;
    }
}

/// Adjacent difference — `out[i] = x[i] - x[i-1]`, `out[0]` undefined.
/// Writes the validity bit for every produced cell.
#[no_mangle]
pub unsafe extern "C" fn op_diff(
    values: *const f64,
    len: usize,
    validity: *const u8,
    out: *mut f64,
    out_validity: *mut u8,
) -> u32 {
    if len == 0 {
        return 0;
    }
    let src = std::slice::from_raw_parts(values, len);
    let dst = std::slice::from_raw_parts_mut(out, len);
    dst[0] = 0.0; // bit stays clear ⇒ undefined
    let mut defined = 0u32;
    for i in 1..len {
        let ok = if validity.is_null() {
            true
        } else {
            is_defined(validity, i) && is_defined(validity, i - 1)
        };
        if ok {
            dst[i] = src[i] - src[i - 1];
            *out_validity.add(i >> 3) |= 1u8 << (i & 7);
            defined += 1;
        } else {
            dst[i] = 0.0;
        }
    }
    defined
}

/// Running accumulation — `cumulative('sum')`.
///
/// The serial-dependency shape: `acc` carries across every cell, so the
/// loop cannot be reassociated, vectorised, or reordered. A missing cell
/// **carries** the accumulator rather than resetting it, and output stays
/// undefined until the first defined value — matching
/// `operators/cumulative.ts`.
///
/// This is the shape where a port has the least to offer: the recurrence
/// is the bottleneck, and it is the same recurrence in both languages.
#[no_mangle]
pub unsafe extern "C" fn op_cumulative_sum(
    values: *const f64,
    len: usize,
    validity: *const u8,
    out: *mut f64,
    out_validity: *mut u8,
) -> u32 {
    let src = std::slice::from_raw_parts(values, len);
    let dst = std::slice::from_raw_parts_mut(out, len);
    let mut acc = 0.0f64;
    let mut seen = false;
    let mut defined = 0u32;
    for i in 0..len {
        let ok = validity.is_null() || is_defined(validity, i);
        if ok {
            acc += src[i];
            seen = true;
        }
        if seen {
            dst[i] = acc;
            *out_validity.add(i >> 3) |= 1u8 << (i & 7);
            defined += 1;
        } else {
            dst[i] = 0.0;
        }
    }
    defined
}

/// Trailing sliding-window mean over `window` cells — `rolling(w, 'avg')`
/// in its count-window form.
///
/// Incremental: one add and one subtract per cell rather than a re-scan,
/// so it is O(n) not O(n·w). Cells before the window fills are undefined,
/// matching pond-ts's trailing alignment.
///
/// Kept to the dense case; the gappy variant needs the same
/// add/remove bookkeeping pond-ts's `rollingState` already does, and the
/// dense number is the one that bounds the win.
#[no_mangle]
pub unsafe extern "C" fn op_rolling_mean(
    values: *const f64,
    len: usize,
    window: usize,
    out: *mut f64,
    out_validity: *mut u8,
) -> u32 {
    if window == 0 || window > len {
        return 0;
    }
    let src = std::slice::from_raw_parts(values, len);
    let dst = std::slice::from_raw_parts_mut(out, len);
    let mut acc = 0.0f64;
    let mut defined = 0u32;
    for i in 0..len {
        acc += src[i];
        if i >= window {
            acc -= src[i - window];
        }
        if i + 1 >= window {
            dst[i] = acc / window as f64;
            *out_validity.add(i >> 3) |= 1u8 << (i & 7);
            defined += 1;
        } else {
            dst[i] = 0.0;
        }
    }
    defined
}

/// Element-wise `a * x + b` **with validity**, so it does the same work
/// the JS control and pond-ts's operators do: read a cell, check whether
/// it is defined, compute, write the value *and* the output validity bit.
///
/// `op_map_scale` (above) omits the validity handling, which made it an
/// unfair stand-in — it was ~3x faster than any operator could actually
/// be, and the first version of the operations benchmark reported 70-90x
/// ceilings because of it. Kept for the pure-arithmetic floor; this is
/// the one the comparison uses.
#[no_mangle]
pub unsafe extern "C" fn op_map_scale_v(
    values: *const f64,
    len: usize,
    validity: *const u8,
    a: f64,
    b: f64,
    out: *mut f64,
    out_validity: *mut u8,
) -> u32 {
    let src = std::slice::from_raw_parts(values, len);
    let dst = std::slice::from_raw_parts_mut(out, len);
    let mut defined = 0u32;
    for i in 0..len {
        if validity.is_null() || is_defined(validity, i) {
            dst[i] = a * src[i] + b;
            *out_validity.add(i >> 3) |= 1u8 << (i & 7);
            defined += 1;
        } else {
            dst[i] = 0.0;
        }
    }
    defined
}
