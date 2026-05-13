# Brief: columnar conversion — partitioning

**For:** a fresh investigation agent (any).
**From:** pond-ts library agent (Claude), 2026-05-13.
**Status:** scoping brief — investigation, not implementation.
**Cross-references (read these, only these):**

- [`docs/briefs/core-columnar-store-spike.md`](core-columnar-store-spike.md) — the evidence base.
- [`PLAN.md`](../../PLAN.md) Phase 4.7: Columnar core substrate — the binding work entry. Read the entry only.

**Do not read** `docs/rfcs/columnar-core.md` or its V2 amendment. We want your reading from the code + the spike's measured evidence, not your reading of someone else's design conclusions.

## What's being decided, and what you're not deciding

The project is committed to building a columnar store as the v1.0 substrate. **That decision is made.** We know and accept that some operators may end up _less_ efficient under columnar than they are today — that's a trade we're making for large overall improvements.

**Your job is feasibility, not strategy.** For your scope: given that we ARE building this, what would the implementation actually look like, and what does it cost?

**The trade-off frame:**

- **Minimize downsides.** Target per-operator **parity at worst**. If you can't get to parity, name it specifically, propose mitigations, and quantify the cost.
- **Maximize upside.** Where columnar unlocks real wins, name them specifically.

You are not deciding the trade-off; we are.

## Your scope

Partitioning — splitting a series by key, holding per-partition state, and routing events to per-partition sub-buffers. **The cross-cutting scope.** Partitioning composes with every other family (aggregation, transforms, reshape) by chaining sugar after `partitionBy`, so the framework's partitioning primitives have to serve every downstream operator's columnar shape.

**Files to read carefully:**

- `packages/core/src/PartitionedTimeSeries.ts` — batch partitioning. `partitionBy(col)` returns this; `.collect()`, `.toMap()`, `.apply()`, and all the chainable sugar (`rolling`, `fill`, `diff`, `rate`, `pctChange`, `cumulative`, `dedupe`, `materialize`, `baseline`, `outliers`, `sample`, `align`, `aggregate`) live here.
- `packages/core/src/LivePartitionedSeries.ts` — live partitioning. `LivePartitionedSeries` and `LivePartitionedView`. Includes the recent v0.17.1 fix (default-inherit `ordering` / `graceWindow` / `retention` from source — that landed last week). Includes `LivePartitionedSyncRolling` wiring.
- Cross-reference: `packages/core/src/LiveSeries.ts` — the `partitionBy` method on `LiveSeries` is the API entry point; defaults are computed there.

**Operators in scope:**

- **Batch:** `TimeSeries.partitionBy(col)` → `PartitionedTimeSeries<S, K>`. Every chainable sugar method (above). Terminals: `.collect()`, `.toMap(transform?)`, `.apply(factory)`.
- **Live:** `LiveSeries.partitionBy(col, options?)` → `LivePartitionedSeries<S, K, ByCol>`. Same shape; partition spawn / event routing / per-partition retention / per-partition grace. Terminals: `.collect()`, `.toMap()`, `.apply(factory)`. Chained variants on `LivePartitionedView`.
- **Typed groups:** `partitionBy(col, { groups })` for declared partition values + narrowed K type.

## What we need from you

For each operator family in your scope, answer these:

1. **What does partitioning actually do at the byte level?** Currently. How is partition state held? How are events routed?
2. **What would the columnar hot path look like?** For:
   - **Batch partition (`TimeSeries.partitionBy`):** today builds per-partition `Map<key, EventForSchema<S>[]>` then re-wraps as `TimeSeries<S>` instances. Under columnar, what's the shape? Index selection over the source's columns per partition? Per-partition columnar sub-stores?
   - **Live partition (`LiveSeries.partitionBy`):** today spawns a sub-`LiveSeries` per partition value, routes via `_pushTrustedEvents`. Under columnar, do sub-partitions get their own ring buffers? Index views into the source's ring buffer?
   - **Chained sugar:** `partitioned.fill().rolling().collect()`. Each link composes a factory; the chain runs per partition. Under columnar, does the chain factory operate on a per-partition columnar store, or on index views?
