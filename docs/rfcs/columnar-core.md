# RFC: Hybrid columnar core

**Status:** strategic RFC draft, not a PLAN commitment.

**Relationship to PLAN.md:** This document challenges, but does not replace,
the current PLAN decision that row-oriented core storage remains binding while
columnar buffers live first at the chart boundary. If any part of this RFC is
adopted, the adopted slice must be copied into `PLAN.md`; until then, PLAN wins.

**Evidence base:** [`docs/briefs/core-columnar-store-spike.md`](../briefs/core-columnar-store-spike.md)
and draft PR #130 on branch `codex/core-columnar-store-spike`.

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
