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

### [PND-PARTBATCH] — Partition routing one pass per partition per chunk (DONE 2026-10-27)

**Why.** The gRPC experiment revival (2026-10-27) re-benched its aggregator
across pond-ts versions and found 0.20.0 (#175, column-native partition
routing) cut throughput ~22% at 1000 hosts x 1000 ev/s, and 15-33% overall vs
0.17. In-pond repro (`packages/core/scripts/perf-partition-rolling.mjs`): the
chunked backing was 30-37% slower than `__backing: 'array'` with a fused
rolling attached, equal with no listener. Cause: `#routeChunk` called
`part._stageRows(store, [i])` per row, so every row paid an order check, a
staging call, a re-entrancy guard, a retention pass, a one-row `'batch'` and a
settle; the staged rows were then re-validated at flush.

**What shipped.** `#routeChunk` buckets the chunk's rows per partition, then
(1) `_stageRowsOpen` per partition: order check, stage the whole slice, open
the partition's guard; (2) `_emitStagedEvent` for every row in source order;
(3) `_stageRowsClose` per partition: retention, one `'batch'`, `'evict'`,
settle, drain queued pushes (partitions close in the order of their last row in
the chunk — Layer-2 review on #838 found that closing in first-seen order sent
a partition `reduce` under `apply()` out of key order into the strict unified
buffer). All partitions' guards are open during step 2, so
a push made from a partition listener queues until that partition closes. Per-partition
scratch slots are reused chunk to chunk (fresh `indices` arrays, not
`length = 0`, which V8 runs as a slow runtime call; it was the hottest line).
The pending-tier flush runs `validateAndNormalizeColumnar` with a new internal
`trusted` option (no per-cell checks, no `Time` per key, no array re-freeze):
rows there were already validated by the source.

**Decision: source-order `'event'`, batched everything else.** Bucketed
`'event'` fan-out was rejected again for the same reason #175 rejected it
(strict `collect()` and the clock-triggered partitioned rolling need source
order). Batched `'batch'` / retention / settle makes a routed chunk look to a
partition exactly like a `pushMany` into it — the per-row behaviour was an
artefact of the routing loop, not a contract (the non-strict per-event path
still delivers one row per push, because its source fans out one event at a
time; unchanged). Error handling changed on purpose: a throwing partition
listener or an undeclared `groups` value no longer aborts routing for the
rest of the chunk; the first error is thrown after every partition is closed.
Pinned by the `[PND-PARTBATCH]` tests in
`test/live/LivePartitionedSeries.columnar-routing.test.ts` (6 of 8 fail on
the old code) and live-parity case `partition-pushmany` (only partition
`'batch'` / `'evict'` counts and the partition `reduce`'s output count differ
from the old build; every `'event'` is identical). An old-vs-new oracle over
1,500 random strict partitioned sessions (collect, fused rolling, partition
rolling, diff, per-partition events and evictions, retention variants) was
identical apart from eviction grouping.

**Numbers** (median of 4 alternating runs, noisy container; the unchanged
`array` path moved up to ±17% between runs):

| cell (+ fused rolling)     | before  | after   | auto / array before → after |
| -------------------------- | ------- | ------- | --------------------------- |
| 1000 hosts x 1 row/batch   | 1406 ms | 1145 ms | 1.47 → 1.21                 |
| 1000 hosts x 10 rows/batch | 1219 ms | 946 ms  | 1.43 → 1.09                 |
| 100 hosts x 10 rows/batch  | 1136 ms | 804 ms  | 1.55 → 0.94                 |

No listener: 10 rows/batch 25-37% faster; 1 row/batch unchanged within noise.

**Not closed:** with one row per partition per chunk the chunked path is still
~20% behind the `Event[]` path when a rolling listens. What's left is the
columnar design itself (rows are validated into columns, gathered into the
partition's staging tier, then rebuilt as transient `Event`s for listeners,
where the `Event[]` path builds one `Event` and shares it). Closing it needs
[PND-COLOUT] / [PND-LROLL]-style column-native consumers, not routing work.

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
closure per cell and so needs a different answer, not just unboxing. _(All
three done 2026-10-19 — see the second-tranche section below.)_

Measured 2026-10-19 while benchmarking pond-rs step 3a (1M rows, 2% gaps,
`crates/pond-rs/bench/rowwise_pond_ts.mjs`): `shift` 56 ms,
`fill('hold')` 52 ms, `fill('linear')` 75 ms against `diff` 8 ms. A CPU
profile puts 51–54% of each in garbage collection; the rest is the
`read(i)` loop, `float64ColumnFromArray`, and for `fill('linear')` the
boxed times array `getTimes` builds from `beginAt(i)`. A throwaway port of
`shift` to the packed path (the same ten lines as `diff`) measured
63 → 8 ms. `fill` needs more care (non-numeric kinds, edge runs, limits),
but the numeric strategies can read `values` and write `NumericOutput` the
same way.

### [PND-BOXFREE] — second tranche SHIPPED (`shift`, `fill`, `mapColumns`) — 2026-10-19

Each now has an unboxed path for **packed number columns**, beside the
untouched boxed loop that stays as the fallback (chunked storage, and for
`fill` the text / boolean / array kinds):

- **`shift`** — one typed `Float64Array`: `NaN` padding at the vacated end,
  a `subarray` copy of the source when it is `allFinite`, otherwise a loop
  that rewrites a stray `±Infinity` gap as `NaN` (the boxed round trip did
  that via `read(i)`).
- **`fill`** — `src.slice(0, n)`, the same gap walk on `v - v !== 0`
  instead of `=== undefined`, `TypedArray.fill` for `hold` / `bfill` /
  `zero` / `literal`, the identical interpolation expression for `linear`,
  then one final pass that rewrites any non-finite cell as `NaN` and derives
  `allFinite` (an unfilled gap, a `NaN` / `±Infinity` literal, or an
  overflowing interpolation all read back as missing, as before). An
  `allFinite` source returns immediately (no gap), and a column with no gap
  filled is kept by reference, as before. `getTimes` now builds a
  `Float64Array` rather than a `number[]` (both paths).
- **`mapColumns`** — reads the buffer and writes a typed output; the
  mapper still runs once per defined cell, in row order. So the closure
  cost remains (the "different answer" above is still open if anyone needs
  it), but the boxed read + boxed intermediate + rebuild are gone, and that
  turned out to be most of the time.

**Measured** (`packages/core/scripts/perf-fill-shift-map.mjs`, same data as
the pond-rs comparison: 1M rows, ~2% gaps in runs of 1–4; 40 warm-up
iterations, median of 15; each figure is one process, three processes per
build; "before" = `main` at 3851ec0, "after" = this change):

| operation (1M rows)  | before (ms)        | after (ms)         | ×                     |
| -------------------- | ------------------ | ------------------ | --------------------- |
| `shift(1)`           | 70.6 / 58.1 / 68.8 | 3.1 / 2.7 / 2.9    | 23.6×                 |
| `shift(-3)`          | 53.5 / 65.7 / 61.0 | 2.7 / 2.7 / 2.8    | 22.5×                 |
| `fill hold`          | 57.3 / 56.1 / 69.5 | 8.5 / 6.2 / 6.2    | 9.2×                  |
| `fill bfill`         | 55.5 / 56.0 / 61.6 | 7.9 / 6.1 / 5.7    | 9.2×                  |
| `fill zero`          | 58.2 / 56.3 / 58.2 | 6.9 / 6.1 / 6.1    | 9.5×                  |
| `fill linear`        | 23.3 / 22.9 / 21.7 | 12.4 / 9.7 / 9.2   | 2.4×                  |
| `fill linear` maxGap | 22.1 / 24.4 / 21.4 | 9.2 / 8.9 / 9.0    | 2.4×                  |
| `fill hold` limit 2  | 63.0 / 62.8 / 63.7 | 5.8 / 5.5 / 5.9    | 10.9×                 |
| `fill hold` (text)   | 26.1 / 26.5 / 26.6 | 30.4 / 23.8 / 26.0 | 1.0× (unchanged path) |
| `mapColumns(v*2)`    | 69.0 / 70.4 / 66.1 | 6.7 / 5.0 / 5.0    | 13.9×                 |
| `diff` (control)     | 4.6 / 8.5 / 7.4    | 5.7 / 9.0 / 6.1    | 1.2× (untouched)      |

