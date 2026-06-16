# Live-series columnar — state assessment (2026-06-16, against v0.27.0)

Consultant assessment requested after the batch columnar wave closed
(v0.25–v0.27). Question: **is the _live_ columnar story "complete enough"
the way the batch one now is?** Short answer: no, and that is the correct
state — but for a reason worth stating precisely, because the two halves are
not symmetric and shouldn't be held to the same bar.

This note is the live-side companion to
[`columnar-arc-assessment-2026-06.md`](columnar-arc-assessment-2026-06.md)
(the batch arc, against v0.20.0). Code anchors are against v0.27.0.

## The asymmetry, stated plainly

**Batch went columnar end-to-end because every step paid for itself
analytically** (numeric reduce 59–73×, pipeline tax recovered, cold-aggregate
cliff removed). The wave is now complete through the whole pipeline:
intake → transforms (`select`/`rename`/`cumulative`/`diff`/`rate`/`fill`/
`slice`/`mapColumns`/`shift`/`collapse`) → reduce/aggregate fast paths →
**rolling output** (#225, v0.26.0) → **`byColumn`** value-axis (#227, v0.27.0).
There is no row-shaped middle left in the batch path that a consumer has
flagged.

**Live went columnar only where a _consumer's measured pain_ proved it pays.**
That is the friction-driven discipline working as designed — but it means
"live columnar" is a set of earned interventions at the retention boundary,
not an end-to-end rewrite. The distinction that confuses every reading of the
roadmap:

- **Batch "3C" = rolling _output_ path** → SHIPPED (#225). No event
  materialization on output, no row re-pack.
- **Live "Step 3 Phase C" = rolling _reducer_ columnar state** (per-reducer
  `rollingColumn` to cut the live GC line) → DEFERRED, unearned.

Same "3C" label, different layers. The batch one is done; the live one is
explicitly waiting for a workload that pushes near ceiling.

## What is columnar in the live layer today (shipped, earned)

1. **Chunked columnar live buffer** — `ChunkedColumnarLiveStorage`
   (`live/live-chunked-storage.ts:134`). Default backing for **top-level,
   `strict`-ordered, time-keyed** `LiveSeries` (election at
   `live/live-series.ts:292-320`). Zero per-row `Event` allocation on the data
   path; Events are materialized **transiently** only when `'event'`/`'batch'`
   listeners exist (`live-series.ts:587-590`) and discarded after dispatch.
   Delivered (gRPC V6): minor-GC max pause −74%, ingest→fanout p99 −78%.
   It is a **churn/latency fix**, not the heap fix it was first billed as —
   the V6 re-bench corrected that framing honestly.

2. **Column-native partition routing** — `#routeChunk` reads the partition
   column directly (`col.read(i)`, `live-partitioned-series.ts:1084-1099`) and
   stages indices, not Events, into per-partition chunked storage with a
   coalescing tier (one packed chunk per ~256 rows). **MERGED as #175,
   2026-06-03.** This was the _genuine_ partition-retention OOM fix: gRPC V8
   cut ColumnarStore 1.58M→94k, Event retention 6.77M→37,891 (−99.4%), heap
   −13.5%, throughput +24%. The originating live problem — gRPC partition OOM —
   **is solved.**

3. **`LiveView.column(name)`** — experimental public numeric column read
   (`live-view.ts:706`), gathers from the current event window
   (`gatherColumnFromEvents`). Shipped v0.19.0, numeric-only, also on
   `LiveColumnGroup` for partitions. This is the live half of the chart-feed
   column API.

## What is NOT columnar / parked (and the measurement that parked it)

- **Step 7 — `LiveSeries` columnar ring buffer.** ❌ **ATTEMPTED, WALKED BACK
  (2026-05-29).** Durable finding, not a TODO: the rolling pipeline subscribes
  to `'event'`, so the consumer needs `Event` objects regardless of backing.
  The ring then decomposes events back into columns (strictly _more_ work),
  and "don't retain events" showed no heap win (36 MB vs 28 MB, ingest 9.4×
  slower). A columnar _buffer_ cannot avoid the allocation when the consumer
  needs events — only a columnar _reducer_ can. Branch
  `feat/step-7-ring-storage`, not merged. The storage-strategy refactor that
  preceded it (PR #168) was kept; the ring backing was reverted.

- **Live Step 3 Phase C — columnar rolling reducer state.** DEFERRED. The only
  lever that would actually cut the live GC line (per-reducer columnar state
  machines), but a large change, and production target is 100k/s while V5/V8
  sit at 2.1–2.5× headroom. Earns its slot when a workload pushes near ceiling.

- **§A column-native output.** The next item, now _unblocked_ by Phase 2 but
  not started. The remaining dominant allocation slice is emit-side: ~11.7 MB/s
  transient at the OOM cell (Events + row-objects for `'batch'` listeners). §A
  forks the payload behind an additive listener name. Spike plan exists
  (`docs/briefs/column-native-output-spike.md`); the API gate (a new listener
  surface) is the reason it waits for a committed consumer.

- **§B columnar reorder.** Unearned. RFC-only
  (`docs/rfcs/columnar-live-protocol.md` — append-only main store + sorted
  "late corral" + grace-flush compaction).

- **Non-strict / non-time-keyed backing.** `reorder`, `drop`, interval/
  timeRange keys all fall back to `EventArrayLiveStorage` (`live-storage.ts:162`,
  row-oriented). Deliberate: those modes need sorted mid-stream insertion the
  chunked append-only backing can't represent.

## The one live loose end worth closing on its own merits

**`LiveReduce` over an `ordering: 'reorder'` source _with retention_ returns
stale/`undefined` snapshots for the windowed reducers** (`min`/`max`/`first`/
`last`/`samples`). Still live in code: their rolling state (monotone deque /
head-removal ordered entries, `reducers/rolling.ts:14-64`) removes by
_arrival index_ (`entries[head]?.index === index`), which assumes eviction
drops the oldest-_arrived_ event. True for `strict`/`drop`/chunked
(append-only); false for `reorder` retention, which evicts the sorted-prefix —
possibly a later arrival. Value-based reducers (`avg`/`count`/`sum`/`stdev`/
`median`/`percentile`/`unique`) remove by _value_ (`rollingSortedArray`,
`rolling.ts:66-94`) and stay correct.

- **Severity:** narrow (one ordering mode × five reducers × retention on), but
  it's a **wrong-answer** bug, not a perf gap. Documented in `LiveReduce`
  JSDoc (`live-reduce.ts:106-119`), pinned by a value-based test, workaround is
  `live.toTimeSeries().reduce(...)`.
- **Pre-existing:** true on `main` before the chunked work; the PR #170 FIFO
  change merely swapped one wrong answer for another and was reverted to
  identity-primary.
- **Fix when earned:** give `min`/`max` a removal-by-value structure (sorted
  array, as `median` already uses) selected _only_ for reorder sources —
  keeping the O(1) monotone deque on the append-only hot path. Self-contained,
  ~reducer-local, does not need the §B corral architecture.

This is the one item I'd argue for closing independent of consumer friction,
because it's correctness, not optimization — it belongs with the
live-robustness cluster (#98/#99/#114), not with the gated §A/§B/live-3C work.

## Verdict

The columnar story is **complete on the batch side** and at a **defensible,
measurement-earned waypoint on the live side** — with the originating live
problem (gRPC retention OOM) **solved** by the chunked backing + column-native
partition routing. What remains live is genuinely friction-gated optimization
(§A output, live-3C reducer, §B reorder) plus one narrow correctness loose end
(reorder+retention windowed extrema) that should travel with the robustness
cluster, not the optimization queue.

"Complete enough for our columnar story" is a fair claim to make today, with
that one-line honest caveat: the live side is complete _at the retention
boundary that motivated it_, and intentionally unfinished above that boundary
until a consumer earns the next step.
