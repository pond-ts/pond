# PND_COLUMNAR_PLAN — columnar substrate: remaining levers

> Breakout plan for the **Columnar substrate** roadmap section in
> [PLAN.md](../../PLAN.md). The batch columnar wave is **complete** (framework
> 1a–1h, TimeSeries integration, reducer fast paths, the full transform wave,
> column API 8a–8e) — full history in
> [docs/archive/phase-4-7-columnar-substrate.md](../archive/phase-4-7-columnar-substrate.md).
> RFCs: [columnar-core.md](../rfcs/columnar-core.md),
> [columnar-live-protocol.md](../rfcs/columnar-live-protocol.md),
> [column-api.md](../rfcs/column-api.md). Ground truth assessments:
> [columnar-arc-assessment-2026-06.md](../notes/columnar-arc-assessment-2026-06.md),
> [live-columnar-assessment-2026-06.md](../notes/live-columnar-assessment-2026-06.md).

Live columnar sits at a defensible **retention-boundary waypoint**: the
originating OOM (gRPC partition retention) is solved (chunked backing +
column-native partition routing #175). Everything below is friction-gated —
each lever has a named consumer signal that would earn it. Label warning from
the archive: "3C" historically meant both the batch rolling _output_ path
(SHIPPED #225) and the live rolling _reducer_ state (still deferred —
[PND-LROLL] here).

## Tasks

### [PND-COLOUT] — Column-native output (§A)

The dominant remaining allocation slice at the live output boundary:
~11.7 MB/s transient at the gRPC OOM cell (~90k Events/s + ~90k
row-objects/s for shared `'batch'` listeners); V8 confirmed the 37k retained
Events are all emit-side. Spike plan:
[docs/briefs/column-native-output-spike.md](../briefs/column-native-output-spike.md)
(payload fork, additive listener name, before-number locked by the V6
re-bench, API gate).

### [PND-REORD] — Columnar reorder (§B)

Append-only main store + sorted "late corral" overlay + grace-flush
compaction, per
[columnar-live-protocol.md](../rfcs/columnar-live-protocol.md) §B.
**Unearned** — no consumer signal yet; stays RFC context until one arrives.

### [PND-LROLL] — Live rolling columnar reducer state (Step 3 Phase C)

The only lever that would actually cut the gRPC ceiling's GC line (the Step-7
ring-buffer attempt was falsified: the consumer needs `Event`s regardless of
backing — walk-back brief at
[docs/briefs/step-7-live-series-ring-buffer.md](../briefs/step-7-live-series-ring-buffer.md)).
Per-reducer `rollingColumn` state machines; open design question whether the
extension surface is internal or a public contract like
`ReducerDef.reduceColumn`. Earns its slot only if a workload pushes near
ceiling (production target 100k/s; V5 measured ~210k/s = 2.1× headroom).

### [PND-PLANNR] — Aggregate planner (step 5)

Minimal fused planner: precompute bucket spans once, answer simple reducers
from prefix sums/counts, fall back to the event-walked path. Friction-gated.

### [PND-DICT] — String / dictionary reducer adaptation (step 6)

`unique` / `top` / `samples` / grouped `count` over dictionary-encoded
columns. Friction-gated.

### [PND-WCNAN] — `withColumn` NaN-canonical `Float64Array` intake

**Source:** dashboard-agent friction report (pond-ts-dashboard engine A/B,
2026-07-21). `withColumn` rejects NaN today, so a consumer deriving a **gated**
column (a value that is present for some rows, missing for others) must hand it
in as a boxed `(number | undefined)[]` rather than a typed array. At density
that boxing is the dominant adapter cost the report measured — the per-tick
derivation memo goes 6.3 ms @ 86k → **~25 ms @ 360k**, mostly boxing three
derived columns per host per tick.

**Ask:** accept a NaN-as-missing `Float64Array` as `withColumn` intake —
symmetric with what `colToValues` already **emits** (NaN for a missing cell).
Then a consumer reads columns out as typed arrays, derives into a fresh
`Float64Array` writing `NaN` for gated-out cells, and hands it straight back —
allocation-free, no boxing. This is one face of the broader **NaN-vs-`undefined`
sentinel asymmetry** flagged as friction #3/#4 in the wide-schema report: the
read side speaks NaN, the write side (`withColumn`) demands `undefined`. Design
call: whether NaN-intake is a `withColumn` option/overload or the columnar
substrate canonicalizes the two sentinels end to end. Friction-gated but has a
named consumer and a measured cost.

### [PND-KERNEL] — Kernel algorithm wins (from the Rust/WASM spike)

**Source:** `spikes/columnar-wasm/` — a working Rust port of the hot
`Float64Column` kernels compiled to `wasm32-unknown-unknown`, benchmarked
against the shipped library in Node and the browser. Full write-up:
[spikes/columnar-wasm/REPORT.md](../../spikes/columnar-wasm/REPORT.md).

**The port itself is a no-go**, and the reasoning is worth keeping because it
will otherwise be re-litigated. Measured, resident (zero-copy) columns, versus
pond-ts's real implementation:

- `sum` / `mean` / `stdev` / `count` on dense columns: **exactly 1.00×**. The
  sum loop is bound by FP-add latency (~0.95 ns/element ≈ 3 cycles); both V8
  and LLVM hit the same wall because it is a property of the recurrence.
- `minMax`: **0.88×** — the port is consistently _slower_.
- `bin(1024, …)`: 2.7× at 10k, **1.00× at 10M** — the win evaporates exactly
  at the size [PND-DECIM] exists to protect, where both are bandwidth-bound.
- The bridged (copy-in-per-call) model is a net loss on every scan kernel, so
  there is no incremental adoption path: the win requires the substrate to own
  allocation end to end (~6,700 LOC substrate + 8,263 LOC of tests), caps the
  library at 4 GB under wasm32, makes memory manual in a layer that churns
  columns by design, and makes the row-shaped API (`scan`, `events`, custom
  reducers) **2× slower** across the boundary.
