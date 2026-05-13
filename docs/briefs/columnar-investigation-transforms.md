# Brief: columnar conversion — transforms

**For:** a fresh investigation agent (any).
**From:** pond-ts library agent (Claude), 2026-05-13.
**Status:** scoping brief — investigation, not implementation.
**Cross-references (read these, only these):**

- [`docs/briefs/core-columnar-store-spike.md`](core-columnar-store-spike.md) — the evidence base. The transforms scope is the **Phase 3 question** the spike didn't run — derived transform chains were deferred. You're the agent answering it.
- [`PLAN.md`](../../PLAN.md) Phase 4.7: Columnar core substrate — the binding work entry. Read the entry only, not the surrounding PLAN.

**Do not read** `docs/rfcs/columnar-core.md` or its V2 amendment. Those are downstream of the question we're asking you to answer fresh. We want your reading from the code + the spike's measured evidence, not your reading of someone else's design conclusions.

## What's being decided, and what you're not deciding

The project is committed to building a columnar store as the v1.0 substrate. **That decision is made and is not what we're asking you about.** We know and accept that some operators may end up _less_ efficient under columnar than they are today — that's a trade we're making for large overall improvements.

**Your job is feasibility, not strategy.** For your scope: given that we ARE building this, what would the implementation actually look like, and what does it cost? Your answers feed into the framework-layer design so we know what we're getting into — both the wins and the regressions.

**The trade-off frame we want you to apply:**

- **Minimize downsides.** Target per-operator **parity at worst** — i.e., a columnar implementation that's no slower / no more allocation-heavy than the current row-backed one. If you can't get to parity, name it specifically, propose mitigations, and quantify the cost.
- **Maximize upside.** Where columnar unlocks real wins, name them specifically.

You are not deciding the trade-off; we are.

## Your scope

Transforms — the chain operators that take a series in and return a (possibly transformed) series out. **This is where the spike's "do derived stores compact eagerly or share buffers" question gets answered.** If derived series have to compact + reallocate on every transform, the spike's allocation wins evaporate into transform-chain overhead. If transforms can share or view-over buffers, the win generalizes through realistic chains.

**Files to read carefully:**

- `packages/core/src/TimeSeries.ts` — sections: `map`, `select`, `rename`, `collapse`, `asTime`, `asTimeRange`, `asInterval`, `diff`, `rate`, `pctChange`, `cumulative`, `shift`, `fill`, `smooth`. Pay attention to how each builds its output — what data is shared, what's re-allocated, what's transformed.
- `packages/core/src/LiveView.ts` — `filter`, `map`, `select`, `window`, `diff`, `rate`, `fill`, `cumulative` as live variants. Note the `process` function shape and how `LiveView` mirrors source eviction.

**Operators in scope:**

- **Schema-rewriting transforms:** `select`, `rename`, `collapse`, `asTime` / `asTimeRange` / `asInterval`. Output schema differs from input schema.
- **Column-appending transforms:** `diff`, `rate`, `pctChange`, `cumulative`, `shift`. Output schema is input + new columns (or input with target columns replaced, depending on opts).
- **Filter:** `filter(predicate)`. Same schema; subset of rows.
- **`map`:** user-supplied function; output schema is the same but cells can differ.
- **`fill`:** carry-forward / linear / bfill / hold / zero / per-column strategies. Same schema; cells changed.
- **`smooth`:** `ema`, `movingAverage`, `loess`. Numeric-column-only; replaces or appends.

## What we need from you

For each operator family in your scope, answer these:

1. **What does each transform actually do at the byte level?** What gets shared with the source, what gets allocated fresh?
2. **What would the columnar hot path look like?** Sketch it for:
   - Schema-rewriting transforms (do they share columns by reference?)
   - Column-appending transforms (do they write to new typed arrays?)
   - `filter` (index selection vs eager compaction?)
   - `map` (per-event-projection or column transform?)
   - `fill` (column-wise sweep with validity bitmap?)
   - `smooth` (online state over typed-array iteration?)
