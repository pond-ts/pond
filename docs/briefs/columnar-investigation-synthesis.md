# Synthesis: columnar conversion investigation

**For:** pond-ts core maintainers (Phase 4.7 framework-layer design).
**From:** pond-ts library agent (Claude), 2026-05-13.
**Status:** synthesis pass over five fresh-agent investigations.
**Cross-references:**

- The five scope reports:
  - [`columnar-investigation-storage-report.md`](columnar-investigation-storage-report.md)
  - [`columnar-investigation-aggregation-report.md`](columnar-investigation-aggregation-report.md)
  - [`columnar-investigation-transforms-report.md`](columnar-investigation-transforms-report.md)
  - [`columnar-investigation-reshape-report.md`](columnar-investigation-reshape-report.md)
  - [`columnar-investigation-partitioning-report.md`](columnar-investigation-partitioning-report.md)
- [`docs/rfcs/columnar-core.md`](../rfcs/columnar-core.md) — the RFC and V2 amendment whose framework-layer design these reports inform.
- [`docs/briefs/core-columnar-store-spike.md`](core-columnar-store-spike.md) — Codex's spike (the evidence base each agent worked from).

## Executive summary

Five fresh agents, each given a minimal brief and one scope of pond-ts's operator surface, **independently endorse the columnar substrate direction.** None proposed reversing the decision; none flagged a deal-breaker. The reports converge on a small set of framework primitives and pin the answers to several design questions the V2 amendment left implicit.

**Headline outcomes:**

1. **The reducer registry contract survives.** `(add, remove, snapshot)` is the right granularity; the framework adds **optional** column-aware methods alongside. Mixed mappings (built-in + custom) don't regress because dispatch is per-column. This is the single most consequential confirmation.
2. **An "index view" primitive emerges as the foundation for derived series.** Three independent reports (transforms / reshape / partitioning) arrive at the same shape: `Map<K, Int32Array>` or `{ source, indices }` projections over the source's columnar store. Derived series share buffers by default; compaction happens only at write or materialization boundaries.
3. **The transform-chain composition question resolves to "share by default."** The Phase 3 deferred question the spike named gets a clean answer: derived stores are schema metadata + column-handle maps; most handles point back at base buffers. Allocation happens only for columns the transform actually computes.
4. **No deal-breaker regressions surfaced.** Three operators have honest regression risk (`groupBy`, `map` user closures, custom-function reducers), all with concrete mitigations that either keep them at parity or move them to event-backed fallback inside the substrate.
5. **The "live partition spawn at 1k hosts" risk has a known mitigation:** lazy ring growth (start at 64, double on append). Confirms the high-cardinality bench doesn't gate v1.0.

## Cross-cutting framework primitives

Patterns that emerged independently across multiple reports — these are the load-bearing framework surface area:

### Index views — the unexpected primary primitive

| Scope        | Where it appears                                                   |
| ------------ | ------------------------------------------------------------------ |
| Transforms   | `filter`: index-selection view with deferred compaction            |
| Reshape      | `groupBy`: `Map<key, GroupView>` instead of `Map<key, TimeSeries>` |
| Partitioning | `partitionBy`: hybrid index-view + compact-on-write                |

Three independent confirmations of the same shape. The framework needs `Store.withRowSelection(indices: Int32Array)` or equivalent — returns a store that borrows source columns under an index projection, materializes on demand.

**Compact-on-write semantics:** the first transform that derives a new column from a view triggers compaction of that partition / filter / group. Read-only chains (`partitionBy(c).aggregate(seq, m).collect()`) flow through indices end-to-end and never materialize. **`collect()` over read-only chains becomes effectively free.**

Not in the V2 amendment. Should be a framework-layer commitment.

### ColumnBuilder for dynamic / append construction

| Scope        | Use                                                     |
| ------------ | ------------------------------------------------------- |
| Reshape      | `pivotByGroup` builder per group; sparse fill; finalize |
| Partitioning | `LiveSeries` ring buffer append semantics               |

Two reports independently identify the same shape (`{ append(v), finalize() }`). Unifying them is a small framework win — the same primitive serves dynamic-schema batch output and live append-only rings.

Mostly absent from the V2 amendment. Should be in framework step 1.

### Validity bitmaps

| Scope       | Use                                                            |
| ----------- | -------------------------------------------------------------- |
| Storage     | Per-cell missing-data marker                                   |
| Transforms  | Round-trip `undefined` through public Event API without boxing |
| Aggregation | Skip undefined cells in column scans                           |
| Reshape     | Sparse fill for `pivotByGroup`                                 |

