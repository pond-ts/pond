# Plan

This document is the single source of truth for what has shipped, what is next,
and the design decisions behind each phase. Update it whenever meaningful work
lands so a lost session does not erase the current state of the project.

---

## Current baseline

What already exists today:

- typed `TimeSeries` construction and JSON ingest/export
- `Time`, `TimeRange`, and `Interval` temporal keys
- immutable `Event` values
- temporal selection and slicing
- alignment, aggregation, joins, rolling windows, and smoothing
- calendar-aware `Sequence` and `BoundedSequence`
- npm packaging and automated release flow
- a Docusaurus docs site plus generated API reference
- PR review discipline — self-review + adversarial agent review with a
  two-comment protocol (agent comment + author response comment) per
  CLAUDE.md; `CHANGELOG.md` now tracks every release

What is still not stable enough to build on aggressively:

- edge-case coverage in several analytical paths is still lighter than it
  should be
- a settled plan for live/stateful composition is still ahead of us

---

## Active experiments

Pond is battle-tested through parallel multi-agent experiments — see
[CLAUDE.md "Multi-agent experiments and the feedback model"](CLAUDE.md#multi-agent-experiments-and-the-feedback-model)
for the philosophy. This section is the canonical roster: who's
working on what, what each has driven into the library, where each
track is now.

### CSV-cleaner (complete; v0.9.x)

Three-agent run (Claude, Codex, Gemini) on a real per-host metrics
CSV with mixed timestamp formats, four spellings of "missing,"
duplicate-retry rows, and gap-from-missed-scrapes. Each agent
produced an independent friction report; library responded with a
coordinated v0.9.x wave.

- **Drove:** `partitionBy`/`PartitionedTimeSeries` (cross-entity
  correctness), `dedupe({ keep })`, `fill(maxGap)` + all-or-nothing
  fill semantics, `**Multi-entity series:**` JSDoc warnings on every
  stateful operator.
- **Writeup:** `website/docs/how-to-guides/ingesting-messy-data.mdx`.
- **Source folder:** `experiments/csv-cleaner/` (PROMPT.md, RUBRIC.md,
  SPEC.md, generate.ts, messy.csv, results/).
- **Notable:** Gemini escaped its sandbox, found the experiment
  folder, cheated. We laughed.

### Dashboard (ongoing as reviewer; drove v0.10-v0.11.0)

Built a full webapp at
[`pjm17971/pond-ts-dashboard`](https://github.com/pjm17971/pond-ts-dashboard).
The dashboard agent stays involved as the React/charting domain
expert and reviews PRs touching that surface. Will inform
`@pond-ts/charts` when that package extracts.

- **Drove:** v0.11.0 `LivePartitionedSeries` (named explicitly as the
  "obvious next step" in round-2 feedback), `useCurrent` reference
  stability, `pivotByGroup` typed `groups`, `useEventRate` /
  `LiveView.eventRate()`, `useCurrent` value narrowing.
- **Writeup:** `website/docs/how-to-guides/dashboard-guide.mdx`.

### gRPC pipeline (in flight; M3 merged, M3.5 in progress)

Claude agent. Three-process gRPC + WebSocket stack: producer
(`@pond-ts/dev-producer` candidate) → aggregator (`@pond-ts/server`
candidate, runs a server-side `LiveSeries`) → web dashboard (the read
side, `useRemoteLiveSeries` candidate). Targeting M5 extraction
sweep producing three RFC-style design docs.

- **Drove so far:** v0.11.3 (`pond-ts/types` subpath export — schema-
  as-contract without runtime dep), v0.11.4 (`LiveSeries.toJSON` /
  `pushJson` / `pushMany` / `Event.toJsonRow` — codec-agnostic
  snapshot+append primitives), v0.11.5 (packaging fix — README/
  LICENSE/CHANGELOG in tarballs), v0.11.6 (count() doc clarification
  on duplicate keys; the M3 friction notes confirmed this fixed M1's
  misdiagnosed stagger workaround), v0.12.0 (Trigger
  primitive — M3.5's `HostAggregator` motivated the synchronised
  partitioned-rolling shape; webapp telemetry's `.sample()` use case
  folded into the same redesign).
- **Milestone files:** `experiments/grpc-pipeline/{PLAN,LINKS,M0..M3.5}.md`.
  - M3 (PR #8) — throughput-characterisation friction report, gRPC
    framing-bound at 73k events/sec, captured in PLAN under
    "Performance expectations and the bench-vs-real-world gap."
  - M3 phase A (PR #9) — `EventBatch` wire batching, 22k → 486k
    events/sec at the saturation cell; pond is genuinely under
    pressure now (~30% wall-clock minor GC). Confirmed bench numbers
    are real-world-validated.
  - M3.5 (PR #11, PR #13) — server-side aggregation slice; surfaced
    that pond had no synchronised-partitioned-tick primitive,
    forcing a hand-rolled `HostAggregator`. Resolved by the v0.12
    Trigger redesign (RFC: `docs/rfcs/triggers.md`).
- **Carry-forwards to `@pond-ts/server` RFC:** coalesce strategy with
  tested default windowMs, reference EventBatch-style proto in
  examples, snapshot-cache design, slow-client policy defaults,
  per-phase metrics histograms (`pushManyTotalMs`, `fanoutRecordMs`,
  `fanoutSerializeMs`, `fanoutBroadcastMs`) as opt-in defaults.
- **V4 validation (2026-05-01).** After v0.14.0 shipped, the
  experiment re-profiled and produced a four-way bench (V1 manual
  `HostAggregator` → V2 v0.12 trial → V3 v0.13.0 → V4 v0.14.0).
  Every CHANGELOG-claimed delta from the v0.14.0 wave shows up in
  the bench: heap −17% to −50% across moderate loads, ceiling
  throughput +23% (208k → 256k/s), tick fps +30%, p99 1.91ms →
  1.15ms. The two profile-flagged hot spots
  (`estimateEventBytes` + `Event → row → Event` round-trips) are
  gone or reduced as advertised. **The remaining ~38% ceiling gap
  to V1 is now isolated to one operator:**
  `LivePartitionedSyncRolling.ingest` per-event reducer-state
  work (8.2% self time at V4 ceiling, larger share than V3's 4.1%
  only because more events are processed per second — the per-event
  cost is roughly unchanged). Reducer batching is the natural
  next lever IF a future user pushes near ceiling; production
  target is 100k/s (V4 hits 256k/s = 2.56× headroom), so it
  doesn't earn its API surface yet. PR #14 on
  `pond-grpc-experiment` carries the four-way story; the
  experiment is now considered fully realized for the M3.5
  scope and ready for its writeup.

### Webapp telemetry (ongoing; drove v0.11.8)

Codex agent. Frontend telemetry-stats reporting (collect latency
events, sample percentiles to a backend every 30 s, display live in
React). Real production code in a trading-platform app.

- **Drove:** v0.11.8 `rolling.sample(sequence)` (later subsumed by
  v0.12.0 triggers). The first design attempt was an
  overload (`live.rolling(Sequence, '1m', mapping)`) mirroring the
  batch shape; closed PR #92 walked that back after implementation
  surfaced a hidden-ownership leak and locked-away rolling state.
  v0.11.8 (PR #93) shipped `.sample()` as a separate composition step.
  Then the gRPC experiment's M3.5 work surfaced that `.sample()` was
  itself overly specific — the deeper factoring is `Source × Trigger
× Aggregation`, with `.sample()` collapsing into "rolling with a
  clock trigger." v0.12.0 ships `Trigger.clock(seq)`
  as a first-class concept; `.sample()` and `LiveSequenceRollingAggregation`
  are deleted. The webapp telemetry agent migrates from `.sample()`
  to `{ trigger: Trigger.clock(seq) }` as part of v0.12 adoption.
- **Surfaced as next deferred:** the `AggregateOutputMap` overload
  on `LiveSeries.rolling()`. The Codex code duplicates the same
  numeric value into four columns named `p50`/`p75`/`p95`/`count` to
  satisfy `AggregateMap`'s "one reducer per column" constraint —
  exactly the gap PLAN's deferred section predicted.

---

## Completed work

### Phase 0: Core performance (done)

All five critical O(N^2) hot paths have been optimized:

| Method                     | Was             | Now                   | Speedup (largest test)  |
| -------------------------- | --------------- | --------------------- | ----------------------- |
| `aggregate()`              | O(N x B)        | O(N + B)              | **172x** at 16k events  |
| `rolling()` (event-driven) | O(N^2)          | O(N) sliding window   | **182x** at 4k events   |
| `smooth('movingAverage')`  | O(N^2)          | O(N) sliding deque    | **15x** at 4k events    |
| `smooth('loess')`          | O(N^2 log N)    | precomputed neighbors | **7.5x** at 1.6k events |
| `includesKey()`            | O(N)            | O(log N) bisect       | **819x** at 8k events   |
| `#alignLinearAt()`         | O(N) + O(log N) | forward cursor        | **134x** at 4k events   |

Landed in commits `05a7af3` and `60b2f07`. Each change has dedicated regression
tests and a benchmark script.

Internal pre-validated constructor path now skips the
`events -> toRows() -> validateAndNormalize() -> events` round-trip for
order-preserving derived transforms (`filter`, `select`, `rename`, `collapse`,
`map`, etc.). Landed in commit `2ef6265`. A chained `filter -> select -> rename
-> collapse -> map` derivation is **2.5x** faster at 8k events.

### Phase 1 progress: Batch hardening (in progress)

- [x] `toJSON()` round-trips with `fromJSON(...)`
- [x] `toRows()` and `toObjects()` explicit normalized export helpers
- [x] both array-row and object-row JSON shapes supported
- [x] docs cover both ingest and export
- [x] custom aggregate reducers and named aggregate outputs
- [x] edge-case tests for empty series, single-event series, empty aggregation
      buckets, rolling alignment edge cases, and half-open interval semantics
- [x] test and document custom reducers for `rolling()` (type plumbing already
      accepted `CustomAggregateReducer`; added edge-case tests and docs)

---

## Phase 1: Batch hardening (in progress)

Goal: make the existing batch surface trustworthy enough to extend.

Remaining scope: none — all items complete. Phase 1 is ready for the decision
gate: is the batch layer complete and trustworthy enough to be the foundation?

Definition of done:

- [x] custom reducer typing and runtime behavior are documented and covered
- [x] edge-case coverage exists for every current analytical primitive

### Remaining performance items (lower priority, address incrementally)

From the original audit, not yet addressed:

- `Time`/`Interval` temporal comparisons still allocate a throwaway `TimeRange`
  per call
- `Event` constructor still does `Object.freeze({ ...data })` +
  `Object.freeze(this)` — measurable overhead at scale
- `rows` getter still materializes N frozen arrays on every access — should
  cache lazily or become a method
- `aggregateValues` still filters the values array twice — one pass suffices
- `compareEventKeys` still uses `localeCompare` for tiebreaking on fixed
  strings — plain `<` is ~10x faster
- `joinMany` still does repeated pairwise joins — an N-way sorted merge would
  be one pass
- `parseDurationInput` is duplicated in `TimeSeries.ts` and `Sequence.ts`

### Known type-level limitation: `TimeSeries<S>` variance

Both Codex and Claude agents flagged in the CSV-cleaner experiment that:

- `toJSON()` returns `TimeSeriesJsonInput<SeriesSchema>` (loose) rather than
  `TimeSeriesJsonInput<S>`, so a typed `TimeSeries<Schema>` round-tripped
  through `toJSON` loses its specific schema. Callers cast back at the
  call site (`as TimeSeriesJsonInput<MySchema>`).
- `RowForSchema` doesn't honor `required: false`, so
  `new TimeSeries({ rows: [[ts, undefined, ...]] })` rejects undefined
  cells even when the schema allows them. Workaround: go through
  `fromJSON({ rows: [[ts, null, ...]] })` instead, which already widens
  cells via `JsonRowForSchema`.

Both fixes are real and correct in isolation, but trying to land them
hits a class-wide variance issue: many `TimeSeries` methods have
overloads that return `TimeSeries<NarrowSchema>` while the impl returns
`TimeSeries<SeriesSchema>`. Tightening `toJSON`'s return to use `<S>`
makes `TimeSeries<NarrowSchema>` no longer assignable to
`TimeSeries<SeriesSchema>` (the variance now propagates through every
method that references S in a return position), which breaks the
overload-impl compatibility check on `pivotByGroup`, `rolling`,
`arrayAggregate`, and `arrayExplode`.

Fixing this properly requires a class-wide variance refactor — either
restructure each invariant overload to use a separate type-level helper
that doesn't tie back to the class generic, or split `TimeSeries<S>`
into a covariant read-side and an invariant write-side. Both are
non-trivial. Queued as future work; the workarounds above are honest
documentation in the meantime.

---

## Phase 2: Batch expansion

Status: complete.

Goal: fill the most obvious product gaps in the batch analytics story.

Completed:

- [x] `reduce` — collapse a series to a scalar or record (whole-series aggregation)
- [x] `groupBy` — partition by column value, optional transform callback
- [x] `diff` / `rate` — per-event differences and per-second rates of change
- [x] `fill` — per-column gap-filling strategies (hold, linear, zero, literal)
- [x] `pivotByGroup` — long-to-wide reshape on a categorical column; the missing
      inverse of `groupBy` for cases where you want one wide series instead of N
      separate ones (added late, after dashboard-agent feedback)
- [x] `TimeSeries.concat([s1, s2, ...])` — fan-in primitive that closes the
      `groupBy(col, fn)` round-trip without forcing callers out of the typed
      contract. Concatenate same-schema series, re-sort by key, return one
      wider series. Shipped in v0.8.2 after the CSV-cleaner agent run flagged
      the missing third leg of the fan-out / column-merge / row-append triangle.
      Initially named `merge` (matching pondjs lineage); renamed to `concat`
      pre-release after the adversarial review flagged the verb-overlap with
      `Event.merge(patch)` and the cleaner alignment with `Array.prototype.concat`,
      `pandas.concat(axis=0)`, and SQL `UNION ALL`.
- [x] `TimeSeries.fromEvents(events, { schema, name })` — companion to `merge`
      for the rare case where you have a flat events array (not a list of
      series) to assemble. Sorts by key. Shipped in v0.8.2.
- [x] `TimeRange.toJSON()` and `.toString()` — `{ start, end }` ms shape that
      round-trips through `new TimeRange(...)` and JSON wire formats; ISO
      `start/end` for debug. Shipped in v0.8.2.
- [x] `series.partitionBy(col)` and `PartitionedTimeSeries<S>` — chainable
      view that scopes stateful transforms to within each partition, fixing
      the cross-entity correctness hazard surfaced by all three CSV-cleaner
      agents. Sugar for `fill` / `align` / `rolling` / `smooth` / `baseline` /
      `outliers` / `diff` / `rate` / `pctChange` / `cumulative` / `shift` /
      `aggregate` plus `apply(fn)` escape hatch. Sugar methods return another
      `PartitionedTimeSeries` (persistent across chains, e.g.
      `ts.partitionBy('host').dedupe(...).fill(...).collect()`); `.collect()`
      materializes back to a regular `TimeSeries`. Shipped in v0.9.0 (PR 1
      of the wave).

Scope: none — all items complete.

Dropped:

- `fillNull` — `fill()` covers all use cases; a separate method doesn't earn its
  API surface

- `resample` — everything it would do is already covered by `aggregate()`
  (downsample) and `align()` (upsample); adding it as pure sugar doesn't earn
  its API surface

Nice-to-have in the same wave:

- per-column alignment policies

Hold for later unless a concrete user need appears:

- `unpivot` — wide-to-long; sketched on the
  [Reshaping](website/docs/pond-ts/transforms/reshape.mdx#unpivot)
  page with a manual workaround. Promote to shipped if a real case
  appears.

### Design notes

**`groupBy`**: returns `Map<string, TimeSeries<S>>` keyed by group values,
preserving full typing on inner series. Optional transform callback avoids
materializing intermediate maps:

```ts
const perHost = series.groupBy('host');
const perHostRolling = series.groupBy('host', (group) =>
  group.rolling('5m', { cpu: 'avg' }),
);
```

**`reduce`**: collapses an entire series to a scalar or record, using the same
reducer specs as `aggregate` but without a time-bucketing sequence. Where
`aggregate` always produces a new `TimeSeries`, `reduce` produces a plain value.
Supports both built-in and custom reducers, same as `aggregate`:

```ts
// single column
const avg = series.reduce('cpu', 'avg'); // => number

// multi-column
const summary = series.reduce({
  cpu: 'avg',
  requests: 'p95',
});
// => { cpu: number, requests: number }

// custom reducer
const weighted = series.reduce(
  'cpu',
  (values) => values.reduce((a, b) => a + b, 0) / values.length,
);

// per-group reduction
const perHost = series.groupBy('host', (g) =>
  g.reduce({ cpu: 'avg', requests: 'p95' }),
);
// => Map<string, { cpu: number, requests: number }>
```

**`diff` / `rate`**: operate on one or more named numeric columns. Non-specified
columns pass through unchanged. First event gets `undefined` in affected columns
by default; `{ drop: true }` removes it instead. `rate` divides by time gap in
seconds. Options object is always the last argument, after column names.

```ts
// single column
const deltas = series.diff('requests');
const perSec = series.rate('requests');

// multi-column
const deltas = series.diff('requests', 'cpu');
const perSec = series.rate('requests', 'cpu');

// drop first event instead of undefined
const deltas = series.diff('requests', { drop: true });
```

**`fill`**: replaces `undefined` values using per-column strategies. Strategies
and options are separate arguments. Strategy names: `hold` (forward fill),
`linear` (time-interpolated), `zero`. Non-string values in the mapping are
literal fill values. `limit` caps consecutive fills per column.

```ts
// single strategy for all columns
series.fill('hold');
series.fill('hold', { limit: 3 });

// per-column strategies
series.fill({ cpu: 'linear', host: 'hold' });

// literal fill values
series.fill({ cpu: 0, host: 'unknown' });
```

`linear` requires known values on both sides of a gap; leading and trailing
undefined runs are left unfilled.

**`pivotByGroup`**: reshapes long-form data into wide rows. Each distinct
value of a categorical column becomes its own column in the output schema,
named `${group}_${value}`, holding the value column at that timestamp.
Rows sharing a timestamp collapse into one output row; missing
`(timestamp, group)` cells are `undefined`. Output schema is dynamic
(column names depend on runtime data), so the return type is
`TimeSeries<SeriesSchema>` (loosely typed) — callers bridging to charts
read columns by name out of `toPoints()` rows.

```ts
// Long: { ts, cpu, host } per row
// Wide: { ts, "api-1_cpu", "api-2_cpu", ... } per row
const wide = long.pivotByGroup('host', 'cpu');
wide.toPoints(); // ready for Recharts <Line dataKey="api-1_cpu" /> etc.
```

Duplicate `(timestamp, group)` pairs throw by default; opt-in with
`{ aggregate: 'avg' | 'sum' | 'first' | 'last' | ... }` to combine
(reuses the `aggregate()` reducer registry, including custom functions
and `pN` / `topN` parsed names). Requires a time-keyed input.

The single-value-column form covers the dashboard case ("one metric,
multiple producers"). A typed-output overload ships in v0.8.1:
`pivotByGroup(group, value, { groups: [...] as const })` propagates the
declared group set to the output schema as literal column names, so
downstream `baseline` / `rolling` / `toPoints` calls narrow without
`as never` casts. The declared form also preserves declaration order
(not alphabetical) and emits columns for declared-but-empty groups so
the schema is stable across runs. The untyped form remains as the
open-set discovery path returning `TimeSeries<SeriesSchema>`. Both
live behind one method via overload.

Rejected follow-ups (from v0.8.0 dashboard-agent feedback):

- **Multi-value-column pivot** — `pivotByGroup('host', ['cpu', 'memory'])`.
  Cross-host-cross-metric layouts hit this, but the workaround
  (two pivots + `join`) is one extra line and stays inside the typed
  contract. Not earning the API surface.
- **`baselineMany` / multi-column `baseline`** — replacing the
  chained `wide = wide.baseline(...)` reassignment with a single
  multi-column call. Cosmetic — the chain is idiomatic immutable-API
  code and reads fine in practice.

Both rejections will be revisited only if a second concrete case
lands.

**Per-column alignment**: extend `align()` to accept a per-column map. Default
(`'hold'`) applies to any column not in the map:

```ts
const aligned = series.align(Sequence.every('1m'), {
  method: { cpu: 'linear', host: 'hold' },
});
```

Definition of done:

- each method has both API docs and worked examples
- type flow is preserved through all new methods
- batch examples cover realistic host/service metrics workflows

---

## Phase 2.5: Columnar primitives

Status: complete.

Goal: fill the remaining analytical gaps that pandas users expect, without
exposing a general "access neighboring events" API. Each operation is a named
columnar primitive that the library implements internally by walking the event
array — the user describes what they want, not how to iterate.

Completed:

- [x] `pctChange` — percentage change relative to previous value
- [x] `cumulative` — running accumulation (sum, max, min, count, custom)
- [x] `shift` — lag/lead column values by N events
- [x] `bfill` strategy for `fill()` — backward fill (propagate next known value backward)
- [x] built-in aggregator parity with original pondjs: `median`, `stdev`,
      `percentile` (`p50`, `p95`, `p99`, etc.), `difference`, `keep`

### Design notes

**`pctChange`**: same shape as `diff`/`rate`. Computes `(curr - prev) / prev`
for named numeric columns. First event gets `undefined` (no previous value).
Purely value-relative — time gap doesn't matter.

```ts
const pct = series.pctChange('requests');
const pct = series.pctChange(['cpu', 'mem']);
const pct = series.pctChange('requests', { drop: true });
```

For period-over-period comparison (today vs yesterday, current vs one hour ago),
the idiomatic approach is `shiftKeys` + `join` rather than a single-series
`pctChange` — that's a separate composition pattern, not a primitive.

**`cumulative`**: takes a mapping of column names to accumulation functions.
Returns a series of the same length with running values. Supported built-ins:
`sum`, `max`, `min`, `count`. Custom accumulators via function.

```ts
const running = series.cumulative({ requests: 'sum' });
const peaks = series.cumulative({ cpu: 'max' });
const mixed = series.cumulative({
  requests: 'sum',
  cpu: 'max',
  errors: 'min',
});
```

Non-accumulated columns pass through unchanged. Unlike `rolling` (fixed window),
`cumulative` grows from the first event — every event sees all prior values.

**`shift`**: moves column values forward (lag) or backward (lead) by N events.
Vacated positions get `undefined`. Useful for "compare to N ticks ago" on
regular-grid data, or as a building block for custom derived metrics.

```ts
const lagged = series.shift('value', 1); // lag by 1
const lead = series.shift('value', -1); // lead by 1
const lagged = series.shift(['cpu', 'mem'], 2);
```

For time-based shifting (e.g. "value 1 hour ago" on irregular data), the
pattern is to `align` to a regular grid first, then `shift` by the
corresponding number of events. A dedicated `shiftKeys(duration)` that offsets
event timestamps (for join-based period comparison) may come later if the
pattern proves common enough.

**`bfill` for `fill()`**: adds a `'bfill'` strategy to the existing `fill()`
method — the mirror of `'hold'` (forward fill). Walks the event array backward,
propagating the next known value into preceding `undefined` gaps. Supports
`limit` to cap consecutive fills, same as other strategies. Works in per-column
mode too:

```ts
series.fill('bfill');
series.fill('bfill', { limit: 3 });
series.fill({ cpu: 'linear', host: 'bfill' });
```

Trailing `undefined` runs (no future value to propagate) are left unfilled,
mirroring how `'hold'` leaves leading runs unfilled.

**Aggregator parity**: the original pondjs shipped 12 built-in reducers. We have
7 (`sum`, `avg`, `min`, `max`, `count`, `first`, `last`). The five missing ones:

- **`median`** — middle value of the sorted bucket. Same as `percentile(50)` but
  earns its own name for readability.
- **`stdev`** — population standard deviation of bucket values.
- **`percentile`** — q-th percentile. Expressed as `'p50'`, `'p95'`, `'p99'`,
  etc. in reducer specs. Linear interpolation between adjacent ranks by default.
- **`difference`** — range within a bucket (`max - min`). Useful for spread /
  volatility measures.
- **`keep`** — returns the value if all bucket values are identical, `undefined`
  otherwise. Useful for preserving constant columns (e.g. `host`) through
  aggregation.

These extend the existing `AggregateFunction` union and work everywhere reducers
are accepted: `aggregate()`, `reduce()`, `rolling()`, and `collapse()`.

```ts
series.aggregate(Sequence.every('10m'), {
  latency: 'p95',
  cpu: 'median',
  host: 'keep',
});

series.reduce({ latency: 'stdev', spread: 'difference' });
```

Definition of done:

- each method follows the `diff`/`rate` pattern (columns + options)
- type flow is preserved — affected columns become optional number
- tests cover empty series, single event, leading/trailing gaps, and
  composition with groupBy
- all 12 original pondjs reducers are available as built-in names
- `percentile` patterns (`p50`, `p95`, `p99`) parse correctly in reducer specs

---

## Phase 3: Live core

Status: complete.

Goal: introduce a minimal but principled live layer without collapsing the
immutable `TimeSeries` model.

Scope:

- [x] `LiveSeries<S>` — mutable, append-optimized buffer sharing the same schema
      type as `TimeSeries`
- [x] push/append APIs
- [x] retention policies (`maxEvents`, `maxAge`); ~~`maxBytes`~~ removed in v0.14.0 as unused
- [x] immutable snapshot via `toTimeSeries()`
- [x] ordering modes (`strict`, `drop`, `reorder`) and late-arrival policy
- [x] subscriptions (`event`, `batch`, `evict`) — synchronous, inline with push
- [x] docs page for LiveSeries

Non-goals for this phase:

- live aggregation, rolling, or smoothing
- React hooks

### Design notes

**Retention** runs on every push. No background timers — the caller controls the
event loop. Data is the clock.

**Ordering**: three modes — `strict` (default, throws on out-of-order),
`drop` (silently discards late events), `reorder` (inserts in sorted position
within a grace window).

**Subscriptions** are synchronous and fire inline with `push`. Async fanout is
the caller's responsibility.

**Subscription ordering**: within a single `push()` call, listeners fire in
this order: `event` (once per event, inline with insertion) → retention runs →
`batch` (once with all added events) → `evict` (if retention removed events).

**`reorder` mode**: without a `graceWindow`, any out-of-order event is inserted
in sorted position via binary search. With a `graceWindow`, events older than
the window relative to the latest timestamp throw. This gives callers control
over how much disorder they'll tolerate.

**`toTimeSeries()` snapshot**: reconstructs rows from the internal event array
and passes them through the standard `TimeSeries` constructor. This re-validates
events redundantly but keeps the two classes fully decoupled. Snapshot is not a
hot path — if profiling proves otherwise, a trusted constructor bridge can be
added later.

**Byte estimation** (`maxBytes`) was shipped in this phase but removed in
v0.14.0 — no real user reached for it, and the gRPC experiment's V3 profile
flagged the per-push estimator as the largest single self-time line (6.2%)
purely maintaining a counter no working app consulted. Pre-1.0 cleanup;
`maxEvents` covers the eviction patterns real apps actually need.

Definition of done:

- [x] `LiveSeries` can ingest ordered data reliably
- [x] retention and snapshot semantics are clearly documented
- [x] subscriptions are predictable and synchronous
- [x] the API is small enough to change if the composition model reveals flaws

---

## Phase 4: Live composition

Status: core primitives complete; **two queued workstreams** —
late-event propagation through live transforms and live merge / join
across sources. Both are committed for upcoming work (no longer in
"deferred" status) but are large enough to ship as their own phases.

Goal: validate the live composition model before building UI integrations on top
of it.

Completed:

- [x] `LiveAggregation` — incremental bucketed aggregation over a `LiveSeries`
- [x] `LiveRollingAggregation` — sliding-window reduction (time-based or count-based) over
      a `LiveSeries`
- [x] `LiveSource<S>` interface — common contract for LiveSeries and LiveView
- [x] `LiveView<S>` — derived view with `filter()`, `map()`, `select()`,
      `window()`, composable with all live transforms via `LiveSource`
- [x] `LiveAggregation` and `LiveRollingAggregation` accept any `LiveSource<S>`, not just
      `LiveSeries<S>`
- [x] `LiveAggregation` and `LiveRollingAggregation` satisfy `LiveSource` for chaining
      (`name`, `schema`, `length`, `at()`, `on('event')`)
- [x] Grace period for `LiveAggregation` — delays bucket closing so
      out-of-order events within the window accumulate into their correct bucket
- [x] `LiveSeries` rejects `graceWindow > retention.maxAge` at construction
      (v0.5.11) — a late event accepted within grace but older than `maxAge`
      would be evicted immediately by retention; the grace contract was a lie
      in that config.

Remaining:

- [x] per-event views: `diff`, `rate`, `pctChange` (stateless, prev→curr)
- [x] carry-forward views: `fill`, `cumulative` (small state per column)
- [x] docs page for live transforms

### Queued: late-event propagation

`graceWindow` is honored at two boundaries and nowhere else:

- ✅ `LiveSeries` ingest — rejects events older than `latest - grace`
- ✅ `LiveAggregation` bucket closure — buckets stay open until
  `watermark - grace`, so late events within grace land in the correct bucket

But a late event accepted at ingest does **not** re-flow through downstream
live transforms:

- ❌ `LiveRollingAggregation` — a reordered insertion becomes a fresh output
  event at its insertion point; the method does not re-scan historical
  windows to include the late event
- ❌ `LiveView.window()` — eviction is not re-applied when an event is
  reordered into the view; a late event "outside the window" sticks around
- ❌ Subscriber notifications — the `event` callback fires identically for
  on-time and out-of-order arrivals; there is no "this was late" payload
  for downstream transforms to key off of
- ❌ React hooks inherit all of the above

Fixing this is a real project, not a small patch. It would likely require
either a new event payload shape (`{ event, kind: 'append' | 'reorder' }`)
or a full patch-event model, and each stateful live transform would need
a recompute path. See Akidau's
[Streaming 102](https://www.oreilly.com/radar/the-world-beyond-batch-streaming-102/)
for the broader picture of what full late-event correctness looks like.

For now, document the scope honestly: `LiveSeries` tolerates moderate
late-event reordering for ingest and bucketed aggregation; stateful live
transforms assume in-order arrival. Callers who need late-event correctness
through rolling windows should batch their work into `TimeSeries` and use
the batch API.

Concrete next steps when this work begins:

- [ ] Add a discriminated `event` payload: `{ event, position: 'append' | number }`
      so downstream transforms know an insertion was reordered and at what
      index
- [ ] Plumb the reorder signal into `LiveRollingAggregation`; decide whether
      to recompute all windows overlapping the insertion, or mark them stale
      and defer until next observer read
- [ ] Do the same for `LiveView.window()` eviction re-evaluation
- [ ] Test matrix: `graceWindow + retention`, `graceWindow + rolling`,
      `graceWindow + window view`, `graceWindow + nested transforms`

### Queued: live merge / join

Multiple `LiveSeries` instances cannot be combined into a single live source
today. There is no `LiveSeries.merge(a, b)` (interleave events from same-schema
sources) and no `LiveSeries.join(a, b)` (join cross-schema sources by time
proximity into a wider schema). The batch API has `series.join(other, ...)`
and a manual `mergeWideRows` recipe documented for charting; the live side
has neither.

The dashboard use case that surfaces this: overlaying two metrics from
separate WebSockets onto one chart (e.g. `cpu` and `memory` arriving as
independent streams that need to render as `{ ts, cpu, memory }` rows). The
dashboard agent asked for `mergeWideRows` to be re-exported as a workaround;
the deeper ask is a live join.

Why it's deferred:

- **Subscription fan-in.** A live join needs to subscribe to N upstream
  sources and emit events on its own schedule (per-source push? buffered
  flush? watermark-driven?). The choice has user-visible latency and ordering
  consequences.
- **Time alignment.** Cross-source joins almost never have exactly-aligned
  timestamps. Either we expose a tolerance window (`{ within: '50ms' }`),
  carry-forward fill, or push the alignment problem to the caller via a
  required `align()` step. Each option has different memory and correctness
  trade-offs.
- **Schema conflict.** Same as batch `join` — two columns called `value` on
  both sides need a prefix or rename strategy. Live join inherits this.
- **Interaction with grace / retention / late events.** A late event on
  source A may need to retroactively emit a join row with the prevailing
  source-B value at that timestamp. This compounds the late-event scope gap
  above.

For now, document the scope honestly: callers who need to combine live
sources for rendering should snapshot each source independently and use the
batch `join()` on the resulting `TimeSeries` instances. The throttled
re-snapshot at the React layer makes this cheap enough for typical dashboard
cadences (`useSnapshot` on each source + `useMemo` over both for the joined
result; `useDerived` is single-source only today). See
[Charting → Live: snapshot-then-batch-join](website/docs/pond-ts/transforms/charting.mdx)
for the worked pattern.

Concrete next steps when this work begins:

- [ ] Decide the surface: `LiveSeries.merge(a, b, ...)` for same-schema
      interleave, `liveA.join(liveB, options)` for cross-schema. Mirror the
      batch shape where possible.
- [ ] Pick a time-alignment story: tolerance window vs. carry-forward fill
      vs. caller-supplied `align()`.
- [ ] Define emission cadence: emit on every upstream push (high frequency)
      vs. emit on watermark advance (lower latency variance).
- [ ] Schema conflict: reuse the batch `onConflict: 'error' | 'prefix'`
      contract verbatim.
- [ ] Decide what late events on one input do to already-emitted join rows
      — defer to the late-event work above, or carve out an in-order-only
      contract for the first cut.

### Shipped: batch dedupe — `series.dedupe({ keep })`

Real-world ingest produces duplicate events: WebSocket replays, Kafka
at-least-once semantics, retried HTTP fetches, polling overlaps.
v0.9.0 (PR 3 of the wave) ships the **batch** dedupe primitive:

```ts
series.dedupe(); // default: keep last
series.dedupe({ keep: 'first' });
series.dedupe({ keep: 'error' }); // throw on duplicates
series.dedupe({ keep: 'drop' }); // discard all events at any duplicate timestamp
series.dedupe({ keep: { min: 'cpu' } }); // keep smallest at named numeric column
series.dedupe({ keep: { max: 'cpu' } });
series.dedupe({ keep: (events) => events[0] }); // custom resolver

// Multi-entity: pair with partitionBy so the key includes the entity column.
series.partitionBy('host').dedupe({ keep: 'last' }).collect();
```

Decisions made:

- **Default key is timestamp alone.** Multi-entity series are
  expected to compose with `partitionBy` rather than have an `on`
  option on `dedupe` itself — `partitionBy` is the project's
  canonical entity-segregation primitive. Adding `on` would
  duplicate that vocabulary.
- **Default `keep` is `'last'`.** Matches WebSocket replay
  intuition: a retried event supersedes the prior occurrence.
- **`min`/`max` take a column reference.** Bare `'min'`/`'max'`
  strings can't carry the column to evaluate; the object form
  (`{ min: 'col' }`) is one extra brace and removes ambiguity.
- **`'drop'` discards the entire bucket.** The value of "1.5 events
  at this timestamp" is rarely defensible. `'drop'` is the
  conservative choice when duplicates indicate untrustworthy data.
- **Custom resolver gets the array.** Two-event reducer (`(a, b) =>
Event`) is more streaming-friendly but less flexible; `(events)
=> Event` lets callers compute averages, medians, etc. Batch can
  afford the array.
- **Custom resolver only invoked for buckets ≥ 2.** Single-event
  buckets pass through untouched without function call overhead.

### Queued: live dedupe (LiveSeries)

The **live** ingest-time story is still open. The PR-3 batch
primitive is a clean shape for it to converge on (`keep: 'first' |
'last' | 'error' | 'drop' | { min/max } | fn`), but live raises
its own questions:

- **Live update vs. emit?** When a duplicate-key event arrives in
  last-wins mode, do we update the in-place event (and notify
  subscribers via a separate `'replace'` event), or treat the new
  one as the canonical event and the old one as evicted? The
  in-place mutation breaks immutability; the evict-and-emit path
  is heavier but stays consistent with the rest of the model.
- **Interaction with grace + retention.** A late event whose key
  already exists in the buffer is a duplicate by definition under
  this design. The grace window already buffers late arrivals;
  dedupe should fold into that window rather than be a separate
  pre-filter. Likely shape: at the close of the grace window for a
  given timestamp, the buffered events are passed through the
  configured `keep` policy and the survivor is emitted.
- **Subscribers:** does dedupe surface a `'duplicate'` event so
  metrics / logging can react? Probably yes.

Concrete next steps when this work begins:

- [ ] Spec live API shape: separate `dedupe` option vs. third
      `ordering` mode. Lean separate-option since dedupe is
      orthogonal to ordering.
- [ ] Plumb through `LiveAggregation` / `LiveRollingAggregation` —
      a duplicate that arrives after a bucket closes is a special
      case (modify or ignore?).
- [ ] Add the `'duplicate'` (and possibly `'replace'`) event type
      to the subscriber surface.
- [ ] Decide grace-window interaction shape (likely:
      dedupe-at-close).

### Shipped: cross-entity correctness via `partitionBy`

The cross-entity hazard turned out to be widespread — almost every
stateful pond-ts transform (`fill`, `align`, `rolling`, `smooth`,
`baseline`, `outliers`, `diff`, `rate`, `pctChange`, `cumulative`,
`shift`, `aggregate`) silently mixes data across entities on a
multi-entity series. Three independent agent runs (Codex, Claude,
Gemini) converged on the issue via `fill('linear')` interpolating
across host boundaries.

Initially scoped as a `fill({ partitionBy })` option. Reframed
because the hazard isn't a `fill` quirk — it's class-wide. Adding
a `partitionBy` option to every affected method would have meant
twelve more options to maintain.

**Solution: `series.partitionBy(col)` chainable primitive.** Returns
a `PartitionedTimeSeries<S>` view with sugar methods for each
affected operator — each one runs the underlying transform per
partition and reassembles via `TimeSeries.concat`. One primitive,
covers all twelve at-risk operators. Shipped in v0.9.0 (PR 1 of
the v0.9.0 wave).

```ts
ts.partitionBy('host').fill({ cpu: 'linear' }).collect();
ts.partitionBy('host').rolling('5m', { cpu: 'avg' }).collect();
ts.partitionBy(['host', 'region']).aggregate(seq, { cpu: 'avg' }).collect();

// Persistent partition — chained per-partition ops without re-partitioning:
ts.partitionBy('host').dedupe(...).fill(...).rolling(...).collect();

// Escape hatch — terminal, returns TimeSeries directly (no .collect):
ts.partitionBy('host').apply((g) => g.fill(...).rolling(...));
```

Decisions made:

- Chainable view (not an option on every method) for surface-area
  discipline.
- Sugar methods return another `PartitionedTimeSeries` so multi-step
  per-partition workflows compose cleanly. `.collect()` is the
  terminal materialize-to-`TimeSeries` step. Pivoted away from the
  initial "always returns `TimeSeries`" design after agent feedback
  showed multi-step chains as the common case.
- Composite partitioning supported via array (`partitionBy(['a',
'b'])`).
- `apply(fn)` escape hatch is terminal (returns `TimeSeries<R>`
  directly) for arbitrary per-partition transforms.

**Bonus fix.** Discovered and fixed a pre-existing brand-check bug
where `series.filter(...).diff(...)` and similar chains failed with
"Receiver must be an instance of class TimeSeries." Root cause:
`#diffOrRate` was a JS-`#`-private method, which fails the brand
check on instances built via `#fromTrustedEvents` (which uses
`Object.create` to bypass constructor validation). Surgical fix:
demote `#diffOrRate` to TS-private (compile-only, no runtime brand
check). Regression test added in
`test/TimeSeries.diff-rate-brand.test.ts`.

### Shipped: `fill` improvements (`maxGap`, all-or-nothing semantics)

The original Codex friction on `fill` had two parts:

- Cross-entity leakage — solved by `partitionBy`, see above.
- **Long-gap policy** — `series.fill('linear', { limit: 3 })`
  formerly filled 3 cells of a 30-cell gap, "fabricating" interpolated
  data across what's actually a long outage. Codex wanted "don't fill
  at all if the gap exceeds N."

Shipped in v0.9.0 PR 2:

- [x] `maxGap: DurationInput` option as a duration-based gap cap.
      `limit` is count-based, `maxGap` is time-based, both compose
      (most restrictive wins).
- [x] All-or-nothing semantics: a gap either fits the caps and gets
      filled entirely, or exceeds them and is left fully unfilled.
      Strictly behavioral change for callers who relied on partial
      fill — flagged in the v0.9.0 release notes.
- [x] No `mode` option — always all-or-nothing. The user's argument:
      "a big gap is never going to benefit from a few points being
      filled in." Partial fill was a confused default.

Implementation: replaced the per-strategy switch (which tracked
`consecutive` per cell) with a unified gap-walker. Each gap is
detected once; size caps and strategy-feasibility (linear needs both
neighbors, hold needs prev, bfill needs next) are checked once;
the gap is filled or skipped atomically. ~50 LOC reduction net,
clearer code.

### Queued: `series.materialize(sequence, options?)` — regularize without filling (v0.10 PR 1)

Round-2 agent feedback (Codex retest of v0.9.0) surfaced a real gap:
`fill()` patches `undefined` cells in an existing event sequence
but never creates new rows; `align()` materializes a grid AND picks
a fill method (`hold` or `linear`) — there's no way to do the
first without the second. This forced Codex to either accept
`align`'s implicit fill choice or hand-roll a grid-completion
pass before applying gap-capped `fill('linear', { maxGap: '3m' })`.

`materialize` does only step one: emit one time-keyed row per
sequence bucket, populate value columns from the chosen source
event in that bucket, leave value columns `undefined` for empty
buckets. The natural composition with `fill()`:

```ts
series
  .partitionBy('host')
  .dedupe({ keep: 'last' })
  .materialize(Sequence.every('1m')) // regularize, undefined for empty buckets
  .fill({ cpu: 'linear' }, { maxGap: '3m' }) // fill with explicit policy
  .collect();
```

**Spec:**

```ts
materialize(
  sequence: Sequence | BoundedSequence,
  options?: {
    sample?: 'begin' | 'center' | 'end';      // bucket anchor for output time
    select?: 'first' | 'last' | 'nearest';    // which source event in each bucket wins
    range?: TemporalLike;                      // bounded slice for procedural sequences
  },
): TimeSeries<MaterializeSchema<S>>
```

**Defaults:** `sample: 'begin'` (matches `align`), `select: 'last'`
(matches `dedupe`'s "newer reading wins" intuition).

**`select` semantics — bucket-bounded.** All three options use
half-open `[bucket.begin, bucket.end)` membership. `'first'` /
`'last'` pick the boundary source event in the bucket;
`'nearest'` picks the source event closest to the `sample`
timestamp **among events in the bucket**. Empty bucket → all
value cells `undefined` regardless of `select`. Users who want
to reach across empty buckets compose `fill('hold')`
afterwards.

**Schema:** `MaterializeSchema<S>` widens value columns to
optional (parallel to `AlignSchema<S>`) since empty buckets emit
`undefined` cells.

**Partitioned variant — bonus.**
`series.partitionBy('host').materialize(seq)` auto-populates the
partition columns on every output row, including empty-bucket
rows — `host`'s value is known by virtue of which partition we're
in. Eliminates a sharp edge that would otherwise force a
`.fill({ host: 'hold' })` step that fails for partitions where
every event is in a long-outage gap. Tiny extra branch in the
partitioned row builder.

**Why a new primitive (not enrichment of existing ones):**

- `align()` mandates a fill method; relaxing that contract is a
  breaking semantic change.
- `aggregate(seq, { *: 'last' }).asTime()` is mathematically
  equivalent for `select: 'last'` (and would require a `'*'`
  shorthand), but conflates "summarize this column" with
  "regularize timestamps." Different intent at the call site.
- The "regularize without choosing fill" use case is the natural
  pre-step to `fill(maxGap)`, and clean composition is the whole
  point.

**Naming.** `materialize` reads naturally (parallel with the
database-view sense of "make this concrete on a grid"). Survives
the lazy-eval connotation since pond-ts is eager throughout.
Better than the alternatives considered: `completeOn` (overlaps
with promise terminology), `densify` (jargon-y, has prior art in
geo libs), `toGrid` (pond-ts `to*` methods conventionally return
non-`TimeSeries` shapes — `toJSON`, `toRows`, `toPoints`).

**Concrete next steps when work begins (PR 1 of v0.10):**

- [ ] Add `materialize` to `TimeSeries` and the `PartitionedTimeSeries`
      sugar (with partition-column auto-fill).
- [ ] `MaterializeSchema<S>` type — value columns widened to optional.
- [ ] Test matrix: empty source, single source on a multi-bucket
      grid, sub-bucket events with each `select` mode, empty
      buckets, off-grid events, partitioned variant preserves
      partition values, full chain (`partitionBy + dedupe +
materialize + fill(maxGap) + collect`).
- [ ] Cleaning page rewritten to lead with the
      `partitionBy + dedupe + materialize + fill` chain as the
      canonical multi-host cleaner.

### Queued: live partitioning — `LivePartitionedSeries` (v0.11 wave)

Same cross-entity hazard exists on the live side.
`LiveRollingAggregation`, `LiveAggregation`, `LiveView.window()`,
and live `diff`/`rate`/`pctChange`/`fill`/`cumulative` all read
from neighboring events and silently mix entities on a multi-host
stream. Dashboard-agent feedback (post-v0.9.0) flagged this
explicitly: their workaround was a hand-rolled per-host filter
view, which doesn't compose with the rest of the live API.

**Design (settled):**

Surface mirrors batch: `liveSeries.partitionBy(col)` returns
`LivePartitionedSeries<S>` with chainable sugar for each affected
operator. `.collect()` materializes back to a unified `LiveSeries`.
`.apply(fn)` is the terminal escape hatch.

```ts
const live = useLiveSeries(source, { maxAge: '5m' });

const cpuSmoothed = live
  .partitionBy('host')
  .fill({ cpu: 'linear' })
  .rolling('1m', { cpu: 'avg' })
  .collect();
// cpuSmoothed is a LiveSeries — events from all hosts interleaved
// by arrival, each with its host's per-partition rolling avg.
```

Decisions made in design review:

- **Per-partition retention.** `maxAge: '5m'` applies to each
  partition independently. A chatty host can't squeeze a quiet
  one out of the buffer.
- **Per-partition grace.** Late events route to their own
  partition's grace window; a late event for host-A doesn't
  perturb host-B's emission.
- **Per-partition aggregation timing.** Host-A's rolling avg
  fires when host-A has enough data, regardless of host-B.
- **Auto-spawn on new partition values.** New host appears →
  allocate a sub-buffer on first event. Optional `{ groups: HOSTS
as const }` upfront for typed narrowing (mirrors the batch
  typed-groups pattern from v0.10 PR 3).
- **Unified eviction stream.** Subscribers see one `'evict'` event
  stream with the partition column populated on each event;
  consumers can filter if they want per-partition handling.

**Cost model:** per-partition state means `N × per-window-buffer`
for rolling/baseline, `N × prev-event` for diff/rate/cumulative,
etc. For 1000 hosts × 1m rolling at 1Hz: ~60k floats. Fine for
typical telemetry; document in the operator JSDocs alongside
the existing per-method warnings.

**Two-PR split:**

**v0.11 PR 1 — `LivePartitionedSeries` view + four most-used
sugar methods.** `fill`, `rolling`, `diff`, `rate` — the
operators dashboard agent named explicitly. Chainable view +
`.collect()` + `.apply()`. Per-partition state map on the source
side; React hook `useLiveSeries(...).partitionBy(col)` works
naturally without a new hook (the view is a property of
`LiveSeries`).

**v0.11 PR 2 — Remaining operator coverage.** `smooth`,
`baseline`, `outliers`, `cumulative`, `shift`, `aggregate`,
`dedupe`. Each follows the same pattern as PR 1 — state allocated
per-partition, output aggregated per-partition, results
interleaved by arrival.

Then **v0.11.0 release** with the full live partitioning package.

For now (until v0.11): snapshot via `useSnapshot` (or
`live.toTimeSeries()`) and use batch `partitionBy`. Throttled
snapshots make this cheap enough for typical dashboard cadences;
it's not free for high-frequency streams.

### Batch → Live applicability

Not every batch `TimeSeries` method needs a live equivalent. The live layer is
about ingestion and incremental computation — when you need the full analytical
toolkit, snapshot to `TimeSeries` and use the batch API.

| Batch method      | Live?    | Notes                                                    |
| ----------------- | -------- | -------------------------------------------------------- |
| `filter(pred)`    | **done** | LiveView                                                 |
| `map(fn)`         | **done** | LiveView                                                 |
| `select(...cols)` | **done** | LiveView, schema-narrowing                               |
| `aggregate()`     | **done** | LiveAggregation (bucketed)                               |
| `diff(...cols)`   | **done** | stateless view, needs previous event                     |
| `rate(...cols)`   | **done** | stateless view, delta / time gap                         |
| `pctChange()`     | **done** | stateless view, (curr-prev)/prev                         |
| `fill(strategy)`  | **done** | carry-forward state per column (hold, zero, literal)     |
| `cumulative()`    | **done** | carry-forward state per column (sum, max, min)           |
| `rename(mapping)` | skip     | achievable with `map()`                                  |
| `collapse()`      | skip     | achievable with `map()`                                  |
| `rolling()`       | covered  | `LiveRollingAggregation` as chainable source (see below) |
| `smooth()`        | covered  | EMA is a closure in `map()`; MA is rolling avg           |
| `shift(col, n)`   | maybe    | needs lookback buffer, niche for live                    |
| `align()`         | no       | resampling assumes complete data                         |
| `join()`          | **gap**  | real ask, queued — see "live merge / join" above         |
| `dedupe()`        | **gap**  | new primitive needed both sides — see "deduping" above   |
| `groupBy()`       | no       | partitioning is a source-level concern                   |
| `within/trim`     | no       | temporal selection — snapshot then slice                 |
| `reduce()`        | no       | whole-series → scalar — that's `LiveRollingAggregation`  |

### Chainable stateful transforms

`LiveAggregation` emits closed buckets. `LiveRollingAggregation` emits per-event aggregate
values. Both should implement `LiveSource<S>` so their output can feed further
views:

```ts
live
  .filter((e) => e.get('host') === 'api-1')
  .aggregate(Sequence.every('1m'), { value: 'avg' })
  .filter((e) => (e.get('value') as number) > threshold)
  .on('event', alertBucket);
```

For `LiveAggregation`, the output events are interval-keyed (closed buckets).
For `LiveRollingAggregation`, each source event produces a new time-keyed output event with
the current sliding-window aggregate. This makes LiveRollingAggregation-as-source the live
equivalent of `rolling()` — no separate class needed.

Similarly, `LiveSmooth` is not needed as a dedicated class: EMA is a stateful
closure inside `map()`, and moving average is `LiveRollingAggregation`-as-source with
`'avg'`.

### Views

`filter`, `map`, `select`, and `window` return `LiveView` — a derived view
that subscribes to its source's event stream and forwards processed events.

**Stateless views** (`filter`, `map`, `select`) apply a per-event transform.
**Bounded views** (`window`) add eviction to keep the buffer within a time or
count limit.

Planned per-event views (`diff`, `rate`, `pctChange`) carry one value per
column from the previous event. Planned carry-forward views (`fill`,
`cumulative`) carry state that accumulates across events. Both fit the LiveView
model — the `process` function closes over the state.

### Accumulators

**`LiveAggregation`**: maintains pending buckets (accumulating), a watermark
(highest timestamp seen), and an optional grace period. A bucket closes when
its `end <= watermark - grace`. With zero grace (default), buckets close
immediately on boundary crossing — matching the behavior before grace was
added. With grace > 0, multiple buckets can be pending simultaneously, and
late events within the grace window route to their correct bucket instead of
being lost.

`.closed()` returns only finalized buckets; `.snapshot()` includes all
pending buckets as provisional results. As a `LiveSource`, `at(index)` and
`length` expose the closed-bucket event buffer; `on('event', fn)` fires
when a bucket finalizes.

```ts
new LiveAggregation(
  source,
  Sequence.every('1m'),
  { value: 'avg' },
  { grace: '5s' },
);
```

**`LiveRollingAggregation`**: maintains a sliding-window reduction. Supports both
time-based windows (`'5m'`) and count-based windows (`100`). Uses
`RollingReducerState` from the reducer registry for incremental add/remove.
As a `LiveSource`, each source event produces an output event containing the
current aggregate value at that point. The output buffer grows with each
source event (downstream consumers can use `.window()` to bound it).
`on('event', fn)` fires per source event with the new aggregate.

| Transform                | Live behavior                          | Owns a buffer? | Chainable? |
| ------------------------ | -------------------------------------- | -------------- | ---------- |
| `filter/map/select`      | Per-event transform                    | Yes (view)     | Yes        |
| `window`                 | Bounded view with eviction             | Yes (view)     | Yes        |
| `diff/rate/pctChange`    | Per-event with prev-event state        | Yes (view)     | Yes        |
| `fill/cumulative`        | Per-event with carry-forward state     | Yes (view)     | Yes        |
| `LiveAggregation`        | Accumulator per bucket + closed stream | Yes            | Yes        |
| `LiveRollingAggregation` | Sliding window + per-event output      | Yes            | Yes        |

### LiveSource interface and LiveView

`LiveSource<S>` is the common interface that all live objects expose for
downstream consumers: `name`, `schema`, `length`, `at(index)`, and
`on('event', fn)`. Both `LiveSeries` and `LiveView` satisfy it, so
`LiveAggregation` and `LiveRollingAggregation` accept any `LiveSource<S>`.

`LiveView<S>` wraps a source with a `process: (event) => event | undefined`
function. If `process` returns `undefined`, the event is filtered out. This
unifies filter (predicate → event or undefined) and map (transform → always
returns event) in one class.

Views maintain their own buffer of processed events for O(1) `at()` and
`length`. Views mirror evictions from their source: when a retention-capped
`LiveSeries` evicts old events, downstream views (filter, map, etc.) remove
corresponding events automatically. This prevents unbounded growth on
filtered/mapped views of a retention-capped source. Detection uses the
`EMITS_EVICT` symbol to safely identify sources that fire `'evict'` events
(avoids duck-typing `on('evict')` which breaks on `LiveAggregation`).

**`select`** narrows the schema. The output `LiveView` has a different schema
type from the input. The constructor accepts an optional output schema for this
case; filter/map omit it (schema is inherited).

**`window`** bounds the view by time or event count. Uses an eviction function
that runs after each event is added. Time-based windows evict events whose
timestamp is below `latest - duration`. Count-based windows keep the last N
events. Unlike retention on `LiveSeries`, window is a query over the data, not a
memory policy — you can keep a large source buffer but view a narrow window.

Views compose by stacking:

```ts
live.filter(pred).select('cpu', 'mem').window('5m').aggregate(seq, mapping);
```

Each view subscribes to its source's `'event'` stream and forwards processed
events to its own subscribers.

### Composition

Views, accumulators, and further views compose naturally:

```ts
live
  .filter(pred)
  .select('cpu', 'mem')
  .window('5m')
  .aggregate(Sequence.every('1m'), { cpu: 'avg' })
  .filter((e) => (e.get('cpu') as number) > threshold);
```

Multiple consumers fan out from one source with shared buffer but separate
state.

**Windowed snapshots**: `live.window('5m')` returns a view backed by the same
source, materialized on `.toTimeSeries()`. Window boundary is relative to
latest event timestamp, not wall-clock.

### Queued: snapshot/append primitives on `LiveSeries`

Surfaced by the gRPC experiment's M1 milestone (WebSocket bridge,
[pond-grpc-experiment#3](https://github.com/pjm17971/pond-grpc-experiment/pull/3)).
`LiveSeries` is missing the parallel JSON / typed-row APIs that
`TimeSeries` already has. The aggregator and browser today hand-
roll per-row push loops, manual column-by-column serialization in
the batch listener, and an unsafe `live.push(row as never)` cast on
the wire→push path. Schema-evolution self-test confirms the cast is
the lone hole where a column rename or addition silently passes
type-check.

Next PR adds **codec-agnostic primitives** plus **JSON sugar over
them**:

| Layer                                    | Methods                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Primitives (typed-tuple, codec-agnostic) | `LiveSeries.toRows()`, `LiveSeries.toObjects()`, `LiveSeries.pushMany(rows)`, `Event.toRow(schema)`    |
| JSON sugar                               | `LiveSeries.toJSON()`, `LiveSeries.fromJSON()`, `LiveSeries.pushJson(rows)`, `Event.toJsonRow(schema)` |

Closes M1 friction notes #1 (`LiveSeries.toJSON()` missing), #2
(batch listener delivers `Event` objects, not rows), #4 (the
`as never` push hole — `pushJson` validates a `JsonRowForSchema<S>`
and translates `null → undefined`), and #5 (no `pushMany` /
`fromJSON`).

**Partial follow-up (post-v0.11.5):** friction note #3 was
re-attempted with distinct named return types
(`TimeSeriesJsonOutputArray<S>` / `TimeSeriesJsonOutputObject<S>`)
in place of `TimeSeriesJsonInput<S> & { rows: ... }` intersections.

- **`LiveSeries.toJSON` narrowing landed.** Overloads keyed on
  `rowFormat` work cleanly; the impl casts the inner
  `toTimeSeries().toJSON()` result. `test-d/liveseries-tojson-narrowing.test-d.ts`
  pins it. For the live snapshot path — the common case for
  networked consumers — the ergonomic win is there.
- **`TimeSeries.toJSON` narrowing still cascades.** Adding the same
  overload pair triggers TS2394 errors at four unrelated overload
  sets (`pivotByGroup`, `rolling`, `arrayAggregate`, `arrayExplode`).
  Cause-and-fix isolated has defeated multiple time-boxes. The
  cascade is reproducible whether the impl signature returns a
  union, `any`, or the broad `TimeSeriesJsonInput<SeriesSchema>` —
  it's specific to `TimeSeries.toJSON`'s shape, not the impl. The
  inline JSDoc records this. Re-attempt if a TypeScript upgrade
  or a refactor of one of those four overload sets unblocks it.

  **Alternative path worth trying first:** extract the toJSON
  serialization body into a module-level helper
  (`serializeToJSON<S>(events, schema, rowFormat)`) called by both
  `TimeSeries.toJSON` and `LiveSeries.toJSON` (replacing the
  current `live.toTimeSeries().toJSON(...)` indirection). Each
  class becomes a thin narrowed wrapper over the helper. The
  cascade trigger is sensitive to `TimeSeries.toJSON`'s in-class
  shape; pulling the body out may bypass it without needing a
  TypeScript upgrade. Cheaper than waiting on a compiler fix and
  unblocks the unified narrowing story for batch consumers too.

**Friction note #7 follow-up (events-per-second ergonomics).**
The original friction was "useCurrent(live, { cpu: 'count' }, { tail: '1m' }).cpu / 60
is awkward." Investigated as a column-free count earlier and
deemed solvable in user code; revisited with a stronger ergonomic
target.

Landed (queued for the next patch release):

- **`LiveView.count()` and `LiveView.eventRate()`** terminal
  accessors. `live.window('1m').count()` and
  `live.window('1m').eventRate()` read the current window count
  and events/sec directly. `eventRate` is the per-window-events-
  per-second operator, deliberately distinct from
  `LiveView.rate(columns)` (the per-column derivative).
  `eventRate` requires a time-based window — `window(N)`
  count-based windows throw at the call site (no denominator).
- **`@pond-ts/react` ships `useEventRate(source, '1m')`** — a
  reactive hook returning the events-per-second number,
  throttled on `'event'` like `useSnapshot`. Single hook
  replaces `useCurrent + custom division`.

The hook works because `LiveView.window(duration)`'s eviction is
arrival-driven: count and rate update on each push, which is when
display matters. Same staleness-at-zero-rate caveat as rolling —
documented at the call site.

**Friction note #6 (count semantics) — investigated, not a bug.**
Empirical reproduction across nine scenarios (LiveSeries push
variadic + per-row, TimeSeries construction, reduce, aggregate,
rolling, LiveAggregation, LiveRollingAggregation, plus the exact
"dashboard defaults: 480 events at 8/s" case) shows the library
preserves duplicate temporal keys and counts them independently at
every layer. The friction-noted "count collapses same-ts events"
diagnosis was empirically wrong; the agent's stagger workaround in
the simulator probably wasn't necessary for the reason claimed.

`test/duplicate-keys.test.ts` locks down the behavior so a future
regression breaks visibly. `count` reducer JSDoc updated to call
out duplicate-key semantics explicitly.

**Deliberately NOT in scope: pluggable codec adaptors.** The
ergonomic shape we're considering for codecs (msgpack, protobuf) is
a `using:`-keyed export/import:

```ts
ws.send(live.export({ using: MessagePackAdaptor }));
const live = LiveSeries.import(bytes, { schema, using: ProtoAdaptor });
```

Tempting to ship the `Adaptor` interface alongside the JSON case as
a "default codec," but several open design questions only get
answered by working code:

- **Per-row vs per-snapshot semantics.** Protobuf likely wants
  per-row (one message per `call.write`); msgpack wants whole-array
  encoding. The interface needs to support both without forcing
  either side into ugly wrapping.
- **Schema-passing semantics.** Protobuf needs the message type;
  JSON / msgpack don't. Pass schema as a second arg, or parameterize
  the adaptor instance with the proto descriptor at construction?
- **Streaming.** Does `Adaptor.encode` need to support streaming
  for huge snapshots, or always return a whole `Uint8Array`?

**Decision: extract `Adaptor` from working code post-M2.** The
gRPC experiment's M2 builds protobuf-on-gRPC for the producer
hop; M3+ may add msgpack-on-WebSocket. Once two real codecs exist
in user-land, we have the shape data to define the contract. Pre-
shipping `Adaptor` now would lock in answers we'd otherwise extract.
The codec-agnostic primitives above (typed tuples in/out) are
sufficient to build M2 with — no library work blocks the experiment.

When the time comes, `Adaptor` likely lives in a separate package
(`@pond-ts/adaptors` or similar) so codec libs don't get pulled
into pond-ts core. The default JSON path stays directly on
`LiveSeries.toJSON()` / `pushJson()` / `fromJSON()` — the most
common case shouldn't pay an adaptor-indirection tax.

### Shipped: `rolling.sample(sequence)` — sequence-triggered rolling snapshot (v0.11.8, superseded by v0.12 triggers)

> **Status note (2026-05-01):** `.sample()` and
> `LiveSequenceRollingAggregation` shipped in v0.11.8 and were deleted
> in v0.12.0. The use case is preserved as
> `live.rolling('1m', m, { trigger: Trigger.clock(seq) })` — same
> emission semantics, no separate class. Migration is a one-line
> change in the webapp telemetry track. The design history below is
> retained because the reasoning ("composition, not fusion") still
> applies and informed the v0.12 trigger factoring.

A frontend telemetry use case (collect latency events at high rate,
report p95 to a backend every 30 s, also display it live in the UI)
surfaced a gap. `LiveRollingAggregation` emits per source event — too
noisy for backend reporting. The batch layer has
`series.rolling(Sequence.every('30s'), '1m', mapping)` for the
"sampled rolling" shape, but the live layer didn't.

`rolling.sample(sequence)` fills it without conflating two operations:

```ts
const rolling = timings.rolling('1m', { latency: 'p95' });

// Backend report every 30 s of event time
const reported = rolling.sample(Sequence.every('30s'));
reported.on('event', (e) =>
  fetch('/api/telemetry', { method: 'POST', body: JSON.stringify(e.data()) }),
);

// Same rolling drives the in-app display, no duplicated state
useLiveQuery(timings, () => rolling.value());
```

**Design decisions:**

- **Composition, not overload.** An earlier iteration tried a
  `live.rolling(Sequence, '1m', mapping)` overload mirroring the batch
  shape exactly. The implementation revealed the misfit: the overload
  had to allocate a hidden inner rolling and track ownership with an
  `ownsRolling` flag to avoid leaking source subscriptions on dispose,
  and the hidden rolling locked away state the user might want to read
  directly (the in-app display case). Keeping the two operations
  separate — `live.rolling(...)` returns a rolling, `rolling.sample(seq)`
  taps it for sequence-triggered snapshots — gives the user one
  reference per concern with no hidden ownership.
- **Honest naming.** "sample" describes what the operation actually
  does (snapshot at sequence boundaries), versus "rolling" which would
  imply a dense grid the live emission doesn't deliver.
- **Data-driven, not timer-driven.** Emission happens when source
  events cross an epoch-aligned boundary. If no events arrive during
  an interval, no event is emitted. Consistent with "data is the
  clock"; no `setInterval` inside the library.
- **Independent lifetimes.** `sample.dispose()` only detaches the
  sampler from the rolling. `rolling.dispose()` is the user's
  responsibility. One rolling can power multiple downstream consumers
  (multiple `.sample()` cadences for different reporting endpoints,
  plus direct `rolling.value()` reads) without coupling.
- **`LiveSequenceRollingAggregation` is a full `LiveSource`.**
  Implements `name`, `schema`, `length`, `at()`, `on('event')`.
  Supports the same view-transform set as `LiveRollingAggregation`
  (filter, map, select, window, diff, rate, pctChange, fill,
  cumulative, rolling, aggregate) for downstream chaining.
- **Output is time-keyed** at epoch-aligned boundaries (e.g.
  `Sequence.every('30s')` → 0, 30 000, 60 000 … ms).
- **Snapshot timing.** `rolling.value()` is read after the
  boundary-crossing event has been ingested by the rolling, so the
  emitted aggregate includes that event's contribution.

### Deferred from this wave

- **Cheap-sampling primitive on `LiveSeries` / `LiveView`** —
  considered and **deliberately not generalized as `.sample()`**. The
  rolling version of `.sample()` snapshots a stateful aggregate
  (`rolling.value()`) at boundaries; a raw `LiveSeries` has no such
  state — the operation would be "emit the most-recent event in each
  bucket" or "emit every Nth event," both of which are inherently
  lossy. Reusing the `.sample()` verb would conflate two different
  operations: principled-aggregate-snapshot vs cheap-stream-thinning.

  If a real use case appears (debugging firehose streams, prototype
  back-pressure relief, ad-hoc data reduction without an aggregation
  decision), it warrants its own primitive with an honest name —
  candidates like `.lastPerBucket(sequence)`, `.throttle(sequence)`,
  or `.everyNth(n)` telegraph "this is lossy by design." The
  asymmetry of `.sample()` only existing on `LiveRollingAggregation`
  is therefore intentional, not a gap to be filled.

  The principled answer for almost any real reporting / dashboarding
  use case is the path that already shipped:
  `live.rolling(...).sample(seq)` — make a deliberate aggregation
  decision, then emit the reduced result at intervals.

- **`AggregateOutputMap` overload on `LiveSeries.rolling()`** —
  **shipped in v0.13.0.** The batch `series.rolling()` accepted both
  `AggregateMap<S>` (`{ existingCol: reducer }`) and
  `AggregateOutputMap<S>` (`{ alias: { from, using } }`); live
  rolling/aggregate now do too. The runtime helper
  (`normalizeAggregateColumns`) was already doing the work for batch
  — extracted to `aggregate-columns.ts` and threaded through the
  three live accumulators (`LiveRollingAggregation`,
  `LiveAggregation`, `LivePartitionedSyncRolling`) plus the public
  surface (`LiveSeries`, `LiveView`, `LivePartitionedSeries`,
  `LivePartitionedView`, plus the chainable `LiveAggregation.rolling`
  / `LiveRollingAggregation.aggregate`). Custom-function reducers
  remain batch-only — guarded at construction with a clear error
  pointing at the alias workaround. The telemetry recipe's "want
  multiple percentiles?" section was rewritten around the
  single-pass `{ p50, p95, p99 }` pattern.

- **`live.rolling(Sequence, ...)` overload.** Not coming back. The
  composition form (`live.rolling(...).sample(seq)`) is clearer about
  what's happening and avoids the hidden-ownership / leaked-listener
  footgun the overload required. Captured in the closed PR #92 as a
  deliberate blind alley.

- **`Trigger.every(duration)` sugar — shipped in v0.13.1.** Codex
  feedback after adopting v0.12 triggers in the production webapp
  telemetry app: `Trigger.clock(Sequence.every('30s'))` is "ceremony-
  heavy for the common case." Sugar added as a one-line wrapper that
  forwards `(duration, { anchor })` to `Sequence.every` internally.
  The explicit `Trigger.clock(seq)` form remains for callers who
  already hold a `Sequence` object (e.g. one shared across batch
  `series.aggregate(seq, ...)` and live triggers) — `Trigger.every`
  always builds a fresh `Sequence`. Telemetry recipe + live-transforms
  doc updated to lead with the sugar form.

- **`Trigger.clock` naming wrinkle — deferred.** Codex flagged the
  same v0.12 retrospective: "the word `clock` made me briefly expect
  wall-clock timers." Docs cleared up the data-driven semantics in
  seconds, so the friction is real but mild. Considered renaming to
  `Trigger.boundary(seq)` or `Trigger.sequence(seq)` for semantic
  precision. Held for two reasons: (1) one signal isn't enough to
  pay the migration cost across an in-flight RFC, two active
  experiments, and existing tests/CHANGELOG/docs; (2) a wall-clock
  trigger may eventually be a real ask, in which case `Trigger.clock`
  becomes a natural umbrella with `Trigger.eventClock` (current data-
  driven behaviour) vs `Trigger.wallClock` (timer-driven). Revisit if
  a second user reports the same naming friction OR if a wall-clock
  trigger lands and the umbrella naming becomes the deciding factor.

- **`Trigger.count(n)` — shipped in v0.13.2.** Second wave of Codex
  feedback after webapp-telemetry adoption. Use case: "very hot
  metrics like row stale times or handler payload sizes where event-
  time boundaries may lag during bursts, but per-event is too noisy."
  Implementation is a counter on `LiveRollingAggregation` plus a
  `case 'count'` branch in the trigger switch — `event` and `clock`
  remain unchanged. Per-partition rollings get count emission
  independently; synced partitioned rolling
  (`LivePartitionedSyncRolling`) doesn't support count because count
  semantics across partitions are ambiguous (per-partition? global?)
  and there's no killer use case for either.

- **Sub-window primitive — `rolling(...).tap(seq, mapping)` over a
  shared event buffer.** Surfaced by the gRPC experiment's
  `HostAggregator` walkback (2026-05-01) and refined in the
  2026-05-03 design pass.

  **What tap actually solves.** Two windows over the same source
  events where window B is a strict subset of window A. The custom
  HostAggregator's win wasn't ergonomic (the agent could already
  correlate two rollings via shared trigger); it was **shared buffer
  storage**. At the gRPC saturation regime (1000 partitions × kHz
  ingest), a 200ms sub-window inside a 1m parent costs ~24 KB per
  partition if it stores indices into the parent's deque, vs ~72 KB
  if it duplicates entries. At 1000 partitions that's 48 MB saved.
  At dashboard scale (50 hosts), the saving is KB. So `tap` is a
  knob for the saturation-regime user, not the typical case.

  Framing: `tap` is the right primitive **when memory dominates**,
  not "the right primitive for multi-window." Multi-window with
  separate rollings stays the default; `tap` is a perf opt-in.

  **Core mechanic.** Parent rolling holds the deque
  (`{ index, timestamp, values }`); child holds **only
  `{ index, timestamp }`** pairs over its smaller window plus its own
  reducer state. On each parent ingest, parent dispatches
  `add(idx, value)` to every registered child; child reads value
  from parent's deque at remove time. Child's window cutoff advances
  independently — child evicts entries that aged out of _its_
  window, not the parent's.

  Reducer state is fully incremental in the child (same machinery
  as `LiveRollingAggregation` today). Snapshot stays O(1) for
  built-ins; O(child-window-N) for custom functions, same perf-cliff
  story as v0.14.1.

  **API shape.**

  ```ts
  const baseline = live.rolling('1m', {
    mean: { from: 'cpu', using: 'avg' },
    sd:   { from: 'cpu', using: 'stdev' },
  });

  const current = baseline.tap('200ms', {
    now: { from: 'cpu', using: 'avg' },
  });

  baseline.on('event', e => /* baseline snapshot */);
  current.on('event', e => /* current snapshot */);
  ```

  `tap` returns a `LiveRollingAggregation<S, ChildOut>` — looks just
  like a rolling, subscribers behave the same. Same overload pattern
  as today's `rolling()`: `AggregateMap` + `AggregateOutputMap` +
  catch-all for variable-typed options. Custom functions allowed
  (post-v0.14.1).

  **Constraints.**
  - **`childWindow <= parentWindow`** — runtime check at construction.
    Type-level enforcement is hard (windows are runtime values), so
    a clear `TypeError` at construct time is the right guard.
  - **Trigger** is independent on the child; defaults to
    `Trigger.event()`. The agent's use case becomes:
    ```ts
    const baseline = live.rolling('1m', m1, {
      trigger: Trigger.every('200ms'),
    });
    const current = baseline.tap('200ms', m2, {
      trigger: Trigger.every('200ms'),
    });
    ```
    Both fire at the same 200ms tick; consumer subscribes to either or
    both and uses the shared boundary timestamp to correlate. Same
    trigger value isn't enforced — different cadences are valid.

  **Partitioned variant.** Mirrors `rolling()`'s partition behaviour.
  `live.partitionBy('host').rolling('1m', m).tap('200ms', m')`
  returns a per-partition tapped view; with a clock trigger, the
  synced rolling shape extends the same way (one row per partition
  per tick).

  **Open questions to settle pre-ship.**
  - **Tap-of-tap.** Conceptually fine — chained sub-windows form a
    tree. Allow it. Doc-note that nesting doesn't compound savings;
    every tap converges on the root parent's storage.
  - **Disposal semantics.** Dispose parent → dispose all taps. Dispose
    a tap → detach without affecting parent. State explicitly.
  - **Break-even point.** Need a benchmark showing at what
    `parent.windowMs / child.windowMs` ratio and what event rate tap
    pays for itself. Guess: ratio > ~10× and rate > ~1k ev/s/partition.
    Below that, two separate rollings are within noise. Bench answers
    "recommend by default" vs "mention as a perf knob."
  - **Vs. multi-window declarative.** Alternative shape:
    `live.rollings({ baseline: { window, mapping }, current: { ... } })`
    returning one composite accumulator. More declarative, less
    compositional. Lean `tap` (it composes — can be built on top of
    an existing rolling without redeclaring), but want a second
    user's gut reaction before locking the API. A more opinionated
    variant — `live.stats(col, { baseline: { window, using }, current:
{ window, using } })` — was sketched in a 2026-05-04 blind review
    by Codex; it's the same compositional point with the recipe
    pre-named. Keep tap as the lower-level primitive; if `stats`
    earns its keep, build it on top.
  - **`excludeCurrentFromBaseline` semantic.** When the child window
    is a strict subset of the parent's by time, the parent's
    snapshot includes events that the child is _also_ using. For
    z-score-style use cases (current vs. baseline-mean ± k·σ), this
    biases baseline toward current. Multi-window-stats consumers
    will want a knob: "compute baseline over parent minus child's
    overlap." Cheap to implement on shared storage (parent's deque
    minus the child's index range); doesn't make sense without
    shared storage. Flag as a stats-recipe option, not a tap-core
    feature.

  **Complementary axis: tile-mode summary primitive.** Codex's
  blind 2026-05-04 review surfaced an alternative direction worth
  capturing as a sibling to `tap`, not a substitute. `tap` shares
  _exact-storage_ — every event the parent retains is reusable by
  children, samples / median / exact eviction all work. **Tile
  mode** keeps a ring of fixed-duration tiles (e.g. 1s) with
  per-column composable moments (`{ n, sum, sumSq }`, optionally
  `{ min, max }`) and computes window stats by combining tile
  summaries. For a 5m baseline at 1s resolution that's 300 tile
  summaries vs. ~150M raw events at 500k/s — three orders of
  magnitude less storage and per-tile O(1) update.

  Tradeoff axes:

  | Axis             | tap (exact)             | tile (summary)              |
  | ---------------- | ----------------------- | --------------------------- |
  | Storage          | O(parent window × N)    | O(window / resolution)      |
  | Reducers covered | All built-ins           | Composable only (avg/stdev/ |
  |                  |                         | sum/count/min/max)          |
  | Eviction grain   | Per-event               | Per-tile boundary           |
  | Late data        | Same as today's rolling | Bounded to tile boundary    |
  | Result freshness | Exact at any moment     | Lags by < `resolution`      |

  Tile mode is the right shape for "high-rate normality monitoring"
  patterns: 5m baseline avg/stdev + 5s current avg/sum + z-score
  deviation, all at 500k/s. Exact mode is the right shape when the
  reducer set includes `samples` / `median` / `top` — which the
  gRPC anomaly-density experiment did, ironically, so tap is the
  right primitive for _that_ use case even though tile would crush
  the storage cost on a stats-only variant.

  **Decision posture.** Both are deferred behind the same
  second-user signal. The tile-mode primitive shouldn't ship before
  tap does because tap's semantics (shared deque, child-as-cursor)
  are the simpler conceptual ground; tile is an optimization on top
  ("here's a way to compress the shared storage to summaries when
  the reducer set permits"). When the third signal lands, evaluate
  which shape the user actually wants — tile if the reducer set is
  composable-only, tap if exact reducers are in the mix.

  **Why deferred:** the savings only matter at extreme scale (≥10k
  partitions or kHz/partition). The naive "two rollings" pattern is
  good enough for the ≥99% telemetry/observability dashboard regime.
  Pondjs never claimed parity with custom aggregators at extreme
  scale; v0.13's writeup honesty section says exactly this. Revisit
  when a **second user** lands on the same wall — that's the design
  signal worth more than one user's data.

  **Second signal logged (2026-05-04).** gRPC experiment V7's
  numbers (all-pond pipeline using `samples()`) regressed ~19%
  throughput vs V6 at saturation; v0.14.3's allocation fix
  (`samples.rollingState()`) closes the per-event leak but the
  architectural gap remains — V7 routes events through two full
  `LiveRollingAggregation` pipelines where V6 had one rolling
  plus a passive `array.push` listener. The gap is the
  "shared-buffer rolling" shape that `tap` would solve. Same
  user, same experiment — counts as 1.5 signals, not 2. Still
  parked. The third signal (or a different user) ships it.

  Reference workaround in the meantime: two separate `rolling()`
  calls off the same source, both with the same trigger. Document
  as the "if you find yourself wanting this" footnote in the
  eventual `tap` RFC.

- **Reducer batching — deferred per the V4 bench.** The gRPC
  experiment's V4 profile (after v0.14.0 shipped) confirms
  `LivePartitionedSyncRolling.ingest` per-event reducer-state work
  (`stdev.add` / `avg.add` / Welford-style running stats) is the
  largest remaining hot spot at ceiling — 8.2% self time. Welford
  updates ARE associative, so an `addMany([values])` reducer
  interface that processes a contiguous run of events in one call
  is sound. But:
  - **Bench validates the user's earlier triage.** Production target
    on the experiment is 100k events/sec; V4 hits 256k/s (2.56×
    headroom). The remaining ceiling gap to V1 is real but doesn't
    block any working app.
  - **API surface impact is wide.** Every reducer (built-in + the
    custom-function path) would need an `addMany` variant; call
    sites in `LiveRollingAggregation` and `LivePartitionedSyncRolling`
    would need to detect "do I have a contiguous batch?" and route
    accordingly. Easy to get wrong; non-trivial to test.
  - **Real gain is narrow.** Welford batching only wins on bulk
    pushes (`pushMany` of N rows in one call). The streaming
    pattern — one event per network handler call — doesn't benefit.

  Revisit if (a) a second user reports ceiling-bound throughput as
  blocking, OR (b) the gRPC experiment's writeup ends up needing
  pond to claim parity with V1 on the saturation regime (it
  currently doesn't; the writeup's honesty section will say "for
  high-rate, custom aggregators win because they can amortise
  reducer state across batches that pond's primitives can't see
  is shareable"). Until then, parked.

  **Related opportunity (logged 2026-05-04):** when a user requests
  both `avg` and `stdev` on the same column, both reducers maintain
  `sum` and `count` independently — duplicated arithmetic on every
  event. Codex flagged this in the blind multi-window review.
  Smaller-scope than full reducer-batching; the fix is to detect
  the compatible-reducer pair at construction and share the
  lower-order moments. Worth measuring before designing — micro-
  bench a paired `avg + stdev` rolling against a single `stdev`
  (which already maintains both internally) to confirm the
  duplication cost is non-trivial. If yes, ~30-line opt-in fast
  path; if no, leave as-is. Independent of the bigger reducer-
  batching question.

- **Live rolling tactical fixes (logged 2026-05-04, not yet
  scheduled).** Two operational items surfaced in Codex's blind
  multi-window review against the live-rolling source. Independent
  of any larger redesign — both are local fixes inside
  `LiveRollingAggregation`.
  - **`Array.shift()` eviction at `LiveRollingAggregation.ts:447`.**
    `#removeFirst()` evicts via `this.#entries.shift()`. V8 amortizes
    `shift` to O(1) on long arrays through a hidden offset, but the
    constant matters at 500k events/s — and the optimization isn't
    guaranteed across engines. A plain head-index pointer (`#head`)
    with periodic compaction, or a true ring buffer when window
    capacity is known a priori (count-window case), is the right
    shape. Bench against the V4-bench harness to confirm a win
    before shipping; small enough that it doesn't earn a design
    pass, just a measurement and a PR.

  - **`history: false | RetentionPolicy` on live rolling outputs.**
    `LiveRollingAggregation.ts:403` does `this.#outputEvents.push`
    unboundedly — every emitted event is retained forever, growing
    one entry per source event (or per trigger fire) for the life
    of the accumulator. Many high-rate users only consume `value()`
    or `on('event', ...)` and never read the historical output
    series; for them, the retention is pure waste. Add an option:

    ```ts
    live.rolling('1m', m, { history: false }); // no retention
    live.rolling('1m', m, { history: { maxEvents: 1000 } });
    live.rolling('1m', m, { history: { maxAge: '5m' } });
    ```

    `history: true` (the implicit default today) preserves current
    behaviour. `false` skips the push entirely; the accumulator
    still exposes `value()` and event-callbacks but `length`/`at`
    return zero/undefined. The retention-policy case mirrors
    `LiveSeries`'s existing retention shape. ~30-50 lines, well-
    bounded; the design question is whether `history: false` should
    also disable `outputEvents` allocation entirely or keep a
    1-entry rolling slot. Lean toward "skip allocation entirely"
    — if the user opts out, opt them out fully.

  Both are opportunistic — neither blocks any working app. Schedule
  alongside the next live-rolling perf pass or when the gRPC writeup
  earns a "what we'd fix next" footnote.

- **`'samples'` reducer + lifted custom-function restriction on
  live — queued for v0.14.1.** Surfaced by the gRPC experiment's
  step-4 (anomaly density). The use case: per-host per-200ms tick,
  count samples exceeding `k·σ` from the baseline mean for several
  `k` thresholds. Mean/stdev come from a 1m baseline rolling (works
  fine via `AggregateOutputMap`); the threshold counts need the
  **raw values** from a 200ms current-tick window. None of pond's
  built-ins yield "all values" — `unique` deduplicates, `top${N}`
  bounds, `keep` is the unique-or-undefined sentinel (and is
  pervasively misread to mean "keep all values" — the agent
  tripped on this).

  Custom-function reducers (`(values) => values.slice()`) cover
  the use case cleanly. Batch already accepts them; live rejects
  with a runtime TypeError pointing at AggregateOutputMap aliases,
  which don't actually solve "all values" either. Asymmetry the
  agent reasonably stumbled on.

  **Two related changes ship together in v0.14.1:**
  - **`'samples'` built-in reducer** — returns the window's values
    as an array. Library-implemented; no custom-function-on-hot-
    path concerns; sits beside `unique` and `top${N}` (same
    array-output kind, same type-system narrowing). `add` O(1),
    `remove` O(N) on eviction, `snapshot` O(N). Memory O(W) for
    window size W. Doc-note: "use on bounded windows."

    **Naming note (2026-05-02):** initially proposed as `'collect'`,
    renamed to `'samples'` to avoid collision with
    `LivePartitionedSeries.collect()` (already used to fan partitions
    back into a unified buffer). `'samples'` also reads naturally
    as a "subset of a population," which dovetails with the
    deferred parameterized form below.

  - **Lift the custom-function-reducer runtime guard on live
    rolling and live aggregation.** Document the perf characteristic
    instead of rejecting. Custom functions don't have incremental
    add/remove machinery — on live they re-run over the full
    window every event (O(W) per event vs O(1) for built-ins).
    For low-rate dashboards / debug aggregations / prototype
    pipelines the convenience matters more than the perf cliff;
    for high-rate use built-ins or `'collect'`. JSDoc on
    `LiveRollingAggregation` / `LiveAggregation` mapping options
    - a callout on the live transforms doc page telegraph the
      cost so callers make an informed choice.

  **Why both rather than just `'collect'`** (decision 2026-05-02
  during the docs phase): the batch-vs-live asymmetry is itself
  the friction. The agent assumed "same reducer shape on both,"
  hit the runtime guard, then had to find a different escape
  hatch. Cleaner to align the surface. Many real use cases gain
  ergonomic value from custom-function reducers; the perf cliff
  is real but documentable, not a footgun once telegraphed. The
  v0.14.1 patch closes both gaps in one motion.

  **Why deferred (vs ship-now):** the perf-doc story lands in the
  windowing concept page (DOCPLAN Wave 3.2). Better to ship the
  reducer + guard removal alongside the docs that explain the
  perf characteristic, rather than ship the API and then write
  the docs separately.

  Scope: ~50-80 lines for `'samples'` + tests, ~10 lines to drop
  the runtime guards in `LiveRollingAggregation` /
  `LiveAggregation` / `LivePartitionedSyncRolling`, ~20 lines of
  perf-doc prose.

  **Shipped 2026-05-03 as v0.14.1**, hotfixed same-day as v0.14.2
  to close a type-narrowing gap the Layer 2 review caught
  post-merge: `'samples'` was registered in the runtime registry
  but missing from `AggregateFunction`, `AggregateFunctionsForKind`,
  `AggregateKindForColumn`, `ArrayAggregateKind`, and
  `ReduceResult`. Build passed because `tsconfig.json` excludes
  `test/` and `npm run verify`'s `test:type` step uses
  `tsconfig.types.json` (covers `src` + `test-d/` only). v0.14.2
  added the missing entries plus a `test-d/types.test-d.ts` block
  pinning narrowing parity with `unique` / `top${N}`.

  **v0.14.3 — `samples.rollingState()` allocation fix
  (2026-05-04).** gRPC experiment V7 (all-pond pipeline using
  `samples()`) regressed throughput ~19% vs V6 (hybrid pond-
  rolling + manual deque) at the saturation regime (1k partitions
  × 1k events/s, 1M target: 209k/s vs 258k/s) and ran +17% heap
  at moderate loads. Two suspects:
  1. **Per-event 1-element `ScalarValue[]` allocations** in the
     rolling state's `add()` — wraps every scalar value in a
     fresh array even though `remove(index)` only needs the
     wrap when the source is array-kind (a single event
     contributing multiple scalars together).
  2. **Two full LiveRollingAggregation pipelines** (baseline +
     samples) where V6 had one rolling + one passive
     `array.push` listener — Map ops + reducer state + trigger
     dispatch + subscriber fan-out duplicated per pipeline.

  Suspect 1 is fixable in-pond and ships in v0.14.3: branch on
  `typeof v` in `add` to store scalars directly; only build a
  sub-array on array-kind sources; snapshot branches on
  `Array.isArray` to flatten the mixed map. Behavior preserved;
  all 15 existing `samples-reducer.test.ts` assertions pass
  unmodified.

  Bench (`packages/core/scripts/perf-samples-reducer.mjs`):
  focused micro-bench (5M scalar add+remove cycles) drops
  239.85ms → 209.09ms median (−12.8%). Integration scenarios
  (100k events × N hosts through full LiveSeries+partition
  pipeline) show tight wall-clock parity within run-to-run
  noise — allocation pressure isn't the dominant cost at that
  scale; the fix compounds at saturation regimes where GC
  pressure stacks. Heap-end snapshots (`process.memoryUsage`)
  are dominated by retained window state, not transient
  allocations, so the saturation-regime benefit isn't directly
  measurable in this script — the gRPC experiment's writeup is
  the load-bearing measurement, and v0.14.3 should narrow the
  V7-vs-V6 gap on heap pressure even if it doesn't close the
  throughput gap.

  **Suspect 2 (architectural cliff) is NOT chased in v0.14.3.**
  Closing the V7-vs-V6 throughput gap would need either a
  "lite" rolling primitive (no trigger dispatch, no subscriber
  fan-out) or shared-buffer storage via the parked `tap()`
  primitive. At the kHz × 1k-partition saturation regime, V6's
  hybrid (one pond rolling for stats + manual deque for raw
  values) is genuinely the right architectural shape; pond's
  `samples` is for typical loads where the per-event pipeline
  overhead is invisible. The honest framing for the writeup:
  v0.14.3 closes the leak; the architectural cliff is
  inherent — pond convenience pays a tax that custom code
  doesn't, and at saturation that tax is visible. Fine outcome.

  **Second signal toward `tap()`.** The V7 numbers are the
  second data point (after the gRPC HostAggregator walkback)
  pointing at shared-buffer rolling as the right primitive
  for the saturation regime. Still deferred — see the `tap()`
  entry above — but the design pressure is real enough that
  the next user landing on the same wall should be the
  trigger to ship.

- **CI safety-net widening — deferred.** v0.14.1 review surfaced
  that `npm run verify`'s `test:type` step doesn't run `tsc -p
tsconfig.vitest.json` (which covers `test/`). Vitest itself
  uses esbuild and strips types, so `npm run test:runtime` doesn't
  catch type errors in test files either. Net: a new public-API
  type entry can break user-facing call sites without `verify`
  failing.

  Fix path: add a `test:type:vitest` script that runs `tsc -p
tsconfig.vitest.json --noEmit`, wire it into `verify`. **Blocked
  by:** existing test files have ~30 unrelated type errors under
  the vitest tsconfig (mostly pushing `undefined` into required
  number columns without `as any` — patterns that work because
  vitest doesn't typecheck but would fail tsc). Cleaning those up
  is its own piece of work, ~half a day. Worth it because the next
  similar slip costs as much as v0.14.2 did to clean up.

- **`'samples(n)'` parameterized form — deferred.** Random thought
  during the v0.14.1 naming pass (2026-05-02): if `'samples'`
  reads as "subset of a population," then `samples(n)` could
  return a uniform random subsample of size `n` — useful for
  bounded-memory representations of large buckets.
  - **Batch:** straightforward reservoir sampling (Algorithm R).
    O(N) time, O(n) memory, classic.
  - **Live rolling:** harder. Reservoir sampling assumes each
    element is seen exactly once; a sliding window has elements
    _exiting_ too (the reservoir might hold an element that's
    just aged out). Sliding-window-reservoir algorithms exist
    (priority sampling with random keys, time-bucketed chunked
    sampling) but each has tradeoffs and adds real implementation
    complexity. Not a one-line addition.

  **Defer.** The default `samples()` (no arg = all values) covers
  every use case the experiments have surfaced. Revisit if a real
  user lands a "I need bounded-memory subsamples of high-cardinality
  windows" pattern.

- **Reducer composition / chaining — deferred RFC.** Same naming
  pass surfaced: it would be useful to chain `samples(20).avg()`
  to mean "subsample 20, then average." That's a two-stage
  reduction — reduce events to 20 values, then reduce those to 1.

  Pond's reducer registry today maps strings to single-stage
  reducers. Chaining means either parsing a string DSL
  (`'avg(samples(20))'`) or shifting the API toward composable
  reducer _objects_ (`avg.of(samples(20))` or
  `pipe(samples(20), avg)`). Both are RFC-shaped — they'd touch
  the reducer-registry contract, the type-system narrowing, and
  the AggregateOutputMap mapping shape.

  **Defer.** Custom-function reducers (shipping in v0.14.1) cover
  the same use case as one-liners today:
  `{ avgSample: { from: 'cpu', using: vals => avg(reservoir(vals, 20)) } }`.
  Lift composition into the registry only after we see two or
  three users hit the pattern frequently enough that the custom-
  function workaround feels like a workaround. Until then the
  custom-function form is the right escape hatch.

### RFC sketch: trigger taxonomy expansion (post-v0.13.2)

Surfaced by Codex feedback after adopting v0.12 triggers in the
production webapp telemetry app (2026-05-01, second wave). Codex
proposed five additional triggers; triage below distinguishes
mechanical extensions, the architectural design moment, and
misclassified asks.

**Mechanical extensions (low design cost):**

- **`Trigger.count(n)` — shipped in v0.13.2.** Captured above.

- **`Trigger.any(...)` — composition over single-axis triggers.**
  Killer use case from Codex:
  `Trigger.any(Trigger.every('30s'), Trigger.count(1000))` —
  "send every 30 s of event time, or sooner if 1000 events have
  arrived since the last fire." Bounds queue depth even when the
  time interval is long. Compositional shape — once count + every +
  idle exist as singletons, `any` is a thin coordinator.

  **Design wrinkle: reset semantics.** When one inner trigger fires
  inside an `any`, do the others reset?
  - For `count(N)`: yes — counter restarts after each fire so it
    measures "N events since the last emission," not "every Nth
    event modulo the input."
  - For `every(duration)`: no — the time grid is epoch-aligned, not
    last-fire-aligned. A reset would drift the boundaries.
  - For `idle(duration)`: yes — idle timer restarts on every fire
    (any fire, not just its own) and on every event arrival.

  Ship after the singletons exist; let real composite usage shape
  reset semantics rather than over-design upfront. v0.14.x candidate.

**Design moment (RFC required):**

- **`Trigger.idle(duration)` — wall-clock crossing.**
  Codex use case: scroll profiling. "User scrolls, events stream in,
  then the idle trigger flushes a final 'settled' snapshot." Real
  pattern, currently underserved — `Trigger.event()` is too noisy
  during the burst, `Trigger.every('500ms')` either misses the
  settle moment or fires uselessly during quiet periods.

  By definition, "fire after N ms of silence" can't be data-driven.
  No event arrives to consult; the trigger has to fire on the
  wall clock. Two architectural forks:

  a) **Accept wall-clock.** `setTimeout`-driven, only armed when a
  subscriber is attached. Ergonomic, real, but commits pond to a
  `setTimeout` dependency it has explicitly avoided through v0.12
  ("data-driven, no setInterval inside the library").

  b) **User-driven tap.** Pond exposes `rolling.checkIdle(now)` or
  similar; user wires their own `requestAnimationFrame` /
  `setTimeout`. Keeps the pure data-driven model but defeats the
  ergonomic promise — the user is now responsible for the tick
  loop.

  **Lean: (a).** Idle is fundamentally about _absence_, and absence
  isn't a data event. A user-side workaround re-implements the
  same `setTimeout` pond would have done, just less centrally. The
  ergonomic win for the targeted use case (interactive UIs, scroll
  profiling, debounce-on-quiet) is real.

  **What (a) commits us to:**
  - `setTimeout` inside the library (host-environment dependency)
  - Fake-timer test infra for deterministic tests
  - The `Trigger.clock` naming wrinkle becomes pressing — once
    pond has a wall-clock trigger, "clock" no longer means
    "data-driven boundary crossing" uniformly.

  **Likely naming reshuffle alongside `idle`:**
  - `Trigger.eventClock(seq)` — current `Trigger.clock` behaviour,
    fires on data-clock boundary crossing
  - `Trigger.wallClock(seq)` — future variant, fires on
    wall-clock boundary regardless of activity
  - `Trigger.idle(duration)` — wall-clock-driven, fires after N ms
    of silence
  - `Trigger.event()`, `Trigger.every(duration)`, `Trigger.count(n)`
    unchanged
  - `Trigger.clock` deprecated as ambiguous, redirected to
    `eventClock` for back-compat through one minor cycle

  This is the RFC moment. Decide: do we want `idle` enough to take
  on `setTimeout`, fake-timer infra, and the naming reshuffle? My
  read: yes — Codex's use case is well-specified and ergonomically
  hard to replicate user-side — but worth waiting for one more
  signal (a second user, or a real production blocker) before
  committing the design effort. v0.14 candidate; gate on signal
  strength.

**Decline / defer:**

- **`Trigger.threshold(column, predicate)` — misclassified.**
  Codex even hedged: "maybe this belongs as a filter after rolling
  rather than a trigger." Confirmed: it does. A trigger answers
  "_when_ do we emit?" uniformly across all output events; a
  threshold answers "_do we emit this event?_" — that's filter
  semantics. Already trivially expressible:
  `live.rolling(window, mapping, options).filter(e => e.get('current') > x)`.
  Document this answer in the trigger doc's "what about
  threshold-based emission?" section so the question doesn't
  re-surface.

- **`Trigger.manual()` / externally poked — sugar over existing.**
  The unload case is `addEventListener('beforeunload', () =>
post(rolling.value()))`. Debug export is `rolling.value()`.
  Reconnect-on-disconnect is the same pattern. If a real version
  ever earns its keep (multiple users hitting it), the right shape
  is `rolling.emit()` as an explicit method on the accumulator,
  not a trigger primitive — because there's no temporal predicate,
  just an imperative "fire one snapshot now." Defer until concrete
  signal.

### Shipped: Trigger as a first-class concept (v0.12.0)

> **Status note (2026-05-01):** the RFC below was approved and
> implemented as v0.12.0. RFC document at
> `docs/rfcs/triggers.md`. Two real users migrating: Codex on webapp
> telemetry, Claude on the gRPC experiment's M3.5 work. Their
> friction notes inform the final stable v0.12.0 release. The
> sketch is preserved for context.

### RFC sketch (approved, implemented): Trigger as a first-class concept

Surfaced by the gRPC experiment's M3.5 step-1 friction note (the
dashboard agent's [`WIRE.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/m3.5-aggregate-wire-step-1/WIRE.md)
asked for synchronised tick aggregation across all partitions; pond
has no primitive for it). On reflection, the gap goes deeper than
"sample is missing one variant" — it's a factoring problem.

**The factoring.** Pond's live layer today carries trigger
semantics implicitly inside each accumulator type:

| Type                                       | Implicit trigger              |
| ------------------------------------------ | ----------------------------- |
| `LiveRollingAggregation`                   | event-driven (emits per push) |
| `LiveAggregation`                          | bucket-close-driven           |
| `LiveSequenceRollingAggregation` (v0.11.8) | sequence-crossing-driven      |

Three accumulators, three implicit triggers, no recombination.
"Rolling-window with count-trigger" or "bucketed with clock-trigger"
have nowhere to live. The sharper factoring is **Source × Trigger ×
Aggregation** — trigger as a first-class composable concept,
orthogonal to the aggregation choice.

**Settled design choices** (as of this RFC sketch):

- **Constructor-function form for triggers.** `Trigger.clock(seq)`,
  `Trigger.count(n)`, future `Trigger.custom(predicate)`. Avoids
  stringly-typed first args; type system narrows naturally; leaves
  room for additional trigger kinds without API churn.
- **Trigger attaches at the source level**, above `partitionBy`.
  All downstream accumulators inherit the trigger; partitions
  share one synchronised clock (which is the dashboard's
  motivating requirement). Shape:

  ```ts
  const ticks = live
    .triggerOn(Trigger.clock(Sequence.every('200ms')))
    .partitionBy('host')
    .rolling('1m', { cpu: 'avg', cpu_sd: 'stdev' });
  ```

- **`.sample()` (v0.11.8) will be removed pre-1.0.** Replaced by
  `live.triggerOn(Trigger.clock(seq)).rolling(...)`. The webapp
  telemetry agent migrates once. No backwards-compat sugar — pond
  prefers one way to do each thing, and pre-1.0 is the right time
  to fix this.

**Default trigger.** Without an explicit `triggerOn`, accumulators
keep their existing event-driven behavior (i.e. an implicit
`Trigger.event()`). Backward compatible for everything that doesn't
care about emission cadence.

**Filter/map/select stay per-event.** Triggers configure
_accumulator emission cadence_, not the entire chain. Stateless
transforms keep running on every event; only `rolling()` /
`aggregate()` / etc. observe the trigger when emitting.

**Open design questions for the M5 RFC:**

1. **What's the type of `live.triggerOn(...)` output?** A new
   `TriggeredLiveSource<S>` that wraps source + trigger? Same type
   with a phantom-tag generic? Decide based on what makes the
   downstream method signatures cleanest. Shouldn't leak into call
   sites the user writes.
2. **Trigger placement in the chain.** Source-level is the design
   decision; but where exactly? Before `partitionBy` was the
   user's framing. Should it also be expressible later
   (`partition.triggerOn(...)` for finer scoping)? Probably not —
   keep it at the source for synchronisation guarantees.
3. **Multiple triggers on the same source.** Two consumers want
   different cadences (e.g. backend report at 30s, dashboard at
   200ms). They'd each call `triggerOn` independently — does that
   produce two `TriggeredLiveSource` views, each driving its own
   downstream chain? Yes — same composition story as `LiveView`.
4. **Cross-trigger semantics: clock + count?** "Emit on clock, but
   no more than every 100 events." Compound triggers via
   `Trigger.any(...)` / `Trigger.all(...)` are a natural extension
   but speculative until needed.

**Sibling RFC item: delta-reducer family.** The dashboard's
`n_in_tick` ("samples since last emission") is a fundamentally
different statistic from rolling-window count — it requires
snapshot-aware state. Triggers alone don't solve it. Reducers like
`countSince`, `sumSince`, `firstSince`, `lastSince` track "what
arrived between my last emission and now" and report the delta. Has
to land in the same RFC because a tick-driven rolling that doesn't
expose `n_in_tick` is incomplete for the motivating use case.

**What this replaces:**

| Today                                                                                 | After                                                                                                |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `live.rolling('1m', m)`                                                               | `live.rolling('1m', m)` (unchanged; implicit `Trigger.event()`)                                      |
| `live.rolling('1m', m).sample(seq)`                                                   | `live.triggerOn(Trigger.clock(seq)).rolling('1m', m)`                                                |
| `live.partitionBy('host').rolling(...).toMap()` (per-host samplers, NOT synchronised) | `live.triggerOn(Trigger.clock(seq)).partitionBy('host').rolling(...)` (synchronised by construction) |

**What does NOT change:**

- `LiveAggregation` (sequence-bucketed with bucket-close emission)
  stays as-is. Its trigger semantics are different from
  `Trigger.clock` — it emits on bucket close, which is a
  conditional-on-watermark, not a per-N-time-units event. May fold
  into the trigger taxonomy as `Trigger.bucketClose(seq)` later;
  not in scope for first cut.

**Status:** RFC sketch only. No implementation work yet. The
gRPC experiment's `HostAggregator` workaround (M3.5 step 1) is
the right shape until this lands. The M5 extraction sweep should
absorb this design as a core-library proposal alongside the
`@pond-ts/server` / `useRemoteLiveSeries` / `@pond-ts/dev-producer`
RFCs. Three external surfaces + one internal factoring change is
the M5 scope to plan around.

Cite for context recovery: this RFC sketch was drafted in
conversation between the user and the pond-ts library agent (Claude)
on 2026-04-30, after the dashboard agent and gRPC experiment agent
collaborated on M3.5 step 1 (`pond-grpc-experiment` PR #11). The
factoring observation came out of asking "is `.sample()` overly
specific?" — yes, but the deeper problem is that trigger semantics
are baked into accumulator types instead of being orthogonal.

### Dropped from scope

- **`LiveRolling`**: covered by `LiveRollingAggregation` implementing `LiveSource` — the
  per-event output stream IS the rolling output.
- **`LiveSmooth`**: EMA is a stateful closure in `map()`. Moving average is
  `LiveRollingAggregation`-as-source with `'avg'`. LOESS is too expensive for per-event
  streaming.
- **`rename`/`collapse` views**: achievable with `map()`. Don't earn dedicated
  API surface in the live layer.

Definition of done:

- [x] stateful transforms use existing reducer infrastructure incrementally
- [x] stateless and stateful transforms compose cleanly
- [x] stateful transforms satisfy `LiveSource` for pipeline chaining
- [x] filtered/live aggregation pipelines are demonstrated in examples
- [x] snapshot vs closed/finalized semantics are explicit where relevant

---

## Phase 5: React integration

Status: in progress. Monorepo restructure complete — `@pond-ts/react` package
at `packages/react/`. Hooks shipped at v0.4.2; usability fixes in progress.

Goal: make Pond useful in frontend apps without forcing a framework-y runtime
model into the core package.

Entry point: `@pond-ts/react` (separate workspace package)

### Hooks

- [x] `useLiveSeries` — creates and owns a `LiveSeries` for component lifetime;
      returns a stable `live` ref and a throttled `TimeSeries` snapshot
- [x] `useTimeSeries` — memoized `TimeSeries.fromJSON(...)` for static/fetched
      data; re-parses only when key changes
- [x] `useSnapshot` — converts any `LiveSource` into a throttled `TimeSeries`
      snapshot for rendering; works with `LiveSeries`, `LiveView`,
      `LiveAggregation`, and `LiveRollingAggregation`
- [x] `useWindow` — derived windowed view that updates as the source grows;
      disposes the view on cleanup
- [x] `useDerived` — applies a batch transform to a snapshot, recomputing when
      the input changes
- [x] `takeSnapshot` — utility: build a `TimeSeries` from any `LiveSource`

### Usability fixes (from external testing)

- [x] `Time.toDate()` — added missing convenience method
- [x] `useWindow` StrictMode fix — view created in `useEffect`, not `useMemo`
- [x] `TimeSeries[Symbol.iterator]` and `toArray()` — ergonomic iteration
- [x] `useSnapshot` accepts `SnapshotSource<S>` structural type — avoids casts
      when passing `LiveAggregation` or `LiveRollingAggregation`
- [x] `LiveView` eviction mirroring — filtered/mapped views now mirror source
      evictions (uses `EMITS_EVICT` symbol to safely detect evict-capable sources)
- [x] `LiveAggregation<S, Out>` and `LiveRollingAggregation<S, Out>` — output
      schema type parameter enables `event.get('col')` to narrow through
      aggregation chains (e.g. `agg.at(0)?.get('cpu')` returns `number | undefined`
      instead of `ScalarValue | undefined`)
- [x] Schema-transform types already exported: `AggregateSchema`, `RollingSchema`,
      `DiffSchema`, `SmoothSchema`, `SmoothAppendSchema`, `SelectSchema`,
      `RenameSchema`, `CollapseSchema`
- [x] `useLiveQuery` — bundles `useMemo` + `useSnapshot` into one call; return
      shape matches `useLiveSeries`, cuts hook count roughly in half for dashboards
      with multiple derived views
- [x] `useLatest` — subscribes to a live source and returns only the most recent
      event; lighter than a full `TimeSeries` snapshot for stat cards and gauges

### Remaining

- [ ] Document `rate()` / `diff()` / `pctChange()` behavior when `dt = 0` —
      concurrent events (same timestamp) produce `undefined`. Workaround is to
      filter per-producer first. A `rateOver({ every: '1s' })` variant that
      normalizes to fixed wall-clock windows may be worth adding later.
- [x] `smooth('ema', { warmup: N })` — drops the first `N` output rows so
      callers don't have to write `.slice(N)` after every EMA call. Shipped
      in v0.5.7. A `seed` variant that initializes the EMA with a specific
      value (rather than trimming the output) is still open if the need
      comes up.
- [x] `outliers(col, { window, sigma, alignment? })` — rolling-baseline
      anomaly detection as a first-class operator. Returns `TimeSeries<S>`
      filtered to events deviating from the rolling avg by more than
      `sigma * rolling_stdev`. Collapses the 30-line manual pattern
      (rolling → avgByTs Map → filter loop) into one call. Shipped in
      v0.5.8.
- [x] `baseline(col, { window, sigma, alignment?, names? })` — appends
      `avg` / `sd` / `upper` / `lower` columns to the source schema in
      one rolling pass; band-chart `toPoints()` (wide rows after
      v0.7.0) and outlier-filter `.filter(cpu > upper)` both read from
      the same intermediate. Replaces the dashboard's "call rolling
      for bands, call outliers for dots" two-pass pattern with one
      call. Shipped in v0.5.9. v0.5.10 followup: `upper` / `lower`
      collapse to
      `undefined` when the rolling window is flat (`sd === 0`) so a
      naive `value > upper || value < lower` filter doesn't flag every
      non-equal point; matches `outliers()`. The two methods are now
      documented as conceptually equivalent (not sugar — they're
      independently implemented). First trial of the two-comment review
      protocol landed through PR #47.
- [x] `toPoints()` / `TimeSeries.fromPoints(points, { schema })` —
      chart-library interop. Originally narrow-form
      `toPoints(col) → { ts, value }[]` in v0.5.8; redesigned in
      v0.7.0 to wide rows
      (`toPoints() → { ts, ...valueColumns }[]`) to match the
      multi-column nature of `TimeSeries` and feed Recharts /
      Observable Plot / visx without a manual merge step.
      `fromPoints` accepts the inverse wide-row shape over any
      time-keyed schema.
- [ ] Dashboard guide doc fixes — show `useLiveQuery` as the idiomatic pattern
      rather than manual `useMemo` + `useSnapshot`; document how derived views
      interact with `LiveSeries` retention.

**Render throttling** is critical. Raw data can arrive at hundreds of events per
second. The `throttle` option caps how often the snapshot is recomputed.
Stateless transforms are cheap enough to build inline during render; stateful
transforms must be created once via `useMemo` on the `live` ref (or
`useLiveQuery`).

Requirements before starting:

- live composition semantics from phases 3 and 4 should already feel stable

Definition of done:

- [x] live data can flow from WebSocket-like sources into throttled React renders
- hooks have examples that mirror likely product use
- the docs explain when to use lazy views vs memoized derived data

---

## Phase 6: Ecosystem and adapters

Status: not started.

Goal: make Pond easier to adopt in real products before committing to a full
first-party charting system.

Scope:

- `pond-ts/node` — Node stream adapters (`Readable`/`Writable`); views and live
  aggregations also expose `.toReadable()`
- `pond-ts/adapters` — bridge helpers such as `toRecharts`, `toObservablePlot`
- improved docs and examples for integrating with existing chart libraries

Later, only after the previous phases are stable:

- `@pond-ts/charts` — first-party chart components built directly on the
  `pond-ts` data model, successor to `react-timeseries-charts`
- **gRPC stream processor experiment** — in progress at
  [pjm17971/pond-grpc-experiment](https://github.com/pjm17971/pond-grpc-experiment).
  Three-tier setup: producer (Node, gRPC) → aggregator (Node,
  WebSocket fanout) → React app, all sharing one `as const` schema
  via `pond-ts/types`. Exploratory: characterizes the single-thread
  aggregator's operating envelope, surfaces the friction notes that
  drive library follow-ups (already shipped: `pond-ts/types`
  subpath in v0.11.3; queued: snapshot/append primitives on
  `LiveSeries` — see Phase 4). Real high-throughput workload would
  also surface routing-overhead bottlenecks with actual data
  (currently the partition routing path is ~0.8 µs/event due to
  row revalidation in `LiveSeries.push`; we deferred the
  optimization for v0.11 because synthetic measurements weren't
  enough signal). Becomes a reference deployment shape for users
  who want pond-ts pipelines in their own services; M5's extraction
  sweep should yield three RFCs (`@pond-ts/server`,
  `useRemoteLiveSeries` for `@pond-ts/react`, `@pond-ts/dev-producer`)
  and — once two codecs exist in working code (JSON on the WS hop,
  protobuf on the gRPC hop) — likely an `Adaptor` interface in a
  separate `@pond-ts/adaptors` package. Separate repo, not part of
  the npm packages.

### Package structure

Monorepo with npm workspaces (`packages/*`):

```
pond-ts              -> packages/core — batch + live library
@pond-ts/react       -> packages/react — React hooks
@pond-ts/charts      -> future — first-party chart components
```

Subpath entry points within `pond-ts`:

```
pond-ts              -> core batch library
pond-ts/live         -> LiveSeries, subscriptions, retention, live transforms
pond-ts/node         -> Node stream adapters (Readable/Writable, future)
pond-ts/adapters     -> bridge adapters for third-party chart libs (future)
```

Browser-safe by default. Node-specific APIs go behind a separate entry point.

Definition of done:

- Node-specific APIs stay out of the browser-safe default entry point
- adapters solve common "how do I graph this?" questions in the docs
- a chart package remains an intentional future decision, not implied scope creep

---

## Recommended release grouping

| Release band | Focus                                                        |
| ------------ | ------------------------------------------------------------ |
| `0.1.x`      | Performance fixes, hardening, serialization, custom reducers |
| `0.2.x`      | `groupBy`, `reduce`, `diff`/`rate`, `fill`                   |
| `0.2.5`      | `pctChange`, `cumulative`, `shift`                           |
| `0.3.x`      | `LiveSeries` core and subscriptions                          |
| `0.4.x`      | Live views and live stateful transforms                      |
| `0.5.x`      | React hooks                                                  |
| `0.6.x`      | Node adapters and third-party chart adapters                 |

---

## Decision gates

Before moving from one major phase to the next, answer the relevant question:

- After Phase 1: is the batch layer complete and trustworthy enough to be the
  foundation?
- After Phase 3: is the `LiveSeries` shape correct, or are we still learning?
- After Phase 4: do live/stateful composition rules feel simple enough for
  users?
- After Phase 5: do common frontend use cases work without ad hoc glue?

If the answer is no, stay in the phase and tighten the model before expanding.

---

## Deferred design decisions

### Array column values (`unique`, `topK`, `percentiles`)

**Status: shipped.** `unique` reducer and the four array column operators
(`includes`, `count`, `containsAll`, `explode`) landed on branch
`feat/array-columns`. The sections below describe the design; see the
implementation checklist at the bottom for what's done and what's still open.

**Decision: reducers may output arrays, but array columns are inert.**

A `'unique'` reducer (distinct values in a bucket) is a natural aggregation —
"which hosts reported in this window?" — but it collides with a constraint:
`CustomAggregateReducer` returns `ScalarValue | undefined`
(`number | string | boolean`), and the natural output of `unique` is
`string[]`.

The full-fat approach — making `ScalarValue[]` a first-class value everywhere —
is expensive. Every conditional type, every reducer, `fill`, `align`, `diff`,
`rate`, chart adapters, JSON round-trips — all need to handle or reject arrays.

But most array-valued use cases share a property: **the array is a reducer
output, never an input to further numerical operations.** You never `avg` a tag
list. You never `diff` a set of host names. The arrays are read-only results
that pass through the pipeline untouched.

That observation dramatically reduces the blast radius:

#### What changes

- **New column kind `'array'`** with value type `ScalarValue[]`.
  `NormalizedValueForKind<'array'>` → `ScalarValue[]`.
- **Reducer registry** gains an `outputKind` that can be `'array'`. A reducer
  like `'unique'` declares `outputKind: 'array'`; the output schema column gets
  `kind: 'array'` automatically.
- **`toJSON` / `fromJSON`** encode array cells as JSON arrays. No format break —
  existing scalar cells are unchanged, and a cell that happens to be an array
  serializes naturally.
- **`CustomAggregateReducer`** return type widens to
  `ScalarValue | ScalarValue[] | undefined`.

#### What stays the same (inert behavior)

- **`NumericColumnNameForSchema`** already filters to `kind: 'number'` — so
  `diff`, `rate`, `pctChange`, `cumulative`, `rolling` naturally skip array
  columns with no code changes.
- **`fill`** strategies (`hold`, `zero`, `linear`, `bfill`) don't apply — array
  columns are skipped.
- **`align`** interpolation doesn't apply — array columns pass through.
- **`filter`, `map`, `select`, `rename`, `collapse`** operate at the event
  level, not individual cell values — arrays pass through naturally.
- **`aggregate` / `rolling`** on a column that is already `'array'` — only
  reducers that accept array inputs would work (`first`, `last`, `keep`,
  `count`). Numeric reducers reject or ignore.

#### Built-in reducers that return arrays

- **`unique`** — distinct non-undefined values, sorted. Works on any column
  kind. **Shipped.**
- **`top(n)`** — top N values by frequency, sorted by count descending with
  deterministic scalar tie-break. Implemented as a string-pattern reducer
  (`'top3'`, `'top10'`, …) parallel to `pNN`, plus a `top(n)` helper that
  returns the typed string literal. Incremental bucket/rolling state via
  a count map, so `rolling('5m', { host: top(3) })` is O(1) per update.
  **Shipped.**
- **`percentiles(...qs)`** — compute multiple quantiles in one pass:
  `percentiles(50, 90, 99)` returns `number[]`. Avoids three separate
  `p50` / `p90` / `p99` columns. **Deferred** — the workaround (declaring
  three output columns) is ergonomic enough and doesn't lose efficiency
  (each `pNN` reducer already shares a sorted-array rolling state). Revisit
  only if multi-quantile dashboards become a common pattern.

#### Array column operators

Once array columns exist, a small set of operators makes them useful for
tagging workflows (e.g. "which hosts reported?", "does this bucket include
host X?"). All operators are prefixed `array*` so they read clearly and
don't collide with existing scalar / temporal methods (e.g. temporal
`contains(range)`).

**Filters** (same schema, predicate-only):

- **`arrayContains(col, value)`** — keep events where the array column
  contains `value`. Common pattern: "show only buckets that saw host
  `api-1`."
- **`arrayContainsAll(col, values)`** — keep events where the array
  contains _every_ value in `values` (AND / subset).
- **`arrayContainsAny(col, values)`** — keep events where the array
  contains _at least one_ value in `values` (OR / intersection non-empty).

**Per-event reduction** — reuses the existing reducer registry:

- **`arrayAggregate(col, reducer, options?)`** — feed each event's array
  to a reducer (`count`, `sum`, `avg`, `min`, `max`, `median`, `stdev`,
  `difference`, `pNN`, `first`, `last`, `keep`, `unique`, or a custom
  function) as if it were a bucket of values. This unifies "count the
  array length" with "average a sample list" with "dedupe within the
  array" under one method. Output kind is inferred from the reducer
  (`outputKind: 'number'` → `number`, `'array'` → `array`, `'source'`
  falls back to `'string'` unless overridden with `{ kind }`). Without
  `as`, the source column is replaced in place; with `{ as: "name" }` a
  new column is appended and the source array is preserved.
  Custom reducer contract matches `CustomAggregateReducer`:
  `(values: ReadonlyArray<ColumnValue | undefined>) => ColumnValue | undefined`.

**Flatten**:

- **`arrayExplode(col, options?)`** — fan each event out into one event
  per element of the array. Default replaces the array column with a
  scalar column of kind `kind` (default `'string'`, overridable).
  With `{ as: "name" }` the array column is preserved and a new scalar
  column `name` carries the per-element value; the source array is
  repeated on each fanned-out event. Events with empty or `undefined`
  arrays are dropped. The resulting series may contain events with
  duplicate timestamps.

All five are batch `TimeSeries` methods. Live equivalents (`LiveView`
variants of `arrayContains` / `arrayContainsAll` / `arrayContainsAny`)
are deferred but straightforward — they'd be stateless predicate views.
Live `arrayAggregate` and `arrayExplode` need more thought (how
`arrayExplode` interacts with eviction is the hard case).

#### Implementation checklist

- [x] Add `'array'` to `ScalarKind`, `ScalarValue`, `NormalizedValueForKind`.
      New types: `ArrayValue = ReadonlyArray<ScalarValue>` and
      `ColumnValue = ScalarValue | ArrayValue`.
- [x] Widen `CustomAggregateReducer` return type to `ColumnValue | undefined`.
      `ReducerDef.outputKind` gains `'array'`.
- [x] Ship `unique` as the first built-in (outputKind: `'array'`). Works in
      `reduce`, `aggregate`, and `rolling` contexts.
- [x] JSON round-trip support for array cells (passes through unchanged;
      validate enforces element kinds on read).
- [x] Array column operators: `arrayContains`, `arrayContainsAll`,
      `arrayContainsAny`, `arrayAggregate`, `arrayExplode`. All append-mode
      operators (`arrayAggregate`, `arrayExplode`) accept `{ as }`.
- [x] `top(n)` — top N values by frequency with incremental bucket/rolling
      state. Usable as `'top3'`, `top(3)`, or any `` `top${number}` ``.
- [ ] `percentiles(...qs)` — multi-quantile reducer. Deferred; the
      workaround of declaring three `pNN` columns is cheap and clear.
- [ ] Live equivalents of array column operators (deferred until there's a
      concrete live dashboard need).

---

## Design principles

These hold across all new work:

- **`TimeSeries` stays immutable.** Live mutation belongs in `LiveSeries`.
- **Schema types flow through every operation.** New methods must produce typed
  output schemas. If a method can't be typed, it shouldn't ship.
- **Half-open `[begin, end)` bucketing.** All sequence-based operations use this
  convention.
- **Alignment is separate from aggregation.** `resample` composes them; it
  doesn't merge them.
- **Transforms are views or accumulators.** If an operation needs only per-event
  or carry-forward state, it's a `LiveView`. If it needs a growing buffer
  (buckets, sliding window), it's an accumulator. Both implement `LiveSource`
  for chaining.
- **Data is the clock.** Bucket close, watermark advance, and window eviction
  are all driven by event timestamps, not wall-clock timers.
- **No background timers or implicit scheduling.** The caller owns the event
  loop. The library is a data structure, not a framework.
- **Browser-safe by default.** Node-specific APIs go behind a separate entry
  point.

## Semantics to preserve

### Half-open bucketing

For sequence-based bucketing and alignment, interval membership is half-open:
`[begin, end)`. Example: times `10`, `15`, `20` in bucket `[10, 20)` includes
`10` and `15`, excludes `20`.

### Alignment sample position

- default: `begin`
- optional: `center`
- `end` is intentionally not a target mode

### Temporal selection vocabulary

Keep these distinct:

- `within(...)` = fully contained
- `overlapping(...)` = intersects, no key modification
- `trim(...)` = intersects and clips key extents

---

## Documentation backlog

Items collected from the multi-agent experiments (CSV-cleaner,
dashboard, gRPC pipeline, webapp telemetry). Each is small in
isolation; worth landing as a single MDX pass rather than dribbling
in piecemeal so readers benefit from a coherent "production
deployment" / "observability" surface in one place.

- **`pushMany` is the throughput-critical primitive** — call this
  out explicitly in `live-series.mdx`'s push section. Apps forwarding
  events from a per-event source (gRPC streams, EventSource, brokers
  with `qos=1`) should reach for `pushMany` with explicit
  producer-side batching, not "trust consumer-side coalescing." The
  M3 friction notes show macrotask-coalesced `pushMany` averages 1.4
  events/call at saturation — the API works, but only when the
  caller actually batches.

- **GC observation snippet** — six-line `PerformanceObserver` over
  `'gc'` entries, alongside the existing `LiveSeries.on('evict')`
  callback docs. Aggregator deployments need this; pond can host the
  one-paragraph pattern.

- **No-NaN guarantee from numeric reducers** — reducer-reference
  page should state explicitly that `p50`/`avg`/`stdev`/`pNN`/
  `difference` emit `undefined` (not `NaN` or `Infinity`) for empty
  windows, cold windows under `minSamples`, and below-threshold
  states. Surfaced in the webapp-telemetry code as defensive
  `toNumber()` wrappers that wouldn't be needed if the guarantee
  were stated.

- **Same-timestamp event behavior per ordering mode** — the
  `LiveSeries` ordering-modes section should pin what happens with
  ties under each mode. The webapp-telemetry code's `Math.max(ts,
lastTs + 0.001)` monotonicity hack was belt-and-suspenders against
  unclear tie-handling. Documenting "ties accepted under `'reorder'`
  and `'drop'`; throws under `'strict'`" would remove the need.

- **Side-channel latency-measurement pattern** — short recipe / how-
  to showing the `Map<eventKey, pushedAtMs>` pattern for end-to-end
  latency in network-fronted aggregators. The M3 experiment hand-
  rolled this; we explicitly chose not to bake `pushedAt` into pond
  (push→batch is synchronous; the latency is entirely
  application-side). Documenting the pattern is the right
  deliverable.

- **`LiveSequenceRollingAggregation` schema reference** — the
  rolling.sample() class is in the API reference but its place in
  the live layered model could use a small diagram (we have the
  ARCHITECTURE.md ASCII version; the docs site doesn't yet show
  it).

Likely venue: a new how-to page, "Observing pond-ts in production",
covering eviction listeners, GC observation, end-to-end latency,
push-vs-pushMany guidance, and pointers to the relevant operator
sections. Estimate: 200-400 lines MDX, single PR, ships via
`gh workflow run docs.yml --ref main` — no version bump required.

## Performance expectations and the bench-vs-real-world gap

A design note worth pinning, surfaced concretely by the gRPC
experiment's M3 milestone.

The library benchmark publishes peak throughput numbers (e.g. **538k
events/sec at P=100, N=10** in the multi-partition rolling
benchmark). These numbers are **achievable iff the caller hands
`pushMany` arrays of N events**. Per-event sources without wire
batching see roughly an order-of-magnitude less:

| Scenario                                                    | Effective throughput                            |
| ----------------------------------------------------------- | ----------------------------------------------- |
| Library bench, `pushMany([...N events])`, N=10              | **538k events/sec**                             |
| Per-event push (`live.push([row])` once per source event)   | ~70k events/sec end-to-end (gRPC framing-bound) |
| Macrotask-coalesced `pushMany` over a per-event gRPC stream | ~73k events/sec (+7-17%); avg batch 1.4 events  |
| Wire-level batched `pushMany` (estimated)                   | 200-400k events/sec                             |

The gap is **wire-shape, not pond**. gRPC delivers one event per
`'data'` callback; `setImmediate`-based coalescing rarely catches
more than the event that triggered the schedule. To approach library
peak with a real network source, the **producer must batch at the
wire** (e.g. `stream EventBatch { repeated Event }` in proto, with
the producer accumulating 1-10ms of events per frame and the
aggregator unpacking into a single `pushMany`).

**Documentation implication:** the benchmarks page (and the README's
"performance" section) should grow a one-paragraph callout that
frames the bench numbers honestly:

> _Pond's bench numbers reflect what's possible when the caller hands
> `pushMany` an array of N events. If you're forwarding from a
> per-event source — gRPC `'data'` callbacks, EventSource frames,
> message-broker `qos=1` subscribers — your effective throughput
> depends on whether the wire layer batches. Per-event forwarding
> typically reaches ~14% of the bench peak; producer-side wire
> batching can recover most of the gap. The
> [gRPC experiment's M3 friction notes](link) show this in detail._

Worth doing alongside the docs-backlog pass above — same MDX
deploy.

**`@pond-ts/server` implication:** the eventual server package
should ship a `coalesce({ windowMs })` strategy with a tested
default, plus a reference `EventBatch`-style proto in examples.
Both surfaced as M3 friction-note carry-forwards. Captured here so
the M5 RFC starts with these pre-baked rather than re-discovering
them.

**What this is NOT:** a deficiency in pond. The bench numbers are
real; `pushMany` is the right primitive; the wire-shape consideration
is inherent to network-bound architectures. Documenting the
expectation is the deliverable, not optimisation work.

## Cross-cutting work

These happen throughout the phases rather than being deferred:

- keep this document current whenever a meaningful implementation milestone lands
- keep the docs site aligned with shipped behavior
- add end-to-end examples whenever a major capability lands
- keep API reference generation working in CI
- expand tests alongside every new public API
- prefer benchmark-backed changes for performance-sensitive core refactors