- `+simd128` measured 1.00× on everything it touched, and it is not free to
  ship — wasm has no runtime feature detection, so SIMD means two artifacts
  and a load-time probe.

**What the spike did prove** is that four of the measured speedups are
_algorithm_, not language — the control experiment implements each in plain JS
over the same `Float64Array` and splits `total = algo × lang`:

| change                                       | algo (JS-only)                                | lang (needs Rust) | notes                                                             |
| -------------------------------------------- | --------------------------------------------- | ----------------- | ----------------------------------------------------------------- |
| quickselect in `reducePercentileColumn`      | **7.3–11.8×**                                 | 2.0–3.5×          | `median`, `p50/p95/p99`, and the `bin`/`binBy` percentile family  |
| 4-lane `Float64Column.minMax`                | 1.27–1.50×                                    | 1.34–1.37×        | bit-identical (min/max are associative); chart per-frame Y-extent |
| 8-accumulator `sum` / `mean`                 | 1.83–1.85×                                    | 1.51–1.56×        | **not** bit-identical — see the semantics gate below              |
| branchless finite guard (`allFinite: false`) | 1.0× on Node's V8, up to 3.9× on Chromium 148 | —                 | engine-version-dependent; see below                               |

**Semantics gate on the `sum` item.** Reassociating the accumulator is not a
bit-identical rewrite (measured divergence up to 27 × eps on large-magnitude
data). `reducers/stdev.ts` documents why the columnar fast path and the row
path must agree, and the cross-path tests assert it — so this one needs a
decision about which paths adopt the new order, not just a patch. The `minMax`
and guard items carry no such gate.

**Engine-version caveat, and the most decision-relevant thing here.** The
guarded (`allFinite: false`) reduction path — the common case, since the flag
is a promise a producer can rarely prove — runs at 0.969 ms under Node's
V8 12.4 and **3.737 ms** under Chromium 148 for identical JavaScript on the
same machine. The JS baseline moves between engine versions by more than the
size of the win being chased. Any future "should this be native" argument
should re-measure rather than cite these numbers.

**Two correctness findings, both worth keeping regardless of the verdict:**

1. `Math.max(0, x)` and Rust's `x.max(0.0)` disagree on NaN (JS propagates,
   IEEE `maxNum` ignores). Welford overflows to NaN on
   `[MAX_VALUE, -MAX_VALUE, 1]`, so `stdev` genuinely _returns_ NaN there —
   which also means **`NaN` cannot serve as an "undefined" sentinel** for a
   `number | undefined` reduction. Note the asymmetry: in `bin` output NaN
   _is_ the correct empty-bucket sentinel, because the container is a
   `Float64Array` with a documented convention. Same value, opposite meaning,
   one layer apart — the same sentinel asymmetry [PND-WCNAN] runs into.
2. `ValidityBitmap.definedCount` is cached at construction, making `count()`
   O(1); any out-of-process representation loses that and silently regresses
   to a popcount. Derived state memoised on JS objects does not survive a
   boundary.

**Acceptance benchmarks already exist** in
`spikes/columnar-wasm/bench/controls.mjs` / `controls-node.mjs`; each JS
control is checked against pond-ts's own answer before it is timed. The
spike's parity harness (`test/parity.mjs`, 1,380 checks) is also a usable
oracle for the `Float64Column` contract and covers cases the current suite
does not — Welford overflow, `-0`, denormals, `allFinite` set pessimistically,
out-of-range gather indices, `binBy`'s inclusive final edge.

**Revisit-the-port trigger.** The one durable language win is `gather`
(2.4–2.8× end to end; 2.8–3.8× on the `lang` term) and validity-heavy paths
generally (1.7–3.0×), where Rust inlines a bit test that JS pays a method call
for. `gather` is also the only kernel where the JS control _failed_ to
reproduce the speedup. If a workload arrives that is dominated by
gather-over-gappy-columns at a size that dominates a frame budget, a
**targeted** kernel behind the existing JS API would be worth costing — a much
smaller project than porting the substrate, and it should be driven by a
friction report, not by this spike.

### [PND-AGGALLOC] / [PND-IVLCOL] — the `aggregate` follow-up

**Source:** the same Rust/WASM spike, asked a second question — _is a
composite operation different from a leaf kernel?_ `bin` reduces one column;
`aggregate` buckets a key column, reduces C value columns per bucket, and
produces a whole series. That is the best possible shape for a port (one
boundary crossing amortised over N × C elements, no per-element callback), so
extrapolating from the leaf numbers would have been wrong in the optimistic
direction. Harness: `spikes/columnar-wasm/bench/aggregate.mjs`, results in
`results-aggregate.txt`, write-up in REPORT.md §6.

Method note worth keeping: the first version decomposed `aggregate` by timing
stages independently and subtracting. The parts summed to **113% of the
whole** — allocation-heavy micro-benches move GC around, so independently
measured medians of a pipeline do not add up. It was replaced with three
_complete_ implementations (pond-ts, a JS rewrite, a WASM-backed one), each
producing a `TimeSeries` verified cell-by-cell identical, all timed end to
end. No subtraction anywhere.

**Result: aggregation is the strongest case for a port the spike found —
2.66× end to end** at 1-minute buckets over 1-second samples, n=1M, C=4
(13.34 ms → 5.01 ms), against 1.00× for `sum`. And it still resolves as a
no-go, for three measured reasons:

1. **Bucket width decides everything.** At ≥600 events/bucket the win falls to
   1.15–1.49×, because `aggregate` _becomes_ the leaf-kernel scan once the
   per-bucket fixed cost amortises away. Hourly and daily rollups get nothing.
