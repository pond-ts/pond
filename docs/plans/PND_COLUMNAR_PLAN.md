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

**[PND-AGGALLOC] shape.** `ReducerDef` gains a range-scoped form —
`reduceColumnRange(col, start, end)` — alongside `reduceColumn`, and
`tryAggregateColumnarStore` calls that instead of
`reduce(column.sliceByRange(start, scan))`. `reduceColumn` stays (it is the
whole-column public path and `Float64Column.sum()` etc. route through it); the
range form is the bucketed caller's door. Bit-identical by construction — the
arithmetic and the non-finite / validity policy are unchanged, only the bounds
move from a column object to two integers.

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
