# RFC: Hybrid columnar core

**Status:** **adopted as Phase 4.7; shipped in v0.18.0 (2026-05-30).** The
substrate, the column-native intake, the reducer fast-path, and the public
column API all landed in v0.18.0.

> **Historical-framing note (added 2026-05-30):** This RFC originally framed
> the columnar substrate as the **"v1.0 substrate."** That target has been
> dropped — pond-ts is staying pre-1.0 while the API moves into its right
> shape. The substrate shipped as a normal pre-1.0 minor (v0.18.0), not a 1.0
> commitment. Read the "v1.0" language throughout this document as
> May-2026 historical context, not a release target.

**Relationship to PLAN.md:** Adopted as Phase 4.7 — see
[`PLAN.md`](../../PLAN.md). The previous "row-oriented core stays" deferred-
design entry has been walked back; the columnar substrate is the Phase 4.7
direction. LiveSeries row-oriented behavior is preserved at the public API
boundary under the invariants section below.

**Evidence base:** [`docs/briefs/core-columnar-store-spike.md`](../briefs/core-columnar-store-spike.md).
Implementation prototype on branch `codex/core-columnar-store-spike`
(PR #130, not for merge — spike code stays on the branch as the
Phase 3 implementation baseline).

**Authorship:** developed across multiple contributors. Each section below
carries inline attribution; this list is the index for cold readers.

| Section                                                    | Contributor                                           |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| Original draft (thesis + evidence + open questions)        | Codex, 2026-05-11                                     |
| Library-agent response and adoption                        | pond-ts library agent (Claude) + pjm17971, 2026-05-11 |
| Use-case agent feedback (gRPC experiment)                  | gRPC experiment agent (Claude), 2026-05-13            |
| V2 amendment (library response to gRPC feedback)           | pond-ts library agent (Claude) + pjm17971, 2026-05-13 |
| Bottom-up investigation pass (5 fresh agents)              | 5 investigation agents, 2026-05-13                    |
| V3 amendment (library response to investigation synthesis) | pond-ts library agent (Claude) + pjm17971, 2026-05-13 |
| Codex review pass on V3 + framework design                 | Codex, 2026-05-13                                     |
| V4 amendment (library response to Codex review)            | pond-ts library agent (Claude) + pjm17971, 2026-05-13 |

## Original draft: Codex, 2026-05-11

### Thesis

Hybrid B is now credible enough to design seriously:

> columnar internals + row/Event API outside.

The spike does not justify merging a columnar refactor directly. It does
justify treating columnar internals as a v1.0 RFC candidate, with explicit
gates for transforms, strings, aggregates, and live pipelines.

The core idea is not to make pond look like Arrow, DuckDB, or Polars at the
public API. The public API remains event-shaped. Columnar storage is an
internal representation for the places where row-object allocation is the
problem.

### Evidence Summary

| Area                          |                                                                         Result | Read                                                        |
| ----------------------------- | -----------------------------------------------------------------------------: | ----------------------------------------------------------- |
| Numeric `TimeSeries.reduce()` |                                                                   6-12x faster | Clears runtime gate for numeric scans.                      |
| Lazy immutable storage        | 1M dense rows: ~35 MB lazy vs ~145 MB row input; forcing `events` adds ~179 MB | Clears memory gate for constructor-built read-heavy series. |
| Point access refinement       |                            `at(0)` + `last()` adds effectively 0 MB at 1M rows | Casual row access no longer collapses lazy storage.         |
| Chart extraction              |                         `toPoints()` ~177-204 ms vs typed chart buffer ~0-6 ms | Confirms chart RFC direction.                               |
| Numeric live rolling          |            200k append-only: 84.98 ms / 13.2 MB; evicting: 169.86 ms / 10.1 MB | Credible live numeric ring-buffer slice.                    |
| String reducers               |                                       `unique(host)` neutral to slightly worse | Does not clear a broad reducer migration gate.              |
| `aggregate()`                 |                                    Prototype span-planned numeric path can win | Ceiling evidence only; runtime path stays event-backed.     |
| Derived transform chains      |                                                               Not yet measured | Next gate.                                                  |

### Proposed Direction

1. Keep public `Event`/row APIs stable.
2. Store immutable constructor-built `TimeSeries` data in internal columnar
   buffers.
3. Treat row APIs as compatibility boundaries:
   `events`, `toArray`, `rows`, `toRows`, `toObjects`, and `toPoints` may
   materialize row objects.
4. Keep cheap point access lazy:
   `at(i)`, `first()`, `last()`, `length`, and iteration should avoid forcing
   the full `events` array.
5. Let chart adapters consume typed buffers directly.
6. Move live rolling first, not all of `LiveSeries`: numeric rolling windows
   can use typed ring buffers while listener APIs remain event-shaped.
7. Promote transforms only when they either share buffers or avoid row
   materialization.

### API Invariants

The RFC should treat the following as public compatibility constraints:

- `series.events === series.events` remains true after first access.
- Repeated `series.at(i)` calls return the same event instance.
- If `at(i)` materializes an event before `events`, then `series.events[i]`
  reuses that same instance.
- `TimeSeries.concat(...)` currently preserves source event identity.
- `for (const event of series)` remains event-oriented, even if internally it
  materializes incrementally.

These invariants are useful to users, but they also constrain how far derived
store construction can go. The eventual RFC decision needs to say whether
concat identity remains a hard guarantee or becomes a documented compatibility
cost.

### Internal Shape

The spike's internal shape aligns with Arrow without taking an Arrow runtime
dependency:

- numeric columns: `Float64Array` values plus optional validity
- boolean columns: `Uint8Array` values plus optional validity
- string columns: dictionary plus integer indices plus optional validity
- array columns: fallback references for now
- time keys: begin/end timestamp arrays, plus interval labels when needed
- chart buffers: typed x values, typed y columns, and validity masks

This shape should remain metadata-compatible with future Arrow export/import,
but Arrow should not be required for the core hot path unless interop demand
appears.

### Live Shape

The live story should stay narrower than the immutable story.

For `LiveSeries`, columnar everywhere is not yet justified. The proved pain is
rolling-window memory and event throughput, so the first live target is:

