# Rust → WASM for the columnar substrate — spike report

**Question.** Take pond-ts's columnar substrate, port it to Rust, compile
to WebAssembly, reabsorb it into the library. Does that pay?

**Verdict: not now, and not in this order — which is weaker than the
"no-go" this report originally claimed. See §9 for the correction.**

The spike works. It runs in Node and in the browser, it is bit-for-bit
identical to pond-ts across 1,380 parity checks, and on some kernels it
is genuinely faster.

The original conclusion leaned on one number — dense `sum` measuring
exactly 1.00× — and read it as "there is nothing here." §9 shows that
number is real but unrepresentative: **real columns have gaps, and at
realistic gap density the same reduction is ~1.9×.** Across a range of
actual `TimeSeries` operations a Rust core is worth **1.3–4.3× on the
numeric kernel**, and the reduce family (`aggregate`, `bin`, `reduce`,
`column().sum()`) is **2.2–2.6× end to end** with nothing else available
to it.

What still argues against porting is not performance. It is the price of
the only model that delivers it — resident-only storage, a 2× slower
row API, a 4 GB ceiling, manual memory in a GC'd library (§7). That is a
cost/benefit judgement, not a benchmark result, and this report
previously presented it as though the numbers settled it.

**The largest single finding is not about Rust at all.** Six element-wise
operators (`diff`, `rate`, `fill`, `shift`, `cumulative`, `mapColumns`)
box every cell through `read(i)` into a `ReadonlyArray<number |
undefined>` and rebuild the column from it — making them **15–27× slower
per column than a plain typed-array loop**. That is TypeScript, it is
larger than anything Rust offers, and it comes first regardless.

Runner-up, same character: `median`/`percentile` is **7.3–11.8× faster**
with quickselect instead of a full sort. One file.

---

## 1. What was built

`spikes/columnar-wasm/` — a working, self-contained port of the hot
`Float64Column` kernels.