All five scopes touch validity bitmaps. Load-bearing. The RFC's internal-shape sketch mentions them; the framework needs to make them first-class — every numeric column gets one (optional, allocated only if any cell is undefined), every reducer skips by validity, every export materializes `undefined` cells correctly.

### `Store.eventAt(i)` + per-index cache

The substrate's compatibility-boundary primitive. Five scopes use it:

- **Storage:** the core lazy-materialization primitive
- **Aggregation:** custom-reducer fallback materializes events
- **Transforms:** `map` user-closure fallback uses `Iterable<Event>` backed by store
- **Partitioning:** `apply(fn)` factories that read `g.events` heavily
- **Reshape:** `dedupe` custom-resolver functions

The spike's Phase 2.5 work pinned this primitive; reports confirm it's the universal compatibility shape. Per-index `Map<number, Event>` cache for reference stability — already proven.

### Direct typed-array key access

| Method             | Use                                                     |
| ------------------ | ------------------------------------------------------- |
| `Store.keyAt(i)`   | `bisect`, `includesKey`, key-comparison-heavy operators |
| `Store.beginAt(i)` | Range queries (`before`, `after`, `within`)             |
| `Store.endAt(i)`   | Bucket-bound search in aggregate / materialize / align  |

Storage and aggregation reports both call this out. The win is small per-call but compounds on hot paths: `align(linear)`, `bisect`-driven `before` / `after`, range scans. Cheap to add.

### `Store.renameColumn` (zero-copy buffer borrowing)

Transforms (`select` / `rename` are O(1) under columnar) and reshape (`{ onConflict: 'prefix' }`) both need it. Buffer-level no-op; schema-metadata change only. Trivially cheap; explicit in the framework.

## The reducer-registry answer (most consequential design call)

**`(add, remove, snapshot)` survives. Adds optional column-aware variants:**

```ts
type ReducerDef = {
  outputKind: 'number' | 'source' | 'array';

  // Existing — kept verbatim. Custom-function reducers stay on this.
  reduce(defined, numeric): ColumnValue | undefined;
  bucketState(): AggregateBucketState;
  rollingState(): RollingReducerState;

  // NEW — optional. Operators prefer these when present.
  reduceColumn?(col, validity?): ColumnValue | undefined;
  reduceColumnRange?(col, start, end, validity?): ColumnValue | undefined;
  bucketStateColumn?(): ColumnarBucketState;
  rollingStateColumn?(): ColumnarRollingState;
};
```

**Why this matters:** custom-function reducers come through `bucketStateFor` / `rollingStateFor` adapters that wrap a user function into `AggregateBucketState`. Forcing a columnar-aware contract everywhere would break custom reducers. With optional methods, operators check: built-in + column kind matches → fast path; else → existing event-walked fallback. **Mixed mappings (numeric `avg` + custom function in the same `rolling`) don't regress** — columns dispatch independently.

This wasn't pinned in the V2 amendment. The aggregation report's answer is the definitive shape. Should land in the RFC as a V3 amendment commitment.

## Aggregate planner

Minimum viable, per the aggregation report:

```ts
type AggregatePlan = {
  bucketStarts: Float64Array;
  bucketEnds: Float64Array;
  bucketBegin: Int32Array; // event-index of first event in bucket
  bucketEnd: Int32Array;
  columns: Array<{
    output: string;
    source: string;
    kind: ScalarKind;
    strategy:
      | { kind: 'prefix-numeric'; op; prefixSum; prefixCount }
      | { kind: 'range-scan'; reducer }
      | { kind: 'dict-counts'; reducer; n? }
      | { kind: 'fallback'; reducer };
  }>;
};
```

Per-column strategy enum makes mixed mappings work without regression. Reshape report's `align` / `materialize` cursor-based sweeps could share the bucket-spans computation. Worth exploring whether the planner generalizes; not blocking.

## New framework primitives the V2 amendment didn't anticipate

Things the V2 amendment didn't sketch that the reports surfaced:

1. **Index views** (covered above). Foundational.
2. **`ColumnBuilder`** (covered above). Foundational.
3. **`Store.scatterByPartition`** (partitioning). Internal batched routing primitive; not the public `pushColumns` API V2 deferred to v1.x. Should be in v1.0 internally; public API still deferred.
4. **`Store.joinByKey` + `Store.concatSorted`** (reshape). Multi-source operations — the V2 amendment treated the framework as single-store; multi-source is a real second axis.
5. **Chunked-output `concat`** (reshape). Zero-copy when temporally-disjoint inputs (the "fetch this hour + last hour" dashboard case). Implies a `ChunkedColumn` shape in the framework. RFC's "internal shape" section mentions chunks but doesn't make them load-bearing; reports show they should be.
6. **`#fromTrustedStore`** (storage). Parallel to `#fromTrustedEvents`, for operators with already-columnar output. Every transform writing new columns uses this; reshape `concat` / `join` / `pivotByGroup` use this; partitioning compact-on-write uses this. Universal.

## V2 amendment refinements

Things the V2 amendment got wrong or could sharpen:

### `loess` smoothing reclassified

V2 listed `smooth({ alignment: 'centered' })` and `smooth('loess')` as "intentional gaps" — operators that don't benefit from columnar. **Transforms report shows `loess` ports cleanly to parity-to-modest-win** — it already operates on `loessAnchors: number[]` and `loessValues: number[]` internally; direct port to `Float64Array` is parity. The worry didn't materialize.

`smooth({ alignment: 'centered' })` for `movingAverage` is also fine — the centered case is bookkeeping complexity, not a columnar fight.