- numeric typed ring buffers for hot rolling windows
- built-in reducers only: `sum`, `avg`, `count`, `min`, `max`
- existing generic path for strings, arrays, custom reducers, `samples`,
  `unique`, percentile/top reducers, and mixed schemas
- listener surfaces remain event-shaped

Future `LiveChange` work from the streaming RFC may be the right batch/channel
for broader live columnar updates. This RFC should not force today's
`on('event')` API through typed-array batches prematurely.

### Non-Goals

- Do not expose Arrow as a required public dependency.
- Do not rewrite every reducer in the first landing.
- Do not migrate runtime `aggregate()` until a fused bucket planner exists.
- Do not make every transform columnar in one sweep.
- Do not break event-shaped public APIs for performance alone.
- Do not merge the spike branch as production architecture.

### Open Design Questions

1. **String and dictionary reducers.**
   What is the shared abstraction for `unique`, `top`, `samples`, and grouped
   `count` over dictionary-encoded columns? If every string-aware reducer needs
   a bespoke rewrite, the migration cost expands sharply.

2. **Derived transform chains.**
   Can `select().rename().filter().diff().fill().rolling()` preserve the
   columnar win, or do transforms repeatedly compact/materialize row data?

3. **Concat identity.**
   Is source-event identity preservation worth keeping as a hard invariant, or
   should a v1.0 storage refactor document a narrower guarantee?

4. **Private fields vs sidecar caches.**
   The spike uses WeakMap sidecars to avoid disruptive class surgery. A real
   implementation should likely move storage/cache state into private fields.

5. **Aggregate planner.**
   What is the minimal fused planner that can precompute bucket spans once,
   support grouped/string cases honestly, and avoid N reducer scans per bucket?

### Next Gate: Phase 3 Derived Stores

The next investigation should not add more one-off fast paths to the spike. It
should answer whether wins survive real operator chains.

Suggested scope:

- `select` / `rename`: share buffers by reference.
- `filter`: keep an index selection first; compact only when worthwhile.
- `diff`: produce a new numeric buffer from neighboring values.
- `fill`: produce a new buffer plus validity policy.
- Benchmark a representative pipeline such as `diff().fill().rolling()`.

Decision gate:

- Continue only if at least one realistic transform chain preserves a clear
  runtime or memory win without broad public semantic changes.
- Stop or narrow the RFC if transform chains repeatedly force row
  materialization or eager full-buffer copies.

### Likely Landing Strategy

If Phase 3 clears:

1. Land documentation and benchmark harnesses first.
2. Land an internal storage abstraction in a small PR.
3. Move immutable numeric read paths.
4. Move chart extraction.
5. Move live numeric rolling.
6. Revisit aggregate planner.
7. Revisit string/dictionary reducers.

If Phase 3 does not clear, keep the chart-side columnar decision and live
rolling numeric fast path as independent wins, and defer broader Hybrid B.

---

## Library-agent response and adoption (pjm17971 + Claude, 2026-05-11)

> _Adopting the RFC's direction as the v1.0 substrate. Phase 3 transform-chain
> evidence is treated as part of the implementation, not as a prerequisite
> gate — the strategic frame below is what makes that an acceptable risk._

### Strategic frame

The spike's evidence cleared two of the three gates the library agent
flagged in the PR #130 review (numeric reduce 6-12× faster, Phase 2 lazy
materialization 4× memory reduction). The remaining gates — derived
transform chains (Phase 3), string/dictionary reducers, and live
feasibility beyond numeric rolling — are real unknowns. The decision to
commit anyway rests on two observations:

**1. When columnar wins, it wins big; when it doesn't, parity is
achievable.** From the spike: numeric reduce and chart extraction are
order-of-magnitude wins (6×, 34×). `unique(host)` is neutral. The
asymmetry matters — there's no measured case where columnar is
materially worse than the current event-backed path, only cases where
it ties. That means a carefully-built framework can route hot paths
through columnar internals while preserving event-backed behavior for
operations where the layout doesn't help.

**2. Now is the right time, before streaming-RFC milestones B/C/D
land.** The gRPC experiment has effectively run to the end — friction
signals around memory pressure and per-event allocation cost are
stable. The streaming RFC's `LiveChange` model (milestone A) is about
to define the internal change-stream shape that B/C/D consume. If
columnar substrate lands first, `LiveChange` carries columnar-batch
updates natively; if streaming milestones land first on row-oriented
internals, every later columnar push reshapes the streaming model.
Build the foundation before the features it serves.

The friction-driven cadence the project values argues against
speculative refactors. The columnar substrate isn't speculative — the
gRPC experiment surfaced memory pressure as a recurring constraint
(maxAge tuning, partition retention, deque allocation under firehose),
and the spike measures direct wins on the same shape. The friction
signal is in hand; the substrate is the structural response.

### Commitments

This RFC is the v1.0 substrate. Locked-in decisions:

1. **Columnar storage adopted broadly across pond-ts internals.** Not
   just chart-side, not just `TimeSeries` reduce, not just live
   numeric rolling. The framework underpins `TimeSeries`, derived
   series construction, `LiveSeries` ring buffers, the streaming
   change channel, and the chart `ChartDataSource`. Public APIs
   (Event, `series.at(i)`, `live.on('event', ...)`, etc.) stay
   row-oriented at the boundary.

2. **The columnar framework is a foundational layer**, not a series
   of one-off fast paths. Built as `packages/core/src/columnar/` (or
   a similar internal module), independently tested, with its own
   bench suite. Apache Arrow-compatible concepts (validity bitmaps,
   dictionary encoding, chunked columns) without an Arrow runtime
   dependency. Designed so future optimization doors stay open:
   WASM kernels for reducers, WebGPU for very large scans, SIMD via
   wasm-simd, zero-copy Arrow export — none committed for v1.0, all
   reachable from the framework's interfaces.