2. **Most of the narrow-bucket win is the `sliceByRange` allocation**
   ([PND-AGGALLOC]) — a JS fix worth 4.88× on the kernel at 10 events/bucket
   and 1.61× of the 2.66× end to end. The `lang` term is 1.15–3.23×.
3. **The bottleneck then moves out of reach** ([PND-IVLCOL]) — `rows→series`
   is 50% of the WASM end-to-end at the sweet spot and 67% at narrow buckets.
   Charging linear-memory ingest per call (the drop-in-accelerator shape)
   takes the wide-bucket case to **0.95×**, a net loss, for the same reason
   §4.4 found.

**Sequencing:** land [PND-AGGALLOC] then [PND-IVLCOL], then re-measure. Both
are TypeScript, both are verified by the committed harness, and together they
remove the two costs that make the port's remaining margin hard to read. If a
2× gap survives on a workload someone actually runs, _that_ is a well-posed
question about a targeted kernel — and unlike this spike, it would have a
named consumer.

**[PND-AGGALLOC] — SHIPPED.** `ReducerDef` gained `reduceColumnRange(col,
start, end)` and `tryAggregateColumnarStore` calls it instead of
`reduceColumn(column.sliceByRange(start, scan))`.

**What the slice actually cost.** More than the object churn the original note
assumed. Per bucket per column, `sliceByRange` allocated a `subarray` view _and_
a `Float64Column` — and on a column carrying a validity bitmap it also called
`validitySliceByRange`, which allocates a fresh `Uint8Array` and copies the
bucket's bits, after which `PackedValidityBitmap`'s constructor popcounts them.
So on gappy data the slice was not just two allocations, it was two extra passes
over the bucket's data, both discarded immediately. Two integers replace all of
it.

**Deviation from the planned shape, and why.** The plan said `reduceColumn`
stays and the range form is the bucketed caller's door — implying the range form
would be a thin re-parameterisation. Reading the reducers showed that is true
for six of the eight but **false for `count` and `avg`**: their whole-column
form answers the bitmap case in O(1) from `validity.definedCount`, cached at
bitmap construction, while a sub-range must popcount via `countInRange`.
Collapsing them onto one body would have turned `Float64Column.count()` from
O(1) into O(n/8). So those two keep genuinely separate implementations, with the
reason recorded at both sites; the other six share one standalone `*Range`
function that `reduceColumn` calls at `(0, length)`.

The `*Range` kernels are **standalone functions, not methods delegating through
`this`** — callers detach the reducer (`reduce: def.reduceColumnRange`), which
would leave `this` undefined.

`planColumnarAggregate` gates on `reduceColumnRange` rather than falling back to
`reduceColumn` + slice. Every built-in has both forms or neither (asserted), so
the gate excludes exactly the reducers it excluded before (`unique` / `top` /
`samples` / `keep` / `first` / `last` boundary cases aside), and there is no
second bucket path left unexercised.

**Measured** (`packages/core/scripts/perf-aggregate-output.mjs`, N=1M, 1 s grid;
`+IVLCOL` is the state after that task, `+AGGALLOC` after this one):

| C   | bucket  | buckets | ev/bkt | original | +IVLCOL  | +AGGALLOC | total     |
| --- | ------- | ------- | ------ | -------- | -------- | --------- | --------- |
| 1   | 10 s    | 100,000 | 10     | 31.18 ms | 17.89 ms | 12.45 ms  | **2.50×** |
| 1   | 60 s    | 16,667  | 60     | 6.65 ms  | 3.63 ms  | 3.16 ms   | **2.10×** |
| 1   | 600 s   | 1,667   | 600    | 2.11 ms  | 1.95 ms  | 1.95 ms   | 1.08×     |
| 1   | 3600 s  | 278     | 3,597  | 1.82 ms  | 1.80 ms  | 1.83 ms   | 0.99×     |
| 1   | 86400 s | 12      | 83,333 | 1.74 ms  | 1.76 ms  | 1.79 ms   | 0.97×     |
| 4   | 10 s    | 100,000 | 10     | 55.52 ms | 38.84 ms | 21.81 ms  | **2.55×** |
| 4   | 60 s    | 16,667  | 60     | 12.77 ms | 10.17 ms | 6.40 ms   | **2.00×** |
| 4   | 600 s   | 1,667   | 600    | 5.25 ms  | 5.03 ms  | 4.79 ms   | 1.10×     |
| 4   | 3600 s  | 278     | 3,597  | 4.80 ms  | 4.72 ms  | 4.86 ms   | 0.99×     |
| 4   | 86400 s | 12      | 83,333 | 4.59 ms  | 4.61 ms  | 4.75 ms   | 0.97×     |

The 0.97–0.99× at wide buckets is **not** a regression: three independent runs
moved those cases ±2.5% in both directions, so it is run-to-run variance on a
~1.8 ms call. It was checked rather than assumed, because the first run showed
+2–3% with a consistent sign across all four wide cases and that is not what
noise usually looks like.

**No cost to the whole-column path.** `perf-reducers-step3.mjs` before/after at
N=1M: sum +4.6%, min −1.8%, max +2.1%, avg −3.4%, stdev −2.0%, median −3.9%,
p95 −0.2% — mixed signs inside the same variance band. The one real addition is
that gappy `percentile`/`median` now sizes its dense buffer with
`countInRange(0, n)` instead of the cached `definedCount`; measured directly on
a 1M column with 10% missing, that popcount is **0.124 ms against a 61.8 ms
`median()` — 0.20%**, dominated by the sort it precedes. Worth the single
implementation.

