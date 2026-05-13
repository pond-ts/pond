# Columnar conversion investigation — partitioning

**For:** pond-ts library agent (Claude).
**From:** investigation agent, 2026-05-13.
**Status:** feasibility note. Cross-cutting layer that composes with
every other operator family.

## 1. Operators investigated

- **Batch:** `TimeSeries.partitionBy(col, opts?)` →
  `PartitionedTimeSeries<S, K>`. Terminals: `collect`, `apply`,
  `toMap`. ~13 sugar methods (`sample`, `fill`, `dedupe`, `align`,
  `materialize`, `rolling`, `smooth`, `baseline`, `outliers`,
  `diff`/`rate`/`pctChange`/`cumulative`/`shift`, `aggregate`).
  Composite keys; typed groups.
- **Live:** `LiveSeries.partitionBy(col, opts?)` →
  `LivePartitionedSeries<S, K, ByCol>` with `LivePartitionedView`
  for chained sugar; terminals `collect`, `apply`, `toMap`.
  `LivePartitionedSyncRolling` and `LivePartitionedFusedRolling`
  for clock-triggered cross-partition synced rolling.

## 2. Per-partition state model — index views vs sub-stores

The design pivot is **index views vs per-partition sub-stores**.

**Index views.** The source `ColumnarStore<S>` holds the canonical
typed-array buffers. `partitionBy(col)` walks the partition column
once and produces `Map<K, Int32Array>` of source-row indices per
partition. Sugar runs over an `IndexedView` that reads through to
shared buffers without copying. Pure read operators (aggregate,
reducers, `toMap` consumed sparsely) answer from index sets
directly. `collect()` becomes a true zero-cost return-source.

**Sub-stores.** Each partition gets its own `ColumnarStore<S>` via
typed-array memcpy of the relevant rows. Operators run normally
per partition; `concat` re-assembles. Guaranteed materialization at
`partitionBy` time.

**Recommendation: hybrid, index-views by default, compact on
write.** Read-only chains stay in index view; the first sugar that
writes a derived column compacts that partition's indices into a
sub-store at that step. Matches the structure of the spike's
Phase 3 derived-store design and `concat`'s event-identity contract.

## 3. Batch partitioning path

Today `bucketByPartition` walks `source.events` calling
`event.data()[col]` per event, builds `Map<string, Event[]>`,
constructs N `TimeSeries` via `fromEvents`, runs `fn`, and concats.
At 1M events × 1k partitions ≈ 1M payload lookups + 1k arrays +
1k `TimeSeries` instances + sort during concat.

Columnar: single pass over the (likely dictionary-encoded) partition
column, integer comparison per row, `Map<K, Int32Array>` output. At
1k partitions × 1k events each, that's ~4 MB of partition metadata
total — dwarfed by source data. No per-partition data copy.

- **`collect()` over read-only chains.** No-op return-source. The
  full `partitionBy(c).aggregate(seq, m).collect()` chain flows
  indices through to the aggregate planner (which the spike showed
  prefix-sum wins on); zero per-partition materialization. Expected
  5–10× depending on cardinality.
- **`collect()` over write-chains** (`fill().rolling()`). Per-
  partition compact-to-sub-store at the first write step → run
  rolling against sub-store → concat sub-stores in time order.
  Equivalent allocation shape to row path, with the per-event
  payload object gone.
- **`apply(fn)`.** Without stub-tracking the factory's API calls,
  default to sub-store materialization. Explicit users of `apply`
  opt into the cost (same as today's `fromEvents`-per-partition
  shape).
- **`toMap(transform?)`.** Map entries are `IndexedTimeSeries<S>`
  views until the consumer forces a write. Real win for the
  dashboard "show top-10, others available on click" pattern.

## 4. Live partitioning path

**Current routing (`#routeEvent`).** Per event: `event.data()[col]` →
`Map.get(key)` → `_pushTrustedEvents([event])` (the v0.17.x trusted
fast path skips Event reconstruction). The `[event]` array alloc per
routed event is the remaining row-shape overhead — minor.

**Columnar routing.** Per row: key extract → `Map.get` → N column
writes into the partition's ring buffer. Routing itself: roughly
parity. The win is downstream — rolling state reads typed buffers
directly, no Event materialization per window slide.

**Spawn cost (the 1k-partition risk zone).** Today each
`#spawnPartition` allocates a `LiveSeries<S>` with empty `Event[]`
and constant overhead — spawn cost is independent of column count.
A naive columnar port pre-allocates each partition's typed-array
columns up to retention. For 1k hosts × 5 numeric cols × 1000
retention × 8 bytes ≈ **40 MB pre-allocated** at spawn time vs
near-zero today. **Real regression.**

_Mitigation: lazy ring growth._ Start each partition's typed-array
columns at 64 events; double on append until retention cap, matching
`Array.push` amortization. Spawn cost stays near-zero. For the
1k-hosts × low-rate-per-host common case, most partitions never
grow beyond the initial 64. **This is the right default and resolves
the regression.** Pre-allocate only when `{ groups }` is declared —
the user has named the count, predictable footprint is fine.

**Event routing batch.** `pushMany(rows)` on a partitioned series
can pre-bucket the batch by partition value (one Int32Array of
"partition idx per row"), then make one `appendRows` call per
partition. Vectorized scatter — wins scale with batch size. **Clean
win at batches ≥ 100.**