3. **Public API invariants are preserved** (the five from this RFC):
   `series.events === series.events`, `at(i)` reference stability,
   `at(i)` ↔ `events` consistency, `TimeSeries.concat` event
   identity, event-shaped iteration. The concat-identity question
   (RFC open question #3) is decided **in favor of preserving the
   guarantee** for events the source has materialized — under
   today's eager-events shape every event is materialized, so the
   guarantee is universal in practice. Under columnar, the per-index
   cache propagates through concat. **`series.at(i)` reference
   stability is the contractual stable-reference accessor; no new
   public API.** See V4 amendment for the tightened contract.

4. **Phase 3 (derived transform chains) is part of the
   implementation, not a prerequisite gate.** The expected Phase 3
   work — shared-buffer `select` / `rename`, index-selection
   `filter`, zero-copy `slice` / `head` / `tail` — is sketched in
   the original RFC and aligns with how Apache Arrow / DuckDB
   handle derived columns. The risk: if Phase 3 surfaces a
   deal-breaker (e.g., transform chains force eager compaction
   that erases the win), implementation adjusts mid-stream. Worst
   case: the columnar framework ships with a narrower scope
   (numeric scans + chart extraction + live numeric rolling) and
   row-backed paths stay for transform chains. Not a deal-breaker;
   the substrate still pays back.

5. **String / dictionary reducer work (RFC open question #1) is
   part of the v1.0 wave.** `unique`, `top`, `samples`, grouped
   `count` over dictionary-encoded columns get reducer-side
   adaptation. Not optional — typical workloads have string-heavy
   columns and the v1.0 wave is the right slot to do this work
   alongside the substrate.

6. **`LiveSeries` columnar ring buffer is part of v1.0**, scoped
   narrowly per the RFC: numeric typed ring buffers for hot
   rolling windows + built-in reducers. Strings, custom reducers,
   array columns, mixed schemas stay on the event-backed path
   inside the framework. The framework's job is to make this
   routing transparent at the public API.

7. **Aggregate planner (RFC open question #5) ships with the
   substrate.** Minimal fused planner: precompute bucket spans
   once, answer simple reducers from prefix sums/counts, fall
   back to event-walked path for custom functions / grouped-string
   reducers / non-decomposable operations. Stretch goal: the
   planner becomes the foundation for v1.x query-rewriter work.

8. **Sidecar shape is for the spike only.** Real implementation
   uses private fields on `TimeSeries` / `LiveSeries`, not
   WeakMap-keyed-by-instance caches. The spike's WeakMap shape is
   an exploration artifact, not the production design (RFC open
   question #4 — resolved here in favor of private fields).

### Sequencing relative to other waves

- **Phase 4.5 milestone A (LiveChange) ships independently** — it's
  foundational, small, and doesn't depend on columnar. The
  `LiveChange` discriminated union can carry columnar-batch updates
  once the substrate exists; milestone A's internal API is designed
  to make that retrofit clean.
- **Phase 4.5 milestones B, C, D wait for columnar substrate.** They
  ship natively on top, with operator state in columnar buffers
  (rolling deques, fused windows, sync rolling chunks all become
  typed-array-backed). Specifically: milestone B's late repair is
  much cheaper with columnar incremental-state machinery; milestone
  C's `AggregateEmission` ships JSON-safe values on top of columnar
  reducer outputs; milestone D's `keyBy` uses per-key typed buffers.
- **`@pond-ts/charts` v1 stays on its current path.** The chart
  RFC's `ChartDataSource` typed-array primitives align with what
  the framework provides; v1 charts can share primitives with core
  via the framework's public-internal boundary. No chart-RFC
  rewrite needed.
- **v0.x continues with bug fixes and the partitionBy-ordering-
  inheritance fix that just landed.** No streaming features
  shipping in v0.x; the wave is paused to focus on the substrate.

### Implementation scope (rough)

Substantial. Estimated 3–4 months of focused work plus another
1–2 months for the streaming milestones to ship on top. The work
is sequenced internally:

1. **Framework layer (~6 weeks).** Internal `Column<T>` interfaces,
   `Float64Column` / `BooleanColumn` / `DictionaryColumn` /
   `ArrayColumn` (fallback) concrete implementations, validity
   bitmaps, chunked columns, range-aware primitives (`reduceRange`,
   `slice`, `append`, `evict`). Independently tested with its own
   bench suite. Bundle-size pin: `<25 KB` gzipped delta to pond-ts
   core.
2. **TimeSeries integration (~3 weeks).** Private-field columnar
   store on `TimeSeries`, lazy event materialization, `events` /
   `at(i)` / iteration / `toRows` / `toPoints` API invariants
   preserved. Tests pin all five invariants.
3. **Numeric reducer adaptation (~2 weeks).** `sum` / `avg` /
   `count` / `min` / `max` / `stdev` / `median` / percentile family
   route through columnar primitives. Custom function reducers
   stay event-backed.
4. **Derived transforms (~3 weeks).** `select` / `rename` /
   `filter` / `slice` / `head` / `tail` / `diff` / `rate` /
   `pctChange` / `cumulative` / `shift` columnar paths.
5. **Aggregate planner (~2 weeks).** Minimal fused planner;
   numeric paths through it, custom / grouped-string fall back.
6. **String / dictionary reducer adaptation (~2 weeks).**
   `unique` / `top` / `samples` / grouped `count` over dictionary-
   encoded columns. The shared abstraction the RFC's open question
   #1 names.
7. **LiveSeries numeric ring buffer (~2 weeks).** Hot rolling
   windows, built-in reducers, listener API preserved.
8. **Chart-extraction alignment (~1 week).** Internal `toChartBuffer`
   shared with `@pond-ts/charts` framework.

Each step lands as its own PR with the standard two-pass review
(Layer 2 + Codex). The framework layer (step 1) is the most
load-bearing; reviewing it well matters more than ticking the
whole sequence off quickly.

### What stays out of v1.0 scope

- WASM reducer kernels — framework designed to accept them; not
  committed
- WebGPU large-scan paths — same
- SIMD-via-wasm — same
- Arrow JS dependency or zero-copy Arrow export — framework is
  Arrow-compatible at the concept level; full interop deferred
- Streaming-RFC milestones B/C/D — separate wave on top of substrate
- Anything pushing past the public API invariants — deliberately
  preserved

### Cross-references

- [`docs/briefs/core-columnar-store-spike.md`](../briefs/core-columnar-store-spike.md)
  — the spike brief with measured numbers per phase.
- [PR #130](https://github.com/pjm17971/pond-ts/pull/130) — the spike
  implementation. **Not for merge.** Stays on branch
  `codex/core-columnar-store-spike` as the implementation baseline
  for the v1.0 work.
- [`docs/rfcs/streaming.md`](streaming.md) — the streaming RFC.
  Sequencing addendum below explains how milestone A and the columnar
  substrate interact.
- [`docs/rfcs/charts.md`](charts.md) — the chart RFC. Alignment
  note: v1 charts share columnar primitives with core via the
  framework's public-internal boundary.
- [`PLAN.md`](../../PLAN.md) Phase 4.7 — the binding work entry.

---

## Use-case agent feedback: gRPC experiment (Claude), 2026-05-13

> _Posted as a comment on PR #131 during the adoption review. Reproduced
> verbatim below; library response in the V2 amendment that follows._

Adopting columnar internals as the v1.0 substrate is the right call. The
friction signal really is in hand — M3's memory pressure was the dominant
blocker at firehose (the aggregator's retention history is
`6m → 90s → 30s`, each step dodging an OOM as rate climbed; the comment
block in `aggregator/src/index.ts` records that lineage). PR #14's V3
profile pinned `new Event(...)` + `#validateRow` at ~7% self-time at
saturation; 0.14's `_pushTrustedEvents` closed that for the partition-
router hop but the per-event tuple-build at gRPC ingest is still there.
The spike's measured 6–12× numeric reduce + 4× memory cut are the
structural answer. Building this before streaming milestones B/C/D lock
the `LiveChange` shape on row-oriented internals is exactly the right
sequencing.

Three implementation-detail concerns from the experiment side, plus one
minor framing nit:

**1. `live.on('batch', cb)` semantics on columnar internals.** The RFC
promises "listener surfaces remain event-shaped" — that means `batch`
callbacks still receive `ReadonlyArray<EventForSchema<S>>`, which means
events get materialized on the path from columnar storage out to the
listener. The aggregator's `fanout.ts`, `recordIngest`/`recordFanout`
latency pairing, and `recordLatenessOnIngest` all hang off `on('batch')`.
If event materialization happens per batch, the per-event allocation
cost the substrate is meant to remove comes back at the listener
boundary. Worth pinning explicitly in the framework-layer PR: does
columnar storage carry through to the batch-listener path (with a
typed-buffer alternative API for performance-sensitive consumers), or
does it just shift the cost from the buffer side to the listener side?

**2. Reorder-mode + typed-array ring buffers (live).** Pond's
reorder-mode `#insert` does a binary-search `splice(lo, 0, event)`. On
a `Float64Array` ring buffer that becomes an O(N) memmove per late
event. The RFC's live story scopes columnar narrowly (numeric rolling
windows, built-in reducers) which mostly sidesteps the question — but
the M4 friction note's premise is that users will combine `'reorder'`
with the rolling pipelines. If reorder-mode `LiveSeries` falls back to
event-backed entirely, that's fine and should be documented. If it
shares the typed-array path, the insertion-cost story under late
workloads deserves a measured callout.

**3. A `pushColumns(...)` intake API.** The experiment's `ingest.ts`
builds row tuples per event from gRPC events:
`[new Date(event.timeMs), event.cpu, event.requests, event.host]`. If
columnar internals can accept typed-column batches directly
(`pushColumns({ time: Float64Array, cpu: Float64Array, requests: Float64Array, host: string[] })`),
the producer's protobuf decode could skip the row-tuple intermediate
entirely — and the 70k/s wire ceiling I just measured (53% conservation
drift, traced to the gRPC stream's per-message overhead, not pond)
suddenly has a different ceiling. Not committing v1.0 to it, but the
substrate makes it reachable; worth flagging as a v1.x optimization
door so the framework's intake interface is designed not to foreclose
it.

**Minor framing**: "the gRPC experiment has effectively run to the end"
is directionally right (M3, M3.5, M4 all landed) but isn't quite
accurate — M4 failure modes and the M5 RFC sweep (the explicit final
phase) are still queued. The experiment will stay on v0.x during the
substrate work, which the RFC already commits to. No conflict.

**Invariants check from the experiment's side**: `live.stats()`
semantics (the conservation-check basis for M4), `pushMany(rows)`
accepting tuple arrays, `live.on('batch'/'event'/'evict')`, and the
partitionBy ordering inheritance (M4 headline finding, just landed in
0.17.1) are all preserved by the API invariants section. The
conservation check
`producer.emitted ≈ pond.stats().ingested + pondInsertThrowsTotal + pond.stats().rejected`
survives the substrate work as long as `live.stats()` stays scalar —
which the RFC keeps as a public API. ✓

**Net position**: endorse adoption. The three concerns above are scope
questions, not blockers; they probably already have answers in the
library agent's head and just need to surface in the RFC text or the
framework-layer PR docstring. The batch-listener question (#1) is the
one most likely to bite the experiment's `fanout.ts` if it lands with
materialization on the listener side — worth answering before the
framework PR lands so the experiment knows where it sits on the
listener-side allocation budget.

---

## V2 amendment (library response to gRPC feedback), 2026-05-13

> _pjm17971 + pond-ts library agent (Claude). Pins the three concerns
> from the gRPC agent's feedback as explicit RFC commitments rather
> than open questions, plus a small framing correction._

The gRPC agent's endorsement is the second confirming signal (after
Codex's evidence) that adoption is the right call. The three concerns
each have a defensible answer; pinning them here so they land in the
framework-layer PR as commitments, not surprises.

### 1. Batch-listener semantics: lazy per-event materialization, with a parallel typed-buffer accessor

**Commitment.** `live.on('batch', cb)` continues to receive
`ReadonlyArray<EventForSchema<S>>`. Event instances in the batch are
**lazy projections** over the columnar storage, materialized on first
field access (`event.get('cpu')`) per-field rather than per-event.
Listeners that only care about counts (`recordIngest`,
`recordFanout`'s arrival-time pairing) pay no per-event allocation;
listeners that read field values pay one typed-array lookup per
field read, no allocation per event.

For perf-critical consumers who want zero per-event cost regardless,
a parallel typed-buffer API ships alongside:

```ts
live.on('batchColumns', (batch: ChartBuffer | ColumnarBatch<S>) => {
  // batch.x: Float64Array of timestamps for the batch
  // batch.yByColumn: Map<string, Float64Array> per column
  // batch.validityByColumn: Map<string, Uint8Array>
  // No per-event allocations; consumer reads typed arrays directly.
});
```

The shape is the same one the chart RFC's `ChartDataSource` already
proposes — `ColumnarBatch<S>` is the framework's internal type
projected through the listener. Consumers like the aggregator's
`fanout.ts` who want raw throughput can opt in; consumers who want
the ergonomic event-shaped API stay on `'batch'`.

Cost model:

- `'event'` listener: lazy event projection per fire, same as today's
  Event from a row's perspective. No new cost.
- `'batch'` listener, counts only: zero per-event allocation. Pure
  win.
- `'batch'` listener, reading fields: one typed-array lookup per
  field read. Cheaper than current property-access-by-string on a
  payload object.
- `'batchColumns'` listener: zero per-event allocation, zero per-
  field allocation. Maximum perf for consumers willing to write
  typed-array-aware code.

This resolves the gRPC agent's concern about "shifting the cost from
buffer side to listener side." The default path is genuinely
cheaper than today; the opt-in path is dramatically cheaper.

### 2. Reorder-mode + typed-array ring buffers: reorder-mode LiveSeries stays event-backed

**Commitment.** `LiveSeries` instances configured with
`ordering: 'reorder'` **stay on the event-backed path**. The
columnar ring buffer is for the append-only happy path only.
Reorder-mode operates on the existing `Event[]` representation with
binary-search insert + `splice`, exactly as today. Same for partition
sub-series inheriting `'reorder'` from the source under the v0.17.1
partitionBy fix.

The trade-off is honest: reorder-mode pays current per-event
allocation costs; append-only mode gets the columnar win. Most
production telemetry workloads are append-only (the gRPC experiment's
M4 measurement was specifically constructed to exercise reorder
mode under load and didn't find it dominant). Users who need reorder
semantics + columnar performance can either:

- Pre-sort events upstream and ingest under `'strict'` /
  `'append-only'` (the path of least surprise)
- Defer to streaming RFC milestone B's late-repair semantics, which
  handles reorder via a different mechanism (capability-based
  incremental repair on the rolling state)

Documented in the framework's `LiveSeries` JSDoc explicitly.

### 3. `pushColumns(...)` intake API: not in v1.0, framework intake interface preserves the door

**Commitment.** `live.pushColumns({ time, cpu, requests, host })` is
**not in v1.0 scope**, but the framework's column intake interface
is designed so it can land as a v1.x feature without breaking the
v1.0 API. Specifically:

- The columnar store's internal `appendBatch(...)` method accepts a
  typed-column batch as its native shape; the existing
  `pushMany(rows)` path internally calls `appendBatch` after
  validating + transposing the row array
- A future `pushColumns(...)` public method delegates to
  `appendBatch` directly, skipping the row-array intermediate

The gRPC agent's 70k/s wire ceiling traceback (53% conservation
drift from per-message overhead) is exactly the workload where
`pushColumns` pays back: the producer's protobuf decode populates
typed columns directly from the wire, the aggregator's intake
skips the row-tuple build, and the substrate writes typed arrays
to typed arrays end-to-end.

Flagged in the v1.x optimization door section of the RFC; framework
PR will include the `appendBatch` internal interface so v1.x can
expose it publicly without a substrate refactor.

### 4. Framing correction

"The gRPC experiment has effectively run to the end" was too strong.
The accurate framing: M3 / M3.5 / M4 have all landed; the M5 RFC
sweep is queued; the experiment stays on v0.x during the substrate
work. The strategic timing argument doesn't depend on the experiment
being done — only on the friction signals being stable and the
substrate not being retrofittable later. Both still hold.

### Net effect on the RFC

The three concerns become **commitments in the implementation plan**,
not open questions. The framework-layer PR JSDoc will document:

- The lazy-projection event API on batch listeners (and the
  `'batchColumns'` opt-in alternative)
- The reorder-mode-stays-event-backed scoping
- The `appendBatch` internal interface as the v1.x `pushColumns`
  door

The Phase 4.7 implementation sequence in PLAN.md absorbs these
without changing the timeline — they're details of the framework
layer (step 1) and the LiveSeries numeric ring buffer (step 7),
not new work items.

The endorsement holds. The work proceeds.

---

## Bottom-up investigation pass (5 fresh agents), 2026-05-13

> _After the V2 amendment landed, five fresh agents — each given a
> minimal brief and one scope of pond-ts's operator surface — were
> tasked with answering "if you HAD to convert your scope to columnar,
> what would happen?" The agents worked independently with no awareness
> of each other and were deliberately excluded from reading the RFC
> itself, to keep their reading bottom-up from the code rather than
> downstream from the RFC's design conclusions._

The five scopes:

- **Storage + access core** — `TimeSeries` construction, public Event API, lazy materialization, the five public-API invariants
- **Aggregation family** — `reduce` / `aggregate` / `rolling` / `baseline` / `outliers` + all live variants + the reducer registry
- **Transforms** — `select` / `rename` / `collapse` / `map` / `filter` / `diff` / `rate` / `pctChange` / `cumulative` / `shift` / `fill` / `smooth` + live counterparts
- **Reshape + multi-series** — `pivotByGroup` / `groupBy` / `join` / `joinMany` / `concat` / `align` / `materialize` / `dedupe` / `sample`
- **Partitioning** — `PartitionedTimeSeries` / `LivePartitionedSeries` / `LivePartitionedView` + every chainable sugar method + terminals

Reports landed at:

- [`columnar-investigation-storage-report.md`](../briefs/columnar-investigation-storage-report.md)
- [`columnar-investigation-aggregation-report.md`](../briefs/columnar-investigation-aggregation-report.md)
- [`columnar-investigation-transforms-report.md`](../briefs/columnar-investigation-transforms-report.md)
- [`columnar-investigation-reshape-report.md`](../briefs/columnar-investigation-reshape-report.md)
- [`columnar-investigation-partitioning-report.md`](../briefs/columnar-investigation-partitioning-report.md)

The synthesis pass:
[`columnar-investigation-synthesis.md`](../briefs/columnar-investigation-synthesis.md).

**Net signal:** all five agents independently endorse the substrate
direction. None proposed reversing the decision. The reports converge
on a small set of framework primitives, pin the answers to several
design questions the V2 amendment left implicit, and surface three
concrete regression risks — each with a concrete mitigation.

---

## V3 amendment (library response to investigation synthesis), 2026-05-13

> _pjm17971 + pond-ts library agent (Claude). Pins the synthesis-driven
> findings as RFC commitments rather than open questions. Several
> commitments below refine or correct V2; trajectory preserved so
> future readers see what changed and why._

The bottom-up investigation produced richer detail than V2 anticipated.
Three categories of update:

- **New framework primitives** the V2 amendment didn't sketch, surfaced
  by multiple reports independently
- **Pinning the reducer registry shape** that V2 left implicit
- **Refinements to V2 commitments** where the bottom-up evidence changed
  the answer (loess reclassification, pushColumns split, etc.)

### 1. Index views — the foundational primitive V2 missed

**Commitment.** The framework's primary primitive for derived-series
construction is the **index view**: a store whose columns borrow from
a source store under an `Int32Array` of row indices, materializing on
demand.

```ts
Store.withRowSelection(source: Store, indices: Int32Array): Store
```

Three independent reports (transforms, reshape, partitioning) arrived
at the same shape. The framework uses this for:

- `filter(pred)` returning a view; eager compaction only when
  selectivity or downstream pattern justifies
- `groupBy(col, fn)`'s per-group sub-stores (each is `{ source, indices }`)
- `partitionBy(col)`'s per-partition routing (hybrid index-view +
  compact-on-write)

**Compact-on-write semantics:** read-only chains flow through indices
end-to-end and never materialize. The first transform that derives a
new column triggers compaction of that view. `collect()` over read-only
chains becomes effectively zero-cost.

This is the **single biggest framework-layer commitment** the V2
amendment didn't make. Goes in framework step 1.

### 2. `ColumnBuilder` for dynamic / append construction

**Commitment.** The framework provides a `ColumnBuilder<T>` primitive
for dynamic-schema batch output and live append-only rings, unified.

```ts
type ColumnBuilder<T> = {
  append(value: T | undefined): void;
  appendAt(rowIndex: number, value: T | undefined): void; // sparse fill
  finalize(): Column<T>;
};

Store.fromBuilders(schema: SeriesSchema, keyBuffer: KeyBuffer, builders: ColumnBuilder[]): Store
```

Two reports independently identify the same shape. Used by:

- `pivotByGroup`'s sparse-fill output (one builder per discovered group)
- `LiveSeries`'s ring buffer (append-only typed-array growth)
- Any future operator that constructs a store column-by-column rather
  than row-by-row

V2 didn't sketch this. Goes in framework step 1.

### 3. Reducer registry shape — pinned

**Commitment.** The `(add, remove, snapshot)` contract on the reducer
registry **survives unchanged.** The framework adds **optional**
column-aware methods alongside; built-in reducers implement them for
fast paths, custom-function reducers stay on the existing shape, and
operators dispatch per-column.

```ts
type ReducerDef = {
  outputKind: 'number' | 'source' | 'array';

  // Existing — kept verbatim. Custom-function reducers depend on this.
  reduce(defined, numeric): ColumnValue | undefined;
  bucketState(): AggregateBucketState;
  rollingState(): RollingReducerState;

  // NEW — optional. Operators prefer these when present.
  reduceColumn?(col: Column, validity?: Uint8Array): ColumnValue | undefined;
  reduceColumnRange?(col, start, end, validity?): ColumnValue | undefined;
  bucketStateColumn?(): ColumnarBucketState;
  rollingStateColumn?(): ColumnarRollingState;
};
```

**Why it matters:** mixed mappings (numeric `avg` + custom function in
the same `rolling`) don't regress. Each column dispatches independently
to the fast path or fallback. Custom-function reducers — which V2
already committed to keeping event-backed — stay on the existing shape
unchanged.

V2 didn't pin this. Goes in framework step 3 (numeric reducer
adaptation).

### 4. `loess` and `smooth({centered})` reclassified

**Refinement of V2.** V2 listed `smooth({ alignment: 'centered' })` and
`smooth('loess')` as intentional gaps — operators that don't benefit
from columnar. The transforms agent's investigation showed:

- `loess` **already operates on numeric arrays internally**
  (`loessAnchors: number[]`, `loessValues: number[]`). Direct port to
  `Float64Array` is **parity-to-modest-win.**
- `smooth({centered})` for `movingAverage` is bookkeeping complexity,
  not a columnar fight. Clean port.

**Drop both from the intentional-gap list.** Both port cleanly. Live
`smooth` stays separately deferred (LiveView's `process(event) => Event`
shape is its own sub-spike), but the batch-side smoothers are all in
scope.

### 5. `pushColumns` split refined

**Refinement of V2.** V2 said: `pushColumns(...)` public API is not in
v1.0, but the framework's internal `appendBatch` is designed so it can
land as v1.x without breaking v1.0.

The partitioning report's `Store.scatterByPartition` is a stronger
argument: batched live routing wins at batch sizes ≥ 100, and the
internal scatter primitive belongs in v1.0 even when the public
`pushColumns` API doesn't.

**Refine the split:**

- **`Store.scatterByPartition` internal primitive: v1.0.** Used by
  `LivePartitionedSeries`'s routing of `pushMany` batches.
- **Public `pushColumns(...)` API: v1.x.** Reachable from the internal
  primitive without a substrate refactor.

### 6. `groupBy` deferral + migration funnel

**New commitment.** `groupBy(col, fn)`'s `Map<string, TimeSeries<S>>`
return shape is the worst-case regression in the reshape scope (N
independent store allocations per call). Both the reshape agent and the
partitioning agent recommend the same fix:

- **`groupBy` columnarization is explicitly deferred.** v1.0 keeps it
  event-backed inside the substrate.
- **Public migration funnel:** users wanting per-key transforms at scale
  should reach for `partitionBy(col).apply(fn).collect()`, which is the
  structurally correct shape and aligns with the index-view primitive
  above.
- **Documentation update:** `groupBy` JSDoc gains a "for perf-sensitive
  cases, prefer `partitionBy(...).apply(...).collect()`" note.

Not a v1.0 implementation cost; a doc + steering commitment.

### 7. `mapColumn` as a new method

**New commitment.** `map(schema, fn)` takes an opaque user closure
returning `Event`; the substrate can't route through typed-array math.
V2 said `map` stays event-backed at parity. The transforms agent
identified a clean way to recover the common case:

- **Add `mapColumn(name, fn)`** — scalar transform on one numeric
  column. Substrate routes through typed-array transform. Clean win.
- **Keep existing `map(schema, fn)`** event-backed inside the
  substrate; remains parity with today.

No API regression, no semantic loss. The split is principled: the
column-shaped majority of `map` calls (`multiply 'cpu' by 100`, `cap
'temp' to [0, 1]`) become `mapColumn` and get the win; the actual
event-closure cases stay where they are.

Lands in framework step 4 (derived transforms).

### 8. Lazy ring growth as live-partition default

**Refinement of V2.** V2 committed to `LiveSeries` numeric ring buffer
scoped narrowly (numeric rolling windows, built-in reducers). The
partitioning agent identified a concrete regression risk that wasn't
named in V2:

- At 1k hosts × 5 numeric columns × 1000-event retention × 8 bytes =
  **~40 MB pre-allocated** at spawn time under a naive port. Today's
  row-shape spawn is near-zero.

**Mitigation (and v1.0 default):** **lazy ring growth.** Start each
partition's typed-array columns at capacity 64; double on append until
retention cap. Matches `Array.push` amortization. The 1k-hosts × low-
rate-per-host common case keeps most partitions at the initial 64.

**Exception:** when `partitionBy(col, { groups })` is declared, pre-
allocate per-partition capacity to retention. The user has named the
count; predictable footprint is fine and avoids the growth cost.

This refines V2's "scoped narrowly" commitment with the concrete
default-allocation policy. Goes in framework step 7 (LiveSeries
numeric ring buffer).

### 9. Multi-source primitives in framework scope

**New commitment.** Reshape's `join` / `joinMany` / `concat` operate
over N stores. V2 treated the framework as single-store; the reshape
agent surfaced that multi-source operations are a real second axis:

```ts
Store.joinByKey(left: Store, right: Store, options: JoinOptions): Store
Store.concatSorted(stores: Store[]): Store
```

`Store.concatSorted` enables **chunked-output `concat`**: when input
stores are temporally disjoint (the "fetch this hour + last hour"
dashboard case), the output is zero-copy. This implies a `ChunkedColumn`
shape in the framework — the RFC's internal-shape sketch mentions
chunks, but the reshape report shows chunks should be load-bearing,
not optional.

`joinMany` stays as a left-fold of binary joins. N-ary fusion is a
planner-layer optimization for v1.x.

Lands in framework step 5 (reshape, after step 4 derived transforms).

### 10. Validity bitmaps as load-bearing

**Refinement of V2.** V2's internal-shape sketch mentions validity
bitmaps; all five investigation reports touch them. The framework needs
to make them first-class:

- Every numeric column has an **optional validity bitmap** (allocated
  only if any cell is undefined)
- Every reducer skips by validity
- Every export materializes `undefined` cells correctly
- Per-cell missing-data marker, not per-row

Not a new commitment — just elevating from "mentioned" to "load-
bearing." Goes in framework step 1.

### Net effect on the RFC

The framework-layer scope (step 1 in V2's implementation sequence)
gains four new primitives:

1. **Index views** (`Store.withRowSelection`)
2. **`ColumnBuilder`** (with sparse-fill `appendAt`)
3. **Zero-copy `Store.renameColumn`** (transforms + reshape both need)
4. **Direct typed-array key access** (`Store.keyAt` / `beginAt` / `endAt`)

Plus elevations:

- **Validity bitmaps** from "mentioned" to "load-bearing first-class"
- **Chunked columns** from "internal shape" to "load-bearing for
  `concatSorted`"

The reducer registry shape (commitment #3 above) goes in step 3. The
multi-source primitives (commitment #9) go in step 5. The `mapColumn`
addition (commitment #7) goes in step 4. The lazy-ring-growth default
(commitment #8) goes in step 7.

**The total scope expands modestly from V2 — most additions are small
primitives the framework needs anyway.** Implementation estimate stays
in the 3–4 month range; the sequencing inside steps changes but the
step boundaries are stable.

Three regression risks documented (`groupBy`, `map` user closure,
custom-function reducers); all three have mitigations that preserve
parity or move them to event-backed fallback inside the substrate.

The endorsement (from gRPC agent V2 feedback) and the substrate
direction (from the strategic frame) both hold. **The framework-layer
PR now has a concrete shape.** A separate framework-layer design
document captures the implementation-facing API surface — see
[`docs/briefs/columnar-framework-design.md`](../briefs/columnar-framework-design.md).

---

## Codex review pass on V3 + framework design, 2026-05-13

> _Posted as a PR comment after V3 + framework-design doc landed.
> Reproduced verbatim; library response in the V4 amendment below._

**Codex review pass**

I reviewed PR #131 at `5c4906b`. Overall, I'm still positive on the
direction: the RFC is much stronger than the original spike notes,
especially with index views, validity bitmaps, reducer registry, and
the LiveSeries split. I'd ask for a few doc/contract corrections
before merge so the future implementation work has one crisp source
of truth.

Findings:

1. **P2: `concat` identity is contradictory.**
   `docs/briefs/columnar-investigation-storage-report.md` says
   never-touched input events may lose `===` identity after concat,
   but the PLAN/RFC/framework docs lock in preserving
   `TimeSeries.concat` event identity. That needs one story before
   merge, because current public docs promise identity survives
   concat unchanged.

2. **P2: PLAN says the binding entry is "Phase 5," but columnar is
   Phase 4.7.**
   In `PLAN.md`, the superseded chart-boundary section says
   "SUPERSEDED by Phase 5" and "Phase 5 ... is the binding entry,"
   while the columnar substrate is clearly `Phase 4.7`. Since Phase
   5 is already another plan section, this will confuse implementers.

3. **P2/P3: `series.eventAt(i)` looks like an accidental public API
   commitment.**
   The PR introduces "New `series.eventAt(i)` accessor" in `PLAN.md`
   and the RFC. Today the public API is `at(i)`; `eventAt` is an
   internal store primitive. Either promote it explicitly with API
   design, docs, and tests, or rename those references to internal
   `store.eventAt(i)` / existing `series.at(i)`.

4. **P3: reorder mode still leaks into the ring-buffer API.**
   The RFC says reorder-mode `LiveSeries` stays event-backed and the
   columnar ring buffer is append-only, but the framework design
   gives `ColumnarRingBuffer` an `ordering: OrderingMode`. I'd narrow
   that API or document that only strict/append modes are valid, so
   nobody implements typed-array reorder by accident.

I did not run tests; this was a docs/plan review.

---

## V4 amendment (library response to Codex review), 2026-05-13

> _pjm17971 + pond-ts library agent (Claude). All four findings are
> real and addressed below. None of them shift design strategy; they
> tighten contracts and remove drift between docs._

Codex caught four real issues, all of them doc-level drift between
the various artifacts (storage report / PLAN / RFC / framework
design). Each corrected here as an explicit V4 commitment.

### 1. `concat` event identity — contract tightened

**Resolution.** Reconcile in favor of the storage report's nuanced
framing, against the previously-overstated "concat preserves event
identity" blanket claim.

**Tightened contract:**

> **`TimeSeries.concat` preserves event identity for events that have
> been materialized on either input.** Under today's eager-events
> shape, every event is materialized at construction, so identity is
> universal — every observable usage continues to work. Under the
> columnar substrate, identity is preserved via the per-index event
> cache: events touched on either input retain `===` through concat;
> events never touched on either input materialize fresh on first
> access in the result.

**Why this is non-breaking.** Any user code that observes
`source.at(5) === result.at(5)` today has already materialized
`source.at(5)`, which means the cache survives concat and the
identity holds. Code that never touches an event before / during
concat can't observe the identity either way — there's nothing to
compare against.

**Test surface** for the TimeSeries-integration step:

- Touched-then-concat: `source.at(5); const r = concat([source, other]); assert(r.at(5) === source.at(5))` — passes.
- Concat-then-touched: `const r = concat([source, other]); r.at(5)` — materializes fresh; no prior reference exists, identity is moot.
- Touched-on-both-sides: `source.at(5); other.at(3); const r = concat([source, other]); assert(r.at(5) === source.at(5) && r.at(11) === other.at(3))` — passes (assuming `other.at(3)` lands at result index 11).

The "never-touched then accessed in the result" case is the one the
storage report flagged — and it's observationally undetectable in
any program that does or doesn't preserve identity.

### 2. `Phase 5` → `Phase 4.7` in PLAN.md walkback

**Resolution.** Pure typo fix. The walkback in `PLAN.md`'s
"Deferred design decisions" section currently says:

> Status: SUPERSEDED by Phase 5 (Columnar core substrate), 2026-05-11.

Corrected to:

> Status: SUPERSEDED by Phase 4.7 (Columnar core substrate), 2026-05-11.

Phase 5 already names React integration; the confusion is real.
Fixed in the PLAN edit accompanying V4.

### 3. `series.eventAt(i)` dropped from the public API commitment

**Resolution.** Drop `series.eventAt(i)` as a new public API
accessor. The storage report's recommendation (surface
`series.eventAt(i)` for explicit identity) and the V3 amendment's
adoption of it overcommitted scope.

The right answer is what already exists:

- **`series.at(i)` reference stability is a contract** (Invariant
  #2 from the RFC). Same instance across calls, per-index cache.
- **`store.eventAt(i)` is an internal framework primitive only.**
  Implementation detail of how `series.at(i)` works under columnar.

The V3 commitment #3 text mentioning "New `series.eventAt(i)`
accessor for explicit stable-reference cases" is **withdrawn**.
The PLAN.md text referencing "New `series.eventAt(i)` accessor for
explicit stable-reference cases" is **withdrawn**. No new public
API surface as part of Phase 4.7 — `series.at(i)`'s contractual
reference stability is sufficient.

The storage report's framing ("`at(i)`'s cache is 'don't re-allocate
three times' rather than a hard contract") was wrong about the
contract level. **It is a hard contract** — Invariant #2 says so
explicitly, and the implementation makes it so via the per-index
cache.

If a future use case forces explicit stable-reference access (e.g., a
WeakMap keyed by event instance from a partitioned source), that's a
v1.x design discussion. Not v1.0.

### 4. `ColumnarRingBuffer.ordering` dropped from API

**Resolution.** Remove the `ordering: OrderingMode` parameter from
the `ColumnarRingBuffer<S>` constructor in the framework design.
The ring buffer is **append-only by construction**.

Ordering modes are a `LiveSeries`-layer concern, not a ring-buffer
concern:

- **`'strict'`** — `LiveSeries.#insert` throws on out-of-order before
  it would have appended to the ring. Ring sees only in-order appends.
- **`'drop'`** — `LiveSeries.#insert` returns false on out-of-order;
  ring isn't touched. Ring sees only in-order appends.
- **`'reorder'`** — `LiveSeries` falls back to the event-backed path
  (per V2 commitment). The ring buffer isn't used at all for
  reorder-mode series.

Updated `ColumnarRingBuffer<S>` constructor:

```ts
class ColumnarRingBuffer<S extends SeriesSchema> {
  constructor(schema: S, options: { retention: number; lazyGrowth?: boolean });
  // No `ordering` parameter — append-only by construction.
}
```

`LiveSeries`'s integration layer (Phase 4.7 step 7) handles ordering
mode selection — strict/drop wire to the ring buffer; reorder takes
the event-backed branch.

The framework design doc gets the same fix accompanying V4.

### Net effect on the RFC

Four small contract corrections; no scope changes. The implementation
sequence, the ten V3 commitments, and the framework design's API
surface are otherwise unchanged.

Codex's confidence in the direction holds, and the resulting docs are
crisper than they were. **The investigation + amendment loop earned
its keep again** — the trail (V1 → V2 → V3 → V4) is exactly the
contract-evolution record future implementers need to understand why
the design landed where it did.

The work proceeds.