3. **What primitives from the framework would your scope need?** Likely candidates: `Column.sliceByIndices(indices)`, `Column.appendDerived(name, kind, values)`, `Store.withColumnsRenamed(map)`, `Store.fromIndexSelection(indices)`. Sketch signatures.
4. **Transform-chain composition:** the hard question. If a user chains `series.diff('cpu').fill('hold').rolling('5m', m)`, does each link allocate a new columnar store, or do they share buffers? What does "share buffers" actually look like at the framework level?
5. **Clean wins:** which transforms get faster/lighter under columnar?
6. **Neutral parity:** which don't move the needle?
7. **Regression risk:** which transforms might cost MORE under columnar?

## Specific questions for your scope

- **`select(...cols)` and `rename({...})`** should be near-free under columnar — schema metadata changes, column references stay. Confirm. What does it cost to preserve the public Event API (which projects per-event from the new schema)?
- **`filter(pred)`:** today allocates a new `Event[]` of survivors. Under columnar, can the result be an `IndexSelection` over the source's columns rather than a compacted copy? When does the consumer force compaction? Trade-offs?
- **`map(fn)`** is the awkward one. User-supplied `(event) => event.set('cpu', cpu * 100)` returns an Event. Under columnar, the output schema is the same but cell values differ — but `fn` operates on Event instances. Options: (a) materialize each event, run `fn`, write back to columnar; (b) restrict `map` semantics for columnar inputs; (c) keep `map` event-backed inside the substrate. Trade-offs?
- **`diff`, `rate`, `pctChange`, `cumulative`, `shift`** are pure column-wise operations on numeric columns. Should be clean wins under columnar — typed-array math, no per-event allocation. Confirm. What about the non-numeric columns that pass through? Are they shared by reference, copied, or re-projected?
- **`fill('hold')`** carries forward the last non-undefined value. Column-wise sweep with validity bitmap should be clean. Confirm. What about `fill('linear')` (interpolates between defined values)? `fill({maxGap})` (all-or-nothing per gap)?
- **`smooth('ema', { alpha })`** is online — each event updates EMA state. Path-dependent. The state at time T depends on every prior event. Under columnar, this is a column-wise scan with one accumulator. Should be clean. Confirm.
- **`smooth('movingAverage', { window, alignment })`** is a rolling window over a numeric column. `alignment: 'centered'` requires future events. Should be clean under columnar (typed-array rolling), but the centered case complicates derived-series construction.
- **`smooth('loess')`** is local regression — needs neighbor lookups per output point. Likely more complex than other smoothers. Worth investigating whether it gets the columnar win or stays event-backed.
- **`collapse({...mapping})`** combines multiple input columns into fewer output columns. Schema rewriting + cell-level transform. What does it cost under columnar?
- **`asTime` / `asTimeRange` / `asInterval`** rewrite the key column. Under columnar, the key arrays (`beginMs`, `endMs`) change shape. Does the framework support multiple key-kind representations natively, or is conversion always a full new store?
- **Schema rewriting cost:** new schemas are common — many transforms produce them. Is there a shared "view over source columns + new schema metadata" primitive that the framework needs?

## Output format

A friction note (~500–1500 words) saved as `docs/briefs/columnar-investigation-transforms-report.md`. Sections:

1. **Operators investigated**
2. **Transform-chain composition shape** — the central question; does the framework support buffer sharing across transforms? What does that look like?
3. **Per-operator-family conversion path** — schema-rewriting, column-appending, filter, map, fill, smooth
4. **Primitives needed** — list + signatures
5. **Clean wins** — quantified if possible
6. **Neutral parity**
7. **Regression risk** — specifics + mitigations
8. **Public Event API cost** — `map` is the most complex case; what's the cost?
9. **Knowns / unknowns**
10. **Recommendations**

## What we explicitly don't want

- Editorializing on whether the columnar direction is right. It's decided.
- Veto-shaped recommendations. "This transform can't be migrated" is useful IF accompanied by a fallback (e.g., `map` stays event-backed inside the substrate); "we shouldn't do this" is not.
- Generalized framework opinions outside your scope. If you see cross-cutting patterns with storage, aggregation, reshape, partitioning, note them — but don't redesign other people's work.
- Code. The deliverable is a friction note, not an implementation.

## Constraints

- ~500–1500 words. Concise.
- Be honest about uncertainty. "I don't know without prototyping" is a useful answer.
- The transform-chain composition question is the most strategically important thing in your scope. Give it weight.
- `loess` smoothing and `map` are the operators most likely to fight columnar. Be honest about whether they earn the migration or stay event-backed.