| Piece                                  | What it is                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/lib.rs`                           | ~1,360 lines of Rust: reductions, `bin`/`binBy` + the per-bucket reduce engine, gather, validity bitmap ops              |
| `build.sh`                             | `cargo build` → three `.wasm` artifacts (baseline / simd128 / opt-level=z). No wasm-pack, no wasm-bindgen, no npm plugin |
| `js/loader.mjs`                        | 155-line isomorphic loader. `fs` under Node, `fetch` in the browser; everything else is plain `WebAssembly` API          |
| `js/wasm-column.mjs`                   | `WasmFloat64Column` — the shape the real integration would take, in both residency modes                                 |
| `test/parity.mjs`                      | 1,380 checks against pond-ts's actual `Float64Column`                                                                    |
| `bench/suite.mjs`                      | Case matrix + timing harness, shared by both hosts so the numbers are comparable                                         |
| `bench/node.mjs`, `bench/browser.html` | The two drivers                                                                                                          |
| `bench/controls.mjs`                   | The same algorithms written in plain JS — the control experiment                                                         |

Ported kernels: `sum`, `count`, `mean`, `stdev` (Welford), `minMax`,
`median`, `percentile`, `bin(W, reducer)` for all eight reducers,
`binBy(key, edges, reducer)` including the merge walk, `gather`
(`sliceByIndices` fused with `validityGatherByIndices`), validity
`popcount` / `countInRange` / `sliceByRange`.

**No wasm-bindgen, deliberately.** The question is what the boundary
costs; wasm-bindgen's glue hides it behind wrappers that copy typed
arrays in and out. A hand-rolled `extern "C"` ABI makes every crossing
visible in the benchmark and reduces the toolchain to `cargo build`.

### Two residency models

Everything below turns on this distinction.

- **Resident** — values live in WASM linear memory for the column's
  lifetime. Reductions are bare calls with pointer arguments; nothing is
  copied. This is the only regime where WASM wins.
- **Bridged** — values stay in a JS `Float64Array` and are copied in per
  call. This is what "just call into Rust for the hot bit" buys you, and
  it is a net loss on every scan kernel measured.

---

## 2. Methodology, and three things that would have made the numbers lies

Every number is the **median** of adaptively-many samples after warm-up,
against **pond-ts's shipped implementation** — not a straw-man loop.
`Float64Column.prototype.bin` is already tuned (hoisted validity
branches, fused minMax, `allFinite` fast path); beating an untuned
baseline would prove nothing.

Three harness bugs were found. The first two were caught before they
reached any conclusion. **The third was not** — it is in the numbers §9
corrects, and it is the reason that section exists.

**Timer clamping.** The first browser run reported `0.000 ms` and
`Infinity×` for most kernels. Browsers clamp `performance.now()` to
**100 µs** outside a cross-origin-isolated page (Spectre mitigation),
versus nanoseconds under Node — so every sub-100 µs kernel was quantised
to a single clock tick. Fixed by probing the timer's real resolution and
calibrating an inner repeat loop so each timed region clears 200 ticks.
Both hosts now measure the same way.

**Dead-code elimination.** A pure reduction whose result is discarded can
be deleted outright by V8's escape analysis, letting the JS baseline
"win" by not running. Every result is fed to a sink.

**Warm-up measured in milliseconds instead of iterations.** The harness
warmed for a fixed 40 ms. For a 10 µs kernel that is 4,000 iterations —
ample. For a 4 ms operation it is _ten_, and V8's optimising tier is a
cliff, not a curve: measured on `Float64Column.sum()` over 1M cells, the
median sat at 3.82 ms through 400 warm-up iterations and dropped to
1.41 ms between 400 and 800, stable thereafter — **2.7×**.

The bias is not symmetric. WASM is compiled ahead of time and has no
tier-up, so under-warming inflates only the JavaScript side, which
**systematically overstates every JS-vs-Rust ratio in this report** in
proportion to how slow the operation already was. Fixed by warming for
1,000 iterations (capped at 3 s) and reporting `warmIters` /
`warmTruncated` so a truncated warm-up is visible rather than silent.

Every figure in §9 is post-fix. Figures in §4–§6 were taken with the old
warm-up: the leaf kernels at 10k–100k rows are unaffected (they got
thousands of warm-up iterations), the 1M and 10M rows are not, and §9
supersedes them where they disagree.

Hardware: Apple silicon (arm64). Node v22.15.0 (V8 12.4) and
Chromium 148 (Electron host). Numbers
are steady-state on one machine — read the _ratios_, not the absolute ms.

---

## 3. Correctness came first, and it found two real bugs

The parity harness runs before any timing and the benchmark refuses to
report if it fails. It found two defects in the port that no type system
would have caught, both worth recording because they are the archetypal
"port to Rust" failure modes.

### 3.1 `Math.max` and `f64::max` disagree about NaN

`reducers/stdev.ts` clamps the variance with `Math.max(0, m2 / n)` to
absorb FP round-off. Transliterated to Rust that is `(m2 / n).max(0.0)`
— and it is wrong. Rust's `f64::max` implements IEEE `maxNum`, which
**ignores** NaN and returns the other operand; JavaScript's `Math.max`
**propagates** it.

Not hypothetical: Welford's recurrence overflows to NaN on
`[MAX_VALUE, -MAX_VALUE, 1]` (the intermediate `delta` hits ±∞). pond-ts
returns `NaN`; the Rust returned `0`. The code reads correct, compiles,
and passes every happy-path test.

### 3.2 The `f64` ABI cannot express `number | undefined`

The first ABI returned `f64` from every reduction and used `NaN` as the
"undefined" sentinel — justified in a comment on the grounds that NaN is
_missing_ under pond-ts's non-finite policy and so can never be an
answer.

That reasoning is wrong for exactly one reduction. `stdev` can genuinely
**return** NaN (§3.1), and `NaN` is an ordinary inhabitant of `number`.
The sentinel silently rewrote a correct `NaN` into `undefined` — a wrong
answer produced by the calling convention rather than the kernel.

Fixed by giving every nullable reduction an out-pointer plus a `u32`
status. Note the asymmetry this creates one layer up: in `bin` output,
`NaN` **is** the correct empty-bucket sentinel (documented, canvas
breaks the sub-path on a NaN vertex). Same value, opposite meaning,
depending on whether the container is a `Float64Array` or a
`number | undefined`.

**Final state: 1,380 checks, 0 failures** — bit-for-bit, including
missing cells, ±Inf, NaN, all-missing columns, denormals, `-0`,
`MAX_VALUE`, empty columns, `allFinite` deliberately set pessimistically,
out-of-range gather indices, and `binBy`'s inclusive final edge.

---

## 4. Results

Full output: [`results-node.txt`](results-node.txt) /
[`results-node.json`](results-node.json). Node v22.15.0, V8 12.4,
darwin/arm64, simd128 build, resident columns.

### 4.1 The headline: dense scans are a dead heat

| op                              | 10k    | 100k   | 1M     | 10M       |
| ------------------------------- | ------ | ------ | ------ | --------- |
| `sum`                           | 1.00×  | 0.99×  | 0.99×  | 0.96×     |
| `mean`                          | 0.98×  | 1.00×  | 0.98×  | 1.01×     |
| `stdev`                         | 1.00×  | 1.02×  | 1.01×  | 0.97×     |
| `minMax`                        | 0.90×  | 0.88×  | 0.86×  | 0.87×     |
| `bin(1024,'minMax')`            | 2.71×  | 2.05×  | 1.29×  | **1.00×** |
| `bin(1024,'minMaxFirstLast')`   | 2.16×  | 2.04×  | 1.27×  | **1.02×** |
| `binBy(1024,'minMaxFirstLast')` | 1.93×  | 2.20×  | 1.56×  | 1.35×     |
| `gather(n/4)`                   | 2.78×  | 2.57×  | 3.49×  | 2.96×     |
| `median` _(sort, both sides)_   | 4.09×  | 3.68×  | 4.15×  | 4.26×     |
| `median` _(quickselect)_        | 19.05× | 23.34× | 28.80× | 33.71×    |
| `p95`                           | 11.65× | 15.45× | 21.99× | 24.65×    |

Three things to read off this:

**`sum`, `mean`, `stdev` are exactly 1.00×.** At 0.95 ns/element the sum
loop is bound by floating-point _add latency_ — roughly 3 cycles per
element, with the next add unable to start until the previous retires.
Both V8 and LLVM hit the same wall, because it is a property of the
recurrence, not of the compiler. Rust cannot beat JavaScript at waiting.

**`minMax` is 0.88× — the port is _slower_, consistently, at every
size.** ~0.15 ns/element, or about one extra instruction per iteration.
V8 lowers the JS `lo <= x ? lo : x` to a branchless `fcsel`; the wasm
lowering costs slightly more. Small, but it is the direction the whole
exercise was meant to move in.

**The `bin` win evaporates exactly where it matters.** 2.7× at 10k,
1.00× at 10M — because at 10M both implementations are memory-bandwidth
bound and the per-bucket fixed costs that WASM saves have been amortised
into nothing. That 10M case is the one
[`PND-DECIM`](../../PLAN.md) actually cares about: the 60fps-at-10M
chart budget. **The decimator gets no help from the port at the size the
decimator exists for.**

### 4.2 Where WASM genuinely wins: branchy paths

`n = 1M`, 30% of cells missing (the validity-bitmap path):

| op                              | speedup |
| ------------------------------- | ------- |
| `gather(n/4)`                   | 3.04×   |
| `bin(1024,'mean')`              | 2.66×   |
| `minMax`                        | 1.76×   |
| `bin(1024,'minMax')`            | 1.68×   |
| `binBy(1024,'minMaxFirstLast')` | 1.58×   |
| `sum`                           | 1.37×   |
| `stdev`                         | 1.04×   |

This is the real language win, and it has a specific cause: pond-ts's
validity test is `validity.isDefined(i)` — an interface method call per
element — while Rust inlines it to a load, shift, and mask. The more the
kernel branches, the more WASM pulls ahead.

### 4.3 One caching regression worth naming

On the gappy shape, `count` goes from **0.000 ms to 0.010 ms** — the
port is asymptotically _worse_. `ValidityBitmap` caches `definedCount`
at construction, so pond-ts's `count()` is O(1); the WASM side has no
such cache and popcounts the bitmap.

Trivially fixable, but it generalises: **derived state cached on JS
objects does not cross the boundary.** Every memoised field in the
substrate (`definedCount`, `ChunkedColumn`'s aggregate validity,
`StringColumn`'s dictionary index, chunk offsets) has to be re-modelled
on the Rust side or re-derived per call. A port that skips this ships
silent asymptotic regressions in exactly the places the original author
thought hardest about.

### 4.4 The boundary is cheap — the _copy_ is not

|                                 | cost                 |
| ------------------------------- | -------------------- |
| empty JS→WASM call              | **0.3 ns**           |
| call with 4 args + `f64` return | **2.1 ns**           |
| copy 1M `f64` JS→WASM           | 0.184 ms (43.5 GB/s) |
| copy 1M `f64` WASM→JS           | 0.835 ms (9.6 GB/s)  |

The call itself is free — 0.3 ns is below the cost of a JS property
access. The interesting number is the **4.5× asymmetry**: writing into
linear memory via `Float64Array.set` hits a `memcpy` fast path, while
reading back out via `.slice()` allocates a fresh JS `ArrayBuffer` and
copies. Any design that keeps results in WASM and streams them out per
frame pays the expensive direction.

**Bridged mode confirms it.** Keeping data in JS and copying in per call:

| op                             | 10k   | 100k  | 1M    |
| ------------------------------ | ----- | ----- | ----- |
| `sum` [bridged]                | 0.85× | 0.88× | 0.85× |
| `minMax` [bridged]             | 0.81× | 0.83× | 0.77× |
| `bin(1024,'minMax')` [bridged] | 2.00× | 1.87× | 1.14× |

A net loss on every scan. So the port only pays in the **resident**
model — which means the substrate must own allocation end to end, and
that is the expensive part (§6).

### 4.5 The row-shaped API doesn't survive the crossing

`scan(fn)` over 1M cells:

|                                               | ns/element |
| --------------------------------------------- | ---------- |
| pond-ts `Float64Column.scan(fn)`              | 6.58       |
| WASM iterating, calling a JS closure per cell | 12.99      |

**1.97× slower.** `scan` is public API, and so are `series.events`,
custom-function reducers, and every consumer callback in the library. If
the values live in WASM, all of them get slower. The port makes the
columnar path faster and the row path worse — and pond-ts deliberately
ships both.

### 4.6 SIMD bought nothing, and one thing cost 2×

Building with `-C target-feature=+simd128` versus the wasm MVP:

| op                    | 100k      | 1M        | 10M       |
| --------------------- | --------- | --------- | --------- |
| `sum` (sequential)    | 1.02×     | 1.00×     | 1.01×     |
| `minMax`              | 1.01×     | 0.99×     | 1.00×     |
| `minMax` (4-lane)     | 0.99×     | 0.99×     | 0.97×     |
| `bin(1024,'minMax')`  | 1.01×     | 1.01×     | 1.00×     |
| `sum` (8-accumulator) | **0.49×** | **0.50×** | **0.53×** |

Flat everywhere except the one kernel written to be vectorisable, which
LLVM auto-vectorised into `f64x2` lanes and made **2× slower** than the
same source compiled without SIMD.

This matters beyond the number, because SIMD is not free to ship. wasm
has no runtime feature detection — `v128` is a module-level _validation_
property, so supporting it means shipping **two binaries** and probing
the engine at load time to choose. The spike pays that cost
(`hasSimd()` in `js/loader.mjs`) and gets 1.00× for it.

### 4.7 Startup and payload

|                                    |                                                |
| ---------------------------------- | ---------------------------------------------- |
| baseline `.wasm`                   | 48,274 B raw · 17,451 gzip · **14,391 brotli** |
| simd128 `.wasm`                    | 50,098 B raw · 18,203 gzip · 15,035 brotli     |
| `opt-level="z"`                    | 33,658 B raw · 13,772 gzip · **11,658 brotli** |
| validate module                    | 0.098 ms                                       |
| compile + instantiate (cold)       | 0.401 ms                                       |
| instantiate (precompiled)          | 0.053 ms                                       |
| ingest 10M rows into linear memory | +2.01 ms, one-time                             |

This is the genuinely encouraging part. ~14 KB brotli and sub-millisecond
startup is a real cost but not a prohibitive one — it would roughly
double `pond-ts`'s wire size, for a partial substrate.

### 4.8 The browser agrees — except where it violently doesn't

The same suite, same machine, in Chromium 148 (V8) against Node 22's
V8 12.4. Full output: [`results-browser.txt`](results-browser.txt).

Most of the table transfers cleanly: `sum`/`mean`/`stdev` 1.00–1.01×,
`median` (quickselect) 26.87×, `gather` 3.24×, `bin` at 1M 1.07×,
bridged mode still a loss, boundary costs within noise of Node's.
`minMax` is _worse_ in Chrome (0.67× vs Node's 0.86×).

Two results invert outright, and both are the **baseline** moving, not
the kernel:

|                                                   | Node (V8 12.4) | Chromium 148 | the WASM         |
| ------------------------------------------------- | -------------- | ------------ | ---------------- |
| `sum` [guarded], JS                               | 0.969 ms       | **3.737 ms** | ~1.59 ms in both |
| ⇒ measured speedup                                | **0.61×**      | **2.35×**    |                  |
| `sum` (reassociated), simd128 vs baseline `.wasm` | **0.50×**      | **1.23×**    | identical bytes  |

On the guarded path, V8 12.4 makes the per-element `Number.isFinite`
check free — it is indistinguishable from the unguarded loop. Chromium
148's V8 charges 3.9× for the same JavaScript. The WASM kernel doesn't
move. So whether "port the guarded path to Rust" reads as a 39%
regression or a 2.4× win depends entirely on which V8 the user is
running.

The SIMD artifact inverts the same way: 2× _slower_ on one engine,
1.23× faster on the other, from byte-identical `.wasm`.

That is the most decision-relevant finding in the report and it is not
about Rust at all. **The JS baseline is a moving target between engine
versions, by more than the size of the win being chased.** A port
justified by today's V8 can be un-justified by next quarter's — and
unlike a JS change, it can't be re-tuned by the engine team on your
behalf.

---

## 5. The control experiment — algorithm or language?

This is the section the verdict actually rests on.

The kernels above aren't just "pond-ts, in Rust." Four of them use a
_different algorithm_ that happened to be easy to reach for in Rust:

| kernel                  | pond-ts today              | the Rust                       |
| ----------------------- | -------------------------- | ------------------------------ |
| `sum`                   | one accumulator            | eight independent accumulators |
| `minMax`                | one running extremum       | four lanes                     |
| `median` / `percentile` | full `Float64Array.sort()` | quickselect                    |
| `gather`                | two passes over `indices`  | one fused pass                 |

None of that needs Rust. So [`bench/controls.mjs`](bench/controls.mjs)
implements each one in plain JavaScript over the same `Float64Array`,
checks it against pond-ts's answer, and times all three. That splits the
measured speedup into

```
total  =  algo  ×  lang
          ─────    ─────
          pond-ts  js-algo
          ───────  ───────
          js-algo  wasm