**`LivePartitionedSyncRolling` / `LivePartitionedFusedRolling`
per-partition state.** Today each holds `entries: WindowEntry[]`
of `{index, timestamp, values: ColumnValue[]}` objects. The
single-window `LiveRollingAggregation` numeric fast-path spike
already proved typed-array ring buffers cut allocation
substantially; the partitioned variants are the same shape ×
N partitions. Direct port: per-partition `Float64Array` ring per
reducer column + per-partition reducer-state objects. **Clean win,
mirrors a proven primitive.**

## 5. Composite + typed groups

**Composite keys** (`partitionBy(['host', 'region'])`). Today
`JSON.stringify` per event. Columnar with dictionary-encoded
component columns: integer arithmetic on dictionary indices
(`(hostIdx << 16) | regionIdx` when both fit). Marginal win on key
construction; the real win is the partition pass itself — integer
comparisons instead of string concatenation + stringify.

**Typed groups (`{ groups: [...] as const }`).** Declared partition
set. Pre-allocate per-partition rings (matches user intent: they
named the count, predictable footprint). With dictionary-encoded
partition columns, declared groups become a known dictionary subset
— `validateGroupMembership` becomes O(distinct) instead of O(events).

## 6. Primitives needed

```
Store.partitionByColumn(col): Map<K, Int32Array>
Store.fromIndexSelection(indices: Int32Array): Store<S>
Store.scatterByPartition(col, rows): Map<K, RowsForPartition>  // live append
ColumnarRingBuffer<S>(schema, retention, ordering)
  .appendRow / .appendBatch / .columnView('col') → typed array
PerPartitionRollingState  // typed-array ring per reducer col, mirrors LiveRolling fast path
```

The spike-branch shapes cover most of this. The partitioning-
specific addition is `scatterByPartition` for batched live
routing.

## 7. Clean wins

- `partitionBy(c).aggregate(...).collect()` and similar pure read
  chains: index-view flow, no per-partition materialization.
- `toMap()` consumed sparsely: unread partitions stay as index sets.
- Composite-key partition pass: integer comparisons over dictionary
  indices, no stringify per event.
- Sync/fused partitioned rolling per-partition state: direct port
  of the proven single-window numeric fast path × N partitions.
- Live batched routing via vectorized scatter (batch ≥ 100).

## 8. Neutral parity

- `apply(fn)` with column-writing factories — sub-store
  materialization is the same shape as today's `fromEvents`-per-
  partition step, just typed-array-backed.
- Write-chain `collect()` end-to-end — same number of
  materializations as today; per-link allocation smaller.
- Per-partition LiveSeries spawn under lazy ring growth — roughly
  parity (one extra metadata struct, skips some event-validation
  setup).

## 9. Regression risk

- **High-cardinality eager ring allocation** (§4). _Mitigation:
  lazy ring growth, default._
- **`apply(fn)` factory reads `g.events` heavily** — forces full
  materialization, loses the columnar win. Not worse than today,
  but a missed opportunity. _Mitigation: docs; sugar is the
  preferred path; per-index Event cache from spike Phase 2.5 covers
  partial reads._
- **Un-dictionary-encoded string partition columns** — partition
  pass falls back to string Map. Same as today. _Mitigation: encourage
  ingest-time canonicalization; existing pattern._
- **`v0.17.1` default-inherit** — inheritance lives at the API layer
  (`LiveSeries.partitionBy` reads instance fields); storage-shape
  independent. _Verify v0.17.1 tests pass under columnar; expected
  to._

## 10. Knowns / unknowns

**Knowns:** the hybrid index-view + compact-on-write model fits;
lazy ring growth resolves 1k-partition allocation; sync/fused
rolling state ports cleanly; read-chain `collect()` becomes free.

**Unknowns:**

- Whether sub-store `concat` in write-chain `apply` has hidden
  per-column overhead vs today's `Event[]` concat. The spike's
  `concat` event-identity work has to generalize to "columnar concat
  preserves source column buffer references where columns are
  immutable" — probable but not measured. Medium risk.
- Custom-reducer fallback path in partitioned rolling. Numeric
  fast path is by-name dispatch; under columnar, custom reducers
  fall back to event-walked. Cost: Event materialization returns
  per event. Probably neutral but worth a bench.
- `LivePartitionedView._stub` factory-output schema capture under
  columnar with lazy rings — should be fine (stub stays
  near-zero), but worth a test pin.

## 11. Recommendations

1. **Hybrid index-view + compact-on-write.** `partitionBy` produces
   index views; sugar that writes compacts at that step.
2. **Lazy ring growth as the default** for per-partition `LiveSeries`
   substitutes. Pre-allocate only when `{ groups }` is declared.
   Resolves the 1k-partition regression.
3. **Port the numeric fast-path spike to partitioned-sync and
   partitioned-fused rolling in the same step.** Same per-partition
   shape; bundle to avoid row↔columnar hops at the boundary.
4. **Add `Store.scatterByPartition` for batched live routing.**
   Small change; real wins at batches ≥ 100.
5. **Pin the v0.17.1 default-inherit contract with columnar-backed
   tests.** Storage change should be invisible; verify.
6. **Document the `apply(fn)` factory contract** once columnar sugar
   lands — factories that read `g.events` heavily lose the win.
   Sugar methods are the preferred path. No code change; JSDoc
   only.
