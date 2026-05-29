# Column-native live pipeline (design brief)

**Status:** Draft, 2026-05-29. **Awaiting design review before implementation.**
**Author:** pond-ts library agent (Claude).
**Supersedes:** the Step 7 ring-buffer approach
([brief](step-7-live-series-ring-buffer.md), walked back — see its §13).
**Motivation:** the gRPC aggregator OOMs at high partition count.

## TL;DR

`LiveSeries` retains a window of `Event` objects. At high partition
count that retained set is the dominant heap consumer and the
aggregator dies with OOM. Replace the per-`LiveSeries` retained
storage with a **chunked columnar buffer** — each `pushMany` batch is
validated directly into typed-array columns (no per-row `Event`) and
appended as a chunk; retention drops/slices chunks off the front.

Measured (spike, `scripts/investigate-batch.mjs`, batched ingest
300k/1k-batch/50k-window):

|                                 | array-events (today) | chunked-columnar | win      |
| ------------------------------- | -------------------- | ---------------- | -------- |
| ingest                          | 48.2 ms              | 12.9 ms          | **3.7×** |
| consume (windowed reduce)       | 0.106 ms             | 0.052 ms         | **2×**   |
| **retained heap** (200k window) | **31.5 MB**          | **6.9 MB**       | **4.6×** |

The 4.6× retained-heap cut is the headline — it's the OOM fix. It
compounds across partitions: V5 measured 92k/s × 1k hosts at
**1857 MB**; a 4.6× cut targets ~400-600 MB.

## Why this wins where the Step 7 ring lost

The Step 7 ring buffer was **9× slower** on this exact workload. The
difference is one thing: **whether an `Event` is ever created.**

- **Step 7 ring:** `create Event` (for the `'event'` listener) →
  _decompose_ it into ring columns. Paid for Events AND columns.
- **This design:** rows → `validateAndNormalizeColumnar` → typed-array
  columns, **directly**. No `Event` created on the columnar path.
  Consumers that read columns never touch an `Event`.

The 9× loss was the Event tax stacked on the columnar tax. Remove the
`Event` from the path and columnar wins on all three axes. The
corollary: **the win only exists if the consume side is columnar
too** — see §3 (the load-bearing condition).

## 1. Where the retained heap goes today

`LiveSeries` (array backing) holds `EventForSchema<S>[]` — one `Event`
(+ `Time` key + frozen data dict) per retained row. For a window of W
rows that's ~31 MB at W=200k (measured), tenured (survives GC,
old-gen). With `partitionBy('host')` over P hosts, it's P × that. The
retained `Event[]` is what OOMs the aggregator, not transient churn.

A chunked columnar buffer holds the same W rows as typed-array columns
(~7 MB at W=200k) and retains **zero `Event` objects**. That's the
4.6× cut.

## 2. The design — chunked columnar live buffer