```

Full output: [`results-controls.txt`](results-controls.txt).

Medians across n ∈ {100k, 1M, 10M}:

| kernel                   | total  | **algo** (free in JS) | **lang** (needs the port) | JS-only reaches |
| ------------------------ | ------ | --------------------- | ------------------------- | --------------- |
| `median` [dense]         | 27.99× | **10.31×**            | 2.57×                     | **70%**         |
| `p95` [dense]            | 22.40× | **8.43×**             | 2.03×                     | **69%**         |
| `sum` [dense]            | 2.85×  | **1.84×**             | 1.55×                     | **58%**         |
| `minMax` [dense]         | 1.74×  | 1.28×                 | 1.36×                     | 45%             |
| `gather` [dense]         | 2.54×  | 0.72×                 | **3.76×**                 | 0%              |
| `gather` [gappy30]       | 2.43×  | 0.88×                 | **2.76×**                 | 0%              |
| `sum` [guarded]          | 0.61×  | 1.00×                 | **0.60×**                 | n/a             |
| `sum` [guarded, retuned] | 1.00×  | 1.00×                 | 1.00×                     | n/a             |

("JS-only reaches" is the share of the total speedup, in log space since
the terms multiply, that a same-day TypeScript PR captures with no Rust
at all.)

**On the three biggest wins, most of the speedup is the algorithm.**
`median` is 28× total, of which **10× is quickselect** — reachable today
by editing `reducers/percentile.ts`. The Rust adds 2.6× on top. That 2.6×
is real, but it is not what makes the number look impressive, and it is
not worth a second toolchain.

**`gather` is the one honest language win.** 2.76–3.76× on the `lang`
term, and the JS control _failed to reproduce it_ — my fused JS gather
came out **slower** than pond-ts's existing two-pass version at 1M and
10M (0.67–0.88× on the algo term). pond-ts's gather is already
well-optimised in JavaScript; the remaining gap is genuine codegen. If a
workload were dominated by gather-over-gappy-columns, that would be the
case for a targeted kernel.

**And the guarded path shows the porting tax.** The straightforward Rust
transliteration of `if (Number.isFinite(x)) acc += x` ran at **0.60×** —
a 40% regression against the JavaScript it replaces, consistent across
every size. V8 (in Node's 12.4) compiles that guard to a branchless
select and pipelines it against the FP-add latency for free; LLVM emitted
a branch that split the loop body. Rewriting it as
`acc += if x.is_finite() { x } else { 0.0 }` recovers exactly parity —
1.00×, not a win.

That path is not exotic. `allFinite: false` is the default and the
common case for any computed column, because the flag is a _promise_ a
producer can rarely prove. So the naive port regresses the library's
normal case, and careful per-kernel tuning gets it back to even.

---

## 6. Follow-up: what if _aggregation_ happened in Rust?

Everything above measures **leaf kernels** — one reduction over one
column. `TimeSeries.aggregate` is a **composite**: bucket a key column,
reduce C value columns per bucket, produce a whole new series. That is
the best possible shape for a port — one boundary crossing amortised
over N × C elements, no per-element callback — so extrapolating from the
leaf numbers would have been exactly the mistake this report warns
about. It got its own experiment:
[`bench/aggregate.mjs`](bench/aggregate.mjs), full output in
[`results-aggregate.txt`](results-aggregate.txt).

Both replacements produce a `TimeSeries` **identical to pond-ts's**,
verified cell by cell before timing. Every number below is directly
measured end to end — an earlier version decomposed the pipeline by
subtracting independently-measured stages and the parts came to 113% of
the whole (allocation-heavy micro-benches move GC around), so the
decomposition was thrown away in favour of running three complete
implementations.

### 6.1 The answer: yes, materially better — up to 2.66×

`n` = 1M events on a 1 s grid, C = 4 columns, whole `aggregate` call:

| events/bucket | buckets | pond-ts | js-algo | wasm    | wasm×     |
| ------------- | ------- | ------- | ------- | ------- | --------- |
| 10            | 100,000 | 60.64ms | 35.61ms | 30.05ms | 2.02×     |
| 60            | 16,667  | 13.34ms | 8.27ms  | 5.01ms  | **2.66×** |
| 600           | 1,667   | 5.48ms  | 5.11ms  | 3.69ms  | 1.49×     |
| 3,597         | 278     | 5.11ms  | 4.85ms  | 4.11ms  | 1.25×     |
| 83,333        | 12      | 4.93ms  | 4.87ms  | 4.28ms  | 1.15×     |

**2.66× end to end** at the typical metrics shape (1-minute buckets over
1-second samples) is a real result, and it is the strongest thing the
whole spike measured — against 1.00× for `sum`. So the composite
intuition is right: aggregation is where a port would pay, if anywhere.

But the same three qualifications hold, all measured.

### 6.2 Bucket width decides everything

Look down the table. At ≥600 events per bucket the win collapses to
1.15–1.49×, because at that point `aggregate` **is** the leaf-kernel
scan — the per-bucket fixed cost has amortised into nothing and what's
left is `sum` over a column, which we already know is 1.00×. Hourly and
daily rollups get essentially nothing.

The win lives entirely at **narrow buckets**, where per-bucket overhead
dominates. Which raises the question of what that overhead is.

### 6.3 Most of the narrow-bucket win is a `sliceByRange` allocation

Same decomposition as §5, applied to the kernel alone (stage 2):

| events/bucket | C   | pond-ts | js-algo | wasm   | **algo×** | **lang×** | total× |
| ------------- | --- | ------- | ------- | ------ | --------- | --------- | ------ |
| 10            | 4   | 40.19ms | 8.23ms  | 2.55ms | **4.88×** | 3.23×     | 15.78× |
| 60            | 4   | 10.04ms | 5.27ms  | 1.81ms | **1.91×** | 2.91×     | 5.55×  |
| 600           | 4   | 5.17ms  | 4.82ms  | 3.33ms | 1.07×     | 1.45×     | 1.55×  |
| 83,333        | 4   | 4.90ms  | 4.84ms  | 4.22ms | 1.01×     | 1.15×     | 1.16×  |

`tryAggregateColumnarTimeKeyed` reduces each bucket by **allocating a
`Float64Column` for it** — `plan.column.sliceByRange(start, scan)`, one
object per bucket per column. At B = 100,000 and C = 4 that is 400,000
throwaway column instances per `aggregate` call.

Passing `(start, end)` to a range-scoped reducer instead allocates
nothing, computes bit-identical results, and is worth **4.88×** on its
own at narrow buckets. That is the `algo` term, and it is a TypeScript
change to one function.

The `lang` term — what Rust actually adds — is a steady 1.15–3.23×.

### 6.4 Once the kernel is fast, the bottleneck moves somewhere Rust can't follow

Fixed costs every implementation pays, measured directly:

| events/bucket | C   | derive | **rows→series** | wasm end-to-end | rows→series share |
| ------------- | --- | ------ | --------------- | --------------- | ----------------- |
| 10            | 4   | 3.65ms | **20.16ms**     | 30.05ms         | **67%**           |
| 60            | 4   | 0.57ms | **2.51ms**      | 5.01ms          | **50%**           |
| 600           | 4   | 0.06ms | 0.25ms          | 3.69ms          | 7%                |
| 83,333        | 4   | 0.00ms | 0.00ms          | 4.28ms          | 0%                |

At the shapes where the port wins, **half to two-thirds of the remaining
time is turning the answer back into a `TimeSeries`.** And that cost is
structural, not sloppy: `aggregate`'s output is **interval-keyed**, and
pond-ts has no columnar construction door for interval keys —
`fromColumns` mints `TimeKeyColumn` / `ValueKeyColumn` only. So even a
substrate that computes the whole result in linear memory has to
materialise `Object.freeze([interval, …])` rows and let `TimeSeries`
re-columnarise them.

An interval-keyed `fromColumns` would delete that line. It is a
TypeScript change, it is worth more than the port at the narrow-bucket
shapes, and the two compose — the port's ceiling rises once it lands.

(Note the sentinel friction on the way through: the reduced columns use
`NaN` for an empty bucket, row intake wants `undefined`, so the
materialiser has to translate. That is [PND-WCNAN]'s asymmetry met from
the other direction.)

### 6.5 The drop-in version still doesn't hold up

Charging the cost of getting columns into linear memory **per call** —
the "keep pond-ts as-is, call Rust for aggregation" shape:

| events/bucket | C   | resident | with ingest charged |
| ------------- | --- | -------- | ------------------- |
| 60            | 4   | 2.66×    | 2.25×               |
| 600           | 4   | 1.49×    | 1.19×               |
| 3,597         | 4   | 1.25×    | 1.02×               |
| 83,333        | 4   | 1.15×    | **0.95×**           |

Still resident-only. Wide-bucket rollups go to a **net loss**, for the
same reason §4.4 found: the copy costs more than the kernel saves once
the kernel isn't the bottleneck.

### 6.6 Is the interval-keyed gap actually addressable? Yes — 16–38×

"pond-ts has no columnar door for interval keys" is a claim about the
current API, not about feasibility. So rather than leave it as an
assertion, I **built the door** out of parts that already exist and
measured it: [`bench/interval-columnar.mjs`](bench/interval-columnar.mjs),
output in
[`results-interval-columnar.txt`](results-interval-columnar.txt).

Every piece was already there:

```
IntervalKeyColumn(begin, end, labels, B)        ← exists
  → ColumnarStore.fromTrustedStore(schema, …)   ← exists, takes ANY KeyColumn
  → SeriesStore.fromTrustedStore(store)         ← exists
  → new TimeSeries({ …, [TRUSTED_SENTINEL] })   ← module-private