**Tests:** `packages/core/test/reducer-column-range.test.ts` (19). The contract
is asserted literally — `reduceColumnRange(col, s, e)` versus
`reduceColumn(col.sliceByRange(s, e))` — across 8 reducers × both `allFinite`
settings × 8 data shapes × 12 ranges, deliberately including ranges that do not
start at 0 and that straddle byte boundaries. **That is the whole risk of this
change**: slicing _rebases_ the validity bitmap so the slice's bit 0 is the
source's bit `start`, while the range form indexes the original bitmap at
absolute positions. Getting it backwards would make every offset bucket read the
wrong cells' validity, with no type error and no crash. Mutation-checked: a
rebased bitmap index in `sumRange`, and `minRange` seeded from `values[0]`
instead of `values[start]`, each fail the suite.

**[PND-IVLCOL] — SHIPPED.** `aggregate()` now assembles its result as a
`ColumnarStore` and adopts it via trusted construction, instead of emitting
frozen `[Interval, …]` rows for `new TimeSeries({ rows })` to walk back into
columns.

**Shape as built.** `tryAggregateColumnarStore` (in
`packages/core/src/batch/aggregate-columns.ts`) replaced the row-emitting
`tryAggregateColumnarTimeKeyed`. Same gate, same bucket walk; the difference is
that each reduced cell is written straight into a per-kind output buffer and the
buckets' begin/end/label axes become an `IntervalKeyColumn`. No new public API —
`ColumnarStore.fromTrustedStore` already accepted any `KeyColumn`, and
`IntervalKeyColumn` already existed. The one plumbing change was extracting
`TimeSeries.#fromTrustedStore`'s body into a module-scoped
`timeSeriesFromTrustedStore`: `aggregateInternal` is a module-level function, and
an ES `#name` is lexically confined to the class body, so it could not reach the
private static. The private static now delegates, so there is one implementation.

**Measured** (`packages/core/scripts/perf-aggregate-output.mjs`, N=1M on a 1 s
grid — the script sweeps _bucket width_, because the cost removed is per output
bucket and the existing `perf-aggregate.mjs` row sweep holds that constant):

| C   | bucket  | buckets | ev/bkt | before   | after    | change             |
| --- | ------- | ------- | ------ | -------- | -------- | ------------------ |
| 1   | 10 s    | 100,000 | 10     | 31.18 ms | 17.89 ms | **−42.6% (1.74×)** |
| 1   | 60 s    | 16,667  | 60     | 6.65 ms  | 3.63 ms  | **−45.3% (1.83×)** |
| 1   | 600 s   | 1,667   | 600    | 2.11 ms  | 1.95 ms  | −7.9% (1.09×)      |
| 1   | 3600 s  | 278     | 3,597  | 1.82 ms  | 1.80 ms  | −1.3% (1.01×)      |
| 1   | 86400 s | 12      | 83,333 | 1.74 ms  | 1.76 ms  | +1.4% (0.99×)      |
| 4   | 10 s    | 100,000 | 10     | 55.52 ms | 38.84 ms | **−30.0% (1.43×)** |
| 4   | 60 s    | 16,667  | 60     | 12.77 ms | 10.17 ms | **−20.4% (1.26×)** |
| 4   | 600 s   | 1,667   | 600    | 5.25 ms  | 5.03 ms  | −4.1% (1.04×)      |
| 4   | 3600 s  | 278     | 3,597  | 4.80 ms  | 4.72 ms  | −1.7% (1.02×)      |
| 4   | 86400 s | 12      | 83,333 | 4.59 ms  | 4.61 ms  | +0.3% (1.00×)      |

The shape matches the prediction: the win is per-bucket, so it is largest at
narrow buckets and vanishes at daily rollups where the reduce dominates. The
±1% at 12 buckets is noise on a 1.7 ms call. Relative gain is _smaller_ at C=4
than C=1 because the reduce term grows with C while the output cost does not —
the fixed cost being removed is a smaller share of a bigger total.

**The sentinel decision, resolved: option 1 (validity bitmap).** An empty bucket
stays `undefined`, not `NaN` — the output column carries a lazily-allocated
validity bitmap exactly as row intake did, so `hasMissing()` / `nullCount()` /
`count()` all report what they reported before. Option 2 (canonicalise
NaN-as-missing end to end) was **not** taken here: it is the better long-term
answer but it is a semantics change that belongs with [PND-WCNAN], and bundling
it into a performance change would have made a behaviour shift invisible inside
a speedup.

**Behaviour preserved deliberately, because trusted construction skips row
intake.** Every check row intake performed on `aggregate`'s behalf is performed
by the new path:

- `assertCellKind` is now **exported from `validate.ts` and shared**, not copied
  — so a reducer overflowing to `Infinity` still raises the same
  `ValidationError` with the same `row N col M: expected finite number` message.
  A copy would have drifted.
- Numeric outputs keep `allFinite: true`, on the same justification the row path
  used (every surviving cell was finite-checked). Dropping it would have been
  safe but would have quietly deoptimised every downstream reduction of an
  aggregate result to the guarded path.
- Interval label construction mirrors `validateAndNormalizeColumnar`'s tail,
  including the `RangeError` (not `ValidationError`) class and wording on a
  mixed string/number label sequence.

The one row-intake check deliberately skipped is the non-decreasing key scan:
`BoundedSequence` already validates its intervals as sorted, non-overlapping and
positive-duration at construction.

**Tests:** `packages/core/test/TimeSeries.aggregate-columnar-store.test.ts` (22).
They were **mutation-checked** rather than trusted for passing first time —
flipping `allFinite` to `false`, removing the `assertCellKind` call, and writing
a `NaN` sentinel instead of clearing the validity bit each fail exactly the
tests meant to catch them (1, 1, and 6 failures respectively).

### [PND-KERNEL] item 1 — quickselect percentile — SHIPPED

`reducePercentileColumn` / `reducePercentileColumnRange` now answer with
quickselect (median-of-three pivot, insertion sort below 16 elements) instead
of densify-then-`Float64Array.sort()`.

