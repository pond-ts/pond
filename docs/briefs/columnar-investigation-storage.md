# Brief: columnar conversion — storage + access core

**For:** a fresh investigation agent (any).
**From:** pond-ts library agent (Claude), 2026-05-13.
**Status:** scoping brief — investigation, not implementation.
**Cross-references (read these, only these):**

- [`docs/briefs/core-columnar-store-spike.md`](core-columnar-store-spike.md) — the evidence base. Read this first; it's what makes the strategic decision defensible.
- [`PLAN.md`](../../PLAN.md) Phase 4.7: Columnar core substrate — the binding work entry. Read the entry only, not the surrounding PLAN.

**Do not read** `docs/rfcs/columnar-core.md` or its V2 amendment. Those are downstream of the question we're asking you to answer fresh. We want your reading from the code + the spike's measured evidence, not your reading of someone else's design conclusions.

## What's being decided, and what you're not deciding

The project is committed to building a columnar store as the v1.0 substrate. **That decision is made and is not what we're asking you about.** We know and accept that some operators may end up _less_ efficient under columnar than they are today — that's a trade we're making for large overall improvements (the spike measured 6–12× numeric reduce wins, 4× memory cut under lazy event materialization, 34× chart-extraction speedup).

**Your job is feasibility, not strategy.** For your scope: given that we ARE building this, what would the implementation actually look like, and what does it cost? Your answers feed into the framework-layer design so we know what we're getting into — both the wins and the regressions.

**The trade-off frame we want you to apply:**

- **Minimize downsides.** Target per-operator **parity at worst** — i.e., a columnar implementation that's no slower / no more allocation-heavy than the current row-backed one. If you can't get to parity in some operator, name it specifically, propose mitigations (fallback to event-backed inside the substrate? hybrid path?), and quantify the cost.
- **Maximize upside.** Where columnar unlocks real wins, name them — speed, memory, GC pressure, allocation count, cache behavior. Be specific about what the win is and why it shows up.

You are not deciding the trade-off; we are. You are surfacing what the trade-off looks like in your scope so we can make it informed.

## Your scope

Storage + access core — the substrate's primary face. Touches every other operator through the consumer-of-events contract.

**Files to read carefully:**

- `packages/core/src/TimeSeries.ts` — the class. Focus on:
  - Constructor + `#validateRow` + `#fromTrustedEvents`
  - `events` getter (currently an eagerly-built array)
  - `at(i)`, `first()`, `last()`, `length`
  - `Symbol.iterator` + `toArray()`
  - `fromEvents`, `fromJSON`, `fromPoints`, `concat` (construction paths)
  - `toRows`, `toObjects`, `toJSON`, `toPoints` (export paths)
- `packages/core/src/Event.ts` — the public Event API (`get`, `set`, `merge`, `select`, `data`, `key`, `timeRange`, `asTime`, etc.)
- `packages/core/src/types.ts` — `ScalarValue`, `ColumnValue`, `ArrayValue`, `EventForSchema<S>`, `RowForSchema<S>`, the schema-kind union
- `packages/core/src/validate.ts` — per-row validation logic

**Operators in scope (focus list):**

- Construction: 5 paths (constructor, `fromJSON`, `fromEvents`, `fromPoints`, `concat`)
- Event access: `events`, `at(i)`, `first`, `last`, `length`, iteration, `toArray`
- Export: `toRows`, `toObjects`, `toJSON`, `toPoints`
- Public Event API: every method on `Event` users touch

**Cross-cutting concern:** the five public API invariants from Phase 4.7 that must be preserved:

1. `series.events === series.events` after first access
2. `at(i)` returns the same instance across calls
3. `at(i)` ↔ `events` consistency (if `at(i)` materializes before `events`, `events[i]` reuses that instance)
4. `TimeSeries.concat(...)` preserves source event identity
5. `for (const event of series)` remains event-oriented

You don't need to defend these — they're public contracts. You DO need to think about what they cost to implement under columnar storage.

## What we need from you

For each operator family in your scope, answer these:

1. **What does it actually do at the byte level?** Currently. What does the hot path look like — what allocates, what walks, what indexes?
2. **What would the columnar hot path look like?** Sketch it. Don't write production code, write enough that the shape is clear.
3. **What primitives from the framework would your scope need?** List them concretely (`store.eventAt(i)`, `store.column<number>('cpu')`, `store.appendBatch(...)`, etc.). The framework's design is downstream of what you actually need.
4. **Where do you see clean wins?** Operators that get faster, lighter, or simpler under columnar.
5. **Where do you see neutral parity?** Operators where columnar doesn't help but doesn't hurt.
6. **Where do you see regression risk?** Operators where columnar might cost more than the current row-backed path. Name them specifically, quantify if you can, propose mitigations.
7. **What's the public-API-invariant cost?** For each of the five invariants, what does the columnar implementation cost to preserve it? Are any of them load-bearing footguns?
8. **What are your knowns / unknowns?** What can you reason about from the code alone? What would you need to measure / prototype to be sure?

## Specific questions for your scope

- The `events` getter is currently a frozen array. Under columnar lazy materialization, what's the right shape? On-first-access full materialization (today's behavior preserved)? Per-index cache + full materialization on `events` access? Something else?
- `at(i)` reference stability: if a user calls `series.at(5)` repeatedly, the same `Event` instance comes back today. What's the minimum cost to preserve that — a per-index `Map<number, Event>` cache? Something cheaper?
- `concat` event identity: today `TimeSeries.concat([a, b])` preserves source `Event` instances from `a` and `b` via array `concat`. Under columnar, what does this cost? Materialize source events on demand and cache them? Force eager event materialization on concat inputs? Drop the guarantee and document the change (we've decided to preserve it, but you should know what preserving costs)?
- `Event.set(col, value)` returns a new Event with the column changed. Under columnar, what's the right shape — clone the underlying columnar slice? Lazily project a wrapped event with an override map?
- `Event.merge(other)`, `Event.select(...)`, `Event.collapse(...)` — same question. What's the columnar shape?
- Validation cost: `#validateRow` runs per row in `pushMany` / constructor. Under columnar intake, can we validate columns once instead of per-row? What does that change?
- `toPoints` / `toRows` / `toObjects` / `toJSON` paths: these are explicitly compatibility boundaries (per Phase 4.7) — they CAN materialize. What's the right shape? Eager materialization on call? Lazy with iterator hooks?

## Output format

A friction note (~500–1500 words) saved as `docs/briefs/columnar-investigation-storage-report.md`. Sections:

1. **Operators investigated** — what you read, what you understood
2. **Likely conversion path** — concrete shape for each operator family
3. **Primitives needed** — list of framework methods + their signatures (sketch level, not production)
4. **Clean wins** — where columnar pays back; quantified if you can reason from the code
5. **Neutral parity** — where columnar doesn't move the needle; explain why
6. **Regression risk** — where columnar might cost more; specifics + proposed mitigations
7. **Public-API-invariant costs** — what each invariant costs to preserve
8. **Knowns / unknowns** — what you can reason about; what you'd need to measure
9. **Recommendations** — specific design choices for the framework-layer PR

## What we explicitly don't want

- Editorializing on whether the columnar direction is right. It's decided. Your scope is implementation.
- Veto-shaped recommendations. "This operator can't be migrated" is a useful signal IF accompanied by a proposed fallback (e.g., stays event-backed inside the substrate); "we shouldn't do this" is not.
- Generalized framework opinions outside your scope. Stay focused on the operators in your scope. If you see cross-cutting patterns with adjacent scopes (aggregation, transforms, reshape, partitioning), note them — but don't redesign other people's work.
- Code. The deliverable is a friction note, not an implementation.

## Constraints

- ~500–1500 words. Concise. Code paths described in prose, not implementation.
- Be honest about uncertainty. "I don't know without measuring" is a useful answer.
- If you find something the spike or the PLAN entry doesn't anticipate, name it. The framework design absorbs surprises better at the brief stage than at the PR-review stage.