```

Only the last hop is unreachable from outside `time-series.ts` — and
that doesn't matter, because **`aggregateInternal` already lives inside
`time-series.ts`** and can call the private `#fromTrustedStore` directly.
`TimeSeries.fromColumns` even says so in its own doc comment: "Other key
kinds (`interval` / `timeRange`) … throw for now — **extend as consumers
need**." This is a deferred extension point, not a design barrier.

Two facts make the key column nearly free to build:

- `Sequence` labels every bucket `value: start` — the numeric bucket
  start. So `labelKind` is `'number'` and the label column holds exactly
  the same values as `begin`, which means it can **alias the same
  `Float64Array`**. The label column costs one object, not one array.
- `end[b] === begin[b+1]` on a fixed step, so `end` is a shifted view of
  the edge array the bucketing already built.

Replacing `rows→series` with that path, n = 1M:

| bucket | C   | buckets | rows→series | columnar   | speedup   | of which is key validation |
| ------ | --- | ------- | ----------- | ---------- | --------- | -------------------------- |
| 10 s   | 1   | 100,000 | 12.11ms     | **0.53ms** | **22.7×** | 101%                       |
| 10 s   | 4   | 100,000 | 19.71ms     | **0.52ms** | **37.8×** | 99%                        |
| 60 s   | 1   | 16,667  | 1.47ms      | **0.09ms** | **15.9×** | 94%                        |
| 60 s   | 4   | 16,667  | 2.52ms      | **0.09ms** | **28.7×** | 100%                       |
| 600 s  | 4   | 1,667   | 0.24ms      | **0.01ms** | 25.7×     | 94%                        |