**Why the "before" `fill linear` here (~23 ms) is not the 75 ms the pond-rs
bench reported — warm-up.** Same data generator, same `main` build. Running
the pond-rs script (`crates/pond-rs/bench/rowwise_pond_ts.mjs`, 5 warm-up
calls) on `main` here gives 78 / 66 / 79 ms; the same script with 40 warm-up
calls gives 23 / 26 ms, matching this bench. Timing each call of the old
`fill('linear')` from a cold start shows ~55–130 ms per call that, in one
run, dropped to ~22 ms from about the 25th call on, and in another had not
dropped by call 40. Old `fill('hold')` showed no such drop (~45–100 ms
throughout). So the old linear path had a slow-then-fast curve and the two
benches sampled opposite ends of it; why V8 speeds that loop up late was not
investigated. The new path has no such cliff: the pond-rs script (5 warm-ups)
on this branch gives `fill linear` 9–10 ms against 71–77 ms on `main`, and
`shift` 3.5–4.3 ms against 53–62 ms, `fill hold` 9–13 ms against 49–60 ms.
For code that calls `fill` once, the cold numbers are the realistic ones, so
the real `fill linear` gain is nearer 8× than 2.4×.

`fill linear` stays the slowest of the four strategies (~9.5 ms against
~6 ms). It is the one that also builds the times array (`getTimes`, one
`store.beginAt(i)` call per row); whether that is where the remaining time
goes was not measured — a quick hold-vs-hold-with-`maxGap` comparison was
too noisy in this container to say.

**Tests:** `packages/core/test/operators-unboxed-fill-shift-map.test.ts`.
Differential, not hand-written expectations: the same random data is built
once packed (new path) and once split across two chunks via `concatSorted`
(old boxed loop, verbatim), and every output must match cell for cell
(`Object.is`, so `-0` counts), with the same `allFinite`, the same raw `NaN`
spelling, and the same "replaced vs kept by reference" outcome. 150 random
shapes × every shift offset; × 8 fill specs × 5 limits × 5 maxGaps; × 7
mappers (incl. ones returning `NaN`, `Infinity`, a string, `undefined`),
also checking the mapper sees the same values in the same order.
Mutation-checked — each of these made the suite fail: shift not rewriting
`±Infinity` as `NaN`; shift keeping `allFinite` despite padding; `fill`
`limit` off by one; wrong trailing-gap span for `maxGap`; `fill` skipping
the final `NaN` rewrite; `fill` rebuilding an untouched column; `mapColumns`
calling the mapper on a gap; `mapColumns` keeping a non-finite result.

### [PND-FILTERTAKE] — SHIPPED 2026-10-19 (`filter` copies kept rows; dense event cache)

Found by the pond-rs R1b step 3b bench: `filter` rebuilt its whole column
store from the kept `Event` objects (`#fromTrustedEvents` →
`buildSeriesStoreFromEvents`). Two changes:

1. **`filter` copies the kept rows out of each column.** The predicate still
   gets `(event, index)`; kept row numbers go into an `Int32Array` and
   `withRowSelection` (already used by `partitionBy`) copies those rows from
   the key and every column. This alone was only ~1.5× (≈150 → ≈100 ms at
   ~50% kept, 1M rows), which is how the second cost was found.
2. **A series built from events holds them as a dense array, not a per-row
   `Map`.** Keeping event identity meant building `Map<rowIndex, Event>` with
   one entry per row — measured ~90 of the remaining ~125 ms (switching it
   off for an experiment took `filter` to ~30 ms). `SeriesStore` gained
   `_fromStoreAndAlignedEventsModulePrivate(store, events)` holding a frozen
   dense array, checked before the `Map` in `eventAt`, and returned directly by
   `toEvents()`. `buildSeriesStoreFromEvents` uses it too (copying a non-frozen
   caller array first, since the `Map` it replaces was a snapshot), so every
   `#fromTrustedEvents` caller gets it: `TimeSeries.fromEvents` on 1M events
   ≈230 → ≈73 ms.

Identity is unchanged: `filtered.at(j)` is still the source's own `Event`.
`SeriesStore` is internal (not exported), so this is not an API change; the
public `eventCache` option on `fromTrustedStore` keeps its validated `Map`.

**Measured** (`packages/core/scripts/perf-filter.mjs`, same data as the
pond-rs bench plus a text column; median of 15; three processes per build;
before = `main` at 5b5c87e, after = this change), 40 warm-up calls:

| operation (1M rows)        | before (ms)           | after (ms)         | ×    |
| -------------------------- | --------------------- | ------------------ | ---- |
| filter v > 500 (keeps 49%) | 145.6 / 155.5 / 163.9 | 30.1 / 33.9 / 32.7 | 4.8× |
| filter keep all            | 290.3 / 282.4 / 307.6 | 57.9 / 54.7 / 73.8 | 5.0× |
| filter keep 1%             | 44.0 / 40.1 / 40.0    | 11.4 / 11.2 / 11.4 | 3.5× |
| filter keep none           | 58.2 / 38.0 / 37.2    | 11.3 / 10.8 / 11.1 | 3.4× |
| … then `.events`           | 191.9 / 258.7 / 194.6 | 37.3 / 49.3 / 50.5 | 3.9× |
| … then `sum(v)`            | 169.4 / 146.5 / 134.6 | 32.8 / 35.4 / 51.3 | 4.1× |