3. **What primitives from the framework would your scope need?** Likely candidates: `Store.partition(col) → Iterable<IndexedView>`, `Store.fromIndexSelection(indices)`, per-partition typed-buffer accessors. Sketch signatures.
4. **Per-partition state:** every chainable sugar method allocates per-partition state. Under columnar, where does that state live? Per-partition store? Per-partition typed-array slices? What's the cost model?
5. **Clean wins / neutral parity / regression risk:** the usual triad.

## Specific questions for your scope

- **`TimeSeries.partitionBy(col).collect()` round-trip cost:** today this is `source → Map<key, Event[]> → flat Event[]`. Under columnar, can the round-trip avoid materializing per-partition event arrays entirely (just route indices through to the output store)? What does that save?
- **`partitionBy(col).apply(g => g.rolling(...).fill(...))` — chained sugar factories.** Each factory runs once per partition with that partition's TimeSeries. Under columnar, can the factory operate on a per-partition index view rather than a fully materialized per-partition store? When does the factory need a materialized store (because it calls `events`, `at(i)`, or constructs derived events)?
- **`PartitionedTimeSeries.toMap(transform?)`** materializes `Map<key, TimeSeries<R>>`. Under columnar, can the map values be index views over a shared source columnar store, or do they need to be independent stores?
- **Live partition spawn cost:** every new partition value spawns a sub-`LiveSeries` today. Under columnar, every sub-partition would allocate its own typed-array buffers (with their own retention / grace / ordering). At high cardinality (1k+ partitions), is this a memory regression vs the current event-backed shape? Or does typed-array allocation per sub-partition stay cheaper than per-event allocation in `Event[]`?
- **Live partition event routing:** `LiveSeries._pushTrustedEvents` is the per-event hop into a sub-partition. Under columnar, can routing skip the per-event step entirely — write directly to the sub-partition's typed columns? What does the routing batch look like?
- **`LivePartitionedSyncRolling` per-partition state:** rolling state per partition. Currently row-shaped. Under columnar, each partition's rolling state could be typed-buffer-backed. Is this an additive win (per-partition columnar rolling) or are there cross-partition concerns the framework needs to handle (sync emit semantics)?
- **`partitionBy(['host', 'region'])` (composite partition keys)** uses a stringified composite as the partition key today. Under columnar, does this become a multi-column index? Stays as stringified composite? What's cleaner?
- **Typed groups (`{ groups: [...] as const }`)** narrow the partition value type at compile time. Under columnar, with declared groups, can the framework pre-allocate per-group columnar slots? Does this enable a tighter implementation?
- **`v0.17.1` default-inherit fix** (just landed): `partitionBy('host')` now defaults to source `ordering` / `graceWindow` / `retention`. Under columnar, the same inheritance shape should hold — but verify the columnar implementation doesn't break the inheritance contract.
- **`PartitionedTimeSeries` sugar method count:** ~13 methods (every stateful operator). Each one runs per partition. Under columnar, is there a single sugar implementation that delegates to the corresponding scope's columnar implementation, or does each one need its own partitioning-aware columnar path?

## Output format

A friction note (~500–1500 words) saved as `docs/briefs/columnar-investigation-partitioning-report.md`. Sections:

1. **Operators investigated**
2. **Per-partition state model** — index views vs sub-stores; trade-offs
3. **Batch partitioning path** — `partitionBy` → `apply` / `collect` / `toMap` under columnar
4. **Live partitioning path** — spawn cost, event routing, sync rolling shape
5. **Composite + typed groups** — special cases worth being explicit about
6. **Primitives needed** — list + signatures
7. **Clean wins**
8. **Neutral parity**
9. **Regression risk** — specifics + mitigations
10. **Knowns / unknowns**
11. **Recommendations**

## What we explicitly don't want

- Editorializing on whether the columnar direction is right. It's decided.
- Veto-shaped recommendations without proposed fallbacks.
- Generalized framework opinions outside your scope. Partitioning composes with every other scope — note cross-cutting patterns, but don't redesign other people's work.
- Code. The deliverable is a friction note.

## Constraints

- ~500–1500 words. Concise.
- Be honest about uncertainty.
- **The high-cardinality partition case (1k+ partitions) is the riskiest workload.** The gRPC experiment's 1k-host bench is the canonical stress test. If columnar per-sub-partition allocation regresses there, it's a real concern. Quantify if you can.
- **Live partition spawn / event routing is the highest-throughput inner loop in pond.** Anything that makes it slower than today's row-shape path is a regression we'd want to know about.
