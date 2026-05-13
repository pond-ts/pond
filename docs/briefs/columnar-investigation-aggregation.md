# Brief: columnar conversion — aggregation family

**For:** a fresh investigation agent (any).
**From:** pond-ts library agent (Claude), 2026-05-13.
**Status:** scoping brief — investigation, not implementation.
**Cross-references (read these, only these):**

- [`docs/briefs/core-columnar-store-spike.md`](core-columnar-store-spike.md) — the evidence base. Read this first; it's what makes the strategic decision defensible. The aggregation family is where the spike measured its biggest wins (numeric reduce 6–12× faster), so the spike numbers are most relevant to your scope.
- [`PLAN.md`](../../PLAN.md) Phase 4.7: Columnar core substrate — the binding work entry. Read the entry only, not the surrounding PLAN.

**Do not read** `docs/rfcs/columnar-core.md` or its V2 amendment. Those are downstream of the question we're asking you to answer fresh. We want your reading from the code + the spike's measured evidence, not your reading of someone else's design conclusions.

## What's being decided, and what you're not deciding

The project is committed to building a columnar store as the v1.0 substrate. **That decision is made and is not what we're asking you about.** We know and accept that some operators may end up _less_ efficient under columnar than they are today — that's a trade we're making for large overall improvements.

**Your job is feasibility, not strategy.** For your scope: given that we ARE building this, what would the implementation actually look like, and what does it cost? Your answers feed into the framework-layer design so we know what we're getting into — both the wins and the regressions.

**The trade-off frame we want you to apply:**

- **Minimize downsides.** Target per-operator **parity at worst** — i.e., a columnar implementation that's no slower / no more allocation-heavy than the current row-backed one. If you can't get to parity, name it specifically, propose mitigations (fallback to event-backed inside the substrate? hybrid path?), and quantify the cost.
- **Maximize upside.** Where columnar unlocks real wins, name them — speed, memory, GC pressure, allocation count, cache behavior. Be specific.

You are not deciding the trade-off; we are.

## Your scope

The aggregation family — reducers, bucketed aggregation, rolling windows, and the live variants. This is the highest-leverage scope: where the spike measured the biggest wins and where typical pond workloads (dashboards, telemetry rollups) spend the most time.

**Files to read carefully:**

- `packages/core/src/TimeSeries.ts` — sections: `reduce`, `aggregate`, `rolling`, `baseline`, `outliers`. Pay attention to how these walk events and accumulate state.
- `packages/core/src/LiveAggregation.ts` — bucketed aggregation over a live source. Grace-period bucket closure; `'event'` / `'batch'` listener integration.
- `packages/core/src/LiveRollingAggregation.ts` — sliding-window reduction. Note v0.15.2's O(1) eviction via head-index pointer (already a row-shape paper cut fixed).
- `packages/core/src/LiveFusedRolling.ts` — multi-window rolling in one ingest pass. The v0.15.0 architectural lift.
- `packages/core/src/LivePartitionedSyncRolling.ts` — synchronized partitioned rolling. Per-partition state with shared trigger.
- `packages/core/src/LivePartitionedFusedRolling.ts` — partitioned + fused.
- `packages/core/src/LiveReduce.ts` — streaming reduce over the source's current buffer.
- `packages/core/src/reducers/` — the reducer registry. Look at how built-in reducers (`sum`, `avg`, `count`, `min`, `max`, `stdev`, `median`, `pNN`, `unique`, `top`, `samples`) implement their `add` / `remove` / `snapshot` / `reset` machinery.
- `packages/core/src/aggregate-columns.ts` — shared column-normalization helper used by both batch and live aggregation.

**Operators in scope:**

- Batch: `series.reduce`, `series.aggregate(seq, mapping)`, `series.rolling(window, mapping)`, `series.rolling(seq, window, mapping)`, `series.baseline(col, opts)`, `series.outliers(col, opts)`
- Live: `live.reduce`, `live.aggregate(seq, mapping)`, `live.rolling(window, mapping)`, fused-mapping form `live.rolling({...}, opts)`, partitioned versions of all of these via `LivePartitionedSyncRolling` / `LivePartitionedFusedRolling`
- The reducer registry itself — every built-in plus the custom-function path

## What we need from you

For each operator family in your scope, answer these:

1. **What does the operator actually do at the byte level?** What allocates per event? What's the inner-loop shape of each reducer's `add` / `remove`?
2. **What would the columnar hot path look like?** Sketch it for numeric reducers (`sum`, `avg`, `count`, `min`, `max`, `stdev`), array-output reducers (`unique`, `top`, `samples`), and percentile / sorted-array reducers (`pNN`, `median`).
3. **What primitives from the framework would your scope need?** Likely candidates: `reduceRange(start, end, reducer)`, `dictionaryIndices(col)`, `slice(start, end)`, `appendChunk`, `evictPrefix(n)`. Sketch concrete signatures.
4. **Clean wins:** Where does columnar pay back? Be specific — which reducers, which workloads, what's the magnitude?
5. **Neutral parity:** Which reducers / operators don't gain but don't lose under columnar?
6. **Regression risk:** Which reducers / operators might cost MORE under columnar? Why? Mitigations?
7. **The reducer registry as an abstraction:** `add(value, index)` / `remove(value, index)` / `snapshot()` is the current contract. Does it survive a columnar substrate, or does it need a new shape (`addBatch(indices, values)`, `addRange(start, end)`, `snapshotRange(start, end)`)?

## Specific questions for your scope

- **`unique(host)` was neutral in the spike** — slightly worse, even. Why? Dictionary encoding theoretically helps but the spike didn't see it. What would `unique` over a dictionary-encoded column actually look like? Is there a primitive that lets `unique` consume dictionary indices directly, or does it always need to materialize values?
- **`top(n)` uses a count Map internally** — works incrementally over events. Under dictionary-encoded columns, can `top` work over dictionary indices instead of values? What changes?
- **`samples` reducer captures raw values in arrival order.** v0.14.3 fixed an allocation hot spot in its rolling state (scalar `add` skipped the 1-element array wrap). Under columnar, what's `samples` actually doing — projecting a typed-array slice? Storing indices into the source column? Both have different semantics under window eviction.
- **`pNN` / `median`** maintain a sorted array of window values. Under columnar, can the sorted state be a typed array? Insert/remove on a sorted Float64Array is O(N memmove) — does that beat the current sorted JS array via splice?
- **`LiveFusedRolling` maintains N windows in one deque.** Per-window reducer state is currently row-aligned (indexed by source-event position). Under columnar, can each window's state share the source's typed-array indices, or does each window need its own typed-array projection?
- **`LiveAggregation` bucket closure** uses grace periods. The bucket state is currently a `Map<bucketKey, ReducerState>`. Under columnar, would per-bucket reducer state benefit from typed-array layout, or is the per-bucket allocation cost negligible relative to the bucket-closure logic?
- **`baseline` and `outliers`** are sugar over rolling + a comparison. They produce derived series. Under columnar, the derived series is the same shape as any rolling output — what does that path look like end-to-end?
- **The custom-function reducer path** (`(values) => ...`) is event-backed today on live. Per Phase 4.7 commitments it stays that way. What's the cleanest fallback shape — accept the custom-function reducer signature against an iterable that lazily projects events from columnar storage? Materialize events for each `snapshot()` call?
- **Aggregate planner:** the spike's prototype precomputed bucket spans once + answered numeric ranges from prefix sums. Under your reading of the operators, what's the minimum planner shape that supports `aggregate(seq, { col: reducer })`? What's the fallback for grouped-string reducers, custom functions, non-decomposable operators?

## Output format

A friction note (~500–1500 words) saved as `docs/briefs/columnar-investigation-aggregation-report.md`. Sections:

1. **Operators investigated** — what you read, what you understood
2. **Likely conversion path** — concrete shape for each operator family
3. **Primitives needed** — list of framework methods + signatures (sketch)
4. **Reducer registry shape** — does `add` / `remove` / `snapshot` survive, or does it need a new contract?
5. **Aggregate planner shape** — minimum planner that handles numeric + groupedString + custom fallback
6. **Clean wins** — where columnar pays back; quantified if you can
7. **Neutral parity** — where columnar doesn't move the needle
8. **Regression risk** — specifics + mitigations
9. **Knowns / unknowns** — what you can reason about; what needs measurement
10. **Recommendations** — specific design choices for the framework-layer PR

## What we explicitly don't want

- Editorializing on whether the columnar direction is right. It's decided.
- Veto-shaped recommendations. "This reducer can't be migrated" is useful IF accompanied by a proposed fallback (custom reducers stay event-backed, etc.); "we shouldn't do this" is not.
- Generalized framework opinions outside your scope. If you see cross-cutting patterns with storage, transforms, reshape, partitioning, note them — but don't redesign other people's work.
- Code. The deliverable is a friction note, not an implementation.

## Constraints

- ~500–1500 words. Concise.
- Be honest about uncertainty. "I don't know without measuring" is a useful answer.
- If you find something the spike or the PLAN entry doesn't anticipate, name it.
- The reducer registry is a critical surface — if its contract needs to change, that ripples broadly. Be deliberate about proposing changes there.