With 5 warm-up calls the ratios are similar (3.2–5.2×, 8.3× for "then
`.events`").

**The pond-rs bench's 348–473 ms "before".** Its script (5 warm-ups) on
this container: 17 runs on the build it measured (`main` at 3851ec0, before
[PND-BOXFREE]) gave 132–175 ms in 15 runs and 294 / 312 ms in 2; with only
the filter case kept in the script, 128–160 ms. 11 runs on the later `main`
(5b5c87e) gave 121–166 ms. So that build and script _can_ read ~300 ms here,
but only rarely, and never 348–473; what made every run slow on the pond-rs
side was not found (warm-up count, data shape and build were ruled out: same
script, same data, same build). On this change the same script gives 29–32 ms.

**One storage difference, not a value difference.** A dictionary-encoded
text column keeps the source's whole dictionary after `filter`
(`StringColumn.sliceByIndices` shares it — the same as `slice` and
`partitionBy`); the old rebuild re-encoded from the kept rows, which for a few
kept rows meant plain text. Values read back the same, but `toArrow()` can now
export the column as a dictionary listing values no kept row uses. Pinned by a
test; compacting is the deferred `compactDictionary` op noted on
`sliceByIndices`.

Remaining floor: "keep none" (~11 ms) is the predicate walk over the source's
events — the `Event`-taking predicate is the cost now, and a column-reading
predicate form would be the next step if anyone needs it.

**Tests:** `packages/core/test/TimeSeries.filter-columnar.test.ts` compares
against the old path, still reachable as
`TimeSeries.fromEvents(source.events.filter(pred), …)`, over time / timeRange
/ interval keys × number / string / boolean / array columns with gaps, `-0`,
repeated timestamps and empty series, × 9 predicates (incl. truthy
non-booleans and a random one replayed on both sides); plus predicate call
order, event identity, frozen `events`, a throwing predicate, chained ops, and
the dense-store contract. Mutation-checked: wrong kept event, index off by
one, strict `=== true` truthiness, dropping the snapshot copy, unfrozen
`toEvents()` — each failed the suite.

### [PND-ROLLDIFF] — SHIPPED (rolling `difference` on two monotone deques)

Found by the pond-rs thread (R1b step 8f). Rolling `difference` kept the
window in a sorted array (`rollingSortedArray`) and spliced each row in and
out, so a row cost O(W) for a window of W rows. It now keeps two monotone
deques, one for the largest value and one for the smallest (the method
rolling `min` / `max` already use, and the one pond-rs uses), so a row costs
amortised O(1) whatever the window.

- **Same answers, `-0` included.** The sorted array answered `-0` for some
  all-zero windows: its zeros went in and out at the front of their run
  (last in, first out), and the answer was the last minus the first. Which
  zero sits where depends on the window's history, not only its contents. A
  stack of zero signs replays that exactly. Checked with `Object.is` against
  the old build on 2,400 random calls (time and count windows, every
  alignment, sequences, zeros of both signs; 2,937 of the old answers were
  `-0`), and in `test/rolling-difference.test.ts` against the old state
  driven by the same adds and removes. Mutation-checked: dropping the zero
  stack fails the tests.
- **Reorder sources keep the sorted array.** A `reorder` source with
  retention can evict any row, which a deque can't handle, so
  `rollingStateFor(..., 'sorted')` swaps in the sorted array for
  `difference` as it already does for `min` / `max` ([PND-LIVFIX]). A test
  in `livfix-reduce-reorder.test.ts` fails without the swap.
- **Plain number arrays, rare compaction.** A first version reused
  `rollingMonotoneDeque` and was slower than the old code on 1-row windows
  (~230 vs ~155 ms): an object per row, and an array copy on almost every
  row. Parallel number arrays and compacting only past 1,024 used entries
  fixed that. `min` / `max` have the same cost ([PND-DEQUEALLOC]).
- **Measured** (`scripts/perf-rolling-difference.mjs`, 1M rows one second
  apart, values as pond-rs's `perf_reducers` example, median of 3
  processes):

  | window      | before  | after  |
  | ----------- | ------- | ------ |
  | 1 s (1 row) | 150 ms  | 127 ms |
  | 5 min       | 354 ms  | 243 ms |
  | 1 h         | 557 ms  | 261 ms |
  | 1 day       | 11.25 s | 246 ms |

  The pond-rs thread reported 4.2 s (1 h) and 96 s (1 day) for the old
  code. Its own script (same rows, `fromJSON`, named output, one cold run,
  with and without `--max-old-space-size=8000`) gives 0.43–0.45 s and
  11.2–11.4 s here, and 0.17–0.22 s on the new code. Growth with the window
  reproduces; the 96 s doesn't. That run was on a busy shared container,
  which may account for it (not verified).

- Rolling over a `Sequence` turned out to scan every row for every point,
  for every reducer: already logged as [PND-ROLLGRID] (shipped, below).

### [PND-REDUCECELLS] — SHIPPED (column kernels for keep / difference / unique / top / samples)

From the Codex PR #810 investigation: these five reducers had no column
kernel, so whole-series `reduce` built every `Event` first, and `aggregate`
fed a fresh reducer state per bucket. New optional `ReducerDef.reduceCellRange
(col, start, end)` works on any column kind: packed numbers and dictionary
strings are read off their buffers (`keep` stops at the first differing
value; `difference` is a min/max scan; `top` counts runs of equal values once;
dictionary strings count codes, then decode), everything else reads cells and
calls `reduce` (`reducers/cells.ts`). `reduce` uses it; `aggregate` plans it
as a `'cells'` column; `reduce`'s fallback for any other reducer reads the
column instead of `Event`s (an `Event`'s data reads the same column).

Ranges of up to 4,096 cells (`SORT_RANGE_MAX`) sort a copy of their values
for `unique` / `top` instead of hashing: on 60-row buckets the typed sort was
4x faster than a `Set` per bucket (35 vs 133–157 ms over 1M values). Bigger
ranges keep the hash, which wins when values repeat (whole-column `unique`
on 100 distinct values: 9 ms).

Checked: 400 random series (signed zeros, gaps, 1 / 4 / 1,000 distinct
values, dictionary and plain strings, booleans, arrays, empty) give
identical JSON from `reduce` and `aggregate` against the previous build for
10 reducers on 4 columns, plus a custom reducer; a planted miscount made 105
differ. Unit test `reducer-cell-kernels.test.ts` checks every range of each
column shape against `reduce`, including a dictionary that holds one string
under two codes (public intake never builds one, so the oracle can't).

Bench `scripts/perf-reducers-cells.mjs`, 1M rows (100 distinct numbers, 4
hosts; median of 7 after 5 warm-ups, middle of 3 processes; busy machine,
±20%):

| Case                          | Before | After  |
| ----------------------------- | ------ | ------ |
| reduce v keep                 | 95 ms  | < 0.01 |
| reduce v difference           | 104 ms | 3.5 ms |
| reduce v unique               | 139 ms | 9.1 ms |
| reduce v top3                 | 124 ms | 19 ms  |
| reduce v samples              | 133 ms | 22 ms  |
| reduce host unique            | 103 ms | 8.6 ms |
| reduce host top3              | 109 ms | 14 ms  |
| aggregate 1m v keep           | 17 ms  | 6.9 ms |
| aggregate 1m v unique         | 283 ms | 156 ms |
| aggregate 1m v top3           | 303 ms | 213 ms |
| aggregate 1s v top3           | 2.99 s | 1.61 s |
| reduce, all-distinct v unique | 420 ms | 441 ms |
| reduce, all-distinct v top3   | 768 ms | 627 ms |

Not fixed here: all-distinct values (hashing a million keys is the cost,
as Codex warned; no gain), and `aggregate` with ~1 row per bucket (1s grid),
where making 1M `Interval`s and validating / copying 1M array cells for the
output column dominate — the array-column and grid PRs address those.

### [PND-ROLLGRID] — SHIPPED (two cursors for grid rolling)

`rolling(sequence, window, mapping)` filtered every row for every bucket,
O(B·N) before any reducing (100k rows, 1-minute grid, 5-minute `avg`: 7.4 s).
Bucket anchors strictly increase (a `BoundedSequence` is sorted and
non-overlapping), so each window is a run of begin-sorted rows whose two ends
only move forward. Now two cursors find each window (O(N + B)), and the result
is built as typed key/value columns, not through row intake.

**Decision: keep reducing each window afresh, not with sliding states.** The
event-driven branch uses incremental rolling states (laned sums, double-double
stdev); the grid branch always used the `aggregate` reducers (`reduce` over
the window's values). Switching to states would be O(N + B) instead of
O(N + B·W), but changes last bits (stdev on values near -1e6 moved in the
12th digit) and broke 2 pond-rs parity cases that pin these bits. So each
window is still reduced with `reduce`, reading packed number columns straight
off the buffer. Cost O(N + B·W); a 1-hour window on a 1-minute grid over 100k
rows (W = 3,600) takes 55 ms.

Checked: 5,400 random cases (time / range / interval keys, repeated times,
gaps, every alignment and sample point, narrow and wide windows, minSamples,
15 reducers on numbers plus text reducers) give byte-identical JSON against
the previous build; flipping one cursor test made 188 differ. Committed test
`TimeSeries.rolling-sequence.test.ts` checks every window by brute force.

Bench `scripts/perf-rolling-sequence.mjs` (median of 7 after 5 warm-ups,
3 processes; old build 3 runs after 1 warm-up):

| Case                                    | Before  | After  |
| --------------------------------------- | ------- | ------ |
| 100k rows, 1m grid, 5m avg              | 7.45 s  | 5.2 ms |
| 100k rows, 1m grid, 1h avg              | 8.09 s  | 55 ms  |
| 4 hosts partitioned, 1m grid, 5m avg    | 2.01 s  | 21 ms  |
| 1M rows, 1m grid, 5m avg + stdev        | not run | 158 ms |
| 100k rows, 1s grid, 1s window (W = 1)   | not run | 34 ms  |
| 10k rows 100 s apart, 1s grid (1M bkts) | not run | 430 ms |

"Not run": the old code needs O(B·N) = 10^10 or more checks there (hours).
The sparse 1M-bucket case is now mostly making 1M `Interval` objects for the
sequence and garbage collection; typed grids are part of the align /
materialize work.

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

### [PND-ARROWTYPE] — read the declared Arrow type — SHIPPED

**Source:** the user, reviewing the Arrow doors after [PND-FLATKEY]: _"if we
support fromArrow and expect a seamless path, the concern is we don't really
support it beyond float64 arrays."_ Correct, and worse than it sounded.

`fromArrow` decided what a column held from the **runtime shape** of
`vector.toArray()`. That is right for every type it supports and silently
wrong outside them, because Arrow's physical layouts do not all store one
machine word per logical value. Measured against real `apache-arrow`:

| Arrow type                    | Before                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `Float16`                     | `1.5` → **`15872`** (half-float bit pattern; length matched, nothing caught it) |
| `Decimal128` + ≥1 null        | `123.45` → **`12345`** (per-element path produced exactly `rows` values)        |
| `Decimal128` dense            | threw — but blamed a length mismatch, not the type                              |
| `Decimal128` as key, all-zero | 2 rows in, **8 rows of timestamp 0** out                                        |

The type list looked respectable; the _mechanism_ knew none of it. Every
supported type was supported by coincidence — it happened to hand back one
machine word per value — so the failure mode outside the set was not
"unsupported type" but "wrong numbers".

**Fixed by gating on the declared type** (`operators/arrow-types.ts`): an
allowlist of `Int`, `Float32`/`Float64`, `Date`, `Timestamp`, `Utf8`/
`LargeUtf8`, `Dictionary<Utf8>`, checked per field on every Arrow door
including the flattened key edges, with refusals naming the type and the cast
that would fix it.

**Decisions worth keeping:**

- **Gate, don't rewrite the reader.** The shape reading is _correct for the
  allowlisted set_ — the matrix proves it row by row. The bug was an
  unrestricted input domain, so restricting the domain fixes it without
  touching the hot path.
- **Narrow and honest over broad.** Considered descaling `Decimal` into
  float64 and supporting `Bool`; both rejected for now. A high-precision
  `Decimal` cannot round-trip through a double, so silently descaling would
  trade one wrong-number bug for a subtler one, and `Bool` needs
  [PND-COLBOOL] in the ingest engine first. Refusing by name is the honest
  version of "we support Arrow".
- **The stand-in exemption.** `ArrowTableLike` is duck-typed by design, and
  the structural fakes carry no `typeId`, so a missing `typeId` falls back to
  shape reading plus a **width check** (`toArray().length === vector.length`),
  which is what actually catches a Decimal-shaped buffer. Every real
  `apache-arrow` table carries `typeId`, so real data takes the strict path.
- **A width guard alone was not enough**, which is why the first proposed fix
  was dropped: `Float16` has one word per row, so its length matches and only
  the declared type distinguishes it from `Float64`.

**The allowlist's own failure mode, hit immediately.** The first cut refused
four types the reader had been handling correctly — `Utf8View` (the string
layout newer Arrow producers emit), `Dictionary<Float64>`, an all-`Null`
column, and `Time32`/`Time64` — caught by Layer-2 review differentially
measuring the base commit against the branch. Restored, with the value type
now decided _through_ a `Dictionary` rather than the encoding being treated as
a type of its own.

The lesson is worth more than the fix: **an allowlist must be derived from what
the code demonstrably reads, not from what its author believes the library
supports.** This one was written from a mental model of pond's semantics —
which is why it also refused `Time32` while blessing `Timestamp`, two types
with the same int-plus-unit shape. The matrix test now asserts both directions,
so refusing something readable fails as loudly as reading something unreadable.
(A related gap fixed at the same time: `TYPE_NAMES` stopped at ordinal 21, so
`Utf8View` was refused as "typeId 24" — breaking the "refused by name" contract
in the same stroke.)

No perf work: the gate is a handful of integer comparisons per **column**, once
per ingest, nowhere near a per-row path.

### [PND-FLATKEY] — the flattened key convention — SHIPPED

Two-edged keys now survive a columnar round trip. `fromColumns` reads the
flattened spelling `toArrow` has always emitted, `toColumns` emits it (where
[PND-TSCOLS] had it throw), and `fromArrow` gained `{ keyKind }` to read it
out of Arrow:

```text
timeRange  →  timeRange   timeRangeEnd
interval   →  interval    intervalEnd    intervalLabel
```

**Why this shape, settled.** The substrate stores `begin` / `end` / `labels`
as separate buffers, so flattening mirrors storage: each edge lands straight
in its buffer, O(1) per column. The two paired alternatives
(`[[begin, end], …]`, and the row-JSON `[value, start, end]` vocabulary) both
need a per-row un-zip on ingest — a row walk inside the door that exists to
avoid row walks. That, not aesthetics, is the argument.

**Naming and collisions — the part that was actually open.** `FirstColumn`
forces a key column's name to equal its kind, so the derived names are fully
determined (`timeRange` is always `timeRange` + `timeRangeEnd`); nothing to
configure, and export and ingest cannot disagree because both call
`flatKeyNames`. The envelope's `schema` keeps declaring the **logical** key,
so it round-trips as the series' own schema. Collisions reduce to one rule
with one asymmetry: a value column may not take a derived name, checked
**unconditionally on ingest** — where export (`toArrow`) only errors when the
colliding column is actually selected, because ingest has one array and two
claimants and no "not selected" escape. `KEY_END_SUFFIX` / `KEY_LABEL_SUFFIX`
moved out of `to-arrow.ts` into the shared `flat-keys.ts` so the four doors
cannot drift.

**Engine changes.** `ingestColumnsToStore` now reads a key spec rather than
one buffer: the second edge and labels are required when the kind calls for
them, sorting permutes by `(begin, end)` (matching the row path's
`compareKeys`), the ordering scan gained the same tiebreak, and interval
labels dispatch string → dict-encoded `StringColumn` / number →
`Float64Column` with the row path's "one type throughout" rule (and its
`RangeError`, for cross-door parity). The `makeKey` callback is **gone** — the
key kind fully determines the column class, so no door needs to pass one.
`TimeSeries.fromColumns` also stopped rejecting non-`time` keys, which it had
done since it shipped.

**Two defects caught in Layer-2 review**, both from the same root — the new
paths were tested with the shapes that were convenient rather than the shapes
that occur. (1) `fromArrow({ keyKind: 'interval' })` threw on any series
`aggregate` produced: those label buckets _numerically_, `toArrow` emits that
column as float64, and the engine was rejecting typed-array labels outright —
while both new Arrow interval tests happened to use string labels. The
rejection is gone (a typed array unambiguously means numeric labels, and is
now adopted zero-copy); numeric labels must be finite, which also catches the
null-becomes-NaN case the Arrow reader produces. (2) The `toColumns` collision
hole above. Both now have regression tests naming the case they missed.

**Perf** (`scripts/perf-from-columns.mjs`, 100k × 7, median of 7). The
point-key path is unchanged — the adopt path sits at ~2.05 ms before and
after, and the `number[]` dense scenario's apparent swing is first-scenario
JIT noise (re-measured 3× each side; the distributions overlap).

| Ingest (100k × 7)                          | Median  |
| ------------------------------------------ | ------- |
| `time` key, `Float64Array` (adopt)         | 2.05 ms |
| `timeRange` key, `Float64Array` edges      | 2.40 ms |
| `interval` key, numeric labels             | 3.18 ms |
| `interval` key, string labels (dict)       | 4.58 ms |
| `timeRange`, `sort: true` — `(begin, end)` | 8.90 ms |

One extra edge buffer costs ~17%; a label column costs what packing a column
costs. All linear, no surprises.

### [PND-TSCOLS] — `TimeSeries.toColumns` — SHIPPED

Wired the store-generic columnar-JSON exporter (shipped with [PND-VSIO]
below) onto `TimeSeries`, closing the one-way `fromColumns` door there too.

**The two-edged-key decision — WALKED BACK one PR later; see [PND-FLATKEY]
below.** This shipped with `toColumns` throwing on a `timeRange` / `interval`
key. The stated reason: a flattened `<key>End` / `<key>Label` spelling (and
two alternatives — an array-of-pairs key column, and reusing
`serializeJsonKey`'s row vocabulary) would be an **export-only dialect**,
since `fromColumns` builds one key buffer from one column and so reads none
of them back.

That reasoning was circular and is recorded here because the shape of the
error is worth remembering: _"no ingest door reads it back"_ is a fact about
`fromColumns`' current contract, not about the shape — and it is not a reason
to refuse the shape when the alternative on the table is **teaching
`fromColumns` to read it**. It was also applied inconsistently: `toArrow`
already emitted exactly this flattening, with no reader, and shipped. The
walk-back came from review (the user, on PR #566), not from the author.

**The TS2394 cascade, isolated at last.** Declaring the precise return type
(a key-remapped mapped type, `{ [C in S[number] as C['name']]: … }`) on
`toColumns` reproduced the cascade `TimeSeries.toJSON`'s doc had recorded as
having "defeated several time-boxed attempts to isolate": TS2394 on four
unrelated overload sets in `time-series.ts` plus four in the live layer.
Narrowed to one line by probe:

- the trigger is the **construct, not its cost** — a trivial
  `{ [C in S[number] as C['name']]: unknown }` cascades identically;
- it is the **return position on this class**, not the type's definition —
  an `interface` wrapper and a deferred `S extends unknown ? … : never`
  inside the alias both change nothing;
- an **overload declaration** (precise signature + loose implementation
  signature) makes it worse;
- a **method-level type parameter** (`toColumns<T extends S = S>()`) defers
  the instantiation past whatever resolution order trips it, and the cascade
  disappears. `T` defaults to `S`, so callers see no difference.

The workaround's one sharp edge, caught in review: an **explicit** `T` is
_unchecked_, not merely redundant. On a wide `TimeSeries<SeriesSchema>` the
`extends S` bound admits any schema, so `toColumns<Other>()` describes columns
the runtime never produces. It takes a type argument nobody has reason to
write, and the bound cannot catch it — so it is documented on the method and
pinned in `test-d/` rather than defended against.

That unblocks narrowing `toJSON` on `rowFormat` — filed as [PND-TSJSONT]
rather than done here, since it changes an existing public return type
(since shipped — see its section below).

**Perf** (`scripts/perf-to-columns.mjs`, median of 7). The headline is the
comparison, not the absolute: `toColumns` reads the columnar store directly
where `toJSON` materialises a row per event.

| Export (100k × 6, dense numeric)  | Median         |
| --------------------------------- | -------------- |
| `toColumns()`                     | 2.5–3.0 ms     |
| `toJSON()` (tuple rows)           | 25.9 ms        |
| `toJSON({ rowFormat: 'object' })` | 18.5–18.6 ms   |
| `toArrow()`                       | 0.005–0.006 ms |

Ranges are across runs and machines: the Layer-2 reviewer reproduced the whole
table independently and landed at 3.0 ms for `toColumns`, so the honest
headline is **8–10×**, not a crisp 10×. Worth keeping as a calibration note —
the first write-up quoted the single fastest run.

Two findings worth keeping: a string column costs ~3× a numeric one (dict
reads), ~10% gaps cost ~3× dense (per-cell validity), and — counter-intuitive
enough to be worth a look — **`toJSON`'s tuple rows are consistently slower
than its object rows**, which the tuple path's per-row `.map()` + spread
plausibly explains. Filed under [PND-TSJSONT].

### [PND-TSJSONT] — narrow `TimeSeries.toJSON` on `rowFormat` — SHIPPED

**Decision.** `TimeSeries.toJSON` now narrows exactly as `LiveSeries.toJSON`
does: omitted / `'array'` → `TimeSeriesJsonOutputArray<S>`, `'object'` →
`TimeSeriesJsonOutputObject<S>`, plus a third overload for a `rowFormat` only
known as `JsonRowFormat` → the union (added to `LiveSeries` too, for parity —
it previously had no signature for that call). Each overload carries the
[PND-TSCOLS] workaround, a method-level `<T extends S = S>`; with it, the
three-overload set compiles with **no** TS2394 cascade, confirming the
`toColumns` isolation also covers overload declarations once the precise
return sits behind a method type parameter. The implementation signature
returns `TimeSeriesJsonOutputArray<any> | TimeSeriesJsonOutputObject<any>`
(it must be compatible with all three). `LiveSeries.toJSON`'s cast went away.
Pinned in `test-d/timeseries-tojson-narrowing.test-d.ts`.

**The one break, deliberately taken.** The old return was
`TimeSeriesJsonInput<SeriesSchema>`. The tuple form is still assignable to
that; the **object** form is not, because `JsonObjectRowForSchema<SeriesSchema>`
demands a property for every possible key name (`time`, `timeRange`,
`interval`). A caller annotating `const j: TimeSeriesJsonInput<SeriesSchema> =
s.toJSON({ rowFormat: 'object' })` now fails to compile; the fix is
`TimeSeriesJsonInput<typeof schema>` or no annotation. Code reading
`.rows[i].someColumn` off the default (tuple) form also now fails — it was
always wrong at runtime. Neither shows up in the repo's own packages, tests, or
stories (`test/` type errors identical before/after: 175 pre-existing).

**Considered, not done.** The old [PND-TSVAR] idea of extracting a
module-level `serializeToJSON<S>` helper — unnecessary once the method type
parameter worked.

**Perf — tuple rows.** The tuple path built a throwaway `dataColumns.map(...)`
array per row and spread it into a second; now one array per row, cells
pushed in place. New durable bench `scripts/perf-to-json.mjs` (median of 9
per process; each cell below is the median of 3 fresh-process runs). The
machine was under heavy concurrent load (loadavg 9–20 on 4 cores), so
absolutes are inflated ~4× against the 25.9 ms quoted above — read the
ratios, not the milliseconds.

| `toJSON`, ms          | tuple before | tuple after | object (ref) |
| --------------------- | ------------ | ----------- | ------------ |
| dense 100k × 6        | 136          | 52          | 71–96        |
| + string col 100k × 7 | 191          | 51          | 60–152       |
| ~10% gaps 100k × 6    | 176          | 48          | 37–39        |
| wide 10k × 41         | 23.5         | 16.9        | 64–67        |
| floor 1k × 6          | 0.73         | 0.26        | 0.20–0.71    |
| interval key 1667 × 3 | 0.72         | 0.58        | 0.29–0.33    |

Tuple rows went ~2.5–3.5× faster at 100k and now sit at or below object rows
on the dense shapes, which is where the counter-intuitive gap was. Wide rows
were already tuple-favoured (41-key object literals are the slow side there)
and improved ~30%. The small interval-key case (~1.7k rows, 2 value columns) is
still tuple-slower; at that size it is dominated by per-row key serialisation
and timer noise rather than the cell loop the fix touched — not chased.

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
- **`toColumns` emits every column kind, and the two legs report the one
  asymmetry differently.** A `boolean` / array column can only arrive by
  `byValue` projection, and the ingest engine takes `number` / `string` value
  columns only. Considered throwing on export (which would make the round trip
  a runtime guarantee) — rejected: `ValueSeries` has no `select`, so a caller
  with a projected boolean column would have no way out. So it exports, and:
  - **columnar leg** — the precise return type isn't assignable to
    `ValueSeriesColumnarInput`, so the broken round trip fails to **compile**;
  - **row leg** — `ValueSeriesJsonRow` is honest about the `boolean` `toJSON`
    really emits, stays assignable, and `fromJSON` **throws at ingest**, naming
    the column and its kind.

  The Layer-2 review (PR #565) caught the PR body over-claiming a uniform
  "fails to compile" here. Making the row types `never` for those kinds was
  considered as the symmetric fix and rejected twice over: it would produce an
  unreadable `not assignable to 'never'` error at a call site where the caller
  did nothing wrong, and it would require a second set of output row types (or
  an output type that lies about what `toJSON` emits). The runtime message is
  the better diagnostic. The real fix, if a consumer ever hits this, is
  teaching `ingestColumnsToStore` `boolean` — which would also give
  `fromColumns` boolean ingest, a separate decision nobody has asked for.

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

### [PND-JOINCOL] — column-native `join` — SHIPPED

**Driver.** Tidal's friction report (2026-10-08). A one-minute view comparing
two instruments (one year of regular-session bars, ~97.5k rows a side) spent
1.3–1.6 s in a left `join` at 59 value columns a side. In the browser it was a
6.6–6.9 s main-thread task, with ~5.2 s under `join` in a dev build. Tidal
measured a consumer-side merge-walk plus gather at 77–121 ms for the same
output, cell for cell. They chose to wait for the library rather than ship
that as a stand-in (tracked on their side as `TDL-JOINCOL`).

**What changed.** `join` was the last batch transform still walking events:
it materialised both sides' events, ran `merge` per output row (an object
spread over every column) and re-columnarised. It is now `joinOp`
(`batch/operators/join.ts`):

1. One merge-walk over the two key columns yields two `Int32Array`s,
   `leftIdx` and `rightIdx`, one entry per output row; `-1` means no row on
   that side.
2. A side whose index is the identity passes its value columns through
   **by reference**, and on the left side its key column too. The test is O(1): all its rows were
   emitted and the other side emitted no one-sided rows. That always holds
   for the primary of a `left` join and the other side of a `right` join. It
   also holds for **both** sides when the keys match one for one, which is
   `joinMany` over aligned inputs.
3. Every other column is one `sliceByIndices`. The substrate's existing
   out-of-range gather contract already marks a `-1` slot missing through
   validity, for every kind and for chunked storage. No new gather primitive
   was needed.

`joinMany` chains `join`, so it got this for free.

**The semantics kept, and the ones that took care:**

- **Key order is the event walk's, restated over buffers.** `begin`, then
  `end`, then, for interval keys only, `compareIntervalValues` on the labels.
  That is `compareEventKeys` plus `Interval.compare`'s tiebreak. Intake orders
  rows by `(begin, end)` only, so labels within a tie can be unsorted. Running
  the same comparator in the same walk reproduces the old output in that case
  too.
- **Repeated keys pair one to one, not as a cross product.** Two left rows and
  three right rows on one key give two matched rows plus one right-only row.
  This was always the behaviour; it is now stated on the method and pinned.
- **A matched row carries the left key, so only the left key column is ever
  adopted.** Equal keys need not be identical. `compareIntervalValues` uses
  `localeCompare`, under which a precomposed é and a decomposed é compare
  equal, and timestamps compare by subtraction, under which `0` and `-0` are
  equal. The first version still adopted the right key column on a `right`
  join for timestamp keys. The Layer-2 review reproduced a `-0` leaking
  through that path, so the right-key pass-through was removed outright. It
  saved one ~0.2 ms gather. Tests pin both cases. The label test first missed
  the branch it was written for: with one row a side, the left-identity
  branch won first, and a mutant survived until the fixture gave each side a
  row the other lacks.
- **Mixed label types.** Numeric and string interval labels never compare
  equal, so they never match. An outer join keeping one-sided rows from both
  sides would produce a series with two label types. The old path threw a
  `RangeError` when it re-columnarised that output. `gatherLabels` now throws
  directly, and left, right and inner joins still work.

**One observable change, deliberately kept.** The old path cached the merged
events, so an unmatched row's `data()` **omitted** the other side's fields.
Events now materialise lazily from the store, as for every other column-native
operator, so those fields appear as `undefined`. `get()` and `toEqual` are
unaffected; `Object.keys` and `toStrictEqual` see the change. It is called out
in the CHANGELOG.

**The second ask, declined: a `columns` option on `join`.** Tidal also asked to
let `join` take only the columns wanted from the other side. That is already
the composition `other.select(...)`, and `select` (with `rename`, to resolve a
name collision) is zero-copy. It brings the 59-plus-2 case to 4 ms without a
new parameter. A `columns` option would duplicate a primitive, which the
Layer-1 checklist flags. The recipe is in the method doc and the website's
`join` section, and a test pins it.

**Perf** (`scripts/perf-join.mjs`). Inputs are rebuilt before every sample and
not timed, because the old path caches its inputs' events on first use.
Median of 7, Node 22, two runs:

| Scenario (~97.5k rows a side)          | Type  | Before   | After        |
| -------------------------------------- | ----- | -------- | ------------ |
| 59 value cols each side                | left  | 1,868 ms | 23.8–24.3 ms |
| 59 value cols each side                | outer | 1,844 ms | 43.6–43.7 ms |
| 59 value cols each side                | inner | 2,123 ms | 28.9–29.2 ms |
| 5 value cols each side (OHLCV)         | left  | 168 ms   | 4.2–4.4 ms   |
| 59-col primary, 2-col other            | left  | 766 ms   | 4.1–4.2 ms   |
| 1M rows, 1 col each, identical keys    | outer | 1,253 ms | 3.7–3.8 ms   |
| 500k + 500k rows, disjoint keys, 2 + 2 | outer | 755 ms   | 22.8–23.5 ms |
| `joinMany`, 4 × ~97.5k × 5 cols        | outer | 457 ms   | 15.3–20.3 ms |

Warm and repeated on the same inputs, the 59-plus-2 left join is ~1 ms. The
walk is 0.34 ms (an inlined loop is 0.23 ms) and each padded gather is
~0.3 ms. The 4 ms above is mostly fresh allocation after the forced GC.

**Measured, not taken: a fused padded gather.** A gather with `-1` slots costs
~0.32 ms per 97.5k-row numeric column, against ~0.23 ms for a dense one.
`validityGatherByIndices` makes a second pass to build the bitmap once it
finds an out-of-range index. A single-pass value-plus-validity gather measured
0.233 ms, which would save ~5 ms of the 24 ms at 59 columns. That change
belongs in `Float64Column.sliceByIndices` and would help every gather, not
only `join`, so it was left out of this PR. Take it when a gather-heavy
consumer shows up.

**Noticed in passing.** `TimeSeries.concat` still collects every input's
events and sorts them. It is the same shape of cost, but nobody has reported
friction, so no task was filed.

### [PND-NANREP] — NaN means missing: the rule, then the storage

**Decision (pre-1.0 review, 2026-10).** The public rule is now **"a `NaN` in a
number column means missing"**, everywhere — batch, live, and
`@pond-ts/process` range outputs. There is no such thing as a _defined_ `NaN`
cell. The storage is deliberately **not** changed: missing is still a cleared
validity bit, and `definedCount` still answers `count()` / `nullCount()` /
`hasMissing()` in O(1). Locking the rule first means the storage switch the
measurements argue for (bitmap 1.398 ms vs NaN-in-buffer 1.118 ms on a 1M scan
at 4% missing; 2.12 ms of bitmap↔NaN churn per `sma(20)` — numbers in PLAN.md's
[PND-NANREP] entry) becomes a **pure internal speed-up with no visible
change**, and can be taken post-1.0 as a patch. Taking the rule and the storage
together would have hidden a behaviour change inside a speed-up — the same
reason the sentinel decision above kept them apart.

**What was already true.** Intake could not produce a defined `NaN`: row intake
rejects non-finite, `fromColumns` / the Arrow doors / `withColumn`'s typed door
map `NaN` to a gap, `pctChange` maps `0/0` to missing, and `aggregate` /
`rolling` / `smooth` reject a non-finite result with a `ValidationError`. The
only source left was an operator's **own arithmetic** writing a defined `NaN`.

**What changed — the write chokepoints, not each operator:**

- `float64ColumnFromArray` — the shared sink for every boxed operator path
  (`collapse`, `fill`, `scan`, `shift`, the chunked fallbacks of
  `diff` / `cumulative`, `LiveView.column()`). `NaN` → missing. (`mapColumns`
  and `rolling` validate their results first and still **throw** on a
  non-finite value — user-callback output is treated as intake there; this
  PR does not change that.)
- `NumericOutput.set` — the unboxed `diff` / `rate` / `pctChange` /
  `cumulative` paths ([PND-BOXFREE]). `NaN` is not written.
- `Float64ColumnBuilder` — the live series-store column build. `NaN` is written
  as `undefined` would be, including an overwrite of a defined cell.
- Live `diff` / `rate` / `pctChange` and `cumulative` views — row-shaped, so
  they emit `undefined` for a `NaN` result directly.
- Live `map` (on `LiveSeries`, `LiveView`, `LiveAggregation`,
  `LiveRollingAggregation`) — the view stores the user `fn`'s `Event`s, not
  columns, so nothing canonicalised a `NaN` the fn wrote and `at(i).get()`
  returned it (found in #748 review). `makeMapView` checks the schema's number
  fields per mapped event and rebuilds the event only when one is non-finite
  (`NaN` on #748; `±Infinity` too once #756 extended the rule).
- `@pond-ts/process` `RangeOutput.set` clears on `NaN`; `sealRange` clears a
  `NaN` an op wrote straight into `values` / `bits` (it already walked every
  defined cell to derive `allFinite`, so this is free).

`Float64Column`'s constructor is the trusted door and does **not** scan; its doc
now states the obligation on a caller handing it a buffer. `ChunkedFloat64Column`
composes chunks and inherits the rule.

**Accumulators are not reset.** A `cumulative` sum that reaches `Infinity` and
then meets `-Infinity` is `NaN` from there on, so every later row reads missing.
A custom fold still receives `NaN` as `acc` and may recover; `scan` resumes as
soon as its step returns a non-`NaN` value. This is the arithmetic's honest
answer, written as a gap.

**`±Infinity` stays a defined value.** It is a real (overflowed) number, distinct
from `NaN`, and no path that previously admitted it was treated as missing, so
the rule does not cover it: `diff` of `MAX - (-MAX)` is a defined `Infinity` and
clears `allFinite`. Two pre-existing asymmetries were found and **left alone**
(out of scope; recorded so they are not rediscovered):

- `count()` routes through the `count` reducer, whose non-finite policy skips
  `±Infinity`, while `nullCount()` reads the bitmap — so on a column holding a
  defined `Infinity`, `count() + nullCount() < length`.
- A live view can carry a defined `Infinity` (e.g. `cumulative` overflow) that
  `toTimeSeries()` then rejects at row intake ("expected finite number"), and
  batch `aggregate` / `rolling` / `smooth` throw on an overflowed result where
  `diff` / `cumulative` keep it. Whether `±Infinity` should be rejected,
  stored, or mapped to missing uniformly is a separate decision.

**Perf.** One `v !== v` compare per written cell. `perf-operators-unboxed.mjs`
(200k × 4 columns) before → after, two after-runs: all ten scenarios within
run-to-run noise (e.g. `diff / dense` 4.01 → 4.22 / 4.14 ms, `diff / 4% missing`
6.95 → 6.49 / 6.29 ms, `cumulative(sum) / dense` 4.22 → 4.41 / 3.96 ms).

**Remaining:** the storage switch itself (NaN-in-buffer for packed numeric
columns, `definedCount` cached as today), now unblocked and invisible.

#### Extended to `±Infinity` — any non-finite number means missing (2026-10)

**Decision.** The rule is now **"a non-finite number in a number column means
missing"**: `NaN`, `Infinity` and `-Infinity` alike. The `±Infinity` half was
left open above as "a separate decision"; this takes it, because the status quo
was five answers to one question — row intake rejected `Infinity`;
`mapColumns` / `rolling` / `aggregate` / `smooth` threw on an overflowed
result; `diff` / `cumulative` stored it as a defined value; reducers skipped
it; `count()` skipped it while `nullCount()` did not (so `count() + nullCount()
< length`); and a live view holding one threw on `toTimeSeries()`. Treating
`Infinity` as a gap is also what makes the later NaN-in-buffer storage switch
clean: with no defined non-finite cell left, the buffer's `NaN` is the only
sentinel the storage needs.

**Write points — the same chokepoints, widened from `v !== v` to
`v - v !== 0`** (one subtract-and-compare, true exactly for `NaN` and
`±Infinity`): `float64ColumnFromArray`, `NumericOutput.set`,
`Float64ColumnBuilder`, the live `diff` / `rate` / `pctChange` / `cumulative`
views, `@pond-ts/process` `RangeOutput.set` / `sealRange` / `packColumn`.

**Operators that threw now store missing:**

- `mapColumns` — the `RangeError` is gone; `float64ColumnFromArray` drops the
  value. (This reverses the call above that a mapper result is intake: it is a
  computed write like any other.)
- `rolling` columnar fast path (`tryRollingCountColumnarNumeric`) and the
  `smooth` EMA fast path — the inline `ValidationError` became a skipped
  write.
- **Reducer results** — `finiteOrMissing` now wraps every reducer _result_,
  not just its inputs: `bucketStateFor` / `rollingStateFor` snapshots
  (built-in and custom adapters), `aggregateValues` / `applyAggregateReducer`,
  the `reduce()` `reduceColumn` fast path, and `aggregate`'s columnar
  `reduceBucket`. That one change covers the generic `rolling` sweep,
  `aggregate` (both paths), `byColumn`, `rollingByColumn`, `pivotByGroup`,
  `arrayAggregate`, `baseline`, and every live accumulator
  (`LiveAggregation`, `LiveRollingAggregation`, the fused / partitioned
  rollings, `LiveReduce`). Putting it on the reducer rather than on each
  output column is deliberate: the live accumulators emit row-shaped events,
  not columns, and `LiveReduce` is documented to agree with
  `toTimeSeries().reduce(...)` — so batch `reduce()` changes too and answers
  `undefined` for an overflowing `sum`.
- **Row-assembled operators** (`smooth` event paths, `baseline`, `align`, the
  row paths of `rolling` / `aggregate` / `pivotByGroup` / `arrayAggregate`)
  now build through `timeSeriesFromComputedRows`, which runs the same intake
  as the constructor with one switch (`nonFiniteAsMissing`) that turns a
  non-finite number cell into missing before the required / kind checks.
  User-facing row intake keeps it off.

**Doors — `Infinity` follows `NaN` at each one.** Row intake
(`new TimeSeries`, `fromJSON`, `LiveSeries.push`) and boxed `withColumn`
reject `NaN`, so they keep rejecting `±Infinity`. `fromColumns` / `fromArrow`
already read both as a gap. Typed `withColumn` (a `Float64Array`) read `NaN`
as a gap but **rejected** `±Infinity`; it now reads it as a gap too, and the
`label` parameter of `float64ColumnFromTypedArray` went with the throw.
`fromEvents` (the trust door) packs the column through the builder, so its
column reads are normalised — but `at(i)` returns the caller's own `Event`
objects verbatim, so an event-level read of a `NaN` / `±Infinity` cell is not.
That gap predates this change (it was already true of `NaN`) and was left
alone: closing it means cloning every event on the trust door.

**`allFinite` is now always `true`** on any column the library builds — every
writer above passes `true` (the per-cell non-finite branches in the writers
were removed as unreachable). The flag itself, `Float64Column`'s default of
`false` for the trusted constructor, the builder's conservative `false`, and
every guarded `reduceColumn` loop are **kept**; removing them is a separate
internal cleanup. Tests that pinned the guarded paths now build their
non-finite columns with the trusted constructor, the one door left that can.

**Sharp edges, recorded.**

- A running-window `sum` / `avg` keeps an incremental sum. Once it overflows,
  removing the large values does not bring it back (`Infinity - MAX` is still
  `Infinity`), so later windows read missing even when their true sum is
  representable. Before this change the same input threw.
- The column-level methods (`col.sum()`, `col.mean()`, …) are not wrapped and
  still return `Infinity` on an overflowing sum, while `reduce('sum')` now
  returns `undefined`.
- `@pond-ts/financial` studies carry explicit guards and comments written
  because "`withColumn` rejects `±Infinity`". The guards are now
  belt-and-braces and the comments (and one oracle case description in
  `scripts/oracle/generate.py`) are stale wording, not wrong output — left
  for a follow-up so the oracle fixture is not regenerated in this change.

**Perf.** `perf-operators-unboxed.mjs` (200k × 4 columns, median ms, two runs
each), before → after: all ten scenarios within run-to-run noise (e.g.
`diff / dense` 4.47 / 4.28 → see the commit message for the full table).

#### The storage switch — `NaN` in the buffer, no bitmap (2026-10)

**Decision ("take the faster option").** Number columns now store a missing
cell as `NaN` in their own `Float64Array` and carry **no validity bitmap**.
With the rule above in place there is no defined non-finite cell left to tell
apart from a gap, so the bitmap on number columns was pure overhead: an extra
buffer to allocate, fill, slice and check, plus 2.12 ms of bitmap↔`NaN` churn
per `sma(20)` between the studies kernel and the column. String, boolean and
array columns keep their bitmaps — they have no `NaN` to borrow.

**Shape.**

- **The marker is any non-finite value; `NaN` is the spelling every writer
  uses.** The test is `v - v !== 0` (true for `NaN` and `±Infinity`). Readers
  accept `±Infinity` as missing too, so a caller-supplied buffer that holds one
  (trusted constructor, Arrow, `fromColumns`) needs no rewrite.
- **`allFinite` changes meaning:** it now promises "no missing cells" (every
  cell finite). Producers set it only when proven — the builder from its own
  write tally, `NumericOutput.finish` / `sealRange` from their defined count,
  typed intake from one scan. A wrong `true` would let reducers skip the gap
  check and fold `NaN` into a sum, so the trusted constructor defaults to
  `false`.
- **`Float64Column(values, length, allFinite = false)`.** The `validity`
  parameter is gone, and a non-boolean third argument throws a `TypeError` so
  an old four-argument call fails loudly instead of being read as "no gaps".
- **`missingCount`** (cached getter, one scan on first ask; chunked sums its
  chunks) replaces the bitmap's `definedCount` for `count()` / `nullCount()` /
  `hasMissing()` / `avg`. The bitmap answered in O(1) because it was built at
  write time; the cached scan costs one pass once and is still faster end to end
  because nothing builds a bitmap up front (`nullCount` on a fresh column: −50%
  dense, −35% gappy).
- **`validity` survives as a lazy, cached getter** derived from the `NaN` cells,
  `undefined` when there are none — kept only for kind-generic code such as
  `toArrow`'s `nullBitmap`. Hot paths never touch it.
- **Gappy sums stay blocked.** The old `blockedSumMasked` (8 lanes through the
  bitmap) became `blockedSumFinite`: 8 lanes, each adding `v - v === 0 ? v : 0`.
  Without it the guarded sum would have fallen back to one sequential chain and
  regressed. This also takes the "block the guarded sum path" item that
  [PND-KERNEL] had left open.
- **Live ring buffer** stores number cells as `NaN` (slots `fill(NaN)`), so the
  snapshot column needs no bitmap either.
- **`fromArrow` with nulls copies.** It used to adopt both Arrow buffers (same
  bitmap layout as pond's). Writing `NaN` into Arrow's buffer would corrupt the
  caller's table, so it now does one `slice` plus a byte-wise walk of the null
  bitmap stamping `NaN`. Still a bulk path, never the per-element `get()`
  fallback; it is the one honest cost of this change. Gap-free columns are still
  adopted with no copy.
- **`@pond-ts/process`:** `RangeOutput` / `ColumnView` / `ColumnBuffers` lose
  `bits` (the worker wire no longer ships a bitmap); `ColumnBuffers` gains
  `allFinite`. `prepareRange` carries the prefix forward as one `values` copy —
  gaps travel with it, so the "warm-up gap became a defined zero" bug class the
  old bitmap mask existed to prevent cannot happen.

**Visible changes** (in CHANGELOG): `toFloat64Array()` returns `NaN` at a gap
(was whatever the buffer held, usually `0`); a column built with the trusted
constructor holding a `NaN` partition value or interval label now reads it as
missing; `fromArrow` copies a null-bearing column; process types lose `bits`.

**Perf** — `packages/core/scripts/perf-nan-missing.mjs`, 1M rows, dense vs 4%
gappy, before (bitmap) and after (`NaN`) built side by side and run
interleaved, median of three runs:

| operation (1M rows)                 | before ms | after ms | change |
| ----------------------------------- | --------: | -------: | -----: |
| fromColumns / dense                 |      8.51 |     5.82 |   -32% |
| reduce sum / dense                  |      0.71 |     0.70 |    -1% |
| reduce avg / dense                  |      0.94 |     0.71 |   -25% |
| reduce min / dense                  |      1.73 |     1.71 |    -1% |
| reduce stdev / dense                |      7.00 |     6.94 |    -1% |
| reduce p95 / dense                  |     15.08 |    14.00 |    -7% |
| diff / dense                        |      8.02 |     7.15 |   -11% |
| cumulative sum / dense              |      7.00 |     7.74 |   +11% |
| fill linear / dense                 |     13.91 |    13.06 |    -6% |
| shift 1 / dense                     |     65.84 |    57.81 |   -12% |
| rolling 20 avg / dense              |     37.57 |    32.22 |   -14% |
| nullCount (fresh column) / dense    |     12.04 |     6.07 |   -50% |
| toColumns / dense                   |     15.24 |    13.11 |   -14% |
| fromColumns / gappy 4%              |     16.13 |     4.89 |   -70% |
| reduce sum / gappy 4%               |      3.19 |     1.97 |   -38% |
| reduce avg / gappy 4%               |      2.67 |     1.66 |   -38% |
| reduce min / gappy 4%               |      3.72 |     2.61 |   -30% |
| reduce stdev / gappy 4%             |      6.61 |     6.64 |    +0% |
| reduce p95 / gappy 4%               |     11.66 |    11.97 |    +3% |
| diff / gappy 4%                     |      6.95 |     5.70 |   -18% |
| cumulative sum / gappy 4%           |      7.20 |     5.99 |   -17% |
| fill linear / gappy 4%              |     84.99 |    84.13 |    -1% |
| shift 1 / gappy 4%                  |     66.64 |    57.09 |   -14% |
| rolling 20 avg / gappy 4%           |     16.08 |    14.68 |    -9% |
| nullCount (fresh column) / gappy 4% |     11.05 |     7.19 |   -35% |
| toColumns / gappy 4%                |     63.98 |    59.77 |    -7% |

The one regression above noise is dense `cumulative` (+11%): the old loop
short-circuited on "no bitmap" while the new one does a subtract-and-compare
per cell. It could take an `allFinite` fast path; not done here because 0.7 ms
on 1M rows did not seem worth the extra branch. Run-to-run noise on this
machine is ±20–30% on the sub-10 ms rows, which is why the table is interleaved
medians. `packages/financial/scripts/perf-agent-queries.mjs` (500k bars): the
5-study stack 81.0 → 70.0 ms, `percentile(95)` 6.8 → 4.6 ms, typed ingest of
6 columns 9.8 → 7.2 ms; everything else within noise.

---

### Per-row `Event` leftovers — [PND-HOOKSIGNAL] / [PND-SPANFILTER] / [PND-ROWSOUT] / [PND-GROUPEVENTS]

Logged 2026-10-31 from Peter's list of methods that build one `Event` per
row when they could work on columns. Three groups:

1. **Forced by the method's promise** (they hand the caller an `Event`):
   `at`, `first`, `last`, `atOrBefore`, `atOrAfter`, `nearest`, iteration,
   `toArray`, `.events`, live `'event'` listeners. Cost is per row read, not
   per row stored. Stays as is.
2. **Leftovers that could work on columns**: `concat` ([PND-CONCATSORT],
   owned by the Codex-speedups work), `toJSON`/`toRows`/`toObjects`/
   `toPoints` ([PND-ROWSOUT]), the key-only selectors
   ([PND-SPANFILTER]), `groupBy`/`pivotByGroup` ([PND-GROUPEVENTS]).
   Already logged elsewhere: [PND-ALIGNHOLD], [PND-DEDUPEMAP],
   [PND-SMOOTHSLOW], [PND-ARRAYSLOW].
3. **Live layer**: built-in operators listen for `'event'`
   ([PND-COLOUT]); the React hooks do too, only as a change signal
   ([PND-HOOKSIGNAL]).

Rules for every PR in this set: output and behaviour stay exactly as now
(including `Event` identity where it holds today, e.g. `after(t).at(0) ===
series.at(k)`), each PR carries before/after timings, and Peter OKs each
merge. pond-rs mirrors pond-ts output, so any change visible in output is
flagged to the pond-rs side.

Baseline (2026-10-31, 1M rows, `time`/`cpu`/`host` with 8 hosts, fresh
series per run, median of 5): `toColumns` 190 ms; `toJSON` 1,523 ms;
`toRows` 2,238 ms; `toObjects` 1,352 ms; `toPoints` 1,446 ms; `slice` 1 ms;
`before` 1,239 ms; `after` 1,236 ms; `tail('100s')` 1,079 ms; `within`
1,174 ms; `overlapping` 1,490 ms; `containedBy` 1,189 ms; `groupBy` 2,446
ms; `pivotByGroup` 3,320 ms. Most of each key-only selector's time is
building the `Event`s, which the series then caches, so a second call on
the same series is cheaper.

Live hook baseline (200k rows into a `maxEvents: 10_000` buffer, column
backing, median of 7):

| batch | no listener | `'event'` | `'event'` + `'evict'` |
| ----: | ----------: | --------: | --------------------: |
|     1 |      458 ms |    488 ms |                610 ms |
|    10 |      102 ms |    183 ms |                230 ms |
|   100 |       37 ms |     77 ms |                141 ms |
|  1000 |       25 ms |     64 ms |                126 ms |

**[PND-HOOKSIGNAL] shipped** : `LiveSeries[ON_SIGNAL]('event' |
'evict', fn)` (registered symbol `pond-ts:onSignal`, internal, not exported)
fires `fn` with no argument once per push in which the channel delivered
rows, at the point of the channel's last call: for `'event'` after the rows
are stored and before retention (on both backings and on the partition
staging path, in `_stageRowsClose`), for `'evict'` where `'evict'` fires
(retention, `_sweepAge`, `clear()`). The hooks use it when the source offers
it and fall back to `on()` otherwise. Why the same moment matters: with
`throttle: 0`, `useSnapshot` / `useLatest` read the series inside the
callback, so a later point (after retention) would change what they show.
Sharp edge kept, not fixed: because `'event'` fires before retention,
`useSnapshot(live, { throttle: 0 })` can show more rows than `maxEvents`
(maxEvents 2, push 3 rows: the snapshot has 3, the series 2). `useEventRate`
is unchanged: its `window()` view stores `Event`s, so its listener on the
view costs nothing measurable (138 vs 125–146 ms, noise). After, same bench
(two runs):

| batch | no listener |  signal | signal + evict | `'event'` + `'evict'` |
| ----: | ----------: | ------: | -------------: | --------------------: |
|     1 |  402–449 ms | 410–427 |        422–467 |               545–601 |
|    10 |  101–107 ms | 106–115 |        105–112 |               211–236 |
|   100 |    31–36 ms |   32–36 |          36–40 |               130–136 |
|  1000 |       24 ms |   20–25 |          25–36 |               108–142 |

## Moved from PLAN.md — 2026-09-23 cleanup

PLAN.md holds future work only, so these write-ups of shipped (or partly
shipped) tasks were moved here **verbatim** when it was cleaned up on
2026-09-23. Where a PLAN.md entry remains, it now carries only what is still
open; the text below is the entry as it read before the cleanup.

### [PND-KERNEL] — as it read in PLAN.md

- **[PND-KERNEL]** — Kernel algorithm wins surfaced by the Rust/WASM spike
  (`spikes/columnar-wasm/`, report + benchmarks committed). The spike says
  **not now, not in this order** on porting the substrate (revised from an
  earlier "no-go" — see REPORT.md §9: a Rust core is worth 1.3–4.3× on the
  numeric kernel, and 2.2–2.6× end to end on the reduce family, but the
  TypeScript work below is 5–10× larger and comes first). The control
  experiment isolated four wins that are pure algorithm and land in
  TypeScript. Two have shipped:
  - **Quickselect for `reducePercentileColumn`** — measured 12.9× on
    `median`/`p95` at 1M rows.
  - **Blocked (8-accumulator) `sum`/`mean`** — 2.51× dense, 2.22× through a
    validity bitmap, **`close.mean()` 0.47 ms → 0.19 ms** end to end. The
    semantics decision this was blocked on is made and recorded in
    [blocked-summation.md](docs/notes/blocked-summation.md): reassociate
    above a 32-cell threshold, leave shorter runs bit-identical. Worth
    noting the direction — blocked summation is _more_ accurate than
    sequential (error grows as O((n/k)·ε + k·ε) rather than O(n·ε)), so the
    trade was speed **and** precision against reproducibility of the exact
    previous bits, not speed against accuracy.

  Remaining: a branchless finite guard for `allFinite: false` reductions,
  and blocking the guarded sum path (measured **1.84×**, deliberately not
  taken — after [PND-WCNAN] almost nothing lands there; see the note).

  **Correction: the 4-lane `Float64Column.minMax` is _not_ bit-identical**,
  as this entry previously claimed. `+0` and `-0` compare equal, so
  `lo <= x ? lo : x` keeps whichever the traversal reached first, and
  lane-parallel traversal reaches a different one — verified: 16 cells, all
  `1` except `values[1] = +0` and `values[4] = -0`, sequential gives `+0`
  and 4-lane gives `-0` (`===` equal, `Object.is` not — and vitest's `toBe`
  uses `Object.is`). `minMax` explicitly commits to matching
  `[col.min(), col.max()]` (PR #153), so the lane form would break that
  commitment on `±0` input for 1.27–1.50× on an operation already costing
  0.49 ms. Not worth it as scoped; if it is ever wanted, it needs a signed
  zero fixup in the combine, not a straight lane split.

  Acceptance benchmarks already exist in
  `spikes/columnar-wasm/bench/controls.mjs`; each control is checked against
  pond-ts's answer before it is timed.
