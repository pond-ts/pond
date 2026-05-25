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

### Source-layout migration (shipped — kebab-case layer folders, schema split)

`packages/core/src/` was a flat 26-file root mixing public classes,
helpers, types, and `Live*` operators. The migration moved every
non-barrel module into a layer folder under a single naming rule.

**Shipped via PRs #137, #138, #140, #141, #142, #143, #144, #145.**

Final layout:

```
packages/core/src/
├── index.ts              # public package barrel (only file at root)
├── batch/                # TimeSeries, PartitionedTimeSeries, validate, json, aggregate-columns
├── core/                 # event, interval, time, time-range, temporal, calendar, duration, errors
├── columnar/             # internal storage substrate (unchanged)
├── live/                 # LiveSeries + every Live*, series-store, live-history, triggers
├── reducers/             # reducer registry (unchanged)
├── schema/               # type vocabulary split by concern (10 files; was types.ts + types-*.ts)
└── sequence/             # Sequence, BoundedSequence, sample
```

Naming rule: every file is kebab-case; class names stay PascalCase
inside the file. No mixed convention, no judgment calls about
"public concept vs internal helper." Documented in ARCHITECTURE.md
under "Source layout conventions."

`schema/` decomposes the former 1022-line, 82-export `types.ts` into
10 focused files (`series.ts`, `events.ts`, `json.ts`,
`aggregate.ts`, `reduce.ts`, `rolling.ts`, `reshape.ts`, `diff.ts`,
`join.ts`, `public.ts`) plus an internal `schema/index.ts` barrel.
The `pond-ts/types` subpath still resolves; `package.json#exports`
was updated to point at `dist/schema/public.{d.ts,js}`.

**No compatibility shims left at the root.** Each layer-move PR
rewired every import site rather than leaving 1-line re-exports
behind. Per-PR diffs were larger, but the end state needs no v1.0
cleanup pass for shim removal.

**What's still aspirational** (not shipped here):

- Operator extraction from `batch/time-series.ts` (4524 lines).
  The structural move is done; the "thin API shell + `batch/operators/*.ts`"
  goal in ARCHITECTURE.md hasn't started. Same for
  `live/live-series.ts` (1185 lines) and `live/live-partitioned-series.ts`
  (1448 lines).
- `io/` layer (row/object/json/point converters) is reserved in
  ARCHITECTURE.md but not yet created — comes into existence when
  operator extraction surfaces the relevant code paths.

**Why this was worth doing now.** Phase 4.7 (columnar core
substrate) and the eventual operator extraction both touch every
public-class file. Doing them on the old flat layout meant
arbitrating PascalCase/kebab-case naming and "public concept vs
internal helper" judgment per PR; doing them on a clean layered
tree means the storage rewrite and operator splits land as
mechanical moves into known homes.

**Public API unchanged.** Every `import { ... } from 'pond-ts'`
and `import type ... from 'pond-ts/types'` resolves to the same
identifiers it did before #137. 1670/1670 tests pass on every
migration PR.

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

### Queued: live align for multi-stream joining