The store it produces has **identical keys and identical values** to
pond-ts's `aggregate` output, verified row by row.

Two things worth reading off this:

**The assembly is free; the validation is the whole cost.** 94–101% of
the columnar path is `IntervalKeyColumn`'s own constructor, which makes
four O(B) passes (finite `begin`, finite `end`, `begin <= end`, and a
per-row `labels.read(i)` label check). Everything else — building the
columns map, both `fromTrustedStore` calls — is O(schema), not O(rows).
A trusted variant that skips validation for producer-generated buckets
would take it to near zero, but at 0.09ms that is not worth doing.

**There is exactly one design decision, and the test found it.** The
workload deliberately carries a gap so some buckets come out empty —
without that, a gapless grid would have reported a false all-clear.
**17,665 value cells differ**, all of them the same thing: an empty
bucket is `undefined` on the row path and `NaN` in a `Float64Array`.
Which one the columnar door carries has to be decided, and it is the
same call [PND-WCNAN] faces from the write side. The honest options are
to give the value column a validity bitmap (bit clear ⇒ `undefined`,
exactly the substrate's existing convention) or to canonicalise
NaN-as-missing end to end. The first preserves current behaviour
exactly; the second is the larger, better change.

Caveat on what was measured: the final `TimeSeries` wrap is not included
(the sentinel is module-private, so the spike stops at `SeriesStore`).
That hop is an object literal plus a constructor that assigns two fields
and freezes — O(1), and not where 2.5ms goes.

### 6.7 What this changes

It moves aggregation from "not worth it" to "the one operation where a
port has a real case" — and then the case still resolves the same way,
only more sharply now that §6.6 has priced the alternative:

- best measured for the port: **2.66×** end to end, at one workload shape
- of which the JS kernel rewrite alone gets **1.61×** (13.34 → 8.27ms)
- leaving **1.65×** for the Rust
- while the `rows→series` cost the port cannot touch — 50% of what
  remains at that shape — turns out to be **28.7× removable in
  TypeScript**, using classes that already exist

So the two TypeScript items in front of the port are not speculative
design work. One is a parameter change to a reducer signature; the other
is an assembly of four existing constructors, measured, with one
sentinel decision to make. Both are in §8.

---

## 7. What a full port would actually cost

The spike ported **one column kind** (`Float64Column`, packed) and the
kernels that read it. That is roughly **15% of the substrate by line
count, and the easiest 15%** — flat `f64` buffers with a bitmap.

What it did not touch:

|                                                | LOC       | why it's harder than `Float64Column`                           |
| ---------------------------------------------- | --------- | -------------------------------------------------------------- |
| `ring-buffer.ts`                               | 1,170     | the live path; capacity growth, wraparound, eviction           |
| `chunked-column.ts`                            | 867       | 4 chunked kinds, offset binary search, aggregate validity      |
| `key-column.ts`                                | 761       | time / timeRange / interval keys, dictionary labels            |
| `builder.ts`                                   | 618       | incremental construction for 4 kinds                           |
| `string-column.ts`                             | 600       | dictionary encoding — needs a string story across the boundary |
| `view.ts`                                      | 516       | zero-copy view transforms over a store                         |
| `concat.ts`                                    | 470       | k-way sorted merge producing chunked output                    |
| `store.ts`, `scatter.ts`, `array-column.ts`, … | 640       |                                                                |
| **substrate total**                            | **6,708** |                                                                |
| public column API (`column.ts`)                | 1,611     | the surface all of it has to keep                              |
| columnar test suite                            | **8,263** | every line of which has to keep passing                        |

Beyond line count, five things make this more than a translation
exercise:

**1. It only pays resident, and resident means owning intake.** Bridged
mode is a net loss (§4.4). So the win requires values to live in linear
memory from the moment they arrive — which means porting the builders,
the ring buffer, `fromColumns`, `from-arrow`, and the live append path.
There is no incremental "put the hot loop in Rust" version of this that
is faster than what exists.

**2. `Float64Array` is public API.** `col.toFloat64Array()` documents
that it returns `this._values` _by identity, no allocation_ — chart
adapters rely on that for inline canvas draw. Resident columns can only
return a view over `memory.buffer` that **detaches on the next
allocation**. Seventeen files in `packages/core/src` already reach into
`_values` / `.validity` directly.

**3. Memory becomes manual, and never shrinks.** WASM linear memory grows
and never returns pages. pond-ts columns are GC'd today; resident columns
need an explicit `free()`. `FinalizationRegistry` is the escape hatch but
it is non-deterministic — and the live layer churns columns continuously
by design. A missed `free()` is a permanent RSS increase, not a
GC-recoverable one.

**4. wasm32 caps the library at 4 GB.** Linear memory is 32-bit
addressed. `MAX_COLUMN_LENGTH` is 2³¹−8 rows; at 8 bytes each that is
17 GB for a _single_ column. Today pond-ts is bounded by system memory
(typed arrays are off-heap). A wasm32 port would cap _all_ resident
columnar data at 4 GB combined. `memory64` exists but is not universally
shipped, and adopting it means a third artifact.

**5. Two artifacts for SIMD, which measured 1.00×.** §4.6.

Then the ordinary costs: `cargo` in CI, a Rust toolchain for every
contributor, `.wasm` in the npm tarball with bundler/CSP/CDN
consequences, no source maps into Rust, and stack traces that stop at
the boundary.

---

## 8. Recommendation

### Not now, and not in this order

> **Superseded in part by §9.** This section originally said "no-go on the
> port" and rested on point 1 below — dense scans at 1.00×. That
> measurement is right and unrepresentative: real columns have gaps, and
> at realistic density the same reduction is ~1.9× (§9.2). The reduce
> family is 2.2–2.6× end to end with nothing else available to it. The
> case against is the structural price in §7, not the performance data.
> Points 2–6 stand as written.

1. **The library's most common operations get nothing.**
   `sum`/`mean`/`stdev`/`count` on dense columns: 1.00×. These are
   latency-bound recurrences; no compiler beats them.
2. **The `bin` win vanishes at the size it's needed.** 2.7× at 10k →
   1.00× at 10M. The 10M chart budget that `PND-DECIM` exists to protect
   gets no help.
3. **Most of the headline speedups are algorithm, not language.**
   `median` 28× decomposes to 10.3× quickselect × 2.6× Rust. A JS-only
   change reaches 45–70% of the total on every kernel except `gather`.
4. **It only pays resident**, so there is no incremental adoption path —
   the substrate has to own allocation end to end. That is ~6,700 lines
   of substrate plus 8,300 lines of tests, and it caps the library at
   4 GB (wasm32) while making memory manual in a layer that churns
   columns by design.
5. **It makes the row-shaped API 2× slower** — `scan`, `events`, custom
   reducers, all public and all deliberate.
6. **The baseline moves more than the win.** §4.8: the same JS is 3.9×
   apart between two V8 versions. Betting a rewrite on a gap that size
   is betting on an engine release note.

### Go on what the spike surfaced

These are ordinary TypeScript PRs against `packages/core`, each
independently landable, each with a benchmark already written in
[`bench/controls.mjs`](bench/controls.mjs):

| #   | change                                                                                                                                                                                                                                                           | measured                                                                                                               | risk                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Element-wise operators stop boxing** — `diff`, `rate`, `fill`, `shift`, `cumulative`, `mapColumns` read each cell via `read(i)` into a `ReadonlyArray<number \| undefined>` and rebuild the column from it, instead of walking `_values` into a `Float64Array` | **~10–20×** per column (exact `diff` control: 9.9× gappy, 17.1× dense)                                                 | six operators, one shared pattern. The boxed array is also how validity is currently derived (`float64ColumnFromArray`), so each needs its own validity write — the same thing [PND-IVLCOL] did for `aggregate`                                                               |
| 1   | **`reducePercentileColumn`: quickselect instead of full sort** — `median`, `p50`, `p95`, `p99`, and the `bin`/`binBy` percentile family                                                                                                                          | **7.3–11.8×**                                                                                                          | median-of-three pivot needed: columnar input is often already sorted, and a naive pivot degrades to O(n²) on exactly that                                                                                                                                                     |
| 2   | **`Float64Column.minMax`: 4-lane form**                                                                                                                                                                                                                          | **1.27–1.50×**                                                                                                         | none — min/max are associative, bit-identical output, the chart's per-frame Y-extent primitive                                                                                                                                                                                |
| 3   | **`sum`/`mean`: 8 accumulators**                                                                                                                                                                                                                                 | **1.83–1.85×**                                                                                                         | **semantic** — reassociation is not bit-identical (measured divergence up to 27 × eps). The cross-path tests assert the columnar and row paths agree, so this needs a decision, not just a patch                                                                              |
| 4   | **Guarded reductions: `acc += isFinite(x) ? x : 0`**                                                                                                                                                                                                             | up to **3.9×** on Chromium 148, ~1.0× on Node's V8                                                                     | none semantically (`acc` starts `+0`, so `+0 + -0 = +0` — the identity has no sign to lose)                                                                                                                                                                                   |
| 5   | **`tryAggregateColumnarTimeKeyed`: range-scoped reducers instead of `sliceByRange` per bucket** — kills one `Float64Column` allocation per bucket per column                                                                                                     | **1.9–4.9×** on the aggregate kernel; **1.6–1.7×** on the whole `aggregate` call                                       | none — bit-identical, verified against pond-ts's output series in [`bench/aggregate.mjs`](bench/aggregate.mjs). Needs `ReducerDef` to expose a `(col, start, end)` form alongside `reduceColumn`                                                                              |
| 6   | **Interval-keyed columnar construction**, so `aggregate` stops round-tripping its answer through frozen rows. Prototyped and measured in §6.6 — every class it needs already exists                                                                              | **15.9–37.8×** on that stage (2.52ms → 0.09ms at 16,667 buckets × 4 columns), which was 50–67% of the post-kernel time | one real decision: an empty bucket is `undefined` on the row path and `NaN` in a `Float64Array`. Either give the value column a validity bitmap (preserves behaviour exactly) or canonicalise NaN-as-missing end to end (bigger, better, and the same call [PND-WCNAN] faces) |

Item 0 is the largest single result in this report — larger than
anything the port offers — and item 1 is worth more than everything the
port measured while being a change to one file. Items 5 and 6 come from the aggregation follow-up
(§6) and compose: 5 removes the kernel's allocation, 6 removes the
output round-trip that dominates once the kernel is fast.

### Revisit if

The one durable language win is **`gather` at 2.4–2.8× end to end
(2.8–3.8× on the language term alone)**, and it's the
only kernel where the JS control _failed_ to reproduce the speedup —
pond-ts's gather is already well-optimised, and the gap is genuine
codegen. Same for validity-heavy paths generally (1.7–3.0×), where Rust
inlines a bit test that JS pays a method call for.

So: if a real workload turns up that is dominated by
gather-over-gappy-columns — a heavy `byValue` / `partitionBy` /
`concatSorted` pipeline on sparse data, at a size where it dominates a
frame budget — a **targeted** WASM kernel behind the existing JS API
would be worth costing. That is a different and much smaller project
than porting the substrate, and it should be driven by a friction report
from an experiment, not by this spike.

**And `aggregate` at narrow buckets is the second candidate** — §6
measured 2.66× end to end at 1-minute buckets over 1-second samples, the
best result in the spike. The reason it still isn't a green light is
that items 5 and 6 above are in front of it: the JS rewrite takes
1.61× of that 2.66×, and the un-portable `rows→series` cost is 50% of
what remains. **Land 5 and 6 first, then re-measure.** If a 2× gap is
still sitting there afterwards, on a workload someone actually runs,
that is a much better-posed question than this spike could answer — and
the harness to answer it is already written.

Until then the substrate stays in TypeScript.

### What to keep

`spikes/columnar-wasm/` is self-contained and doesn't build, test, or
ship with the workspace. Worth keeping for the parity harness (a working
oracle for the `Float64Column` contract, including edge cases the current
suite doesn't cover — `MAX_VALUE` overflow in Welford, `-0`, denormals)
and for the control benchmarks, which are the acceptance test for the
four PRs above. If it's re-run later, `./build.sh && node bench/node.mjs`
is the whole workflow.

---

## 9. Correction and revision: per-operation measurement

§4–§6 measure _column kernels_ and one composite (`aggregate`). Nobody
calls a column kernel; they call `series.fill(...)`. This section
measures the operations, with the warm-up bug of §2 fixed, and it
changes the conclusion.

Harness: [`bench/operations.mjs`](bench/operations.mjs),
[`bench/aggregate-current.mjs`](bench/aggregate-current.mjs). Output:
[`results-operations.txt`](results-operations.txt),
[`results-aggregate-current.txt`](results-aggregate-current.txt).

### 9.1 What the warm-up bug cost

Corrected kernel speedups, one column of 1M rows, ~4% missing, all three
doing identical work (read with validity, compute, write value + bit):

| kernel shape     | as first reported | **corrected** |
| ---------------- | ----------------- | ------------- |
| bucketed reduce  | 4.46×             | **4.26×**     |
| prefix scan      | 3.29×             | **3.28×**     |
| gather           | 3.81×             | **3.28×**     |
| element-wise     | 2.05×             | **2.05×**     |
| **whole reduce** | **4.12×**         | **1.87×**     |
| sliding window   | 1.48×             | **1.33×**     |

So the honest range is **1.3–4.3×**, and the whole-column reduce figure
was wrong by 2.2×.

### 9.2 The dense-scan headline was unrepresentative

§4.1 leads with `sum` at 1.00× and reads it as "there is nothing here."
That is true for a **dense** column — one with no validity bitmap at all.
Sweeping gap density on the same 1M column:

| missing | pond-ts  | Rust     | lang ×    |
| ------- | -------- | -------- | --------- |
| 0%      | 0.955 ms | 0.950 ms | **1.00×** |
| 1%      | 1.570 ms | 0.942 ms | 1.67×     |
| 4%      | 1.707 ms | 0.924 ms | 1.85×     |
| 10%     | 2.070 ms | 1.049 ms | **1.97×** |
| 30%     | 3.191 ms | 2.237 ms | 1.43×     |
| 50%     | 4.164 ms | 3.325 ms | 1.25×     |

Real time-series columns have gaps. The win peaks near 2× at 4–10%
missing — where most monitoring data sits — and falls off at both ends
(nothing to skip when dense; unpredictable branches when half-empty).
Leading with the 0% column was choosing the one point where Rust looks
worst.

### 9.3 Per operation

C = 4 mapped columns, N = 1M, ~4% missing. `kernel` is the share of the
operation that scales per column, fitted from a C ∈ {1,2,4,8} sweep.
`JS-only` and `+RUST` are **upper bounds**: resident columns, zero
boundary, zero ingest, whole per-column term replaced.

| operation            | shape           | total   | kernel | algo × | lang × | JS-only | +RUST     |
| -------------------- | --------------- | ------- | ------ | ------ | ------ | ------- | --------- |
| `rate`               | element-wise    | 421 ms  | 100%   | ~27×   | 2.0×   | 27.3×   | 55.9×     |
| `fill('hold')`       | element-wise    | 319 ms  | 100%   | ~21×   | 2.0×   | 20.6×   | 42.3×     |
| `fill('linear')`     | element-wise    | 296 ms  | 100%   | ~19×   | 2.0×   | 19.2×   | 39.3×     |
| `diff`               | element-wise    | 294 ms  | 100%   | ~19×   | 2.0×   | 19.1×   | 39.0×     |
| `mapColumns`         | element-wise †  | 277 ms  | 100%   | ~18×   | 2.0×   | 17.9×   | 36.7×     |
| `shift`              | element-wise    | 242 ms  | 100%   | ~16×   | 2.0×   | 15.7×   | 32.1×     |
| `cumulative`         | prefix scan     | 166 ms  | 100%   | 6.4×   | 3.3×   | 6.3×    | 19.5×     |
| `rolling(100,'avg')` | sliding window  | 418 ms  | 91%    | 32.9×  | 1.3×   | 8.4×    | 8.9×      |
| `smooth('ema')`      | prefix scan     | 1626 ms | 65%    | 41.3×  | 3.3×   | 2.8×    | 2.9×      |
| `bin(1024)` ×C       | bucketed reduce | 9.8 ms  | 100%   | n/a    | 4.3×   | 1.00×   | **2.62×** |
| `reduce('avg')`      | whole reduce    | 9.0 ms  | 100%   | n/a    | 1.9×   | 1.00×   | **2.47×** |
| `column().sum()` ×C  | whole reduce    | 8.9 ms  | 100%   | n/a    | 1.9×   | 1.00×   | **2.43×** |
| `aggregate`          | bucketed reduce | 12.2 ms | 85%    | n/a    | 4.3×   | 1.00×   | **2.17×** |
| `select` / `rename`  | no kernel       | ~0 ms   | —      | n/a    | 1.0×   | 1.00×   | 1.00×     |
| `align(linear)`      | element-wise    | 18.0 ms | 20%    | 0.2×   | 2.0×   | 0.60×   | **0.82×** |
| `byValue`            | gather          | 8.6 ms  | 1%     | n/a    | 3.3×   | 1.00×   | **0.77×** |

† `mapColumns` takes a JS **closure**. No kernel can replace it without a
declarative expression API, so its `+RUST` figure is unreachable today.

`n/a` on algo × means pond-ts already _is_ the tight typed-array loop —
there is nothing to rewrite, and Rust is the only remaining lever.

**Caveat on `algo ×`.** The generic element-wise control is a 1-read map
while `diff` is a 2-read adjacent difference, so the model overstates.
An exact `diff` control measured **9.9× on gappy data, 17.1× dense**
against the model's 19.1×. Read the element-wise algo column as ~10–20×,
indicative. The `lang ×` column is measured directly and needs no such
caveat.

### 9.4 `aggregate`, against the current library

Both sides given the columnar output path that [PND-IVLCOL] shipped, so
the only difference left is who runs the reduction.

| ev/bucket | C   | total    | 1. derive | 2. reduce | 3. output | kernel | ceiling   |
| --------- | --- | -------- | --------- | --------- | --------- | ------ | --------- |
| 10        | 4   | 23.15 ms | 5.73      | 16.83     | 0.59      | 73%    | **2.51×** |
| 60        | 1   | 3.33 ms  | 0.65      | 2.59      | 0.10      | 78%    | **2.17×** |
| 60        | 4   | 6.66 ms  | 0.65      | 5.91      | 0.10      | 89%    | **2.48×** |
| 600       | 4   | 5.23 ms  | 0.06      | 5.16      | 0.01      | 99%    | 1.54×     |
| 3,597     | 4   | 5.00 ms  | 0.01      | 4.99      | 0.00      | 100%   | 1.23×     |

[PND-IVLCOL] and [PND-AGGALLOC] removed the non-kernel overhead, so
`aggregate` is now **73–100% kernel**. That _raises_ Rust's relative
ceiling while halving its absolute prize: at the typical shape Rust could
once have saved 8.3 ms of 13.34; now it can save **4.0 ms of 6.66**.

### 9.5 The revised position

Three groups:

- **Rust is the only lever** — `bin` 2.62×, `reduce` 2.47×,
  `column().sum()` 2.43×, `aggregate` 2.17×. pond-ts is already the tight
  loop; no TypeScript change touches these.
- **TypeScript is the bigger lever** — `rate`/`diff`/`fill`/`shift`
  ~10–20×, `cumulative` 6.4×, `rolling` 32.9×, `smooth` 41.3×. Rust adds
  1.3–3.3× _on top of_ a rewrite that has not happened.
- **Rust loses** — `align` 0.82×, `byValue` 0.77×, reshape 1.00×.

So the performance case for a Rust core is real: **~2.5× on the reduce
family, with nothing else available to it.** What argues against it is
§7 — resident-only storage, the 2× row-API penalty, the 4 GB ceiling,
manual memory — and that is a judgement about price, not a benchmark
result.

**Revised recommendation: not now, and not in this order.** The
TypeScript work in §8 is 5–10× larger, comes first regardless, and
changes the baseline the Rust question would be asked against. Re-ask
after it lands, with fresh measurements — this report has now been
wrong once by measuring the baseline badly, and the baseline keeps
moving.

---

## 10. Revision 2: the workload is not what this report assumed

Everything above measures a general-purpose time-series library. The actual
driver is narrower and it changes the answer: **agents repeatedly
interrogating large historical financial bar series** — derived columns,
summaries, facts — to build and test trading strategies.

Two properties of that workload undercut §7, which is where the case against
a Rust core actually lived.

### 10.1 The structural objections were priced for the wrong workload

| §7 objection                                                                                        | under this workload                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resident-only**: bridged mode is a measured loss, so the substrate must own allocation end to end | The series is loaded **once** and queried hundreds of times. Resident is the natural model, not a concession; ingest amortises to nothing. **Objection largely dissolves.** |
| **Row API 2× slower** (`scan`, `events`, custom reducers)                                           | Agents ask for _derived columns, summaries and facts_ — columnar output. Row iteration is not the access pattern. **Weakens sharply.**                                      |
| **4 GB ceiling** (wasm32)                                                                           | 500k bars × 6 columns × 8 B ≈ 24 MB. Even 100M bars ≈ 4.8 GB, and that is far past normal use. **Weakens.**                                                                 |
| **Manual memory** in a GC'd library                                                                 | Load-once/query-many is the easiest possible lifetime story. **Weakens.**                                                                                                   |
| **Baseline moves 3.9× between V8 versions**                                                         | Still true, and still a reason to re-measure rather than to abstain.                                                                                                        |

So the honest revision: **for this workload the Rust case is materially
stronger than §9.5 concluded.** The reduce family at 2.2–2.6×, gather at
3.3×, prefix scan at 3.3× are all directly in the path, and "as fast as
possible" is the actual requirement rather than a nice-to-have.

### 10.2 But the TypeScript wins in front of it are still bigger

Measured on the real shape — 500k 1-minute OHLCV bars, resident, per query
(`packages/financial/scripts/perf-agent-queries.mjs`):

| query                                                       | ms            |
| ----------------------------------------------------------- | ------------- |
| 5-study strategy pass (sma20+sma50+sma200+bollinger+zscore) | **318.30**    |
| `bollinger(20)`                                             | 105.26        |
| `zScore(20)`                                                | 98.77         |
| `envelope(20)`                                              | 69.33         |
| `percentChange()`                                           | 23.66         |
| `sma(20)` / `sma(200)`                                      | 21.48 / 21.47 |
| `ema(20)`                                                   | 3.95          |
| `close.median()` / `percentile(95)`                         | 2.83 / 2.91   |
| `close.stdev()`                                             | 2.58          |
| `close.minMax()` / `mean()`                                 | 0.95 / 0.47   |

**Studies are ~100× the cost of summary facts.** All effort belongs there.

Inside `sma(20)`'s 22.17 ms:

| stage                                   | today        | typed       |
| --------------------------------------- | ------------ | ----------- |
| `rolling` scan (builds a whole series)  | **14.64 ms** | —           |
| `readNumericColumn` (boxes it back out) | **8.28 ms**  | **0.40 ms** |
| `withColumn` re-ingest                  | 3.61 ms      | 5.28 ms     |

Two TypeScript targets, both larger than the 2–3× a port offers:

- **[PND-ROLLKERN]** — `rolling` is 66% of every study. It already writes typed
  result columns, but drives the generic `rollingStateFor` accumulators: three
  polymorphic calls (`add`/`remove`/`snapshot`) per row per column for O(1)
  arithmetic — 29 ns/row. This is the same disease `cumulative` had, where
  unboxing alone bought 1.2× and specialising the fold bought 4–7×.
- **[PND-STUDYBOX]** — the study kernel boxes every cell, and `bollinger`
  allocates four 500k boxed arrays before three `withColumn` re-ingests.
  `withColumn` already accepts a `Float64Array`, so the round trip is
  column → boxed → column for nothing. 20× on that stage.

### 10.3 Revised position

**TypeScript first, and then Rust is likely worth it — which is a different
conclusion from §9.5's "not now, not in this order."**

The ordering argument survives, for a reason that is not about size: porting
first would freeze the current boxed, virtual-call-per-row architecture at the
WASM boundary. The kernels a Rust core would own are exactly the ones
[PND-ROLLKERN] and [PND-STUDYBOX] are about to reshape, and a port built
against today's shapes would have to be rebuilt.

Land those two, re-run `perf-agent-queries.mjs`, and re-ask. On a resident
load-once/query-many series with no row-API pressure, a 2–3× on the reduce and
window kernels is a straightforwardly good trade — the objections that made it
look otherwise were priced for a workload this is not.