**Measured** (`scripts/perf-reducers-step3.mjs`, N=1M): `median` 76.18 ms →
5.90 ms, `p95` 75.80 ms → 5.88 ms — **12.9×**, above the 7.3–11.8× the spike
predicted. `sum` / `min` / `max` / `avg` / `stdev` unchanged (1.00×, 0.99×,
1.02×, 1.00×, 1.00×).

**Median-of-three is load-bearing, not a flourish.** Columnar percentile input
is frequently already sorted or nearly so — a monotonic key column, a
`cumulative` result, a `byValue` materialisation. A first- or middle-element
pivot degrades to O(n²) on exactly those inputs, which would convert a chart
frame into a hang. A 200k-cell already-sorted case is pinned with a wall-clock
bound that quadratic cannot pass.

**It also closed a cross-path drift.** `Float64Array.prototype.sort()`
implements the spec total order, which places `-0` strictly before `+0`; the
row path's `(a, b) => a - b` comparator returns `-0` for that pair, which
`Array.prototype.sort` treats as equal and (being stable) leaves in input
order. So `p0` of `[0, -0, 0, -0, 0]` was `-0` on the columnar path and `+0`
on the row path — a data-dependent disagreement between two paths the
`aggregate` fast-path gate picks between per call. Quickselect compares with
`<` / `>`, under which the two zeros are equal, so the paths now agree.
Pinned explicitly.

**Tests:** `packages/core/test/percentile-quickselect.test.ts` (24). The
reference is computed by actually sorting with the row path's comparator
rather than hard-coded, across 17 data shapes × 13 quantiles, plus 200
randomised trials biased toward heavy duplicates (the classic Hoare-partition
stall), the sorted/reverse-sorted quadratic traps, sizes either side of the
insertion-sort threshold, and the signed-zero regression pin.

### [PND-BOXFREE] — first tranche SHIPPED (`cumulative`, `diff` / `rate` / `pctChange`)

`packages/core/src/batch/operators/numeric-io.ts` adds `packedNumericSource`
(raw `Float64Array` + validity bits, or `null` for chunked / non-numeric) and
`NumericOutput` (typed value buffer + eagerly-allocated bitmap, dropped at
`finish()` when every cell is defined). `cumulative` and `diff-rate` use them;
the old boxed loop stays as the fallback for sources the fast path declines.

**Measured** (`scripts/perf-operators-unboxed.mjs`, 200k rows × 4 columns):
**4.0–7.1×** across all five entry points, dense and gappy.

**Two things the naive version got wrong, both found by measuring:**

1. **Unboxing alone barely moved `cumulative`** — 166 ms → 142 ms (1.2×). Its
   per-cell cost was never the box, it was one invocation of `buildApply`'s
   closure per element. Specialising `sum` / `count` / `max` / `min` into
   dedicated loops is what took it to 2.6 ms. A custom fold still routes
   through the closure, because that call is the caller's own function.
2. **A shared `isDefinedAt(bits, i)` helper cost more than it saved** —
   called with both `null` and `Uint8Array`, so V8 could not inline it.
   Inlining the bit test at each site follows the convention the reducers
   already use (hoist the validity branch, don't dispatch per cell).

**Measurement note, and it invalidated an earlier round of numbers.** The
benchmark harness warmed up for a fixed 40 ms. For a ~20 ms operation that is
~10 iterations, and V8's optimising tier is a cliff: `Float64Column.sum()` over
1M cells held at 3.82 ms through 400 warm-up iterations and dropped to 1.41 ms
between 400 and 800. The symptom was that whichever configuration ran **first**
in a process measured 3–7× slow — reversing the loop order reversed which side
looked bad, which is how it was caught. The numbers above use 1000 warm-up
iterations on both sides, at an N small enough that the pre-change build can
reach them. `spikes/columnar-wasm/bench/suite.mjs` now warms by iteration count
and reports `warmTruncated`; the other `scripts/perf-*.mjs` in this repo still
warm for 3 iterations and are suspect for anything above ~1 ms.

**Tests:** `packages/core/test/operators-unboxed.test.ts` (106). Expectations
are computed by reference implementations mirroring the _old_ boxed code, not
hard-coded. Mutation-checked: making a missing cell reset the accumulator
instead of carrying it (5 failures), inheriting `allFinite` instead of deriving
it (4), and keeping the validity bitmap when every cell is defined (1).

One thing the tests surfaced: row intake **rejects non-finite numbers**, so a
_defined_ NaN / ±Infinity cell cannot be constructed through
`new TimeSeries({ rows })` at all. It is still reachable — an operator whose own
arithmetic overflows produces one, and that column is a legitimate input to the
next operator — so those cases are tested by chaining rather than by
construction.

**Remaining under [PND-BOXFREE]:** `fill` (four strategies, and it handles
non-numeric kinds), `shift`, and `mapColumns` — the last of which takes a JS
closure per cell and so needs a different answer, not just unboxing.

### [PND-ROLLKERN] — SHIPPED (per-column sweeps + `avg` specialisation)

`tryRollingCountColumnarNumeric` already wrote typed result columns, but drove
the generic `rollingStateFor` accumulators from a **single shared sweep**: one
`states[c].add(...)` call site that saw every reducer's state shape in turn, so
it was megamorphic and uninlinable. Three virtual calls per row per column
(`add` / `remove` / `snapshot`) for O(1) arithmetic — 29 ns/row.

The window bounds depend only on the row index, `count` and the alignment,
never on the column, so the columns were sharing a sweep for no reason.
`sweepRollingColumn` now runs one column at a time: each call site is
monomorphic, and the walk is over one contiguous column rather than striding
across all of them. `avg` is additionally specialised inline.

**Measured** on the workload that motivated it — 500k 1-minute OHLCV bars
through `@pond-ts/financial`:

| query                  | before           | after            | ×             |
| ---------------------- | ---------------- | ---------------- | ------------- |
| 5-study strategy pass  | 318.30 ms        | 212.18 ms        | **1.50×**     |
| `bollinger(20)`        | 105.26 ms        | 73.66 ms         | 1.43×         |
| `zScore(20)`           | 98.77 ms         | 61.88 ms         | 1.60×         |
| `envelope(20)`         | 69.33 ms         | 45.03 ms         | 1.54×         |
| `sma(20)` / `sma(200)` | 21.48 / 21.47 ms | 15.20 / 14.49 ms | 1.41× / 1.48× |

**Why only `avg` is specialised.** It is what `sma` and the centre line of
`bollinger` / `zScore` reduce to, and its recurrence is a running sum with no
accuracy argument to preserve. `stdev` deliberately keeps its state path: its
`rollingState` implements an order-independent Welford delete with exact
`n <= 1` and `n === 1` cases chosen to avoid cancellation on near-equal large
values, and duplicating that inline to save a call would be trading a
documented numerical property for a constant factor. `min` / `max` keep their
monotonic deque for the same reason.

**Contributor semantics preserved.** The shared sweep chose between the bare
built-in state (safe only when the source is provably all-finite and fully
defined) and the `rollingStateFor` wrapper that applies the non-finite policy.
`sweepRollingColumn` keeps that choice and reproduces the wrapper's filter in
its `contributes()` predicate, so the contributor set cannot drift between the
two paths.

**Follow-up — `stdev` specialised too (SHIPPED).** It was the dominant per-row
cost in `bollinger` / `zScore` once `avg` was inlined. The Welford
order-independent delete is now transcribed **verbatim** into the sweep,
including both exact-reset branches.

| study                 | before   | after        |
| --------------------- | -------- | ------------ |
| 5-study strategy pass | 84.15 ms | **70.58 ms** |
| `zScore(20)`          | 26.49 ms | 19.88 ms     |
| `bollinger(20)`       | 31.51 ms | 25.18 ms     |

The test asserts **`Object.is`, not `toBeCloseTo`**, against the real
`rollingState()` object driven through the same window walk. That choice is
the point: a closeness test would pass for a transcription that quietly
dropped one of the recurrence's special cases, and those only misbehave on
data with large offsets that no ordinary fixture carries. Mutation-checked —
reaching `n → 1` via the reverse step instead of setting it directly fails 3
tests, the naive `n·mean − v` mean update fails 10, and dropping the `m2 < 0`
clamp fails 1.

`min` / `max` keep their monotonic deque: unlike Welford it is a data
structure rather than a recurrence, so inlining it would mean duplicating the
deque itself, and they are not on the studies' hot path.

### [PND-AGENTQ] — the true baseline, measured properly

Every ratio quoted during the optimisation session compared against a
baseline captured with `perf-agent-queries.mjs`'s original **200-iteration**
warm-up. That is below V8's optimising-tier cliff (~800 iterations for
operations this size), so the baseline was itself inflated — and because
entries run in order, inflated unevenly: whichever query ran first paid most.