Recommend dropping these from the intentional-gap list. Live `smooth` stays separately deferred (LiveView's `process(event) => Event` shape is its own sub-spike).

### `pushColumns` framing refined

V2 said: "the framework's `appendBatch` internal interface is designed so `pushColumns` can land as v1.x without breaking v1.0." Partitioning report's `Store.scatterByPartition` is a stronger argument for the internal primitive at v1.0. **Refine:** the internal scatter primitive is v1.0; the public `pushColumns(...)` API stays v1.x. Updated wording for the RFC.

### Batch-listener semantics confirmed

V2 committed to: `live.on('batch', cb)` receives lazy-projection events; `live.on('batchColumns', cb)` as a zero-allocation parallel API. **Storage report confirms the lazy-projection shape** (`Store.eventAt(i)` + per-index cache). **No report disputes the dual API.** Confirmed.

### Reorder-mode commitment unchanged

V2 said: reorder-mode `LiveSeries` stays on the event-backed path. **No report challenged this.** Partitioning report explicitly says routing parity holds under the row-shape path; aggregation and transforms reports don't push on it. Confirmed.

## Regressions and mitigations

Three concrete regression risks named across the reports, each with a mitigation:

### 1. `groupBy(col, fn)` — N independent stores per call

Naive port allocates N typed-array store copies. At 100 groups × 1M rows: bad. **Mitigation: defer `groupBy` columnarization in v1.0.** Funnel users to `partitionBy(col).apply(fn).collect()` (already the canonical pattern, returns the same shape). Document the migration; keep `groupBy` event-backed inside the substrate.

Both reshape and partitioning agents independently arrive at this answer.

### 2. `map(schema, fn)` — opaque user closure

The user closure returns `Event`; substrate can't route through typed-array math. **Mitigation: add `mapColumn(name, fn)` as a new method** (scalar transform on one numeric column, clean win for the column-shaped majority); **keep existing `map` event-backed inside the substrate** as the fallback at parity. No semantic loss, no API regression.

Transforms report. Aligned with V2's "preserve API at parity worst case" framing.

### 3. Custom-function reducers

Per-event cost is `data[source]` + per-event walk today. Under columnar, requires Event materialization or a `col.at(i)` indirection. **Mitigation: thin `col.at(i): ColumnValue | undefined` accessor**, or fall through to `Iterable<Event>` lazily backed by the columnar store. Aggregation report.

Custom-function reducers were already declared as event-backed in V2's reducer-registry commitment; this confirms.

### Additional risks worth tracking

- **Small-N regression curve (storage):** sub-1k series might lose to plain `Event[]` due to typed-array setup cost. Genuinely unknown until measured. Mitigation: either accept (real hotspots are large series) or keep an event-backed fast path for very small series at the substrate boundary. Worth a perf sweep before TimeSeries integration lands.
- **High-cardinality partition spawn (partitioning):** naive port pre-allocates ~40 MB at 1k hosts × retention. **Mitigation: lazy ring growth (start at 64, double on append).** Pre-allocate only when `{ groups }` is declared. Resolves cleanly.
- **Stacked filter chains (transforms):** triple-indirection in deep filter chains. **Mitigation: auto-materialize when depth exceeds threshold or downstream is a tight numeric scan.** Heuristic; needs measurement.
- **`apply(fn)` factories reading `g.events` heavily (partitioning):** loses the columnar win. Not worse than today; missed opportunity. **Mitigation: docs.** Sugar methods are the columnar-friendly path. JSDoc update; no code.

## Sequencing recommendations (per-scope)

The reports converge on a per-scope sequencing within the Phase 4.7 implementation plan:

- **Framework layer (step 1):** index views, `ColumnBuilder`, validity bitmaps, `Store.eventAt(i)` + cache, `Store.renameColumn`, typed-array key access (`keyAt` / `beginAt` / `endAt`), `Store.withRowSelection`, `#fromTrustedStore`. The shared primitives.
- **TimeSeries integration (step 2):** invariants pinned by tests; `concat` event-cache hand-off; export paths store-native.
- **Numeric reducer adaptation (step 3):** reducer registry optional methods; numeric fast paths; aggregate planner.
- **Derived transforms (step 4):** **`fill` first** (already column-shaped, drives validity-bitmap design); **numeric derivative quintet bundled** (`diff` / `rate` / `pctChange` / `cumulative` / `shift`); schema-only operators (`select` / `rename` / `asTimeRange`) almost-free; `filter` with index views; `mapColumn` as new method.
- **Reshape — incremental (step 5):** **`concat` first** (cleanest demonstration, smallest new primitive); then `align` + `materialize`; then typed `pivotByGroup` (defer dynamic-schema path until dictionary string columns are real); then `join` via `Store.joinByKey`. Defer `groupBy` columnarization, funnel to `partitionBy`.
- **Aggregate planner (step 6):** standalone module; consolidates per-column strategy dispatch.
- **Partitioning — hybrid index-view (step 7):** primary implementation; sync/fused rolling per-partition state ports from the existing numeric fast path; lazy ring growth as default; `Store.scatterByPartition` for batched routing.
- **`LiveSeries` numeric ring buffer (already in V2 plan):** extension to `LiveReduce` and `LiveFusedRolling` mechanical given the spike's existing `LiveRollingAggregation` work.

## Knowns / unknowns going into the framework PR

**Knowns:**

- The substrate direction works; no deal-breaker regression surfaced
- Five framework primitives are confirmed across multiple scopes (index views, ColumnBuilder, validity bitmaps, eventAt cache, typed-array key access)
- Reducer registry contract evolves cleanly (optional methods, custom-function fallback preserved)
- Transform chains share buffers by default; compact only at materialization boundaries
- Live numeric rolling extends cleanly from the spike's proven primitive

**Unknowns the implementation should measure:**

- Small-N regression curve (storage) — sub-1k row series
- `at(i)` hover-handler micro-benchmark — chart-code per-frame access pattern
- Dictionary-encoded `unique` / `top` workload sensitivity — gRPC bench should justify the fast path before shipping
- V8 cost of `Int32Array`-indirected column reads — drives the filter compaction policy
- `EventKey` instance reuse across `keyAt` / `eventAt` — affects key-comparison-heavy operators
- Buffer-borrowing semantics on chained operators — provenance tracking for ownership

## Recommended next actions

1. **V3 amendment to the columnar-core RFC.** Captures:
   - Index-view pattern as a framework-level commitment
   - `ColumnBuilder` as a foundational primitive
   - Reducer registry shape (optional column-aware methods alongside `(add, remove, snapshot)`)
   - `loess` and `smooth({centered})` reclassified from intentional-gap to clean-port
   - `pushColumns` refinement: internal scatter primitive v1.0; public API still v1.x
   - `groupBy` deferral with migration funnel to `partitionBy`
   - `mapColumn` as new method; `map` stays event-backed
2. **Framework-layer PR design document.** Internal to the implementation but shapes everything else. Pulls the agreed primitives from this synthesis + the V2 amendment into one concrete API sketch.
3. **Perf-bench gap analysis.** The reports identify several unknowns that need measurement (small-N curve, dictionary `unique` sensitivity, V8 indirection cost). Add `perf-columnar-{storage-access, filter-chain, small-n, dict-unique}.mjs` to the spike's existing bench suite.
4. **Document `apply(fn)` factory contract.** JSDoc note that factories reading `g.events` heavily lose the columnar win; sugar methods are the columnar-friendly path. No code change needed; doc-only.

## Net position

The investigation pass earned its keep. Five fresh agents working independently produced converging recommendations, surfaced primitives the V2 amendment didn't anticipate, and named concrete regression risks with concrete mitigations. The framework-layer design is meaningfully more detailed than it would be without this pass; the implementation team starts from a richer spec.

The endorsement holds. The substrate is buildable. The framework-layer PR has its shape.
