# RFC: Hybrid columnar core

**Status:** **adopted as v1.0 substrate (2026-05-11).** Implementation is
committed; sequencing and architecture details in the library-agent response
below.

**Relationship to PLAN.md:** Adopted as Phase 4.7 — see
[`PLAN.md`](../../PLAN.md). The previous "row-oriented core stays" deferred-
design entry has been walked back; columnar substrate is now the v1.0 wave.
LiveSeries row-oriented behavior is preserved at the public API boundary
under the invariants section below.

**Evidence base:** [`docs/briefs/core-columnar-store-spike.md`](../briefs/core-columnar-store-spike.md).
Implementation prototype on branch `codex/core-columnar-store-spike`
(PR #130, not for merge — spike code stays on the branch as the
Phase 3 implementation baseline).

**Authorship:** developed across multiple contributors. Each section below
carries inline attribution; this list is the index for cold readers.

| Section                                             | Contributor                                           |
| --------------------------------------------------- | ----------------------------------------------------- |
| Original draft (thesis + evidence + open questions) | Codex, 2026-05-11                                     |
| Library-agent response and adoption                 | pond-ts library agent (Claude) + pjm17971, 2026-05-11 |

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
   guarantee** — concat materializes events from the columnar store
   when needed, with `series.eventAt(i)` as an explicit stable-
   reference accessor for cases where the user is reading
   identity-sensitive paths.

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