The baseline was therefore re-measured on a clean worktree at the pre-session
commit (`206ef18`), with the same 1000-iteration warm-up now used everywhere.
500k 1-minute OHLCV bars, resident, per query:

| query                      | true baseline    | now            | honest ×          | (as reported during the session) |
| -------------------------- | ---------------- | -------------- | ----------------- | -------------------------------- |
| 5-study strategy pass      | 320.35 ms        | 65.25 ms       | **4.91×**         | 4.88×                            |
| `bollinger(20)`            | 108.24 ms        | 22.58 ms       | **4.79×**         | 4.66×                            |
| `zScore(20)`               | 99.59 ms         | 17.60 ms       | **5.66×**         | 5.61×                            |
| `envelope(20)`             | 69.01 ms         | 11.32 ms       | **6.09×**         | 6.12×                            |
| `sma(20)` / `sma(200)`     | 22.28 / 22.22 ms | 6.52 / 6.35 ms | **3.42× / 3.50×** | 3.29× / 3.38×                    |
| `percentChange()`          | 22.40 ms         | 3.17 ms        | **7.06×**         | 7.45×                            |
| `close.median()`           | 32.00 ms         | 2.75 ms        | **11.66×**        | 1.03×                            |
| `close.percentile(95)`     | 31.99 ms         | 2.85 ms        | **11.22×**        | 1.02×                            |
| `ema(20)`                  | 2.05 ms          | 2.06 ms        | **0.99×**         | 1.92×                            |
| `close.minMax()`           | 0.48 ms          | 0.48 ms        | **1.00×**         | 1.98×                            |
| `close.mean()` / `stdev()` | 0.47 / 2.63 ms   | 0.47 / 2.54 ms | 1.00× / 1.03×     | —                                |

**Three corrections worth keeping:**

1. **`ema` never improved.** It was reported at 1.92× at one point; it is
   0.99×. It composes on core's `smooth`, not the count-window rolling kernel,
   so none of this work touched it — which is what the structure predicted and
   the under-warmed number contradicted.
2. **`minMax` and the pure summary facts are unchanged**, as they should be —
   nothing in this session touched them. The 1.98× once quoted for `minMax`
   was noise.
3. **`median` / `percentile` are 11.2–11.7×**, not the ~1.0× the session
   baseline suggested. That baseline was captured _after_ quickselect had
   already landed, so it hid its own win.

The headline (strategy pass ~4.9×) held up. The per-query numbers moved in
both directions, and two of them were entirely artefacts.

### External reference: polars (Rust kernels)

pandas answers "how fast is what a practitioner would otherwise reach for".
**polars answers the sharper question — how fast is this work when the kernels
are Rust?** That makes it the most relevant external number this project has:
the Rust/WASM spike asked whether porting the substrate would pay, and polars
is that port, done by someone else, on the same workload.

`packages/financial/scripts/perf-vs-polars.mjs`, 500k 1-minute OHLCV bars,
polars 1.36.1. `st` = 1 thread (the per-core comparison); `mt` = 10 threads
(what polars gives a user by default). **< 1.00× means pond-ts is faster.**

