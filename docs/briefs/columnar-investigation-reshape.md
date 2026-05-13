# Brief: columnar conversion — reshape + multi-series

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

Reshape + multi-series operators — anything that changes the shape of the data (wide-vs-long, joined-across-sources, regularized to a grid) or operates over multiple series at once. The most schema-rewriting-heavy scope; surfaces "what does columnar do with dynamic-shape outputs" questions.

**Files to read carefully:**

- `packages/core/src/TimeSeries.ts` — sections: `pivotByGroup`, `groupBy`, `join`, `joinMany`, `concat`, `align`, `materialize`, `dedupe`, `sample`.
- `packages/core/src/sample.ts` — the strategy types and how `sample` decides what to keep.

**Operators in scope:**

- **Long-to-wide:** `pivotByGroup(groupCol, valueCol, options?)`. Produces a dynamic-width schema (`${group}_${valueCol}` columns) from a categorical source.
- **Many-series-to-one:** `groupBy(col, fn)`. Splits by group key + applies a transform per group. Returns `Map<key, TimeSeries>` (currently).
- **Cross-source merge:** `join(other, opts)`, `joinMany(sources, opts)`. Combine columns from N series sharing a time axis.
- **Vertical stack:** `concat([s1, s2, ...])`. Re-sort events from N same-schema series.
- **Resample:** `align(seq, opts)`. Onto a grid; `'hold'` / `'linear'`.
- **Regularize:** `materialize(seq, opts)`. Emit one row per bucket with `'first'` / `'last'` / `'nearest'` selection.
- **Deduplicate:** `dedupe({ keep })`. Same schema; fewer rows by key.
- **Thinning:** `sample({ stride })` / `sample({ reservoir: { size } })`.

## What we need from you

For each operator family in your scope, answer these:

1. **What does each operator actually do at the byte level?** What allocates? What walks?
2. **What would the columnar hot path look like?** Pay particular attention to operators that produce dynamic schemas (`pivotByGroup`) and operators that combine multiple sources (`join`, `joinMany`).
3. **What primitives from the framework would your scope need?** Likely candidates: `Store.merge(stores, joinPolicy)`, `Store.fromGroupedIndices(groups)`, `Store.appendColumn(name, kind, values)`. Sketch signatures.
4. **Multi-source operations:** `join`, `joinMany`, `concat` operate over N stores. What's the framework's story for "operate over multiple columnar stores"? Each operand has its own buffers; can the output share buffers from any of them? Or is the output always a fresh store?
5. **Dynamic schemas:** `pivotByGroup` produces a schema whose column set depends on data values (one column per distinct group value). What does this cost under columnar? Pre-scan to enumerate distinct values, then allocate columns? Lazy schema?
6. **Clean wins:** which operators get faster / lighter?
7. **Neutral parity:** which don't move the needle?
8. **Regression risk:** which might cost MORE?

## Specific questions for your scope

- **`pivotByGroup(groupCol, valueCol)`** produces a wide schema dynamically. Today it pre-scans for distinct group values, then allocates per-`(timestamp, group)` cells. Under columnar, the row-set is the same; the column count is dynamic. Does the framework need a "construct store with N parallel value columns" primitive? Does it stage columns in arrays-of-arrays and snapshot to typed buffers? What's the right intermediate?
- **`pivotByGroup({ groups: [...] as const })` (typed)** narrows the output schema at type level. Same byte-level question — but now we know columns upfront. Does this enable a tighter implementation?
- **`groupBy(col, fn)` returns `Map<key, TimeSeries>`.** Each group is its own series. Under columnar, this is "filter by group key" repeated per group. Can the groups share the source's columns by index selection, or do they each get a compacted copy? Trade-off vs `partitionBy` (which has its own scope — see the partitioning brief).
- **`join(other, opts)` and `joinMany(...)`** match by time axis (currently). The output has columns from both. Under columnar, can the output borrow column references from both sides? What does that cost when types differ between sides (e.g., one side has `cpu` as `'number'`, other has `cpu` as `'string'`)?
- **Join conflict policies** (`'error'`, `'prefix'`) interact with the output schema. Under columnar, how does the framework express "this output store has column X borrowed from source A and column X-with-prefix from source B"?
- **`concat([s1, s2, ...])`** re-sorts events from N sources by key. Today's `Array.concat` + sort. Under columnar, this is "merge N sorted columnar slices into one sorted columnar store." Is this a clean win (typed-array merge sort) or does it depend on the sort algorithm?
- **`align(seq, { method: 'hold' })`** outputs one row per grid step, value held forward. Under columnar, this is a column-wise sweep with index pointers into the source. Should be clean.
- **`align(seq, { method: 'linear' })`** interpolates between defined values. Numeric-column only. Clean under columnar.
- **`materialize(seq, { select })`** picks one source event per bucket. Index-based selection from source. Should be clean under columnar.
- **`dedupe({ keep })`** keeps one row per key. Under columnar, this is an index selection + (for resolution functions like `{min: col}` or `{max: col}`) a per-key scan. The keep policies (`'first'`, `'last'`, `'error'`, `'drop'`, `{ min }`, `{ max }`, custom function) have different shapes. Which ones map cleanly to columnar?
- **`sample({ stride: N })`** on snapshot side picks every Nth event. Index selection. Clean under columnar.
- **`sample({ reservoir: { size } })`** picks K-of-N random. Algorithm R single-pass over the index space, then sort by key on output to preserve chronological invariant. Under columnar, this is "K random indices, then materialize the columnar slice over those indices." What does the framework need to support this?

## Output format

A friction note (~500–1500 words) saved as `docs/briefs/columnar-investigation-reshape-report.md`. Sections:

1. **Operators investigated**
2. **Multi-source story** — how does the framework handle operations over N stores?
3. **Dynamic schema story** — what does `pivotByGroup` look like under columnar?
4. **Per-operator conversion path** — pivot, groupBy, join, concat, align, materialize, dedupe, sample
5. **Primitives needed** — list + signatures
6. **Clean wins**
7. **Neutral parity**
8. **Regression risk** — specifics + mitigations
9. **Knowns / unknowns**
10. **Recommendations**

## What we explicitly don't want

- Editorializing on whether the columnar direction is right. It's decided.
- Veto-shaped recommendations without proposed fallbacks.
- Generalized framework opinions outside your scope. If you see cross-cutting patterns with storage, aggregation, transforms, partitioning, note them — but don't redesign other people's work.
- Code. The deliverable is a friction note.

## Constraints

- ~500–1500 words. Concise.
- Be honest about uncertainty.
- `pivotByGroup` (dynamic schema) and `join` / `joinMany` (multi-source) are the operators most likely to surface framework requirements not yet anticipated. Give them weight.
- The `Map<key, TimeSeries>` output shape of `groupBy` is awkward under columnar (N sub-stores) — if you see a cleaner replacement (e.g., a "partitioned view" shape that shares source buffers), name it. But don't go off-script; that's the partitioning scope's call.