A new `LiveStorage` backing (slots into the PR-2a strategy layer that
already shipped, #168):

```
ChunkedColumnarLiveStorage
  #chunks: ColumnarStore<S>[]    // each = one validated pushMany batch
  #chunkOffsets: number[]         // prefix sum of chunk lengths (for at(i) bisect)
  #total: number                  // sum of chunk lengths
  #eventCache: Map<number, Event> // lazy at(i) materialization, remapped on evict
```

- **append (pushMany):** `validateAndNormalizeColumnar(batch)` →
  `ColumnarStore` → push as a chunk. No per-row `Event`. (Reuses the
  Step 2c intake path verbatim.)
- **retention:** drop whole chunks off the front while the oldest is
  fully out of window; slice the boundary chunk for exact `maxEvents`
  (see §4 Q1). O(chunks), no per-row work, no copy on whole-chunk
  drops.
- **at(i):** bisect `#chunkOffsets` → (chunk, localIndex) → read the
  row's columns → materialize + cache an `Event`. Same lazy-cache +
  evict-remap shape the Step 7 ring used (and the same care required —
  see §5 risks).
- **snapshot / toTimeSeries:** `concatSorted(#chunks)` (the chunks are
  temporally disjoint + sorted — exactly what `concatSorted` from step
  1g was built for) → wrap as `TimeSeries`. Or materialize. Likely
  much cheaper than today's row-rebuild.

## 3. The load-bearing condition: column-native consume

The retained-heap win (Phase 1) holds **even with Event-based
consumers**, because the consumer extracts values and discards the
`Event` — it's the _buffer_ that retains Events today, not the
consumer. So a chunked buffer cuts the retained set regardless of how
consumers read.

But the _throughput / GC-rate_ win (the V5 22% GC) requires the
consume side to go columnar too: the `'event'` listener fires per row
and forces a transient `Event` materialization per push. Those are
young-gen (collected fast) so they don't OOM — but they're the 22% GC
_rate_. Removing them needs the rolling reducer to consume columns
(= Step 3C). Hence the phasing:

## 4. Phasing

### Feed granularity — the OOM is the BATCHED source deque (resolved 2026-05-29)

The gRPC agent confirmed the OOM driver is the **source `LiveSeries`
deque** ("~3.8 GB in the source deque alone… not the rolling state or
snapshot history, which have separate ~12k-row rings"). The source
deque is the **top-level `live`** fed by **batched** `pushMany(wireBatch)`.
Two consequences:

1. **No coalescing needed.** The OOM-prone structure is batched at
   ingest (high throughput goes hand-in-hand with chunking; per-event
   gRPC delivery would bottleneck before reaching pond). Chunked
   one-chunk-per-`pushMany` targets it directly. The earlier
   single-push-proliferation worry is moot for the OOM path.
2. **Partition sub-series are NOT the primary OOM driver.** They're
   fed per-event by `#routeEvent` (`_pushTrustedEvents([event])`), so
   chunking them naively would make 1-row chunks — but they're not
   where the memory dies, so **Phase 1 keeps partition sub-series
   array-backed** (gated by an internal backing flag). Chunking
   partitions later uses **(B) batched routing** — `LivePartitionedSeries`
   groups a source `pushMany`'s events by partition and feeds each
   partition one batch — chosen over storage-level coalescing because
   (a) it keeps the storage simple, (b) it's a per-event-routing-
   overhead win, and (c) the source-deque fix doesn't depend on it.
   Deferred follow-on, validated by the gRPC heap profile (which will
   show whether per-partition chunk sizes warrant it).

### Phase 1 — chunked columnar buffer for the top-level source deque (the OOM fix)

`ChunkedColumnarLiveStorage` selected for **top-level** strict/drop +
time/timeRange series; `pushMany` validates each batch into one chunk
(column-native intake, no per-row `Event`). Partition sub-series stay
array-backed (not the OOM driver). Retained heap on the source deque
drops ~4.6×. The `'event'` listener still fires (Events materialized
transiently — young-gen, GC'd; compat path). `at(i)` lazy-materializes

- caches.

* **Bench gate:** in-pond `perf-live-columnar.mjs` (batched pushMany,
  chunked vs array source — ingest/consume/heap) confirms the spike's
  win survives integration; then gRPC re-bench at the OOM cells with
  the heap profile as the before-number.
* **Public API:** zero new surface. Retention preserved (Q1). The
  `'event'` / `at(i)` / `toTimeSeries` contracts hold.

### Phase 2 — columnar rolling reducer (= Step 3C, the GC-rate win)

The rolling reducer gains an `ingestBatch(columnarChunk)` path that
walks the value column instead of per-event `Event`s. Removes the
transient per-row `Event` allocation on fan-out → cuts the 22% GC
rate → throughput win. Builds on Phase 1's chunked buffer. Bigger,
per-reducer work (Welford / monotonic-deque expressed columnar).

- **Bench gate:** gRPC V6 ceiling re-bench. Target: the
  `LivePartitionedFusedRolling.ingest` self-time + GC % both drop.

## 5. Hard design questions (need decisions before Phase 1 code)

### Q1 — retention exactness (the one public-behavior risk) — ✅ RESOLVED: exact slicing

Batch-granular retention would make `live.length ≥ maxEvents` (window
= "last K full chunks"), a behavior change. **Decision: preserve exact
retention** by slicing the boundary chunk — drop whole chunks that are
fully out, then replace the boundary chunk with `store.sliceByRange(...)`
(zero-copy subarray on Float64 columns). Exact at the row level for
both `maxEvents` (`length === maxEvents`) and `maxAge` (drop chunks
whose newest row < cutoff, slice the boundary chunk at the cutoff).

**Confirmed by the gRPC agent (2026-05-29):** the experiment uses
`maxAge`, and its `live.on('evict')` listener increments `eventsEvicted`

- tracks `firstEventTs` for the dashboard's `window_age_seconds`
  warmup readout, plus a conservation check (`emitted ≈ ingested +
throws + rejected + evicted`). Batch-granular eviction would delay
  both by up to a chunk's worth of events and fuzz the conservation
  check. Zero-copy boundary slicing avoids that — one chunk-header
  tweak per eviction, in the noise.

### Q2 — the `'event'` listener compat path

`'event'` must keep firing per row (LiveAggregation/View/Reduce
subscribe to it). Phase 1 materializes a transient `Event` per pushed
row for the fan-out. Recommendation: accept the transient
materialization in Phase 1 (it's young-gen, doesn't OOM); Phase 2's
columnar consume removes it for substrate-aware consumers. **Optional
optimization:** skip materialization when `#onEvent.size === 0` (the
gRPC partition-router case uses `_pushTrustedEvents`, not `'event'`).

### Q3 — lazy `at(i)` cache + eviction remap

Same shape as the Step 7 ring (materialize on demand, cache, remap on
evict). This is the part that bit Step 7 (the LiveReduce identity
issue). **Mitigation:** LiveReduce already moved to FIFO-position
eviction on the ring branch — that fix is identity-independent and
should be carried forward (it's strictly more robust). Re-audit every
`'evict'` consumer for identity assumptions (only LiveReduce had one).

### Q4 — `reorder` ordering mode — ✅ RESOLVED: OOM is on `strict`

A chunked append-only buffer can't sorted-insert mid-stream (same
constraint as the ring), so `reorder` keeps the `EventArrayLiveStorage`
backing (the strategy layer routes by mode); chunked columnar serves
`strict`/`drop`.

**Confirmed by the gRPC agent (2026-05-29) — documented at commit
granularity, not memory:** every OOM in the aggregator's history was
on default `ordering: 'strict'` (the `ORDERING` env option was added
in `324e0fe`, _after_ all three OOM-driving retention commits
`3f985a2` `'6m'` → `dfc4eeb` `'90s'` "OOM at moderate" → `dd3aeb5`
`'30s'` "OOM at firehose"). The driver is explicit in
`aggregator/src/index.ts:42-48`: **~6.3M events × ~600 bytes ≈ 3.8 GB
in the source `LiveSeries` deque alone**, past V8's 4 GB ceiling —
the source deque, not rolling state or snapshot history (those have
separate ~12k-row rings). **Phase 1's chunked buffer targets exactly
that structure on exactly the ordering mode that OOMs.**

**Deferred follow-up:** `reorder` at firehose is _untested_ (M4's
drift harness ran ~2400 events total). Whether `reorder`-firehose
OOMs differently — and thus needs the indexed-columnar path (Step 7
brief §11) — is an open question, NOT a known different failure. It
does not gate Phase 1.

### Q5 — interval-keyed series

Same as Step 7: chunked columnar handles time/timeRange; interval
keeps the array backing initially. Low priority.

## 6. Public API consequences

- **Phase 1:** zero new surface, retention/`event`/`at`/`toTimeSeries`
  contracts preserved (Q1 exactness). Internal storage swap behind the
  PR-2a strategy layer.
- **Phase 2:** the rolling reducer's `ingestBatch` is internal; the
  per-reducer columnar contract (`rollingColumn`-style) is the design
  question — internal hook vs public extension surface. Defer to
  Phase 2.

## 7. Estimated shape

- **Phase 1:** ~600-900 LOC (`ChunkedColumnarLiveStorage` + intake
  wiring + lazy cache + boundary-slice retention + conformance
  additions to the shared suite + invariant pins). One PR.
- **Phase 2:** larger, per-reducer columnar state. Multiple PRs.

Each step: Layer 2 + Codex review, **human merge approval** per the
wave standing rule. Bench in the commit message; gRPC re-bench is the
gate.

## 8. Sequencing note — measure the OOM workload first

The Step 7 lesson: don't build before confirming the measurement
targets the real problem. **Before Phase 1 code, confirm the OOM is
(a) on the `strict`/`drop` path the chunked buffer serves, and (b)
driven by retained `Event[]`, not a leak elsewhere.** The gRPC
experiment's heap profile at the OOM cell is the prerequisite — if it
confirms retained-Event-dominated heap on a chunked-eligible ordering
mode, Phase 1 proceeds with a clear target.

## 9. Status

**Design review complete (2026-05-29). Both gating questions resolved
by the gRPC agent with documented evidence:** Q1 → exact boundary
slicing; Q4 → OOM is on `strict` firehose, driven by the source
`LiveSeries` deque's retained `Event[]` (~3.8 GB), which is exactly
what Phase 1's chunked buffer replaces. `reorder`-firehose is a
deferred follow-up, not a Phase 1 gate.

**Phase 1 cleared to start.** Bench "before" number: the gRPC agent
captures a heap profile at the historical OOM cell (90s/firehose,
strict — Event count + retained size) to anchor the Phase 1 PR's
before/after. Build proceeds in parallel; the two converge at the PR
bench. Human merge approval per the wave standing rule.

## Cross-references

- [`step-7-live-series-ring-buffer.md`](step-7-live-series-ring-buffer.md)
  — the walked-back ring approach; §11 (storage strategy), §13 (NO-GO).
- [`PLAN.md` Phase 4.7 "Next wave"](../../PLAN.md#next-wave-grpc-re-bench--substrate-adoption-queued-2026-05-28).
- Spike benches: `scripts/investigate-ring.mjs`,
  `scripts/investigate-batch.mjs` (on branch `feat/step-7-ring-storage`).
- `validateAndNormalizeColumnar` (Step 2c), `concatSorted` +
  `ChunkedColumn` (step 1g) — the substrate this assembles.