| query                     | pond-ts        | polars st      | polars mt      | vs st         | vs mt         |
| ------------------------- | -------------- | -------------- | -------------- | ------------- | ------------- |
| `ema(20)`                 | 2.08 ms        | 6.33 ms        | 6.27 ms        | **0.33×**     | **0.33×**     |
| `bollinger(20)`           | 23.23 ms       | 43.16 ms       | 13.78 ms       | **0.54×**     | 1.69×         |
| `envelope(20)`            | 11.78 ms       | 16.75 ms       | 6.06 ms        | **0.70×**     | 1.94×         |
| **5-study strategy pass** | **64.32 ms**   | **77.35 ms**   | 18.95 ms       | **0.83×**     | 3.39×         |
| `zScore(20)`              | 17.83 ms       | 18.37 ms       | 13.19 ms       | **0.97×**     | 1.35×         |
| `sma(20)` / `sma(200)`    | 6.48 / 6.99 ms | 5.55 / 5.49 ms | 5.52 / 5.48 ms | 1.17× / 1.27× | 1.17× / 1.28× |
| `close.median()`          | 2.46 ms        | 1.72 ms        | 1.63 ms        | 1.43×         | 1.51×         |
| `close.percentile(95)`    | 2.44 ms        | 0.67 ms        | 0.67 ms        | 3.64×         | 3.67×         |
| `close.minMax()`          | 0.47 ms        | 0.10 ms        | 0.09 ms        | 4.85×         | 5.05×         |
| `volume.sum() + minMax()` | 0.95 ms        | 0.16 ms        | 0.15 ms        | 5.88×         | 6.30×         |
| `close.stdev()`           | 2.52 ms        | 0.31 ms        | 0.30 ms        | 8.16×         | 8.32×         |
| `percentChange()`         | 3.25 ms        | 0.36 ms        | 0.40 ms        | 8.92×         | 8.05×         |
| `close.mean()`            | 0.47 ms        | 0.05 ms        | 0.05 ms        | 8.98×         | 9.34×         |

**The result splits cleanly by shape, and the split is informative.**

**Composite studies: pond-ts is level or ahead per core.** The five-study
strategy pass — the thing agents actually run — is **0.83×**, i.e. pond-ts
beats single-threaded polars. `ema` is **0.33×**, three times faster (checked:
the warm-up gate this benchmark adds to polars' `ewm_mean` costs 0.12 ms of
its 6.17 ms, so the gap is real and not the harness).

**Whole-column reductions: polars is 4–9× ahead.** `mean` 8.98×, `stdev`
8.16×, `sum`+`minMax` 5.88×, `minMax` 4.85×. These are the simplest kernels in
the library and the largest gap — which is exactly what a SIMD, multi-
accumulator implementation buys and a scalar sequential loop does not.

**This is the same finding the WASM spike made, from the other side.** The
spike measured dense `sum` at **1.00×** against a hand-written Rust kernel and
read it as "there is nothing here". Both were doing scalar sequential
accumulation, so of course they tied. polars shows what the kernel is
_capable_ of: ~9×. The spike's conclusion was right about the language and
wrong about the ceiling — the headroom is in vectorisation and reassociation,
which [PND-KERNEL] already lists (8-accumulator `sum`/`mean`, measured
1.83–1.85×, blocked on a semantics decision because reassociation is not
bit-identical).

**Threads are the other half.** polars at 10 threads takes the strategy pass to
18.95 ms — 3.39× ahead. Nothing in pond-ts is parallel, and for a
load-once/query-many agent workload on a multi-core box that is a real
structural gap, independent of any kernel work.

**What this says about the Rust question.** It sharpens rather than settles it.
The composite path does not need Rust — it is already competitive per core.
The reduction path plausibly does, but the first ~2× there is a TypeScript
change ([PND-KERNEL] item 3) and the rest is SIMD, which WASM offers and the
spike measured at 1.00× only because it was benchmarking the wrong algorithm.

### [PND-KERNEL] item 3 — blocked summation — SHIPPED

Runs of ≥ 32 cells in `sum` / `mean` accumulate into eight independent
partial sums (`packages/core/src/reducers/blocked.ts`): **2.51×** dense,
**2.22×** through a validity bitmap, `close.mean()` **0.47 → 0.19 ms** end
to end — the polars gap on `mean` closes from 8.98× to ~3.8× with no Rust.
The semantics decision that blocked this is made and recorded in
[blocked-summation.md](../notes/blocked-summation.md): reassociation is not
bit-identical to the previous output, but it is _more_ accurate
(O((n/k)·ε + k·ε) vs O(n·ε) error growth — pinned as tests); runs below the
32-cell threshold stay sequential and bit-identical, which keeps the
exact-equality row-path parity tests meaningful. Deliberately left
sequential: the guarded `allFinite: false` path (measured 1.84×, but cold
after [PND-WCNAN]), `stdev` (a Welford recurrence, not an accumulation), and
the rolling kernel (add/remove windows — never calls these; the financial
oracle is untouched). The same pass **corrected the plan's `minMax` claim**:
the 4-lane form is _not_ bit-identical (signed-zero selection differs;
counterexample in the note) and is not taken.

### [PND-TOARROW] / [PND-ARROWNULL] — Arrow doors both ways — SHIPPED

The follow-through on the polars assessment
([polars-as-core-assessment-2026-07.md](../notes/polars-as-core-assessment-2026-07.md)):
make Arrow the interop boundary in both directions instead of adopting any
engine as a core.