`series.align(seq, { method: 'hold' | 'linear' })` exists on the batch
side and is the canonical primitive for resampling irregular events
onto a regular grid. There is no live counterpart today — earlier
PLAN drafts classified `live.align` as an intentional gap (claiming
the live buffer doesn't have "stable footing" for it). That framing
was wrong: align needs a point _forward_ of each grid boundary, not
historical context, and the live buffer has the historical side
already. The forward-point requirement makes streaming align a
**bounded-lag** problem, not a structural impossibility.

**Use-case driver: multi-stream joining.** The textbook case is
network counter data combined into derived timeseries — `cpu_in`
and `cpu_out` arriving on independent producers' schedules, joined
via `throughput = in - out` after both are aligned to a common
grid. pondjs supported this in production for exactly this shape.
Today's pond-ts users work around it with snapshot-then-batch on
every tick — heavy at firehose rates and per-tick latency-bound.
A live `align` unblocks the natural shape of the queued live join
work above (joining two streams typically requires aligning both
first).

**Lag trade-off:**

- `method: 'hold'` — emit grid point T once a source event with
  `time > T` arrives (or once we know no source has been seen since
  the last update past T). Lag = (next source event time) - T.
  Bounded for dense sources; unbounded if the source goes quiet.
  Same as batch's "no source seen since" semantics.
- `method: 'linear'` — needs a defined source value strictly after
  T to interpolate. Lag is strictly the inter-event gap straddling
  T. For dense sources (the network-counter case at sub-second
  resolution), sub-second lag; for sparse sources, indefinite.
  Caller opts in.

**Connection to streaming-RFC milestones:**

- **Milestone A (`LiveChange`)** — not strictly needed; live align
  works on top of `'event'` listeners alone.
- **Milestone C (`AggregateEmission` finality modes)** — cleanly
  models the lag: align could emit `kind: 'update'` when a grid
  boundary first crosses, `kind: 'final'` once the bounding event
  arrives. Without C, the v1 cut emits a single event per grid
  point at the moment the lag closes — simpler shape, less rich.
- Independent of milestones B and D.

**v1 surface (proposed):**

```ts
const aligned = live.align(Sequence.every('1s'), {
  method: 'hold',
  emit: 'on-bound', // emit only when the bounding source confirms;
  //   alternative: 'provisional' for milestone-C
  //   `update`/`final` semantics later.
});

// Multi-stream join shape (depends on live merge/join above):
const throughput = live.alignAndJoin([cpuIn.align(seq), cpuOut.align(seq)], {
  compute: ([inV, outV]) => (inV ?? 0) - (outV ?? 0),
});
```

The `alignAndJoin` shape is illustrative — the actual API depends
on how the live merge/join entry resolves. If the v1 cut of merge/
join requires aligned inputs, `align` ships first and merge/join
chains it; if merge/join supports tolerance-window joining without
explicit alignment, `align` is independent.

**Same logic applies to `live.materialize(seq)`.** Materialize is
align's sibling: both regularize an irregular source onto a
sequence grid; both need a forward bound. Materialize emits the
first / last / nearest source event inside each bucket, which only
becomes definitive when the next-bucket event arrives. Bounded-lag
the same way. Probably ships alongside live align as a paired
release; defer the design until the align driver is firm.

**Why not deferred indefinitely:** the multi-stream join story is
a recurring pattern (network monitoring, financial feeds, IoT
multi-sensor fusion). Pond's current "snapshot every tick + batch
join" workaround is correct but expensive at scale — it pays the
TimeSeries reconstruction cost on every tick, which dominates at
firehose loads. Live align + live join is the structural fix.

**Sequencing posture:** earns its slot when (a) a use-case agent
hits the snapshot-then-batch friction concretely, or (b) the live
merge/join work above starts and align is needed as a prerequisite.
Until then, queued.

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

### Queued: live API parity for the buffer-as-window persona (logged 2026-05-04)

Surfaced by the gRPC experiment's metric agent code:

```ts
const rolling = series.rolling(
  RETENTION,
  { p50: 'p50', p75: 'p75', p95: 'p95', count: 'count' },
  { minSamples: 1, trigger: rollingReportTrigger },
);
```

The agent wrote `rolling(RETENTION, ...)` because they wanted "stats
over my entire current buffer, emitted on a trigger" — and the
explicit form was the closest primitive available. It works, but
it's a workaround. The user holds a `LiveSeries` with retention as
their only window; the buffer **is** the window. Forcing them to
declare a two-level structure (retention + a rolling window matched
to retention) reads as ceremony when the simpler intent is "reduce
the buffer streaming-style."

This is a recurring shape — many users will not want a two-level
series (rolling-window buffer via retention plus a rolling window
inside it). The library's job is to make the one-level case as
obvious to write as the two-level case.

**Triage of gaps surfaced when comparing `LiveSeries` / `LiveView`
to batch `TimeSeries` for this persona:**

**Tier 1 — direct asks for the buffer-as-window user.**

> **Cross-reference (2026-05-05):** `live.reduce()` is the
> single-buffer face of the **Fused multi-window rolling +
> buffer-as-window unification** primitive (see "Deferred from this
> wave" below). Design `live.reduce()` from the start as sugar for
> the fused form (record API) with the `'buffer'` sentinel:
>
> ```ts
> live.reduce(mapping, opts) ===
>   live.rolling({ buffer: mapping }, { history: false, ...opts });
> ```
>
> This makes the API future-compatible: extending to multi-window
> via `live.rolling({ '1m': m1, '200ms': m2 }, opts)` is "add
> another entry to the record" not "introduce a new primitive
> shape." Ship Tier 1 first if fused-rolling lands later; if both
> ship together, ship as the unified buffer-as-window release.

- **`live.reduce(mapping, opts?)`** — full-window streaming reduce.
  Mirrors batch `series.reduce(mapping)` semantically: "no window,
  just everything in scope." Returns an accumulator with
  `value()` + `on('event', ...)`. Implementation is thin — under
  the hood it's `rolling(retention-bound, mapping, { history: false })`
  with the window taken from `LiveSeries`'s own retention. Pairs
  with the `history: false` tactical fix and is sugar over the
  fused multi-window primitive.

  **Open questions to settle pre-ship:**
  - **No retention case.** If the source has no retention bound
    (or unbounded `maxEvents`), `live.reduce` reduces over the
    whole history. Doc-note: "memory grows with `LiveSeries`
    retention; use bounded retention for high-rate sources." Same
    caveat as live rolling, but more invisible because the user
    didn't write the window down — louder doc treatment warranted.
  - **Retention change after construction.** Probably an error or
    stale-state case; needs explicit handling.
  - **Late events / grace.** Should follow whatever the source
    buffer does — a late event accepted within grace updates the
    reduce; an evicted event is removed. Same machinery as today's
    rolling.

- **`live.timeRange()`** — span of the current buffer
  (`last.begin() - first.begin()`). Trivial to implement; "how much
  data am I holding?" is a question this persona genuinely asks.
  Batch has it; live doesn't.

- **`live.eventRate(): number`** — events per second over the buffer.
  `LiveView` already exposes this (line 240); `LiveSeries` does
  not. Today the user does `live.window('1m').eventRate()` to get
  rate over the last minute — fine when they want "last minute"
  specifically; needless detour when they want "rate over what's
  retained." Pure parity addition.

- **Naming consistency: `live.count()` vs `live.length`.** `LiveView`
  has both `count()` (line 218) and `length`; `LiveSeries` exposes
  only `length`. Either give `LiveSeries` a `count()` alias for
  symmetry, or drop `LiveView.count()` in favor of `length`. Lean
  toward dropping `LiveView.count()` — `length` is the JS-idiomatic
  shape. Minor; settle alongside the other Tier 1 work.

**Tier 2 — query primitives on the sorted live buffer (SHIPPED v0.16.0).**

Pure parity additions on `LiveSeries` and `LiveView`. Both classes
now expose:

- **Predicate query:** `find(pred)`, `some(pred)`, `every(pred)`.
  Linear scan; thin wrappers over the underlying event array's
  same-named methods.
- **Key-position query:** `includesKey(key)`, `bisect(key)`,
  `atOrBefore(key)`, `atOrAfter(key)`. Binary search on the sorted
  buffer; O(log N).

`KeyLike` and `toKey` are now exported from `TimeSeries.ts` (and
re-exported from the package root) so callers can type their own
helpers consistently across batch and live.

37 dedicated tests in `packages/core/test/live-query-tier2.test.ts`
cover empty-buffer behavior, bisect edge cases (before / exact /
between / after), live mutation reflection (retention evicts
update bisect), and LiveView parity (windowed bisect respects
view boundary; filtered view's `includesKey` returns false for
filtered-out events).

Use cases that motivated this: "is there already an event with
key K?" / "what was the most recent event before time T?" — both
come up in dashboard / monitoring patterns where the buffer **is**
the working set.

**Tier 3 — range slicing and the `window` vs `tail` naming.**

`TimeSeries` has `tail(duration)`, `within(range)`, `before(t)`,
`after(t)`, `trim(range)`, `overlapping(range)`, `containedBy(range)`.

`LiveSeries.window(size)` is conceptually a tail-like `LiveView` —
"recent slice." But `window` collides with the windowing-operator
concept (`rolling`, `aggregate`, `reduce` are all "windowing modes"
per the docs). Two open questions:

- **Rename `window` → `tail`?** Better matches batch and reads
  more clearly. Public-API rename — needs deprecation. Reach for
  this only if it's part of a broader live-naming pass.
- **Add `live.within(range)` / `before(t)` / `after(t)`?** Same
  machinery as `window`, scoped differently. Returns `LiveView`.
  Useful for the buffer-as-window persona who wants "events
  between two timestamps."

Ship Tier 3 only after Tier 1 + 2 land and the persona's actual
usage patterns reveal which slicing shapes matter most.

**Not gaps (intentional):**

- `live.smooth({ alignment: 'centered' })`, `live.smooth('loess')` —
  these need a forward window the live buffer can't bound generally.
  Trailing-alignment EMA / movingAverage are online and feasible if
  driven by friction; the centered / loess variants are best left to
  `live.toTimeSeries().smooth(...)`.
- `live.shift` is a re-keying transform that doesn't bring obvious
  live value beyond `live.map(e => e.set('time', ...))` — defer
  unless a use case argues for it.

**Reclassified — moved to queued.** An earlier draft of this section
listed `live.align(seq, ...)` and `live.materialize(seq, ...)` as
intentional gaps because "they need historical context the live
buffer doesn't have stable footing for." That framing was wrong —
both operators need a point _forward_ of each grid boundary, not
historical context, and that's a bounded-lag problem rather than a
structural impossibility. See the new "Queued: live align for
multi-stream joining" entry above for the use-case driver and the
lag trade-off.

**Suggested PR structure:**

- **PR 1 — Tier 1 core:** `live.reduce()` + `live.timeRange()` +
  `live.eventRate()` + `live.count()` parity decision (~150 LoC
  - tests).
- **PR 2 — Tier 2 query parity:** `find` / `some` / `every` /
  `includesKey` / `bisect` / `atOrBefore` / `atOrAfter` (~100 LoC,
  pure parity additions, no design questions).
- **PR 3 — Tier 3 if/when:** range-slicing parity + `window` vs
  `tail` decision. Defer until Tier 1 + 2 ship and the API-usage
  shape suggests which slicing matters.

**Why queued and not blocked-on-something:** all three tiers are
small, well-scoped, and motivated by direct user evidence (the
metric agent's call site for Tier 1, batch parity gaps for Tier
2, naming consistency for Tier 3). No design surface needs a
second user signal first — the gaps are visible from the existing
batch-vs-live contrast. Schedule alongside the next live-API pass
or when a buffer-as-window user reports specific friction.

### Shipped: pipeline `stats()` accessor across 8 live classes (v0.16.0)

Per-class `stats()` accessor shipped in PR 2 of the v0.16.0 wave —
covers `LiveSeries`, `LiveRollingAggregation`, `LiveFusedRolling`,
`LiveAggregation`, `LiveReduce`, `LivePartitionedSeries`,
`LivePartitionedSyncRolling`, and `LivePartitionedFusedRolling`.
Each class has private integer counters incremented in existing
handlers (`#ingest` / `#removeFirst` / `#emitEvent` / `#routeEvent`)
plus an O(1) `stats()` accessor returning a plain record.

Per-class shapes match the design sketch below, with two
deviations:

1. `LiveAggregation.stats()` returns
   `{ eventsObserved, bucketsClosed, openBuckets, openBucketStart? }`
   instead of `{ eventsObserved, bucketsClosed, emissions,
openBucketStart? }`. `emissions` would have been redundant with
   `bucketsClosed` (every closed bucket emits exactly one output
   event); `openBuckets` (current pending bucket count) carries
   bucket-lifecycle info users actually reach for.
2. `LiveReduce.stats()` was added beyond the original 7-class
   sketch since the gRPC team uses it as their primary primitive;
   shape is `{ eventsObserved, evictions, emissions, bufferSize }`
   where `bufferSize = eventsObserved - evictions` (current count
   of events in reducer state, tracking the source's retained
   buffer).

Tests: 33 dedicated stats tests in
`packages/core/test/live-stats.test.ts` covering shape pinning,
counter advancement on every relevant event, retention/eviction
counting, late-event silent-drop accounting, partition counting,
trigger-fire-count for non-event triggers, and a 10k-event
allocation smoke test. All 1177 core tests + 55 react tests
passing.

Original design sketch (logged 2026-05-06):

Surfaced by the gRPC experiment's manual-counter pattern in
`aggregator/src/aggregate.ts` (step 6, pond-grpc-experiment#26):

```ts
let eventsIngested = 0;
let eventsEvicted = 0;
const offBatch = live.on('batch', (events) => {
  eventsIngested += events.length;
});
const offEvict = live.on('evict', (events) => {
  eventsEvicted += events.length;
});
// later, on every tick:
emit({ events_ingested_total: eventsIngested, ... });
```

Every long-running pond pipeline reaches for cumulative counters
of _something_ — events seen, events evicted, emissions fired,
partitions spawned. The library has the data internally
(`'batch'` / `'evict'` listeners, the `#partitions` map, the
output buffer length); users wire it themselves because pond
doesn't expose it in a single accessor. Each new user
reinvents the same handler+counter boilerplate.

**The shape — `stats()` accessor on each accumulator/series.**
Read-only point-in-time snapshot, returned as a plain record.
Per-class field set:

```ts
live.stats();
// { ingested, evicted, rejected, length, earliestTs?, latestTs? }

rolling.stats(); // LiveRollingAggregation
// { eventsObserved, evictions, emissions, windowSize }

fused.stats(); // LiveFusedRolling
// { eventsObserved, evictions, emissions, windowSize, windowsCount }

agg.stats(); // LiveAggregation
// { eventsObserved, bucketsClosed, emissions, openBucketStart? }

byHost.stats(); // LivePartitionedSeries
// { partitions, eventsRouted }

syncRolling.stats(); // LivePartitionedSyncRolling / LivePartitionedFusedRolling
// { partitions, eventsObserved, emissions, windowSize: max-across-partitions }
```

**Cost budget — strict.** Each new field is a private integer
counter, incremented in handlers that already exist. `stats()`
itself constructs one record on call. Per-event cost: ~3
integer increments. No allocation per event, no listener fan-
out, no per-event indirection. This is an observability
ergonomic, not a perf concern — sits in the same bucket as
`length` / `windowSize` / other zero-cost accessors.

**Read pattern — polling, not subscription.** Users call
`stats()` when they want a snapshot:

- Once per tick when assembling a wire frame (gRPC pattern)
- On every render frame at 60fps (dashboard pattern)
- From `setInterval(..., 10_000)` for periodic backend export
- From inside a `Trigger.every('10s')` handler for data-clock
  cadence

A push-based `on('stats', cb, { trigger })` shape was
considered and rejected for v1 — wall-clock timers inside pond
break the data-is-the-clock invariant the rest of the library
preserves; data-clock cadence via `Trigger.every` is already
composable in 5 lines of user code (subscribe to `'event'`,
check ts crosses boundary, call `stats()`). Revisit only if
users repeatedly write that exact composition.

**What's NOT in scope:**

- **Distributions / latency histograms.** That's metrics-
  framework territory; users wanting Prometheus-style
  observability layer a real metrics library at the
  application boundary on top of `stats()`.
- **Per-partition stats maps.** Aggregate "partition count"
  is enough for v1; per-partition counts add memory
  proportional to partition count. Add only if a user lands
  on the wall.
- **Late-event / reorder accounting.** Useful for
  `ordering: 'reorder'` debugging, but the reorder path is
  already complex; targeted additions when `OrderingMode`
  semantics get more attention.
- **Beam-style metrics registry.** Counter / Gauge /
  Distribution / runner aggregation. Massive scope creep —
  pond is an in-process series library, not a distributed
  pipeline orchestrator. Permanently out of bounds.

**Framing.** Same as the v0.15.2 abstraction-cost framing:
making observation cheap is library work; building a metrics
system isn't. Polling `stats()` is sufficient for the long-
tail of "I want to know how my pipeline is doing"; anything
richer is application code that composes on top.

**Implementation rough estimate.** ~150 LoC across the seven
accumulator/series classes (~20-25 LoC each, mostly counter
fields + `stats()` method). Tests pin "counter advances on
every relevant event" + "snapshot record shape matches
class." Bench: trivial — confirm the stats() construction is
sub-µs and per-event counter updates are unmeasurable. Could
ship as v0.16.0 (small additive surface, type-safe) alongside
the queued buffer-as-window Tier 1 work.

Cross-reference: gRPC experiment manual counter
(pond-grpc-experiment#26 step 6); the v0.15.2 SHIPPED entry's
"manual counter vs rolling" follow-up doc note.

### Shipped: `partitionBy` default-inherit fix (v0.17.1)

Bug fix, strictly additive, no surface change beyond defaults. Surfaced by
the gRPC experiment's
[M4 friction note](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/M4.md):
under `source = LiveSeries({ ordering: 'reorder', graceWindow: '30s' })`
followed by bare `live.partitionBy('host')`, the source accepted late
events via its reorder path but the partition sub-series was constructed
with default `'strict'` ordering. `_pushTrustedEvents` routed the late
event to the partition's `#insert` which threw with a strict-mode error,
and the throw propagated back up through the source's listener fan-out
into `live.push()`. **99.5% of late events crashed the partition router**
in the friction-note's drift harness.

**Fix:** `LiveSeries.partitionBy()` now default-inherits `ordering`,
`graceWindow`, and `retention` from the source. Explicit options on
`partitionBy(by, ...)` override per-field. `LivePartitionedSeries.collect()`
and `apply()` likewise default-inherit `ordering` and `graceWindow` from
the partitioned series (which inherits from source); retention stays
caller-explicit on collect/apply per the existing append-only fan-in
semantics. `graceWindow` inheritance is gated on effective ordering being
`'reorder'` — LiveSeries' constructor rejects strict + graceWindow.

Existing callers with explicit `partitionBy(by, { ordering, ... })`
unchanged. Existing callers on strict sources unchanged (source default
is strict; inherited default is strict). The behavior change is exactly
the bug fix: `'reorder'`-mode sources now produce reorder-mode partitions
by default.

Six tests in `LivePartitionedSeries.test.ts` pin: inherited ordering,
inherited graceWindow within reorder, inherited retention on partitions,
explicit override of inheritance, strict-source no-change, and the
edge case where overriding ordering to strict suppresses graceWindow
inheritance. `collect()` inheritance pinned by a separate test.

Released as v0.17.1.

### Shipped: `live.sample({...})` — bounded-memory stream sampling (v0.17.0)

Surfaced by the gRPC experiment's M3.5 finish-line work. Cross-reference:
[`pond-grpc-experiment/friction-notes/rfcs/bounded-memory-sampling.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/rfcs/bounded-memory-sampling.md)
(originating RFC, with measured firehose numbers). Shipped via PR #129.

#### Shipped scope (v0.17.0)

- **Live-side: stride only.** `LiveSeries.sample`, `LiveView.sample`,
  `LivePartitionedSeries.sample`, `LivePartitionedView.sample` all accept
  `SampleStrategy = { stride: number }`.
- **Snapshot-side: stride + reservoir.** `TimeSeries.sample` and
  `PartitionedTimeSeries.sample` accept `BatchSampleStrategy` (both forms);
  reservoir uses single-pass Algorithm R, sorted by key on output to preserve
  the chronological invariant.
- **Bias trap is a doc warning, not a type-level guard.** The
  multi-entity bias risk on pre-partition `live.sample(...)` is documented
  in the `LiveSeries.sample` / `LiveView.sample` JSDoc with the
  `partitionBy(...).sample(...)` recommendation, matching the existing
  convention for `rolling` / `aggregate` / `fill` / `diff` / `rate` /
  `cumulative` / `pctChange` / `reduce`. None of those operators have a
  type-level partition-acknowledgment token; `sample` follows the same
  convention.

#### Implementation: closure-counter inside `LiveView`

The live-side implementation collapsed dramatically from the original
~300-LoC `LiveSample` class to a `~30-LoC` `makeStrideSampleView` helper in
`LiveView.ts` — the same factory pattern that backs `makeFillView` /
`makeDiffView` / `makeCumulativeView`. Each `.sample({...})` call site
captures its own counter in a closure and returns a `LiveView<S>`:

```ts
export function makeStrideSampleView<S>(
  source: LiveSource<S>,
  stride: number,
): LiveView<S> {
  let counter = 0;
  return new LiveView<S>(source, (event) => {
    counter++;
    return counter % stride === 0 ? event : undefined;
  });
}
```

Returning a `LiveView` (not a bespoke operator) means the chainable
surface — `filter`, `rolling`, `reduce`, `select`, `map`, … — is
immediately available downstream of the sample. This was a Layer 2
adversarial-review finding on PR #129's first attempt; the simplification
fixed it for free. Per-partition state falls out of the existing factory
pattern (`new LivePartitionedView(this, sub => makeStrideSampleView(sub, N))`):
each partition's sub-series gets its own closure, so the counter is
per-partition by construction.

#### Deferred from this wave: live-side reservoir

Live-side reservoir is **deferred to v0.18.0+** and gated on milestone A
of the streaming RFC (`LiveChange` model). The blocker: Algorithm R's
random-slot replacement produces **non-prefix** evictions of the live
buffer (e.g., replacing `event_50000` in `[event_1000, event_50000,
event_100000]`), but the current live-eviction protocol is **prefix-only**
— `LiveView` mirrors source eviction by computing `cutoff =
evicted[last].begin()` and dropping every view event with `begin() <=
cutoff`. A reservoir-style replacement event_50000 would corrupt
downstream `LiveView`s by also dropping event_1000.

Codex's adversarial review on PR #129 caught this protocol violation on
the original implementation (which emitted reservoir replacements as
single-element `'evict'` events and relied on `LiveView` accepting them as
prefix evictions — silent corruption of any `view.sample(...).filter(...)`
chain). The fix needs an **exact-removal eviction channel** — `LiveChange`
with `kind: 'remove' | 'replace'` carrying event identity — which arrives
with Phase 4.5 milestone A.

Snapshot-side reservoir is unaffected (single-pass Algorithm R over a
known-N events array, no eviction concern) and ships in v0.17.0 as the
canonical visualization shape:

```ts
series.sample({ reservoir: { size: 500 } }).toRows();
```

The user's framing ("ship reservoir, especially for visualization, that
seems a more natural interface") drives the snapshot-side default;
visualization is exactly the use case where reservoir's uncorrelated
points beat stride's regular-spacing artifact.

**The window-length wall.** Streaming aggregator memory is `O(window_seconds ×
event_rate × per_partition_count)`. At 70k events/s × 80 partitions, a 1m
rolling baseline holds ~4.2M events × ~600 bytes ≈ 2.5 GB. A 5m baseline at
the same rate is 170 GB — non-starter. Window length is pinned to whatever
fits in the heap, even though operators consistently want longer baselines
for stability (`sd / sqrt(N)` standard error scales with `N`).

Sampling decouples baseline length from event rate. At firehose × stride=10:
`cpu_avg` 0.5446 → 0.5575 (within burst-walk drift), `cpu_sd` 0.1166 → 0.1176
(identical to 3 d.p.), `cpu_n` per host 53,282 → 5,278. The SE grows √10 ≈
3.2× but stays an order of magnitude below the per-event noise floor for the
gRPC experiment's reducer mix (`avg`/`sum`/`min`/`max`/`count`/percentiles).

**The product framing:** "5× more stable cluster CPU baseline at the same
memory budget" beats "30% lower aggregator memory" as a roadmap pitch.

#### API shape

A new chainable operator on `LiveSeries`, `LivePartitionedSeries`, `LiveView`,
`LivePartitionedView`, `TimeSeries`, and `PartitionedTimeSeries`. Identity-on-
schema — `sample` doesn't transform row shape, just thins the stream:

```ts
live
  .partitionBy('host')
  .sample({ stride: 10 })
  .rolling('5m', { cpu_avg: 'avg', cpu_sd: 'stdev' }, { trigger });
```

Two strategy types — split by call-site:

```ts
// Live-side (all four call sites)
type SampleStrategy = { stride: number };

// Snapshot-side (both forms; no live-eviction concern)
type BatchSampleStrategy = { stride: number } | { reservoir: { size: number } };
```

`partitionBy(...).sample(...)` thins each partition's stream independently —
the canonical safe shape, recommended in the JSDoc on the pre-partition
sites. Snapshot-side `TimeSeries.sample` and `PartitionedTimeSeries.sample`
accept the broader `BatchSampleStrategy` since single-pass Algorithm R is
unaffected by the live-eviction protocol.

#### Strategy: stride (live + snapshot)

- Deterministic — keep events whose per-stream counter is a multiple of N
- O(1) per event, no RNG, no allocation
- Uniform-over-time: every moment's window is a uniform sample of events
- **Default for sliding-window stats** (rolling, aggregate, reduce-over-window)
- Plays cleanly with the existing prefix-eviction protocol (closure-counter
  inside `LiveView`)

#### Strategy: reservoir (snapshot-side only in v0.17.0)

Snapshot-side: single-pass Algorithm R over the known events array, sorted
by key on output. O(N) time, O(K) space, no eviction concern. Ships in
v0.17.0 as `TimeSeries.sample({reservoir: {size: K}})`.

- Approximately uniform K-subset of the snapshot's events
- Output is sorted by key (chronological invariant preserved)
- **Default for population-summary and visualization** —
  `series.sample({reservoir: {size: 500}}).toRows()` for a scatter plot is
  the canonical case: uncorrelated points (no regular-spacing artifact),
  fixed point count, no `aggregate(seq, ...)` collapse-to-grid
- `Math.random()` for v1; an optional `rng?: () => number` parameter for
  reproducible benchmarks / tests can land later if friction surfaces

**Live-side reservoir deferred to v0.18.0+** — the original Option A
"drift-on-eviction" design (Algorithm R + slot-refill on source evict) was
implemented and reviewed; Codex caught that Algorithm R's random-slot
replacement produces non-prefix evictions, which silently corrupt
downstream `LiveView`s mirroring eviction via cutoff. See "Deferred from
this wave" above for the dependency chain. The original Option A design
description is preserved here for the next implementation pass:

> Algorithm R for ingest: each new event has probability `K / seen` of
> replacing a random reservoir slot. On source eviction, if the evicted
> event is in the reservoir, remove that slot; the next arriving event
> refills deterministically. Approximately uniform K-subset of the
> source's currently-retained buffer; drifts slightly toward newer events
> under steady-state eviction.

Strict sliding-window uniform sampling (chain sampling, Babcock-Datar-Motwani)
is deferred indefinitely — Option A's drift is acceptable for streaming
statistics; the strict variant would need its own paper-citation review
and chain bookkeeping. Live-side will get Option A first, on top of the
`LiveChange` exact-removal channel.

#### The bias trap (documented in JSDoc, not gated by types)

The gRPC experiment's prototype shipped with a real bug: a single global
stride counter applied to a structured stream (round-robin host order) kept
the same 8 hosts every batch and dropped the other 72. Nothing in the
cluster headline noticed. The fix was per-host counters — exactly what
`partitionBy('host').sample(...)` does for free.

This is the **same multi-entity consideration** that already applies to
every stateful live operator — `rolling`, `aggregate`, `fill`, `diff`,
`rate`, `cumulative`, `pctChange`, `reduce` all silently mix data across
entities on a multi-entity stream unless scoped per-partition first. None
of those operators have a type-level partition-acknowledgment token; the
JSDoc warns and points users at `partitionBy(...)`. `sample` follows the
same convention:

```ts
class LiveSeries<S> {
  sample(strategy: SampleStrategy): LiveView<S>; // JSDoc warns about
  //                                                multi-entity bias
}

class LivePartitionedSeries<S, K, ByCol> {
  sample(strategy: SampleStrategy): LivePartitionedView<S, K, ByCol>;
  // safe by construction — each partition gets its own counter
}
```

An earlier iteration of this PR shipped a `GlobalSampleStrategy =
{ stride; unsafeGlobal: true }` type-level token, but the user pulled it
during review with the framing _"partitioning needs to be considered by
the user in many of our operators"_ — token-of-the-week consistency
beats per-operator novelty. The bias trap is captured in the
`LiveSeries.sample` / `LiveView.sample` JSDoc, the test file's
"bias-trap regression pin" doc-comment, and the `partitionBy().sample()`
recommendation chain in the example mappings.

#### Sample-rate metadata: Option A (observed-only)

Reducer outputs (`'count'`, `'sum'`, `'samples'`, `topN`) reflect what
actually flowed through the consumer. Users multiply by `1/sample_rate` to
estimate true counts. Library does not thread sample rate through reducer
state.

Documented in the docstring with a worked example:

```ts
// Estimating true count from sampled stream:
const sampled = live.partitionBy('host').sample({ stride: 10 });
const counts = sampled.rolling('1m', { events: 'count' });
// counts.value().events × 10 ≈ true count over the 1m window
```

`live.stats().ingested` and `live.on('batch', cb)` are upstream of any
`.sample(...)` op — they continue counting true throughput. Only consumers
downstream of `sample` see the thinned stream.

#### Snapshot-side parity

`TimeSeries.sample(strategy)` and `PartitionedTimeSeries.sample(strategy)`
ship for parity. Reservoir on a `TimeSeries` is materially simpler than on
a live source (single pass of Algorithm R over the known events array, no
eviction concern, no Set bookkeeping). `series.sample(...).toRows()` is the
canonical visualization path.

#### Per-partition state

`partitionBy(...).sample({stride: N})` holds an independent stride counter
per partition, not a single shared counter (which would re-introduce the
bias trap on a multi-host stream). Same factory-per-partition pattern that
`partitionBy(...).rolling(...)` already uses — each partition's `LiveView`
owns its closure.

Once live-side reservoir lands (v0.18.0+ on top of `LiveChange`),
`partitionBy(...).sample({reservoir: {size: K}})` will hold a K-event
reservoir per partition. For the gRPC experiment's 80 partitions × K=100,
that's 8000 events of reservoir state — bounded, predictable.

#### Use-case mapping

| Use case                                         | Stride                      | Reservoir                                   |
| ------------------------------------------------ | --------------------------- | ------------------------------------------- |
| Sliding-window stats (rolling avg / percentiles) | ✅ default                  | n/a (live) — ⚠️ drift (live, post-v0.18.0+) |
| Population summary over the retained buffer      | ⚠️ rolling-only             | ✅ snapshot                                 |
| Visualization (scatter plot, sparkline samples)  | ⚠️ regular-spacing artifact | ✅ snapshot default                         |
| Top-K / unique reducers                          | ❌ misses singletons        | ⚠️ also misses, with extra randomness       |
| `live.reduce()` over buffer-as-window            | ✅ uniform-over-time        | n/a (live)                                  |

Picking the wrong strategy is the highest-leverage bug the docs can prevent;
this table belongs in the operator's JSDoc verbatim. v0.17.0 lands the
live "stride" column and the snapshot "reservoir" column; the live
"reservoir" column rolls in with v0.18.0+ milestone A.

#### Composability

Composes cleanly with the rest of the live operator surface — the
`LiveView` return type means filter/rolling/reduce/select/map/diff/rate/
fill/cumulative all chain naturally downstream of `.sample(...)`:

```ts
// rolling — primary case from the gRPC experiment
live.partitionBy('host').sample({ stride: 10 }).rolling('5m', mapping);

// pre-partition stride feeding rolling (v0.17.0 PR #129 chainability fix)
live.sample({ stride: 10 }).rolling(5, mapping);

// pre-partition stride feeding filter — chainable surface available
live.sample({ stride: 10 }).filter(predicate);

// buffer-as-window — also valid
live
  .partitionBy('host')
  .apply((sub) => sub.sample({ stride: 10 }).reduce(mapping));

// snapshot-side visualization
series.sample({ reservoir: { size: 500 } }).toRows();
```

#### Implementation scope (as shipped)

- **Live-side stride:** ~30-LoC `makeStrideSampleView` helper in
  `LiveView.ts` + four call-site methods (`LiveSeries.sample`,
  `LiveView.sample`, `LivePartitionedSeries.sample`,
  `LivePartitionedView.sample`) each ~3 lines.
- **Snapshot-side stride + reservoir:** ~30 LoC inline in
  `TimeSeries.sample`, plus per-partition delegation in
  `PartitionedTimeSeries.sample`.
- **Strategy types:** `src/sample.ts` (~80 LoC of types + JSDoc explaining
  why live reservoir is deferred).
- **Tests:** 23 runtime tests in `test/LiveSample.test.ts` covering stride
  determinism, eviction tracking, per-partition isolation, the bias-trap
  regression pin, composability with rolling, snapshot reservoir
  approximate-uniformity (statistical pin: 4σ × ≥18-of-20 trials), and
  type-level `@ts-expect-error` pins in `test-d/live-sample.test-d.ts`.
- **Two-pass review:** Layer 2 (Claude) + Codex adversarial. Codex
  caught the live-reservoir non-prefix-eviction protocol violation that
  drove the simplification described above. Both reviews are durable on
  PR #129.

#### Forward dependencies

The shipped v0.17.0 scope (live stride + snapshot stride/reservoir)
doesn't depend on Phase 4.5 — it's a current-shape transform built on the
existing `LiveView` infrastructure (closure-counter + the standard
`EMITS_EVICT` cutoff-based prefix-eviction protocol). Lands standalone,
before milestone A starts.

**Live-side reservoir DOES depend on Phase 4.5 milestone A.** The
non-prefix eviction problem only resolves once the streaming RFC's
`LiveChange` model gives us an exact-removal channel
(`{ kind: 'replace' | 'remove', target: EventId }`). Until then, the
existing `'evict'` channel can only carry prefix evictions consistently.
This pins the v0.18.0+ wave order: milestone A first, then live-side
reservoir as a follow-up PR landing on top.

The stride form is independent of v0.18.0+ milestone B/C/D — it's a
stream-content transform, not a state or finality transform. Sampled
streams flow through the future `LiveChange` model unchanged: dropped
events simply don't appear as `kind: 'append'` in the downstream change
stream.

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

- **Fused multi-window rolling — SHIPPED v0.15.0 (2026-05-05).**
  The keyed-form `live.rolling({ '1m': m1, '200ms': m2 }, opts)`
  primitive is live on `LiveSeries`, `LiveView`, and
  `LivePartitionedSeries` — a single ingest pass over a shared
  deque, single trigger, one merged output event per boundary.
  Two new classes (`LiveFusedRolling`,
  `LivePartitionedFusedRolling`); type-level surface
  (`FusedMapping`, `FusedRollingSchema`,
  `FusedPartitionedRollingSchema`, `DurationString`) exported.

  Bench against gRPC RFC #20 acceptance criteria
  (`packages/core/scripts/perf-fused-rolling.mjs`):
  - Partitioned 100 hosts, 100k events: fused vs two-rollings =
    **−27.9% wall, −29.0% heap**.
  - Partitioned 1000 hosts saturation: **−31.8% wall, −44.5% heap**.
  - Fused vs single-rolling baseline: +16.8% wall, +4.0% heap
    (the small constant overhead of an extra window's reducer
    state).

  The architectural cliff is closed; gRPC experiment can migrate
  V7 → V8 with one ingest pass. Test surface: 24 runtime tests
  (single-window equivalence + multi-window + partitioned + types)
  - type-d block. All pass; full suite green at 1111 + 55.

  **Validated by gRPC experiment V8 (pond-grpc-experiment#22,
  2026-05-05).** Same-day migration; V8 is a **strict improvement
  over V6 across every measured load point** — not just a V7
  recovery:

  | Config           | V6 heap | V7 heap | V8 heap | V8 vs V6 |
  | ---------------- | ------- | ------- | ------- | -------- |
  | 9k/s             | 161 MB  | 147 MB  | 132 MB  | **−18%** |
  | 87k/s            | 1617 MB | 1886 MB | 1217 MB | **−25%** |
  | 92k/s × 1k hosts | 1379 MB | 1426 MB | 1263 MB | **−8%**  |
  | Ceiling tput     | 258k/s  | 209k/s  | 284k/s  | **+10%** |

  All three RFC #20 acceptance criteria met and surpassed.
  End-to-end p99 latency at 87k/s: **0.71ms (V7) → 0.16ms (V8)**
  — 4.4× improvement, the shared per-event ingest doing
  measurable work. This closes the architectural cliff the V6→V7
  profile-diff exposed.

  **Second validation axis — reducer cardinality
  (pond-grpc-experiment#25, M3.5 step 5).** The first axis
  (N windows) was pinned by pond's bench at N=2..5 (constant
  ~100ms wall, win compounding). Step 5 added three more
  reducers (`requests_avg`/`sum`/`count`) to the same 1m window
  in the gRPC aggregator — same window, +75% reducer count.
  Cost: **+5-11% heap, −3% throughput** (4 → 7 reducers); still
  beats V6 baseline at most load points despite doing 2× the
  reducer work. Confirms that adding reducers within an existing
  window doesn't add per-event pipeline overhead — only the
  unavoidable per-reducer state work, which separate rollings
  pay too. Both axes (window count + reducer cardinality) of the
  primitive's compose-for-free claim are now empirically grounded.

  **Deferred to follow-ups (logged here for the future-reader):**
  - **`live.reduce(mapping)` sugar.** `'buffer'` sentinel is in
    the type but throws at runtime. Lands with the buffer-as-
    window Tier 1 PR. (gRPC V8 noticed the sentinel-in-types
    surprise — confirmed as known gap.)
  - **`TimeSeries.rolling` snapshot-side parity.** Live-side only
    in v0.15.0.
  - **Path A** (share `LiveSeries` buffer when `longest_window ≤
retention`). Currently Path B (own deque); same API, perf
    follow-up.
  - **SHIPPED v0.16.0: compile-time uniqueness check** on fused
    output columns. `FusedMappingValid<FM>` resolves to a branded
    `__FUSED_ROLLING_ERROR` type when two windows declare the same
    output column name; the call site fails with a message naming
    the conflicting column. Wired into `LiveSeries.rolling`,
    `LiveView.rolling`, and both `LivePartitionedSeries.rolling`
    overloads. Pinned in `test-d/fused-rolling.test-d.ts`.
  - **Tighter `DurationString` template-literal type — DEFERRED.**
    Investigated in v0.16.0 development: a fully-recursive integer-
    only template hits TS's "circularly references itself" error,
    and a bounded union (10^N digit strings up to N=12) hits "union
    type is too complex to represent" past ~5 digits. The current
    `${number}${unit}` already rejects non-numeric prefixes
    (`'1min'`, `'abch'` fail); fractional / negative / exponential
    shapes (`'1.5m'`, `'-1m'`, `'1e3m'`) pass at the type level but
    fail runtime parsing. Documented in `utils/duration.ts` JSDoc
    so future readers don't re-attempt the bounded-union dead end.
    Revisit only if a user lands on this with concrete friction.
  - **`partitionBy` partition-column literal narrowing —
    SHIPPED v0.15.1 (2026-05-05).** gRPC V8 found that
    `live.partitionBy('host').rolling({...})` widened the
    partition-column type, with the V8 workaround
    `live.partitionBy<'host'>('host')` clobbering the value-type
    parameter K. v0.15.1 added `ByCol` as a third generic
    parameter on `LivePartitionedSeries<S, K, ByCol>` and
    `LivePartitionedView<SBase, R, K, ByCol>`, captured from the
    `by` argument; threaded through every per-partition method
    so chained pipelines (`partitionBy('host').fill(...).rolling(
{...})`) survive the narrowing. The workaround can drop;
    `partitionBy('host')` is now sufficient. type-d block
    extended to pin both root and chained narrowing.

  ***

  **Original design rationale (preserved for the historical
  record):** Two independent signals merged into one design. Tap-
  by-itself was overfitting to the gRPC use case; the fused form
  covers both gRPC and the buffer-as-window persona without
  hierarchy bookkeeping.

  **The two signals:**
  1. **gRPC profile-diff (PR #19, 2026-05-05).** Profile-grade
     evidence that V7's regression is the second
     `LivePartitionedSyncRolling`, not the `samples` reducer.
     Every per-event pond hop roughly doubled in inclusive time
     vs V6 (`#routeEvent` 15.0% → 28.9%, `ingest` 11.5% → 25.0%,
     `_pushTrustedEvents` 13.1% → 27.4%). The reducer itself is
     ~2.3% self-time; v0.14.3's allocation fix closed that leak.
     The architectural cost is doubled per-event ingest. Closing
     it needs a single ingest pass that updates multiple windowed
     reducer states.

  2. **Buffer-as-window persona (metric agent's call site).**
     `series.rolling(RETENTION, mapping, ...)` is the workaround
     when the buffer IS the window. The user has retention; they
     want stats over the buffer; they shouldn't have to declare a
     two-level structure (retention + a matched rolling window) to
     get there. `live.reduce(mapping)` covers the single-buffer
     case, but the broader pattern is "buffer + zero-or-more
     sub-windows." Same primitive answers both.

  **gRPC RFC #20 carry-forwards (2026-05-05).** Library-side RFC
  posted from the experiment side, in response to the design
  consolidation in PLAN. Pushes back on several details and
  refines others; outcomes carried into this entry below:
  - Drop the array-form escape hatch entirely; record form is the
    only fused-rolling API. Per-window options via elaborated
    value form (`{ mapping, minSamples }`) instead of dropping to
    array form.
  - Output shape is **ONE merged `LiveSource<Out>` stream**, not
    N accumulators or N streams. The collapse-to-one-event-handler
    win is half the value of the proposal.
  - Compile-time duplicate-column detection across windows via
    branded error type — strict improvement over status quo.
  - `DurationString` template-literal type for record keys —
    catches typos like `'1min'` at compile time.
  - Time-based windows only (count-based stays on the single-
    window overload).
  - Partition-column auto-injection unified across all windows.
  - Acceptance criteria pinned at hard perf targets.

  **The unified user-facing shape.** A `LiveSeries` with retention
  IS a buffer; the buffer IS the implicit longest window of any
  rolling computation attached to it. Declared sub-windows are
  tighter cursors into that buffer. Three APIs over the same
  machinery:

  ```ts
  // Single buffer (the buffer-as-window common case):
  const stats = live.reduce({ p95: 'p95', count: 'count' });

  // Single sub-window (today's shape; no change):
  const r = live.rolling('200ms', { samples: 'samples' });

  // Multi-window — keyed-record form (the fused primitive):
  const fused = live.rolling(
    {
      '1m': { cpu_avg: 'avg', cpu_sd: 'stdev', cpu_n: 'count' },
      '200ms': { cpu_samples: 'samples' },
    },
    { trigger },
  );
  ```

  User mental model is unified: "what windows do I want?" The
  buffer is just the longest one (clipped to retention; see below).
  All three APIs share the same trigger / output / event-subscriber
  surface — they're sugar over the same primitive.

  **Record form is the only fused-rolling API.** No array form.
  The earlier proposal to keep an array form as escape hatch for
  per-window options was rejected in the gRPC RFC for three
  reasons:
  - Strictly worse readability — three layers of nesting
    (`window:` / `output:` / individual columns) where two suffice.
  - Compile-time duplicate-column detection works naturally for
    the record form (objects can't have duplicate keys); is hard
    for the array form.
  - Per-window cadence (the main motivation for the array form)
    is rare; users who need it fall back to two `rolling()` calls
    and pay the V7 cost. Fused rolling explicitly trades that
    rare case for the simpler API in the common case.

  **Per-window options via elaborated value form.** When per-window
  options are needed (like `minSamples`), the record value
  switches from a bare mapping to a wrapper:

  ```ts
  byHost.rolling(
    {
      '1m': { cpu_avg: 'avg', cpu_sd: 'stdev' },
      '200ms': {
        mapping: { cpu_samples: 'samples' },
        minSamples: 5,
      },
    },
    { trigger },
  );
  ```

  Common path stays clean (value = mapping); elaborated form is
  used only when needed. Top-level options
  (`{ trigger, minSamples }`) apply as defaults across all
  windows; per-window elaborated `minSamples` overrides for that
  window.

  **Output shape — one merged stream.** Fused rolling emits ONE
  `LiveSource<Out>` with all windows' columns merged into one
  event per partition per trigger boundary. Not N accumulators;
  not N event streams. The whole point is that user code
  collapses to one event handler — V7's `pendingByTs` /
  `partsFor` / `tryEmit` machinery dissolves into:

  ```ts
  fused.on('event', (e) => {
    // All windows' columns on one event — no buffering, no drain.
    const tick = assembleTick(
      e.key().begin(),
      e.get('host'),
      {
        cpu_avg: e.get('cpu_avg'),
        cpu_sd: e.get('cpu_sd'),
        cpu_n: e.get('cpu_n'),
      },
      e.get('cpu_samples') ?? [],
    );
    scheduleFrame(tick);
  });
  ```

  See gRPC RFC #20's "Worked example" for the full V7 → V8 diff —
  ~30 lines of join/drain machinery (`pendingByTs`, `partsFor`,
  `tryEmit`, microtask scheduling) collapse to the handler above.
  Readability win is independent of the perf win and may be the
  larger of the two for typical users.

  **TypeScript surface.** Three things the type system needs to
  do:
  1. **Flat-merge per-window columns into one schema.** For each
     entry in the fused mapping, compute the per-window columns
     the way `RollingSchema` / `RollingOutputMapSchema` do today,
     then union all of them. Auto-inject the partition column
     once at the front (not per window).

  2. **Compile-time duplicate-column detection.** If two windows
     define the same output column name
     (`'1m': { cpu_avg: 'avg' }` plus `'5m': { cpu_avg: 'avg' }`),
     emit a `never` plus a branded error type at the call site:

     ```ts
     type CheckUniqueOutputs<FM> = /* duplicate detected */
       ? { __error: `Duplicate output column '${string}' across windows` }
       : FM;
     ```

     Strict improvement over the status quo, where two separate
     `rolling()` calls can silently shadow each other's column
     names.

  3. **`DurationString` template-literal type for keys.**
     Constrain object keys to `${number}${'ms'|'s'|'m'|'h'|'d'}`
     to catch typos like `'1min'` at compile time. The `'buffer'`
     sentinel is allowed alongside as a literal:

     ```ts
     type DurationString =
       | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`
       | 'buffer';

     type FusedMapping<S extends SeriesSchema> = Readonly<
       Record<DurationString, FusedMappingValue<S>>
     >;
     ```

  Substantive type-level work — non-trivial generics across the
  three responsibilities. Worth budgeting separately from the
  runtime implementation.

  **Time-based windows only.** Object keys are duration strings
  (or the `'buffer'` sentinel). Count-based windows
  (`live.rolling(100, ...)`) stay on the existing single-window
  overload and are not mixable with time-windows in the fused
  form. The window-clip-to-retention rule and the boundary-
  detection logic both depend on time semantics; mixing kinds
  isn't worth the complexity for a primitive whose target use
  cases (multi-window stats over a streaming buffer) are
  inherently time-shaped.

  **Partition-column auto-injection.** The existing partitioned-
  rolling overload auto-injects the partition column (e.g.
  `host`) into the output schema, even if the mapping doesn't
  name it. Fused does the same — partition column appears once
  at the front of the merged output, never per-window.

  If a window's mapping explicitly tries to name the partition
  column (`'1m': { host: 'first' }`), the existing collision check
  in `LivePartitionedSyncRolling` fires; fused preserves this
  guarantee across all windows. The merged output schema is
  `[time, partition_col, ...union_of_window_columns]`.

  **Snapshot-side parity.** `TimeSeries.rolling` should accept the
  same record-form keyed mapping. Less perf-critical (offline)
  but API parity matters for code that moves between live and
  snapshot mode (the gRPC experiment's V6 → V7 → fused migration
  is exactly this pattern). Implementation is simpler on the
  snapshot side (no trigger, no streaming dispatch); the
  TypeScript surface is shared.

  **Storage model.** One shared deque of `{ absIdx, ts, values }`,
  sized by the longest declared window. Each window holds:
  - `head: absIdx` — absolute event index of the oldest event still
    in this window's reducer state (monotonic across the rolling's
    life; survives deque compaction)
  - `reducerStates: RollingReducerState[]` — one per output column

  Per-event work:

  ```
  ingest(event):
    deque.push({ absIdx, ts, values })          # 1 append (was N)
    for window in windows:
      cutoff = event.ts - window.duration
      while getEntry(window.head).ts < cutoff:
        for col: col.state.remove(window.head, ...)
        window.head++
      for col in window.cols:
        col.state.add(event.absIdx, ...)
    deque.dropFrontTo(min(window.head for window in windows))
  ```

  Cost story matches the gRPC profile-diff:
  - `#routeEvent` / `_pushTrustedEvents` runs once instead of N →
    kills the V6→V7 doubled inclusive-time
  - Per-window add/remove cost unchanged (same as N rollings)
  - Shared deque storage → kills V7's +17% heap delta (the second
    rolling's per-bucket array state goes away)

  **Cursor representation: absolute event indices.** `head` is the
  absIdx of the oldest event still in the window. Stable across
  deque compaction (`deque.frontAbsIdx` translates absIdx → array
  position). Matches how `RollingReducerState.add(index, ...)`
  already takes an absolute index for `Map`-keyed remove.

  **Path A vs Path B — the buffer-as-window optimization.**

  If the longest declared window ≤ retention, the LiveSeries buffer
  already holds every event the fused rolling needs. The fused-
  rolling's own deque becomes redundant.

  | Path                            | Behavior                                                                     | Cost                                                                                                           |
  | ------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
  | **A** — share LiveSeries buffer | Fused holds only cursors + reducer state; events live once                   | Bigger refactor: fused needs read access into LiveSeries' deque shape; eviction wiring crosses module boundary |
  | **B** — own deque               | Fused subscribes via `'event'`, maintains its own deque alongside LiveSeries | Smaller change; same code shape as today's rolling. Events held twice when longest_window ≤ retention          |

  **Ship B first.** It gets the gRPC win immediately (single ingest
  pass eliminates the doubled per-event hop) and the API surface
  is identical to A. Path A is a buffer-as-window perf follow-up —
  a runtime optimization that's invisible to the user. Storage
  duplication at typical scale (~100 hosts × low-rate streams) is
  invisible; at saturation (1k partitions × kHz) it's measurable
  but not blocking.

  **Constraint: windows clip to retention.** When a declared window
  exceeds retention, the rolling reduces over whatever's currently
  retained. No fallback, no escape hatch — buffer-as-window users
  already accept this semantic by virtue of choosing retention as
  their bound. The rule is consistent: declaring a window through
  the fused form means "this is a sub-window of the buffer."

  Users who need exact-window semantics regardless of buffer size
  keep using today's-shape `live.rolling(window, mapping)` — that
  primitive maintains its own deque independent of LiveSeries
  retention and is preserved unchanged. The choice between fused
  and standalone-rolling becomes "are you a buffer-as-window user
  (fused, clipped) or do you want exact-window-no-matter-what
  (standalone)?"

  **Single-window equivalence — load-bearing pin.**
  `live.rolling(window, mapping, opts)` (today's shape) MUST
  produce identical output to `live.rolling([{ window, output:
mapping }], opts)` (fused with one entry). Tested explicitly.
  Otherwise the unification is incomplete — users would observe a
  silent behavior shift when adding a second window.

  **`live.reduce()` as fused-with-one-entry.** Design `live.reduce(
mapping, opts)` from the start as sugar for the fused form (record
  API) with the `'buffer'` sentinel:

  ```ts
  live.reduce(mapping, opts) ===
    live.rolling({ buffer: mapping }, { history: false, ...opts });
  ```

  Same trigger options, same `value()` shape, same event-subscriber
  surface. The `'buffer'` sentinel resolves to retention at
  construction. No API divergence; either Path A or Path B
  implements correctly.

  **Tap is a separate primitive — not subsumed by fused.** The
  earlier "tap as compositional sugar over fused-rolling" framing
  (where `parent.tap(w, m)` would add a sub-window to an existing
  rolling) is dropped. Once we accept the record form as the
  primary API, there's no compositional add-after-the-fact use
  case worth supporting — declare your windows up front in one
  call.

  However, the gRPC RFC #20 introduces `tap()` as a different
  primitive: a **per-partition observer callback** for slim
  observation use cases. See every event in a partition cheaply,
  no aggregation. Distinct problem, distinct solution; not a
  replacement for fused rolling. Captured as a separate companion
  entry below.

  **Tile-mode storage axis (preserved as alternative).** Fused-
  rolling stores raw events in the shared deque. For composable-
  reducer-only workloads (`avg`/`stdev`/`count`/`sum`/`min`/`max`),
  the deque could store fixed-duration tile summaries instead —
  `{ n, sum, sumSq, ts_start, ts_end }` per tile. 5m at 1s
  resolution = 300 tile entries vs ~150M raw events at 500k/s ×
  5m. Three orders of magnitude less storage; per-tile O(1)
  update.

  Tile mode is an alternative storage shape for fused-rolling; it
  applies when the reducer set is closed under associative summary.
  Defer until fused ships and we see the workload mix that
  motivates adding it. Sibling axis to "Path A vs Path B" — both
  are perf optimizations on the fused primitive, transparent to
  user-facing API.

  **Implementation rough estimate.**
  - New class `LiveFusedRolling<S, Out>` (single merged output
    schema): ~400-500 LoC for the runtime — shared deque, per-
    window cursors + reducer-state, fused `#evictPartition`,
    boundary-detection collapsing N triggers into one fan-out.
  - Type-level work — substantive generics across three
    responsibilities (flat-merge schemas, duplicate-column
    detection, `DurationString` constraint): ~150-200 lines of
    type aliases + helpers + tests in `test-d/`.
  - Public surface: keyed-form overload on `LiveSeries.rolling` /
    `LivePartitionedSeries.rolling` / `LiveView.rolling` /
    `TimeSeries.rolling` (snapshot-side parity).
  - `live.reduce(mapping)`: ~20 LoC of sugar over the keyed form.
  - Single-window equivalence test: today's-shape produces
    identical output to fused with one entry.
  - Multi-window correctness tests: ~200 LoC.
  - Partitioned variant tests: ~100 LoC.
  - Bench `perf-fused-rolling.mjs`: V6-vs-V7-style cost diff plus
    buffer-as-window storage footprint.

  Total ~1000-1200 LoC + tests + bench. Medium PR; not multi-week.

  **Acceptance criteria (from gRPC RFC #20).** When this lands,
  the experiment migrates `aggregate.ts` from V7 (two rollings +
  per-`(ts, host)` join) to V8 (fused rolling, single event
  handler). The bench bar:
  - Ceiling throughput within 5% of V6's 258k/s (V7 was 209k/s,
    −19%).
  - 87k/s heap close to V6's 1617 MB (V7 was 1886 MB, +17%).
  - 9k/s heap stays at or below V7's 147 MB.
  - `LivePartitionedSyncRolling.js` self-time drops back to
    ~8-10% range (V7 was 20.7%).
  - `#routeEvent` / `_pushTrustedEvents` / `ingest` inclusive
    times drop back to V6's range.
  - `#evictPartition` self-time drops to ~4-5% (V7 was 8.8%, NEW
    in V7's top-25).

  Not "exact V6 parity" — the perf budget is "fused rolling pays
  for the readability + correctness wins (compile-time uniqueness,
  one event handler) without measurable regression vs the manual-
  deque V6 baseline." Bench numbers are the load-bearing record;
  don't ship without the full diff in the PR body.

  **Open design questions to settle pre-ship.**
  - **Top-level vs per-window `minSamples`.** Top-level applies as
    a default; per-window elaborated form overrides for that
    window. Settled this way — matches the existing `minSamples`
    surface and avoids forcing every entry into the elaborated
    form when one window needs the override.

  - **Partitioned variant.** `live.partitionBy('host').rolling(
{...}, opts)` — one shared deque per partition, all windows
    over that partition's deque. At 1k partitions × 2 windows,
    fused saves the 1k duplicated deques V7 builds today.
    Per-partition partitioned variant uses the existing
    `LivePartitionedSyncRolling` machinery; the changes are in
    how it stores/iterates per-partition state to support multiple
    windows.

  - **Path A boundary case.** When `longest_window ≤ retention`
    changes at runtime (e.g., user mutates retention), Path A
    detects and degrades to Path B. Document explicitly. Most
    users won't change retention at runtime; the case worth
    handling is the construct-time choice.

  - **Custom-function reducers.** Same per-window O(W) snapshot
    cost as today's rolling; doc-note unchanged. Fused doesn't
    make this cheaper — per-event work is shared, but snapshot
    cost is per-window-per-emit and that's already what custom
    functions cost today.

  - **`window: 'buffer'` sentinel resolution.** When does it
    resolve — construct time (capture retention then; reject if
    retention later changes), or runtime (re-resolve every emit
    against current retention)? Lean construct-time + reject-on-
    change for predictability. If a user genuinely needs dynamic
    retention coupling, they declare `window: live.retention()`
    explicitly and we expose a method for it.

  - **Single trigger vs per-window trigger — closed.** Single
    trigger across all windows is by design; that's the point of
    fusion. Users who need per-window cadence fall back to two
    `rolling()` calls and pay the V7 cost. Rejected the array-
    form alternative.

  **Why ship.** Two distinct user signals (gRPC profile-diff +
  buffer-as-window metric-agent call site), one clean primitive
  design that covers both, fits the existing API surface as
  `rolling`'s array overload, shipping unblocks both the buffer-
  as-window release AND the gRPC saturation regime. The earlier
  parking rationale ("wait for second user") is satisfied by the
  two signals being independent — different agent, different
  experiment context, same primitive answers both.

  Reference workaround in the meantime: two separate `rolling()`
  calls off the same source, both with the same trigger.
  Documented in the eventual fused-rolling RFC as the "before-
  v0.X" pattern.

- **Companion: per-partition observer `tap()` (gRPC RFC #20,
  pending evaluation).** A separate primitive raised alongside
  the fused-rolling RFC. **Distinct problem from the earlier
  hierarchical-tap design** that was folded into fused-rolling
  above — this one is a per-partition observer callback for
  slim-observation use cases.

  Use case shape: "see every event in a partition cheaply, no
  aggregation." E.g., per-host event-rate gauges, per-host
  arrival-time histograms, debug instrumentation that doesn't
  need a windowed reducer. Today the only way to get per-
  partition events is `live.partitionBy('host').apply(sub =>
sub.rolling(...))` or `partitionBy.collect()` — both do more
  work than the use case needs.

  Sketch from the RFC:

  ```ts
  byHost.tap((host, event) => {
    // Observer fires once per (host, event) pair.
    // No aggregation, no buffer, no reducer state.
  });
  ```

  Pairs well with fused rolling (shared dispatch infrastructure
  on the per-event hot path) but doesn't subsume or get subsumed
  by it — different problems. RFC explicitly says fused-rolling
  is the higher-value of the two for the experiment's M3.5 step
  5+ roadmap; if only one ships first, fused goes first.

  **Status: pending evaluation.** Hold until fused-rolling lands
  (its design is settled; tap's design is one paragraph and a
  use case). Re-triage once fused ships and we have the dispatch
  infrastructure to share. May turn out to be a small bolt-on; may
  surface enough open questions to earn its own RFC. Don't pre-
  decide.

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

- **Live rolling tactical fixes (logged 2026-05-04, expanded
  2026-05-05, not yet scheduled).** Operational items surfaced in
  Codex's blind multi-window review and the gRPC profile-diff
  (PR #19). Independent of any larger redesign — local fixes
  inside the live-rolling classes.
  - **`Array.shift()` eviction — SHIPPED v0.15.2 (2026-05-06).**
    The gRPC experiment's step 6
    (pond-grpc-experiment#26) escalated this from "tactical
    follow-up" to "shipping blocker" — they hit a 4× throughput
    regression (88k/s → 21k/s) when adding a non-partitioned
    `live.rolling({...}, { trigger })` next to the partitioned
    per-host one. The cliff is the same `Array.shift()` cost,
    just exposed by the firehose-rolling shape instead of the
    multi-second-window-many-evictions shape PLAN originally
    expected.

    All four call sites converted to the head-index pointer
    pattern + periodic batched compaction:
    - `LiveFusedRolling.#compactFront`
    - `LivePartitionedFusedRolling.#compactPartitionFront`
    - `LiveRollingAggregation.#removeFirst` / `#evict`
    - `LivePartitionedSyncRolling.#evictPartition` (time + count
      branches)

    Per-event eviction is now O(1) amortized at all deque sizes.
    Compact-batch threshold = 1024 stale entries (or half the
    array, whichever comes first); above either threshold, the
    deque splice-removes the dead prefix and resets the pointer.

    Bench (`packages/core/scripts/perf-fused-rolling.mjs`):
    worst-case shift pattern (50s window, 50k fill + 50k evict)
    drops 1123ms → 53ms — **21× faster** at the cliff. Steady-
    state deque without eviction is unchanged (V8's hidden-offset
    optimization already handled that well; the cliff was
    specific to large-deque + per-ingest-eviction).

    The agent's manual-counter workaround in `aggregate.ts` can
    now drop; non-partitioned `live.rolling` is viable at the
    rates the experiment cares about.

    **Validated end-to-end by gRPC step 6 follow-up
    (pond-grpc-experiment#26, same-day).** The agent re-enabled
    the natural API and benched it against their preserved
    manual-counter implementation:

    | Config       | Manual counter | Natural API (0.15.2) | Δ        |
    | ------------ | -------------- | -------------------- | -------- |
    | 87k/s heap   | 1278 MB        | 1460 MB              | +14%     |
    | Ceiling tput | 303k/s         | 257k/s               | **−15%** |
    | At 87k/s p99 | —              | 0.40 ms              | —        |

    The cliff is gone (21k/s → 89.9k/s sustained at 87k/s bench
    point — fully closed). The remaining ~15% throughput gap at
    ceiling vs the manual counter is the inherent abstraction
    cost: a rolling pipeline does push-to-deque + reducer-add +
    periodic snapshot per event, where a manual counter is just
    `count++`. That's not a cliff to chase — it's the expected
    constant-factor difference between "just track a number" and
    "maintain a windowed reducer." The agent shipped the natural
    API anyway: API symmetry with the partitioned variant; the
    gap falls in a regime (>100k/s single-stream) the dashboard
    doesn't reach.

    **Doc-worthy follow-up:** add a "manual counter vs rolling"
    note to the rolling reference. The rolling primitive is the
    right answer for sliding windowed reductions; for "I just
    need a cumulative counter or a tick-window delta," a manual
    counter off `live.on('batch')` remains strictly cheaper.
    Small docs entry; not blocking.

    **The framing this validates:** abstractions have a cost.
    We just don't want the cost to fall off a cliff. v0.15.2
    closes the cliff; the remaining 15% is the abstraction
    paying for itself.

  - **SHIPPED v0.16.0: `history: false | RetentionPolicy` on live
    rolling outputs.** Both `LiveRollingAggregation` and
    `LiveFusedRolling` accept the option. Default `true` preserves
    current behaviour; `false` skips the `outputEvents.push`
    entirely (so `length` stays 0 and `at(i)` returns `undefined`,
    while `'event'` listeners and `value()` still work);
    `{ maxEvents?, maxAge? }` mirrors `LiveSeries`'s existing
    retention shape. The accumulator's "skip allocation entirely
    when opted out" question resolved toward strict opt-out. 16
    dedicated tests in `packages/core/test/live-rolling-history.test.ts`.

    Original sketch (preserved for the historical record):

    ```ts
    live.rolling('1m', m, { history: false }); // no retention
    live.rolling('1m', m, { history: { maxEvents: 1000 } });
    live.rolling('1m', m, { history: { maxAge: '5m' } });
    ```

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

  **Suspect 2 (architectural cliff) is NOT chased in v0.14.3 —
  shipping addressed by fused-rolling.** Closing the V7-vs-V6
  throughput gap needs shared-buffer storage with single-ingest
  dispatch. At the kHz × 1k-partition saturation regime, V6's
  hybrid (one pond rolling for stats + manual deque for raw
  values) is genuinely the right architectural shape; pond's
  `samples` is for typical loads where the per-event pipeline
  overhead is invisible. v0.14.3 closes the per-event allocation
  leak; the architectural cliff needed a primitive design.

  **Profile-grade isolation (PR #19, 2026-05-05).** The gRPC
  agent's V6→V7 profile-diff confirmed the cost story is doubled
  per-event hop, not the `samples` reducer (which is fine, ~2.3%
  self-time). Inclusive-time deltas:
  - `LivePartitionedSeries.#routeEvent` 15.0% → 28.9% (+13.9 pp)
  - `LivePartitionedSyncRolling.ingest` 11.5% → 25.0% (+13.5 pp)
  - `LiveSeries._pushTrustedEvents` 13.1% → 27.4% (+14.3 pp)

  Every per-event pond hop roughly doubled. Single-ingest fused
  rolling closes this directly.

  **Two signals merged into the fused-rolling entry.** The V7
  profile-diff plus the buffer-as-window persona's metric-agent
  call site are independent signals (different agents, different
  experiments) pointing at the same primitive. Combined design
  is captured in the **Fused multi-window rolling + buffer-as-
  window unification** entry above. The earlier `tap()` framing
  (hierarchical parent/child) is preserved as compositional sugar
  on top; fused-rolling is the lower-level primitive that ships
  first.

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

## Phase 4.5: Streaming semantics

Status: not started.

Adoption of RFC phases 1–3 from
[`docs/rfcs/streaming.md`](docs/rfcs/streaming.md). The RFC is strategic
context developed across four contributors (original by pjm17971 + Codex,
review notes from the library agent, V2 + V3 amendments by Codex, use-case
agent feedback from the gRPC experiment). This section is the binding
adoption: phases 1–3 of the RFC become committed work, milestones A–D below.
RFC phases 4–7 (progress abstraction, replay/recovery, joins, async
operational polish) stay forward-looking and are explicitly not adopted
here — they will be revisited if and when use-case friction earns them.

Goal: turn the live layer into a deterministic streaming aggregation engine
with explicit time, lateness, finality, keyed state, and structured change
metadata. Preserve pond's data-clock-as-default identity; resist Beam and
operator-graph vocabulary; keep the chain-first user model.

Sequencing: this work lands BEFORE the Phase 6 ecosystem extraction
(`@pond-ts/server`, `@pond-ts/charts`). The server package's
WebSocket-snapshot-then-deltas pattern depends on milestones C (output
finality + wire-safe `AggregateEmission` + stable IDs) and the
emission-history snapshot work that's currently parked in RFC phase 5.
When the server extraction starts, emission-history can be pulled forward
from the RFC into PLAN as the friction signal arrives.

Validation: each milestone must be exercised by a use-case agent (the gRPC
experiment, a successor experiment, or the eventual server/charts package
work) before the design is considered settled. Per CLAUDE.md "Multi-agent
experiments and the feedback model," friction reports drive refinement; per
"Strategic RFCs," the RFC stays as context while PLAN entries are the
contract.

### Milestone A: Source-side change model

Goal: structured `LiveChange` discriminated union surfacing append vs
reorder vs evict on every `LiveSource`. Every later milestone depends on
this. The change stream is internal-first — public `on('change')` lands
only when the API is ready to commit; `on('event')` stays unchanged for
backward compat.

Type:

```ts
type LiveChange<S extends SeriesSchema> =
  | { kind: 'append'; event: EventForSchema<S>; index: number }
  | {
      kind: 'reorder';
      event: EventForSchema<S>;
      index: number;
      previousLatest: EventForSchema<S>;
    }
  | {
      kind: 'evict';
      events: readonly EventForSchema<S>[];
      reason: 'retention' | 'window' | 'clear';
    };
```

Required behavior:

- `LiveSeries.push` identifies append vs reorder; reorder reports the
  insertion index
- retention emits structured eviction changes
- `LiveView`, `LiveRollingAggregation`, `LiveAggregation`, `LiveReduce`,
  and partitioned live operators consume `LiveChange` internally
- existing `on('event')` listeners continue to fire for both append and
  reorder

Performance budget: per-event ingest within 5% of v0.16.1 baseline at
70k events/s, measured against the gRPC experiment's existing benches and
`packages/core/scripts/perf-*.mjs`. Bench numbers go in the commit message.

Dependencies: none. This is the foundational milestone.

Cross-reference: RFC milestone A; library agent review notes "Decisions
to pin before milestone A"; V3 "Operator changes are distinct from source
changes."

### Milestone B: Late repair via reducer capabilities

Goal: capability-based late-data repair, with reducer metadata declaring
what each reducer can correct cheaply.

New registry contract:

```ts
type ReducerCapabilities = {
  lateRepair: 'incremental' | 'recompute' | 'unsupported';
  serializable: boolean;
  emptyBucketIdentity?: ScalarValue;
};
```

Initial population: all built-in reducers declare `lateRepair`. The gRPC
experiment's reducer mix (`avg`, `sum`, `min`, `max`, `count`,
`samples`-deque, eventual t-digest) is 100% `'incremental'` per the
use-case feedback; that's the dominant case for production telemetry.
`'recompute'` and `'unsupported'` are escape hatches for custom function
reducers and reducers that can't safely correct.

Required behavior:

- `LiveRollingAggregation` and `LiveFusedRolling` repair affected windows
  on `kind: 'reorder'` events for `'incremental'` reducers
- `'recompute'` reducers re-evaluate the affected window; diagnostics
  expose how often it fires
- construction-time rejection: `ordering: 'reorder'` plus
  `lateRepair: 'unsupported'` throws unless the operator is configured
  with `late: 'append-only'`

`emptyBucketIdentity` and `serializable` are added as fields but consumed
later (by milestones C and the deferred RFC phase 5, respectively).

Dependencies: milestone A (`LiveChange` provides the reorder signal).

**Driver status (2026-05-11):** the gRPC experiment exercised pond's
late-data behaviour under controlled injection (see
[friction note M4](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/M4.md)).
Round-1 results suggested ~11% drift on the biased host, which a Codex
adversarial pass falsified — the `Math.random()` calls in the simulator
leaked through the round-1 methodology. Once every randomness source
was seeded across replicates, **drift collapsed to within noise on every
host** at the experiment's measurement style (last-tick `.value()` reads
over a 60s rolling window). Milestone B's library design is sound, but
the gRPC experiment's measurement style doesn't surface its payoff —
by the time the consumer reads `.value()`, all late events are already
in the buffer.

The cases that _would_ surface B's value (emission-stream consumers,
idempotent sinks via stable IDs, intermediate-tick reads, short-window
`cpu_sd`) aren't in the gRPC experiment's shape. Milestone B is
design-ready but **driver-light by empirical test**; sequencing it
should wait until a different consumer surfaces friction at one of
those measurement styles, or until milestone C's stable-ID + upsert
output mode makes "idempotent backend writer" a real consumer pattern.

Cross-reference: RFC milestone B; V2 "Late-repair cost model"; V3
"Reducer capabilities become the streaming registry contract."

### Milestone C: Output finality and stable IDs

Goal: explicit finality contract on aggregate output. `'append'` and
`'upsert'` modes; stable JSON-safe `AggregateEmission` shape; library-
specified output ID encoding so sinks can write idempotently. `'retract'`
mode is deferred.

Type:

```ts
type AggregateEmission<Value, Key = Record<string, ScalarValue>> = {
  kind: 'update' | 'final';
  id: string;
  key: Key;
  window: { start: number; end: number };
  value: Value;
};
```

Wire-safety rules: `id` is a string; `kind` is a string literal; `window`
fields are epoch milliseconds; `key` is a shallow scalar record; `value` is
JSON-encoding-safe (no `Date` / `Time` / `Interval` / function / class
instance / cyclic value). Reducers whose output isn't JSON-safe must
require a codec or be rejected for `AggregateEmission` output.

Output ID format: `pond:v1:<series>:<operator>:<key>:<windowStart>:<windowEnd>`,
each segment URI-component encoded. The `pond:v1:` prefix gives room to
change composite-key encoding later without pretending old IDs were
informal. Composite-key encoding for `keyBy(['host', 'region'])` is
explicitly deferred to post-v1.

Output mode behavior:

- `'append'` (default for back-compat): every emission is a new event;
  late corrections do not mutate prior outputs
- `'upsert'`: each output has a stable identity; `kind: 'update'` for
  open buckets, `kind: 'final'` exactly once per bucket; late data inside
  grace produces a replacement value with the same ID
- `'retract'`: deferred

Pinned semantics:

- empty buckets: do NOT emit `final` by default; opt-in via
  `emitEmpty: true`, which uses the reducer's `emptyBucketIdentity`
- grace zero: a bucket that closes on a boundary-crossing event emits one
  `final`, never `update` then `final` for the same ID in the same cycle
- `final` exactly once per output ID
- late-after-final default: `LateAfterFinalPolicy = 'drop'` with a
  diagnostic counter; `'error'` and `'correction'` are opt-in

`'append-only'` late mode definition:

```ts
type LateCorrectionMode = 'correct' | 'append-only';
```

`'correct'` repairs prior outputs; `'append-only'` skips correction and
allows the late event to flow through the operator's forward path
without producing `update` emissions for finalized IDs.

`LiveAggregation.grace` surface fix: `live.aggregate(sequence, mapping,
{ grace: '5s' })` now accepts the `grace` option directly. The constructor
path stays. Default remains source `graceWindowMs` when present; explicit
`grace` overrides. Closes a v0.16.0 surface gap surfaced during the stats
review.

Dependencies: milestone A (change-stream); milestone B (capability
registry — `emptyBucketIdentity` consumed here).

Cross-reference: RFC milestone C; V2 "Output finality decisions";
V3 "AggregateEmission is a wire-safe frame," "Stable output ID encoding,"
"`late: 'append-only'`."

### Milestone D: Keyed streaming aggregation

Goal: first-class `keyBy/window/aggregate` builder, distinct from
`partitionBy`. Per-key bucket state, per-key grace, stable per-key output
identity, and `keyTtl` for high-cardinality stability.

Public surface:

```ts
const ticks = live
  .keyBy('host')
  .window(Sequence.every('1m'), { grace: '5s' })
  .aggregate(
    { cpu: 'avg', latency: 'p95', requests: 'sum' },
    { output: 'upsert', keyTtl: '1h' },
  );
```

`keyBy` is a streaming-aggregation builder; `partitionBy` stays the per-
partition transform builder. Same partition-column machinery underneath,
different return types and mental models. Documentation must keep them
distinct so every example doesn't have to explain which mode it's in.

Required behavior:

- single-column keys for v1 (composite keys deferred — see RFC V3
  "Composite keys are explicitly post-v1")
- per-key isolated state, per-key open buckets
- per-key grace inheritance + override
- stable output identity = key + window
- quiet keys finalize when progress permits
- `keyTtl` measured against progress (not wall-clock); a key is eligible
  for eviction only after all of its windows are final; eviction emits an
  operator-side change

New operator-side change type, distinct from source-side `LiveChange`:

```ts
type OperatorChange =
  | {
      kind: 'key-evict';
      key: Record<string, ScalarValue>;
      reason: 'keyTtl';
      lastEventTime: number;
      progress: number;
    }
  | { kind: 'bucket-open'; id: string }
  | { kind: 'bucket-final'; id: string };
```

`OperatorChange` is diagnostic / control-plane. The data plane stays
`AggregateEmission`. This preserves the RFC V3 three-layer split:
`LiveChange` (source buffer), `OperatorChange` (operator state),
`AggregateEmission` (user-facing output frames).

Dependencies: milestone A (changes), B (capabilities), C (emissions).

Cross-reference: RFC milestone D; V2 "`keyBy` is distinct from
`partitionBy`," "Key retention"; V3 "Operator changes are distinct from
source changes."

### Out of scope (RFC phases 4–7 deferred)

Explicitly NOT adopted in this PLAN entry; these stay in
`docs/rfcs/streaming.md` as forward-looking context until use-case
friction earns them:

- **Phase 4 — Watermark / progress abstraction.** Data-clock progress
  is the current behavior and stays the default; manual / source progress
  modes wait until a use case forces them. Beam-style watermark holds
  are permanently deferred.
- **Phase 5 — Replay, snapshots, recovery.** Input-log replay,
  operator-state snapshots, reducer state serialization, and emission-
  history snapshots are all deferred. The server extraction (Phase 6)
  may pull emission-history forward when it's needed; that's a friction-
  driven decision.
- **Phase 6 — Streaming joins.** Bounded keyed joins and richer triggers
  (`Trigger.any`, idle / wall-clock triggers) wait until progress
  semantics settle.
- **Phase 7 — Operational polish.** Async fanout subscriber error policy,
  full operator metrics expansion (`live.stats()` is the seed),
  WebSocket adapter (lives in `@pond-ts/server`, not core), backpressure
  modes — all deferred.
- `'retract'` output mode.
- Composite-key output ID encoding (single-column keys only for v1).
- `maxKeys` eviction (time-based `keyTtl` is the v1 must-have).

### Forward dependencies on this milestone set

Phase 6 (Ecosystem and adapters) depends on milestones C and D landing
before the server / charts extraction. Specifically:

- `@pond-ts/server` extraction needs `AggregateEmission` (C) +
  `keyBy/window/aggregate` (D) + stable IDs (C) before its
  WS-snapshot-then-deltas pattern can be cleanly built. Emission-history
  (RFC phase 5) is the next dependency to pull forward when that
  extraction starts.
- `@pond-ts/charts` extraction needs `AggregateEmission`'s wire-safe shape
  (C) so chart inputs are JSON-safe streaming frames rather than
  experiment-specific protocols. The constraints captured in the existing
  `@pond-ts/charts` Phase 6 entry stay as the design input from the gRPC
  experiment's M3.5 friction.

### Release shape (tentative)

The RFC is explicit that the seven-phase scope is aspirational, not a
binding contract. For the adopted milestones A–D, a plausible release
shape:

- v0.17.0 — milestone A (`LiveChange` source-side, internal consumption,
  perf-budget commit)
- v0.18.0 — milestone B (capability registry + late repair on incremental
  reducers)
- v0.19.0 — milestone C (`AggregateEmission`, output IDs, `'append'` /
  `'upsert'` modes)
- v0.20.0 — milestone D (`keyBy/window/aggregate` builder + `keyTtl`)

Each release follows the existing two-pass review protocol (Layer 2
adversarial agent review + Codex pass) and is validated by at least one
use-case agent before merge. Release shape is tentative; if friction
reshapes the milestones, the version map adjusts.

**Sequencing addendum (2026-05-11):** Phase 4.7 (columnar core substrate)
is adopted as the v1.0 wave. Milestone A is foundational and ships
independently — `LiveChange` is small, no columnar dependency, and its
internal API is designed to carry columnar-batch updates once the
substrate exists. Milestones B, C, and D **wait for the columnar
substrate** so they ship natively on top, with operator state in
typed-array buffers rather than retrofitted later. The release shape
above adjusts accordingly: A continues toward v0.18.0; B/C/D defer to
post-Phase 4.7.

---

## Phase 4.7: Columnar core substrate (v1.0 wave)

Status: adopted 2026-05-11. Not started.

This is the **v1.0 substrate**. Adoption decision documented in
[`docs/rfcs/columnar-core.md`](docs/rfcs/columnar-core.md) ("Library-agent
response and adoption" section); evidence base in
[`docs/briefs/core-columnar-store-spike.md`](docs/briefs/core-columnar-store-spike.md);
spike implementation on branch `codex/core-columnar-store-spike`
(PR #130, not for merge — kept as the Phase 3 implementation baseline).

**Goal: a foundational columnar framework that underpins pond-ts
internals, preserving the public event-shaped API.** Builds the
substrate that future streaming, charts, server, and ecosystem work
ride on top of. Future optimization doors (WASM reducer kernels,
WebGPU large scans, SIMD via wasm-simd, zero-copy Arrow export) stay
open for v1.x but are not committed for v1.0 itself.

**Strategic frame.** The columnar substrate is not a series of one-off
fast paths; it's a properly abstracted, independently-tested layer
that the rest of pond-ts is rebuilt on. The spike measured the wins
(numeric reduce 6–12×, memory under lazy event materialization 4×
reduction, chart extraction 34×); the strategic argument is timing —
do this before streaming-RFC milestones B/C/D land so they ship
natively on the substrate, not as retrofits of row-oriented internals.
See the RFC for the full argument.

**Locked-in commitments (from the RFC's "Library-agent response"):**

1. Columnar storage adopted broadly across internals (`TimeSeries`,
   derived series, `LiveSeries` ring buffers, the streaming change
   channel, chart `ChartDataSource`). Public APIs (Event, `at(i)`,
   `live.on('event')`, etc.) stay row-oriented at the boundary.
2. Framework as a foundational layer at `packages/core/src/columnar/`
   (or similar), independently tested, with its own bench suite.
   Apache Arrow-compatible concepts without Arrow runtime dependency.
3. Public API invariants preserved (the five from the RFC):
   `series.events === series.events`, `at(i)` reference stability,
   `at(i)` ↔ `events` consistency, `concat` event identity (preserved
   for events the source has materialized; under columnar the
   per-index cache propagates through concat — under today's
   eager-events shape every event is materialized so the guarantee
   is universal in practice; see V4 amendment for the tightened
   contract), event-shaped iteration. `series.at(i)`'s reference
   stability is the contractual stable-reference accessor; no new
   public API.
4. Phase 3 (derived transform chains) is part of the implementation,
   not a prerequisite gate. Implementation adjusts mid-stream if
   Phase 3 surfaces a deal-breaker; worst case is a narrower
   columnar scope (numeric scans + chart extraction + live numeric
   rolling) with row-backed paths for transform chains.
5. String / dictionary reducer adaptation in v1.0 wave (`unique`,
   `top`, `samples`, grouped `count` over dictionary-encoded
   columns).
6. `LiveSeries` columnar ring buffer in v1.0, scoped narrowly:
   numeric typed ring buffers for hot rolling windows + built-in
   reducers. Strings / custom reducers / array columns / mixed
   schemas stay event-backed inside the framework.
7. Aggregate planner: minimal fused planner; precompute bucket
   spans once, answer simple reducers from prefix sums/counts,
   fall back to event-walked path for non-decomposable operations.
8. Private fields on `TimeSeries` / `LiveSeries`, NOT WeakMap
   sidecars (the spike's shape is exploration-only).

**Implementation sequence (rough, ~3–4 months focused work):**

1. Framework layer (~6 weeks) — `Column<T>` interfaces,
   `Float64Column` / `BooleanColumn` / `DictionaryColumn` /
   `ArrayColumn` concrete impls, validity bitmaps, chunked columns,
   range-aware primitives. Independently tested. Bundle-size pin:
   `<25 KB` gzipped delta to pond-ts core.

   Sub-sequenced per
   [`docs/briefs/columnar-framework-design.md`](docs/briefs/columnar-framework-design.md).
   Per-sub-step status:
   - **1a — Float64Column, BooleanColumn, ValidityBitmap.** ✅
     Shipped (PR #132, merged 2026-05-13). 116 framework tests,
     bundle delta < 5 KB gzipped. Length validation
     (`MAX_COLUMN_LENGTH = 2**31 - 8`), packed validity bitmap with
     one-shot freeze that copies bits into an owned buffer,
     boundary tests on every public entry point. Two rounds of
     Codex adversarial review per the PR comment trail.
   - **1b — StringColumn (dict + fallback), DictionaryColumn ops.** ✅
     Shipped (PR #133, merged 2026-05-13). 210 framework tests
     (+94 from 1b's StringColumn surface). Constructor enforces:
     mutually exclusive dict/fallback modes; dictionary indices in
     range for valid cells; fallback no-validity invariant (every
     slot must be a string, else throw); explicit validity
     consistency. `scan` uses `''` as the missing-value sentinel
     for invalid rows in both modes (no divergence); validity-aware
     cross-dictionary `remapColumnToDictionary` for join paths.
     Four rounds of Codex adversarial review per the PR comment
     trail, each finding real issues; the contract surface ended
     up substantially more rigorous than the original draft.
   - **1c — ArrayColumn + KeyColumn (time / timeRange / interval),
     EventKey cache.** ✅ Shipped (PR #134, merged 2026-05-13).
     289 framework tests (+79 across ArrayColumn + KeyColumn).
     `ArrayColumn` (fallback mode) with defensive freeze on cells,
     `EMPTY_ARRAY_SENTINEL` for `scan(skipInvalid:false)`,
     element-wise `ArrayValue` contract enforcement. Three
     `KeyColumn` variants with lazy `Map<number, EventKey>` cache
     pinning `keyAt(i) === keyAt(i)`. `IntervalKeyColumn` supports
     discriminated label columns (`StringColumn | Float64Column`)
     for `IntervalValue = string | number` round-trip, with
     hardened runtime discriminator and per-row type/finite
     assertions. Three rounds of Codex adversarial review per
     the PR trail; each round closed real gaps.
   - **1d — ColumnarStore (read-only) + SeriesStore row-API
     adapter (Path B layering split).** ✅ Shipped (PR #135,
     merged 2026-05-13). 324 framework + adapter tests.

     **Architectural pivot mid-review.** The initial 1d shape had
     `ColumnarStore` materialize Events, manage the eventCache,
     and emit row-shape exports — framework-level code that knew
     about `Event` / `EventKey` / `Time` / `TimeRange` /
     `Interval`. Three rounds of review (L2 + 2 Codex) found
     correctness issues at the same surface (cache validation
     incomplete, key identity, kind-aware data equality, extra-
     /missing-fields leaks) because those concerns sit at the
     wrong layer.

     Pivoted to clean separation:

     **Pure framework** at `packages/core/src/columnar/`. Zero
     upstream imports (runtime or type). Owns its own type
     vocabulary at `columnar/types.ts` (`ColumnDef`,
     `ColumnSchema`, `ScalarValue`, `ArrayValue`, `KeyKind`).
     `ColumnarStore<S>` is schema-validated composition of
     `KeyColumn` + value columns + `valueAt`. Independence test
     scans every framework file for forbidden imports
     (`Event` / `Time` / `TimeRange` / `Interval` / `temporal` /
     `types` / operators).

     **Row-API adapter** at `packages/core/src/series-store.ts`.
     `SeriesStore<S>` wraps a `ColumnarStore` + optional
     eventCache. Owns `keyAt` / `eventAt` / `toEvents` /
     `Symbol.iterator` / `toRows` / `toObjects` + the five
     public-API invariants from the RFC. Structural cache
     validation: structural key equality via `EventKey.equals`,
     per-column data agreement, exact-schema field set (no
     extras OR missing fields), kind-aware value equality
     (`Object.is` for numbers so NaN matches itself, shallow
     element-wise for arrays so the `ArrayColumn` defensive freeze
     doesn't break cache sharing).

     Bundle: 17.2 KB framework + 4.0 KB adapter = 21.2 KB
     gzipped (under the framework-design <25 KB target).

     The split also surfaced what later sub-steps need to
     decide: row-shape intake factories (`fromValidatedRows`,
     `fromTrustedEvents`) belong at the `SeriesStore` layer; the
     framework's `ColumnBuilder` operates on column data.

   - **1e — `ColumnBuilder` primitives + `fromValidatedRows`
     row-intake.** ✅ Shipped (PR #136, merged 2026-05-13). 34
     builder tests + 11 row-intake tests. Framework adds Float64
     / Boolean / String / Array column builders with one-shot
     `finalize`, defensive copy at append for arrays, and
     amortized O(1) capacity doubling. Row-API adapter adds
     `SeriesStore.fromValidatedRows` that delegates to
     `validateAndNormalize`, walks events into builders, and
     pre-populates the eventCache so event identity survives
     intake. Two real bugs caught in review — both in the
     overwrite path: `#writeAt(rowIndex, undefined)` failing to
     clear the validity bit (L2), and defined→defined `appendAt`
     overwrite inflating `#definedCount` without a bitmap (Codex
     round 1). Both fixed with regression tests.
     Deferred follow-up (start of 1f or later): `fromTrustedEvents`
     (skip validation pass) and framework-level `fromBuilders`
     factory on `ColumnarStore` — both reuse the in-place
     `buildSeriesStoreFromEvents` helper.
   - **1f — Index views (`withRowSelection`, `materialize`) +
     zero-copy schema ops.** ✅ Shipped (PR #147, merged
     2026-05-27). 49 view tests; framework total ~370 tests.
     Five framework-level ops: `withRowSelection` (materializing
     gather via per-column `sliceByIndices`), `materialize`
     (identity for 1f; stable surface for the future lazy-view
     path), `withColumnsRenamed`, `withColumnReplaced`,
     `withColumnAppended`, `withColumnsSelected`. All three
     `KeyColumn` variants got `sliceByIndices(indices)` methods
     to support the gather path. Three rounds of review (L2 +
     Codex × 2) found real correctness gaps closed before merge:
     eager out-of-range index validation (silent epoch-row
     corruption under `withColumnsSelected([])`), unsafe column
     names (`__proto__` / `prototype` / `constructor` reserved
     centrally at `ColumnarStore.fromTrustedStore`), and
     inherited-Object-prototype names as rename-map keys
     (`renames[name]` walked `Object.prototype`; fixed with
     `hasOwnProperty.call`). The materializing-vs-lazy decision
     is documented; lazy view-mode columns are a future-doors
     optimization with the existing API as the stable surface.
   - **1g — Chunked value columns + `concatSorted` + `materialize`
     compaction.** ✅ Shipped (PR #148, merged 2026-05-25). 62
     framework tests after Codex round-1 fixes (42 `ChunkedColumn`
     + 20 `Concat`); framework total ~433 tests.
     Four chunked value-column variants
     (`ChunkedFloat64Column`, `ChunkedBooleanColumn`,
     `ChunkedStringColumn`, `ChunkedArrayColumn`) — each holds a
     `ReadonlyArray<Plain>` of chunks + `chunkOffsets: Int32Array`
     (prefix sum), eagerly computes an aggregate validity bitmap
     (preserving the "no bitmap ⇒ all defined" convention), and
     implements the shared `Column` interface
     (`read`/`scan`/`sliceByRange`/`sliceByIndices`). The `Column`
     union widens to include them; a new `storage: 'packed' |
     'chunked'` secondary discriminator lets hot-path callers
     (reducers) narrow on `kind === 'number' && storage ===
     'packed'` to dereference `Float64Column.values` etc.
     `sliceByRange` stays chunked across multi-chunk ranges
     (zero-copy on chunk boundaries) and collapses to plain
     within a single chunk; `sliceByIndices` always
     materializes (gather destroys chunk locality).
     `concatSorted(stores)` N-way concat over temporally-disjoint
     stores: validates schema structural equality, key disjointness
     (strict `<` for Time, half-open `<=` for TimeRange/Interval),
     materializes the key column (`begin`/`end`/labels — labels
     rebuilt via `stringColumnFromArray` so the dict-vs-fallback
     heuristic runs on the whole), and flattens nested chunked
     inputs so chunks always stay one level deep. `materialize`
     now does real work: walks each value column, compacts any
     chunked variants to their plain counterparts via dedicated
     `materializeChunked*` helpers, and returns the input
     unchanged when every column is already packed (identity
     fast-path).
   - **1h — `ColumnarRingBuffer` + `scatterByPartition`.** ✅
     Shipped (PR pending, branch `feat/columnar-step-1h`). 49 new
     framework tests (35 `ColumnarRingBuffer` + 14 `Scatter`);
     framework total ~482 tests.
     `ColumnarRingBuffer<S>` is a mutable, append-only circular
     buffer backing streaming sources. Circular indexing with
     `head` + `length` + `capacity`; logical row `i` lives at
     physical `(head + i) % capacity`. Per-column mutable storage
     for all four value kinds (Float64Array, bit-packed Uint8Array,
     `(string|undefined)[]`, `(ArrayValue|undefined)[]`) and all
     three key kinds (Time, TimeRange, Interval — the latter
     requires `intervalLabelKind: 'string' | 'number'` in options).
     `appendBatch(batch: ColumnarStore<S>)` validates schema
     structural equality and routes per-row writes through circular
     indexing. Lazy growth (default true) starts at
     `min(retention, 64)` and doubles to `retention`; eager mode
     pre-allocates. Eviction advances `head` once `length ===
     retention`. Batches larger than `retention` keep only the
     trailing `retention` rows. `evictPrefix(n)` and `snapshot()`
     decouple the immutable view from ongoing append/evict — the
     snapshot owns fresh typed buffers and dict-rebuilds the
     string columns via `stringColumnFromArray` so encoding
     decisions run once on the snapshot window. The ring is
     **ordering-agnostic** (per RFC V4); strict/drop/reorder
     semantics live at the `LiveSeries` layer.
     `scatterByPartition(source, columnName)` partitions a store
     by a scalar value column, returning
     `Map<ScalarValue, ColumnarStore<S>>`. Rejects array-kind
     partition columns and the key column. Drops rows whose
     partition cell is undefined or `NaN` (the `NaN !== NaN`
     gotcha makes it useless as a Map key). Per-bucket sub-stores
     preserve schema and the input's relative row order;
     cross-bucket order is unspecified (it's a Map).

   **State after 1h (2026-05-25).** All step-1 sub-steps (1a–1h)
   shipped. The framework layer is complete; the next batch of
   work is TimeSeries integration (step 2 in this section's
   roadmap). 1885 tests total across core + react. Framework
   total: ~482 columnar tests. Bundle target (<25 KB gzipped)
   slipped past 26 KB at 1g; 1h adds ~12-15 KB more (ring buffer
   is substantial). Targeted size optimization will be a separate
   sub-step before merging the framework into the user-visible
   API. The pure-substrate layering established in PR #135 (Path
   B) has held cleanly across every subsequent sub-step — no
   framework file imports `Event` / `Time` / `TimeRange` /
   `Interval` / `temporal` / row-API types, verified by the
   independence test on each PR.

2. TimeSeries integration (~3 weeks) — private-field columnar store,
   lazy event materialization, API invariants pinned by tests.
3. Numeric reducer adaptation (~2 weeks) — `sum` / `avg` / `count` /
   `min` / `max` / `stdev` / `median` / percentile family.
4. Derived transforms (~3 weeks) — `select` / `rename` / `filter` /
   `slice` / `head` / `tail` / `diff` / `rate` / `pctChange` /
   `cumulative` / `shift` columnar paths.
5. Aggregate planner (~2 weeks).
6. String / dictionary reducer adaptation (~2 weeks).
7. `LiveSeries` numeric ring buffer (~2 weeks).
8. Chart-extraction alignment (~1 week).

Each step lands as its own PR with the standard two-pass review
(Layer 2 + Codex). The framework layer is the most load-bearing;
reviewing it well matters more than ticking the whole sequence off
quickly.

**Validation pattern.** Each step is exercised by a use-case agent
before merge — the gRPC experiment is the natural primary driver
(memory pressure was its recurring friction), supplemented by the
dashboard / webapp telemetry / future experiments as they arise.
Per CLAUDE.md "Multi-agent experiments and the feedback model,"
friction reports drive refinement; the substrate is foundational
enough that getting feedback per step matters more than usual.

**Release shape (tentative).** v1.0 is the target version when the
substrate + the streaming milestones (B/C/D) that ship on top all
land cleanly. Tentative version map:

- v0.17.x — current patch wave (partitionBy ordering inheritance,
  etc.) — bug fixes only
- v0.18.0 — streaming milestone A (`LiveChange` source-side) — ships
  independently of columnar
- v0.18.x — columnar framework layer (step 1) lands behind feature
  flag or as internal-only initially
- v0.19.0 — columnar TimeSeries integration (steps 2–4) — first
  user-visible substrate landing
- v0.19.x — aggregate planner + string reducer adaptation +
  LiveSeries ring buffer (steps 5–7)
- v0.20.0 — streaming milestones B + C ship on substrate
- v1.0.0 — substrate complete + milestone D + chart alignment;
  v1.0 framing is the version when public API stability commits
  long-term

Release shape is tentative; if implementation surfaces a different
sequencing or a chunk doesn't earn its slot, the version map
adjusts.

**Cross-references:**

- [`docs/rfcs/columnar-core.md`](docs/rfcs/columnar-core.md) — the
  binding RFC with full library-agent response.
- [`docs/briefs/core-columnar-store-spike.md`](docs/briefs/core-columnar-store-spike.md)
  — evidence base from the Codex spike.
- [`docs/rfcs/streaming.md`](docs/rfcs/streaming.md) — streaming
  RFC; sequencing addendum notes how milestone A + columnar
  interact.
- [`docs/rfcs/charts.md`](docs/rfcs/charts.md) — chart RFC; v1
  charts share columnar primitives with core.
- The previous "row-oriented core stays" deferred-design entry
  (now superseded; walked back in the Deferred Design Decisions
  section above).

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

- **`@pond-ts/server`** — first-party server package extracted from the gRPC
  experiment's aggregator + WebSocket fan-out shape. Owns the
  WS-snapshot-then-deltas pattern, `WireMsg<T>` envelope versioning,
  heartbeat / slow-client policy, server-side backpressure, and schema-to-
  wire coordination. Depends on Phase 4.5 milestones C
  (`AggregateEmission` + stable IDs) and D (`keyBy/window/aggregate`)
  landing first. Will likely pull emission-history snapshots forward from
  RFC phase 5 when the snapshot-on-connect pattern needs them. Core stays
  connector-light per the streaming RFC; the server package owns the
  deployment shape.
- `@pond-ts/charts` — first-party chart components built directly on the
  `pond-ts` data model, successor to `react-timeseries-charts`. Strategic
  positioning: **the visualization end of pond** — `data → pond → charts`
  with zero friction, where the pond pipeline is the moat. Scope is
  **timeseries only** (line, band, bar, scatter, box); not pie, treemap,
  or generic visualization.

  **v1 does not depend on Phase 4.5 milestone C.** Only the final
  `fromAggregateEmission` adapter does — v1 ships earlier with a loose
  pre-milestone-C wire shape contained inside the adapter layer. The
  sequencing reason is bandwidth: streaming-RFC work earns more leverage
  until milestone C is in flight.

  **Full design** in [`docs/rfcs/charts.md`](docs/rfcs/charts.md). Covers
  the layered-engine architecture (pond source → adapter → typed-array
  store → viewport/decimator → chunked Path2D cache → canvas renderer
  → React shell), the `ChartDataSource` interface, the v1 component
  reduction (rendering spine + `LineChart` + `BandChart` only;
  `BarChart` / `ScatterChart` / `BoxChart` as v1.1 layer implementations),
  the 9 implementation traps from the gRPC experiment, the uPlot
  technique inventory reweighted for the library's scale, and the
  perf-invariant test surface. Authorship trail: original gRPC-experiment
  RFC + pjm17971 strategic frame + Codex architectural review + library
  agent amendment.

  **Cross-references:**
  - Working canvas implementation:
    [pond-grpc-experiment#37](https://github.com/pjm17971/pond-grpc-experiment/pull/37)
    (merged; 50 MB plateau vs Recharts OOM at 1–5 min).
  - Original friction-note RFC:
    [`canvas-chart-primitive.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/rfcs/canvas-chart-primitive.md).
  - Layout-primitive design template:
    [react-timeseries-charts](https://github.com/esnet/react-timeseries-charts).

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

### Internal storage shape: row-oriented stays; columnar lives at the chart boundary

**Status: SUPERSEDED by Phase 4.7 (Columnar core substrate), 2026-05-11.** A
Codex evidence-gathering spike measured the gap — see
[`docs/rfcs/columnar-core.md`](docs/rfcs/columnar-core.md) and
[`docs/briefs/core-columnar-store-spike.md`](docs/briefs/core-columnar-store-spike.md).
The evidence (6–12× numeric reduce, 4× memory reduction under lazy event
materialization, neutral on string reducers) plus the strategic timing
argument (do this before streaming-RFC milestones B/C/D so they ship on
the substrate, not on row-oriented internals that need retrofitting)
flipped the decision. The original deferred-design framing below stays
for trajectory reasons — future readers can see what was decided when
and why the position changed. Phase 5 of this PLAN is the binding entry.

---

**Status (prior): deferred. Logged 2026-05-10.**

**Decision (superseded).** Keep row-oriented (`Event[]`) internal storage in `TimeSeries` /
`LiveSeries`. Columnar storage lives at the **chart-package boundary** as an
explicit fast path (`ChartDataSource` + typed-array buffers per
[`docs/rfcs/charts.md`](docs/rfcs/charts.md)), not as a core refactor.

**Reasoning.** A modern analytical engine would store columns: one
`Float64Array` per numeric column, validity bitmaps, string interning,
sequential cache-friendly iteration, SIMD-friendly inner loops in reducers.
Apache Arrow / DuckDB / Polars all do this. The win is real — at firehose
× 100k events × tens of columns we're paying ~6×–10× the memory and
iteration cost a columnar store would.

But the cost-benefit analysis at pond's target operating point doesn't
support the rewrite:

- 100k+/sec on a non-distributed JavaScript runtime is plenty for the
  workloads we target. Workloads needing millions/sec are on Beam / Spark —
  a different operational and cost regime that pond explicitly doesn't
  compete with (per the streaming RFC's "non-goals").
- The `Event` API ergonomics (`event.get('cpu')` schema-narrowed, `set` /
  `merge` / `select` / `collapse` / `data()` / `key()`) are a real
  product moat. They're across 1,300+ tests, every reducer, every operator,
  every React hook. We don't disassemble that for "a bit more speed."
- The row-oriented tax is real and visible — v0.14 / v0.15 perf wave was
  a string of row-shape paper cuts (`estimateEventBytes` removal in
  v0.14.0, trusted-pipeline partition router in v0.14.0,
  `samples.rollingState()` scalar-add allocation fix in v0.14.3, O(1)
  head-index eviction in v0.15.2). Each fix addresses an instance of the
  class; columnar would address the class. We accept the per-fix cost in
  exchange for keeping the API intact.

**Where columnar pays back NOW: the browser.** Beam / Spark don't run
there. The perf ceiling for visualization at firehose × tens of series
is a place pond can credibly win — `@pond-ts/charts` adopts columnar
internals via the layered architecture in
[`docs/rfcs/charts.md`](docs/rfcs/charts.md), specifically the typed-array
store + chunked Path2D cache + viewport/decimator pipeline. The core
public API stays row-oriented; columnar lives behind the chart adapter
boundary.

**Three positions considered:**

1. **Row-oriented core + chart-side columnar adapter (adopted).** The
   chart package commits to columnar from v1 via `ChartDataSource`; the
   core API stays `Event`-shaped. User-facing perf cliff (browser
   rendering) closed without forcing a core refactor.
2. **Hybrid: columnar internals + Event views + row API outside (right
   north star, deferred).** TimeSeries internals migrate to typed-array
   columns; `at(i)` / iterators return Event _views_ that read lazily from
   buffers. Reducers' hot loops can drop to column reads. The
   duckdb / Arrow / Polars precedent — _columnar internals, row API for
   ergonomics._ Significant refactor; LiveSeries mutability complicates
   Event lifetimes (held Event view after eviction). Earns its slot only
   after the streaming-RFC milestones land — refactors should follow
   major architectural commitments, not lead them.
3. **Columnar everywhere, Event becomes a transient projection
   (rejected).** Best perf, simplest internals, major API break.
   v2.0 territory; the API moat goes with it.

**When to revisit (Hybrid B):**

- After Phase 4.5 milestones A–D land (the change-stream model and
  capability registry inform what columnar internals would consume —
  e.g. `LiveChange` could carry columnar-batch updates instead of
  per-event `Event`s).
- When chart-side columnar machinery is proven in production (validates
  the inner-loop primitives a core migration would reuse).
- v1.0 is a natural forcing function.

If revisited, **Hybrid B is the target.** A serious RFC at that point —
not before. Premature refactor risk plus the streaming-RFC work earns
more leverage right now.

**Cross-references:**

- The chat thread that surfaced this decision: 2026-05-10, during the
  `@pond-ts/charts` Codex review on
  [`docs/rfcs/charts.md`](docs/rfcs/charts.md). The chart RFC's
  "Internal data shape: columnar typed arrays from day one (Codex 2)"
  section is where columnar got committed at the chart boundary; the
  conversation pivoted on whether the same commitment should extend to
  the core. This entry says no.
- Row-shape paper cuts (evidence of the tax): CHANGELOG entries for
  v0.14.0 (`estimateEventBytes`, trusted-pipeline router), v0.14.3
  (`samples.rollingState()` allocation), v0.15.2 (O(1) eviction).
- Streaming RFC's non-goals (
  [`docs/rfcs/streaming.md`](docs/rfcs/streaming.md) §"Non-goals"):
  "pond should not become 'mini Beam'." Columnar-everywhere is part of
  what would push us in that direction; staying row-oriented in the
  core keeps us on the deterministic-single-process side of the line
  the RFC draws.

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