**`toArrow`** (`packages/core/src/batch/operators/to-arrow.ts`,
`TimeSeries.toArrow()`): hands the live buffers over in Arrow's layout —
numerics as the `Float64Array` itself, validity bitmap as-is (LSB-first,
bit-identical to Arrow's), booleans as the packed bitmap, dict-encoded
strings as `Int32Array` indices + dictionary. Returns `{ length, fields }`,
not an Arrow `Table` — pond takes no dependency; the caller assembles with
`makeData`/`makeVector` (adapter on the method doc). Two named
non-zero-copy cases: chunked columns materialize; non-dict strings are a
plain JS array. Two-edged keys flatten to `<key>` + `<key>End`
(+ `<key>Label`), with a named error on collision rather than duplicate
Arrow field names.

**`fromArrow` null path** — a null-bearing `Float64` column now adopts
**both** buffers zero-copy: **19.3 → 1.5 ms (12.7×)** at 500k rows / 4%
nulls, faster than the dense path (which still pays a
closure-per-cell `validityFromPredicate`). Adoption declines to the old
`get()` walk (same answers — differential-tested, gates mutation-tested)
for: sliced vectors (chunk offset ≠ 0), multi-chunk, non-`Float64Array`
values, `nullCount` disagreeing with the bitmap popcount, or a **defined
non-finite cell** — that last one is the semantics gate keeping NaN-as-gap
intake uniform whether or not adoption is possible. The finiteness scan
doubles as the `allFinite` proof, so adopted columns land on the unguarded
reduction path.

Ingest-side enabler, worth knowing on its own: `ingestColumnsToStore` gained
an `adopted` channel for pre-built columns, and — a separate observable
change — **numeric columns with gaps now carry `allFinite: true`** (the
ingest predicate _is_ the finiteness proof; the flag was previously dropped
whenever a bitmap existed, costing every gapped column the fast reduction
path for the life of the series).

Round trip pinned against real `apache-arrow`:
`toArrow → Table → fromArrow` shares the original storage (values buffer by
object identity; key and bitmap by `ArrayBuffer` — arrow re-wraps views).
Deferred, none blocking: IPC-bytes convenience (`tableToIPC` is the caller's
two-liner) and a how-to showing the polars sidecar pattern end to end. (The
third deferral, `ValueSeries.toArrow`, shipped with [PND-VSIO] below.)

### [PND-VSIO] — `ValueSeries` ingest / export parity — SHIPPED

`ValueSeries` had one door in (`fromColumns`, plus the `byValue` projection)
and **none out** — no way to get rows, a wire payload, or buffers back. The
gap was visible enough that PR #564 declined to document `ValueSeries` on the
ingest page for want of anything to document. Closed here: three ingest doors
(`fromJSON`, `fromColumns`, `fromArrow`) and five export doors (`toRows`,
`toObjects`, `toJSON`, `toColumns`, `toArrow`), each ingress paired with its
inverse.

**Decisions worth keeping:**

- **Separate wire types, not widened time ones** (`schema/value-io.ts`).
  `JsonValueForKind<'value'>` resolves to `never`, so every row type built on
  the time-side helpers collapses for a value schema. Parallel types preserve
  the `SeriesSchema` / `ValueSeriesSchema` disjointness the value-axis RFC
  is built on — a time row can't reach a value door by accident.
- **`fromJSON` is the strict door; the columnar doors stay loose.** Per-cell
  kind checks (shared `assertCellKind`, so the strictness contract is one
  fact), `required` enforced, non-finite numbers **rejected**. `fromColumns` /
  `fromArrow` keep "non-finite ⇒ gap" and ignore `required`, because a decoded
  buffer cannot distinguish absent from not-a-number. Exactly the asymmetry
  `TimeSeries` already has between its row and columnar doors — matching it
  was preferred over making the two `ValueSeries` doors agree with each other.
- **No axis-name convention on `fromArrow`.** The time door defaults to a
  field named `'time'`; `{ axis }` is **required** on the value door because
  `strike` / `frequency` / `depth` / `cumDist` are all equally plausible and
  silently keying on the wrong column is worse than an error. No `timeUnit`
  either — an axis carries no unit, so the raw values are taken at face value.
- **`toColumns` emits every column kind, and the type catches the one
  asymmetry.** A `boolean` / array column can only arrive by `byValue`
  projection, and `fromColumns` can't ingest it back. Considered throwing on
  export (which would make the round trip a runtime guarantee) — rejected:
  `ValueSeries` has no `select`, so a caller with a projected boolean column
  would have no way out. Instead the precise return type is simply not
  assignable to the ingest type, so the broken round trip fails to **compile**.
- **`storeToColumns` is store-generic** (`operators/to-columns.ts`) and
  handles single-edge keys only; two-edged (`timeRange` / `interval`) keys
  throw rather than inventing a `<key>End` wire shape no door reads back.
  `TimeSeries.toColumns` is the obvious next wiring — deliberately **not**
  done here to keep this PR to its title (see PLAN.md).

**Perf** (`scripts/perf-value-series-io.mjs`, 100k rows × 7 columns, median of
7). No optimization landed: a probe of a dense-numeric fast path for
`toColumns` (copy `_values` directly instead of `read()` per cell) measured
_slower_ (3.3 ms vs 2.8 ms) — V8 already inlines the monomorphic `read`, so
the current loops are at the floor for an allocating export.

| Door                             | Median   | Note                                     |
| -------------------------------- | -------- | ---------------------------------------- |
| `fromColumns` (baseline)         | 3.7 ms   | the door the others are measured against |
| `fromJSON`, tuple rows           | 13.2 ms  | the per-cell kind check is the product   |
| `fromJSON`, object rows          | 24.2 ms  | + a property lookup per cell             |
| `toRows` / `toJSON` (tuples)     | ~11 ms   | N frozen tuples                          |
| `toObjects` / `toJSON` (objects) | ~21 ms   | N objects, C property writes each        |
| `toColumns`                      | 5–12 ms  | C arrays, **no** per-row allocation      |
| `toArrow`                        | 0.008 ms | a buffer handoff — O(C), not O(N·C)      |
