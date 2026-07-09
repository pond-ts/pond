# Architecture

Living document covering pond-ts's internal structure. Aimed at future
contributors (human or AI) reading the codebase cold — explains what
exists, why it's shaped that way, and which patterns recur. Not a user
guide; for that, see `website/docs/`.

Updated alongside meaningful structural changes. If you change a layer
boundary, add a new class to one of the layers, or introduce a new
recurring pattern, update this file in the same pass.

---

## 1. Layered model

Three layers, with snapshots crossing the boundary downward:

```
┌────────────────────────────────────────────────────────────────────┐
│  Live layer (bounded buffers, push ingestion, subscription)        │
│                                                                    │
│   ┌──────────────────┐  ┌────────────────────┐                     │
│   │  LiveSeries<S>   │  │ LivePartitioned    │                     │
│   │  (bounded buffer)│←─│ Series<S, K>       │                     │
│   └─────┬────────────┘  │ (per-partition     │                     │
│         │               │  routing + sub-    │                     │
│         │ (subscribes)  │  buffers)          │                     │
│         │               └────────────────────┘                     │
│         ▼                                                          │
│   ┌──────────────────┐  ┌────────────────────┐  ┌────────────────┐ │
│   │  LiveView<S>     │  │ LiveAggregation    │  │ LiveRolling    │ │
│   │  (lazy derived;  │  │ <S, R>             │  │ Aggregation    │ │
│   │  filter/map/fill │  │ (sequence-bucketed │  │ <S, R>         │ │
│   │  /diff/rate/     │  │  windowed reduce)  │  │ (sliding       │ │
│   │  cumulative)     │  │                    │  │  window;       │ │
│   │                  │  │                    │  │  trigger?:     │ │
│   │                  │  │                    │  │  Trigger)      │ │
│   └──────────────────┘  └────────────────────┘  └────────────────┘ │
│                                                                    │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │ LivePartitionedSyncRolling<S, K, R>  (clock-trigger only)    │ │
│   │ partitionBy(col).rolling(window, m, { trigger: clock(seq) }) │ │
│   │ → LiveSource<RowSchema>; one event per partition per         │ │
│   │   boundary crossing; all events for a tick share the same ts │ │
│   └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│   All implement LiveSource<S>: { name, schema, length, at, on }    │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │  liveSeries.toTimeSeries()
                              ▼  (snapshot — Live → Batch)
┌────────────────────────────────────────────────────────────────────┐
│  Batch layer (immutable, complete data, full analytical surface)   │
│                                                                    │
│   ┌──────────────────┐         ┌──────────────────────────┐        │
│   │  TimeSeries<S>   │ ──────► │ PartitionedTimeSeries    │        │
│   │  (immutable      │         │ <S, K>                   │        │
│   │  column-typed    │         │ (chainable per-          │        │
│   │  series)         │         │  partition view)         │        │
│   └──────────────────┘         └──────────────────────────┘        │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │  every event holds an EventKey
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│  Core values (immutable, no behavior beyond their data)            │
│                                                                    │
│   Event<K, D>                              (one observation)       │
│   Time / TimeRange / Interval              (event keys)            │
│   Sequence / BoundedSequence               (recurrence rules)      │
│                                                                    │
│   types.ts: SeriesSchema, EventForSchema<S>, RollingSchema<S,M>,   │
│             MaterializeSchema<S>, DedupeKeep<S>, etc.              │
└────────────────────────────────────────────────────────────────────┘
```

**Cardinal rule:** the live layer is for _ingestion and incremental
computation_; the batch layer is for _analytical transforms over
complete data_. When you need full analytical power on live data,
snapshot to `TimeSeries` and use the batch API. Live operators only
exist where incremental computation is genuinely cheaper than
re-snapshotting.

### Why three layers and not one?

Because they have different invariants:

- **Core values** are immutable and structural. An `Event` cannot be
  mutated; you produce a new one.
- **Batch** is whole-data. Every method has access to the full event
  array and can sort, scan, or index freely.
- **Live** is incremental. Each operator must produce its output on
  every push without rescanning history; state is per-event-arrival.

A single layer would force every operator to handle both modes, which
either (a) bloats the API surface with mode flags or (b) restricts
operators to the lowest common denominator (event-driven only).

---

## 2. Stateful primitives

### `TimeSeries<S>` (`packages/core/src/TimeSeries.ts`)

Immutable, column-typed series. Constructed with a `SeriesSchema` (the
first column is one of `time`/`timeRange`/`interval`; the rest are
value columns) and rows. Validation happens at construction via
`validate.ts`; events are sorted by key, then frozen.

Internally stores:

- `name: string`
- `schema: S` (frozen)
- `events: ReadonlyArray<EventForSchema<S>>` (sorted by key)

Most analytical methods (`fill`, `align`, `aggregate`, `rolling`,
`smooth`, `baseline`, `diff`, `rate`, `dedupe`, `materialize`,
`partitionBy`) return new typed `TimeSeries` instances with the right
output schema. The output schema is captured by _narrowing types_
(see §3).

Internal construction shortcut: `static #fromTrustedEvents` skips
validation when the caller has already produced valid events (e.g.
chained transforms). See §3 for the trusted-construction pattern.

### `PartitionedTimeSeries<S, K>` (`PartitionedTimeSeries.ts`)

Chainable view that scopes stateful transforms per-partition. Returned
by `series.partitionBy(col)` or `series.partitionBy(col, { groups })`.

Persistent across chains: each sugar method (`fill`, `align`,
`rolling`, …) returns another `PartitionedTimeSeries<NewSchema, K>`,
preserving the partition state. Terminal methods materialize back:

- `.collect()` → `TimeSeries<S>`
- `.apply(fn)` → `TimeSeries<R>` (concat per-partition outputs of `fn`)
- `.toMap()` → `Map<K, TimeSeries<R>>` (per-partition map)

Internally:

- `source: TimeSeries<S>` (the underlying series)
- `by: ReadonlyArray<keyof S & string>` (single column or composite)
- `groups?: ReadonlyArray<K>` (declared partitions for typed narrowing)

Per-partition execution lives in `static applyToSource(source, by, fn)`,
which buckets events by composite key (using `partitionKeyOf`),
runs `fn` on each bucket's sub-series, and concats the result. Sugar
methods all delegate through `applyToSource`.

Trusted construction (`static #fromValidated`) used by `rewrap` to
build chained views without re-walking the source for groups
validation.

### Stateful batch operators

Every operator that reads neighboring events (`fill`, `align`,
`rolling`, `smooth`, `baseline`, `outliers`, `diff`, `rate`,
`pctChange`, `cumulative`, `shift`, `aggregate`, `dedupe`,
`materialize`) carries a `**Multi-entity series:**` JSDoc paragraph
naming the operator's specific cross-entity hazard and pointing at
`partitionBy`. Discoverable via LSP hover, IDE quick-help, or any
type-definition consumer (including AI agents).

Notable internals:

- **`fill`** uses a unified gap-walker. For each value column, scan
  forward; on hitting `undefined`, find the gap's bounds (start, end,
  length, span); check strategy feasibility (`linear` needs both
  neighbors, `hold` needs prev, `bfill` needs next, `zero`/literal
  need neither); check size caps (`limit`, `maxGap`); fill atomically
  or skip (all-or-nothing).
- **`materialize`** runs a forward cursor over the source events
  alongside the bucket sequence. For each bucket, find events in
  `[bucket.begin, bucket.end)`, pick one via `select`, emit a
  time-keyed row at the bucket sample point.
- **`dedupe`** buckets events by full event key (begin for time,
  begin+end for timeRange, begin+end+value for interval), then
  applies the `keep` policy per bucket.
- **`rolling`** is the closest to a real algorithm — a sliding
  deque with O(1) per-event add/remove, indexed by either time or
  event count.

### `LiveSeries<S>` (`LiveSeries.ts`)

Bounded buffer for live ingestion. Configurable retention
(`maxEvents` / `maxAge`), grace window (for late events
in `'reorder'` ordering), and three subscription channels:
`'event'`, `'batch'`, `'evict'`. Implements `LiveSource<S>`.

Validation at ingest: `push(...rows)` runs each row through the same
schema validation as `TimeSeries`. Eviction runs after each push to
honor retention.

`live.toTimeSeries()` snapshots to a batch series — the standard
crossing point between layers.

### `LiveView<S>` (`LiveView.ts`)

Lazy derived view. Wraps a `LiveSource<S>` and a `process(event)`
function that returns either a transformed event or `undefined` (to
skip). Subscribes to source `'event'` and emits derived events as they
arrive. Used by `filter`, `map`, `select`, `fill`, `diff`, `rate`,
`pctChange`, `cumulative`.

Mirrors source eviction (`'evict'`) when the source advertises
`EMITS_EVICT`.

### `LiveAggregation<S, R>` and `LiveRollingAggregation<S, R>`

Stateful windowed aggregations. Each maintains internal reducer state
across events and emits derived events as windows fire.

- `LiveAggregation` — sequence-bucketed; events flush when their
  bucket closes.
- `LiveRollingAggregation` — sliding window; emits on every input
  event with the current window's reduced value.

### Trigger-based emission (`triggers.ts`)

`v0.12.0-experimental` factors **emission cadence** as a first-class
concept orthogonal to the aggregation choice. `LiveRollingAggregation`
accepts an optional `trigger` in its options:

- `Trigger.event()` (default) — emits per source event push (the
  historical behavior of `LiveRollingAggregation`).
- `Trigger.clock(sequence)` — emits when a source event crosses an
  epoch-aligned boundary of the (fixed-step) `Sequence`. Replaces
  the v0.11.8 `LiveSequenceRollingAggregation` / `.sample()` pattern.

The trigger is observed by the accumulator's emission path — state
updates remain per-event, only emission is gated by the trigger.
`rolling.value()` is independent of the trigger; it always returns
the current rolling-window snapshot.

**Synchronised partitioned rolling.** When a clock trigger is passed
to `LivePartitionedSeries.rolling()`, emission is **synchronised
across partitions**: a shared bucket index is maintained across all
known partitions, and any partition's event crossing the boundary
fires emission for every partition at the same instant. Implemented
in `LivePartitionedSyncRolling.ts` (internal, no public class name —
the public type is `LiveSource<RowSchema>` whose schema includes the
partition column for downstream rebucketing).

Restricted to direct-after-`partitionBy` for the experimental
release: chained sugar (`partitionBy(c).fill(...).rolling(...)`)
rejects clock triggers with a clear error. Lifts when a real use
case appears.

The full design rationale and migration story is captured in the
RFC at `docs/rfcs/triggers.md`.

### `LivePartitionedSeries<S, K>` (`LivePartitionedSeries.ts`)

Live counterpart to `PartitionedTimeSeries`. Routes events from a
source `LiveSource<S>` into per-partition `LiveSeries<S>` sub-buffers.

Each partition is an independent `LiveSeries` with its own:

- Retention (per-partition `maxEvents`/`maxAge`)
- Grace window (per-partition late-event acceptance)
- Subscription state

Auto-spawns a new partition the first time a value is seen (or eagerly
spawns all declared values when `groups` is set). Partition routing
runs as a `'event'` listener on the source.

Two terminals:

- `.toMap()` → `Map<K, LiveSource<S>>` — per-partition sources for
  direct subscription
- `.collect()` → unified `LiveSeries<S>` — append-only fan-in (see §3
  for why)
- `.apply(factory)` → unified `LiveSeries<R>` — per-partition factory
  composition

**v0.11 PR 1 scope:** foundation only. Chainable typed sugar
(`partitioned.fill().rolling().collect()`) deferred to PR 2; PR 1
ships `apply((sub) => sub.fill().rolling())` as the chaining
mechanism.

---

## 3. Recurring patterns

### Schema generics and narrowing types (`types.ts`)

The library is type-driven. Every operator captures its input schema
as a generic `S extends SeriesSchema` and produces an output schema
through type-level transforms:

- `RollingSchema<S, M>` — replace value columns named in `M` with the
  reducer's output kind
- `MaterializeSchema<S>` — replace first column with `time`, widen
  value columns to optional
- `AlignSchema<S>` — replace first column with `interval`, widen value
  columns to optional
- `DiffSchema<S, T>` — replace columns named in `T` with the diff
  result type
- etc.

Each type lives next to the operator it describes. `SeriesSchema` is
`readonly [FirstColumn, ...ValueColumn[]]` — a tuple, not just an
array, so the type system can preserve column order through chains.

### Trusted construction via JS-private statics

Pond-ts uses `static #foo` (JavaScript private static methods, not TS
`private`) for internal constructors that bypass safety checks. The
`#` syntax provides true runtime privacy — no `as any` cast or
prototype walk can reach them.

Three uses today:

- **`TimeSeries.#fromTrustedEvents(name, schema, events)`** — skip
  schema validation when the caller's events came from another
  validated `TimeSeries`. Used by every chained transform's output.
- **`TimeSeries.#diffOrRate(series, mode, columns, options)`** —
  shared impl for `diff`/`rate`/`pctChange`. Was originally an
  instance method but moved to `static #` after a brand-check bug:
  `Object.create`'d instances (built via `#fromTrustedEvents`) failed
  the JS-private brand check on instance methods. Static methods
  brand-check the class, which always passes.
- **`PartitionedTimeSeries.#fromValidated(source, by, groups?)`** —
  build a chained partitioned view without re-walking the source for
  groups validation. Used by `rewrap` after every sugar method.

When to reach for it: your class has a public constructor with
non-trivial validation, and an internal path needs to construct
instances where validation is provably redundant. Don't expose this
as a public API; the `static #` enforces that.

### Typed groups pattern

Operators that bucket data by a column value support an optional
`{ groups }` declaration that narrows the output's key type from
`string` to a literal union:

```ts
const HOSTS = ['api-1', 'api-2'] as const;

series
  .partitionBy('host', { groups: HOSTS }) // narrows K
  .fill({ cpu: 'linear' })
  .toMap();
// Map<'api-1' | 'api-2', TimeSeries<S>>

long.pivotByGroup('host', 'cpu', { groups: HOSTS });
// schema literally: [time, 'api-1_cpu', 'api-2_cpu']
```

Properties when `groups` is declared:

- Output enumerates in declared order (not insertion order)
- Empty declared groups still appear (with empty `TimeSeries` /
  `undefined` cells)
- Runtime values not in `groups` throw at construction
- Empty `groups: []` and duplicate values throw upfront
- Numeric/boolean partition columns are stringified by the encoder, so
  declared groups must be the stringified form (`['1', '2']`)

### Per-partition state via factory pattern

`LivePartitionedSeries.apply(factory)` and `PartitionedTimeSeries`'s
sugar methods both spawn per-partition state by calling a factory
function once per partition. The factory is the only thing that knows
how to build the operator chain; the partitioned view just holds the
map of per-partition outputs.

Contract: factory must be **pure and re-runnable**. No closure-captured
mutating state, no external subscriptions on input/output. The
implementation may invoke the factory with stub inputs to capture
output schemas synchronously, in addition to the real per-partition
calls.

### Append-only fan-in vs mirrored materialization

`LivePartitionedSeries.collect()` and `.apply()` are **append-only
fan-in sinks**, not mirrored materializations. Per-partition retention
or grace evictions do not propagate to the unified buffer.

Reasoning:

- Mirroring evictions requires either a private selective-eviction
  API on `LiveSeries` or per-event provenance tracking, both of which
  are larger surgery
- The "collect" / "apply" naming already implies fan-in
- Users who want current per-partition state can use `.toMap()` and
  snapshot
- Users who want a bounded unified buffer can pass a `retention`
  option to `collect()` for it to manage independently

Documented as the contract; pinned by tests. May be revisited if real
users hit the divergence.

### Source layout conventions

The conceptual layers above should also be visible in the source tree.
Historically, `packages/core/src/` grew around large public class files
(`TimeSeries.ts`, `LiveSeries.ts`, `LiveView.ts`, ...). That was useful
while the library was small, but it makes later work harder: public API
shape, operator implementation, helper types, and internal storage
details drift into the same file, and a 4500-line `TimeSeries.ts` or
1000-line `types.ts` is no longer browsable.

The target source layout is:

```
packages/core/src/
├── index.ts                          # public package barrel — only file at the root
├── core/                             # immutable value primitives
│   ├── event.ts                      # exports Event
│   ├── time.ts                       # exports Time
│   ├── time-range.ts                 # exports TimeRange, toTimeRange
│   ├── interval.ts                   # exports Interval
│   ├── temporal.ts                   # EventKey, TemporalLike, *Input types
│   ├── calendar.ts                   # CalendarOptions, CalendarUnit, TimeZoneOptions
│   ├── duration.ts                   # parseDuration, DurationInput
│   └── errors.ts                     # ValidationError
├── schema/                           # public type vocabulary — replaces types.ts
│   ├── index.ts                      # internal barrel
│   ├── series.ts                     # SeriesSchema, ColumnDef, FirstColumn, ValueColumn, ScalarKind, …
│   ├── rows.ts                       # Row / Object / Normalized / Json row+event types
│   ├── aggregate.ts                  # AggregateSchema, AggregateReducer, AlignSchema, …
│   ├── reduce.ts                     # ReduceResult, reducer-shaped types
│   ├── rolling.ts                    # RollingSchema, RollingAlignment, fused-rolling types
│   ├── join.ts                       # JoinSchema, JoinManySchema, JoinType, prefix variants
│   ├── reshape.ts                    # Materialize / Select / Rename / Rekey / Baseline / Collapse / Fill / Dedupe
│   ├── diff.ts                       # DiffSchema, SmoothSchema, SmoothMethod
│   └── arrays.ts                     # ArrayValue, ArrayAggregate*, ArrayExplode*
├── batch/                            # TimeSeries + batch-only implementation
│   ├── time-series.ts                # the class — thin API shell
│   ├── partitioned-time-series.ts
│   ├── validate.ts
│   ├── json.ts                       # fromJSON / toJSON helpers
│   ├── aggregate-columns.ts
│   └── operators/                    # (grown over time) batch operator implementations
├── live/                             # LiveSeries + live mechanics
│   ├── live-series.ts
│   ├── live-view.ts
│   ├── live-partitioned-series.ts
│   ├── live-aggregation.ts
│   ├── live-rolling-aggregation.ts
│   ├── live-fused-rolling.ts
│   ├── live-partitioned-fused-rolling.ts
│   ├── live-partitioned-sync-rolling.ts
│   ├── live-reduce.ts
│   ├── live-history.ts               # bounded ring buffer for snapshotting
│   ├── series-store.ts               # row-based store adapter
│   └── triggers.ts                   # Trigger + trigger types
├── sequence/
│   ├── sequence.ts
│   ├── bounded-sequence.ts
│   └── sample.ts                     # SampleStrategy, BatchSampleStrategy
├── reducers/                         # reducer registry + per-reducer modules
├── columnar/                         # internal storage substrate (not in public barrel)
└── io/                               # (future) row/object/json/point converters extracted from TimeSeries
```

Two design choices worth pinning explicitly:

- **No `utils/`.** A single-file `utils/` folder is just noise; pure helpers go to whichever layer owns them (`parseDuration` is a temporal primitive, so it lives under `core/`).
- **`io/` is reserved, not created yet.** Don't make empty layer folders. It comes into existence when there's real material to move (the `toRows`/`toObjects`/`toPoints`/`fromPoints` family currently inside `TimeSeries.ts`).

#### Naming rules

**One rule: all files are kebab-case.** Class names stay PascalCase
inside the file — only the filename changes. `time-series.ts` exports
class `TimeSeries`; `live-view.ts` exports class `LiveView`; `event.ts`
exports class `Event`.

No mixed convention, no judgment calls about "is this an exported
concept or an internal helper" — promotion or demotion across the
public boundary never requires a file rename. This matches the modern
TypeScript ecosystem (tRPC, Effect, Zod, Drizzle, Next.js internals).

Other naming guidance:

- A file should have one primary responsibility. Multiple exports are
  fine when they form one cohesive concept (`triggers.ts` exporting
  `Trigger` plus its trigger types).
- `packages/core/src/index.ts` is the only public package barrel.
  Folder `index.ts` files are internal conveniences, not public API.
- Public class files trend toward thin API shells. `time-series.ts`
  describes the constructor, accessors, iteration, and public method
  surface; substantial analytical work delegates to `batch/operators/*.ts`.
  `live-series.ts` owns live-source identity, pushing, snapshotting,
  and subscription API; retention, ordering, and serialization
  mechanics live in dedicated `live/*.ts` modules.

#### Columnar stays internal

Columnar is an internal substrate, not a fourth public layer. It sits
under batch and selected live hot paths while preserving the row/Event
API boundary. The framework lives at `packages/core/src/columnar/`, is
not re-exported from the public package barrel, and keeps storage
primitives (`store.ts`, `column.ts`, `builder.ts`, `validity.ts`, …)
separate from columnar operator implementations
(`columnar/operators/*.ts`) when those grow large enough.

#### Compatibility barrels are temporary

Step-by-step refactors land via thin shim files at the old path that
re-export from the new location (e.g. the current root-level `sample.ts`
and `triggers.ts` after PR #138). This keeps each migration PR
behaviourally inert and reviewable.

**These shims are temporary.** They have a defined end-of-life: all
remaining shims are removed in a single labeled breaking release before
v1.0, after which the only stable import path is the public package
barrel. We don't keep them indefinitely — every permanent shim is
another path the internal layout can't actually move.

External consumers should import only from `'pond-ts'`. Deep imports
into `pond-ts/dist/*` are not part of the supported API surface and may
break at any release.

#### Migration order

The reorg is sequenced so each PR is small and behaviourally inert. The
public package barrel keeps exporting the same identifiers throughout.

1. **Land this convention in `ARCHITECTURE.md`.** Done in the PR
   carrying this section.
2. **Establish layer folders with internal barrels.** Largely done by
   PRs #137–#138 (`core/`, `live/`, `sequence/`).
3. **Rename existing layer-folder files to kebab-case.** Mechanical
   `git mv`; the internal barrels absorb the change for callers. On
   macOS use the two-step rename (`X.ts` → `_tmp.ts` → `x.ts`) for
   case-only renames.
4. **Move remaining root-level files into their layer folders,
   kebab-case.** Each move PR adds a root-level shim only if external
   imports depend on the old path; pure internal moves don't earn a
   shim.
5. **Split `types.ts` into `schema/*.ts`.** The biggest single change.
   Keeps a `schema/index.ts` barrel so existing import sites can be
   updated in one mechanical pass. Already-extracted type files
   (`types-aggregate.ts`, `types-fused-rolling.ts`, `types-public.ts`,
   `types-reduce.ts`) fold into the new `schema/` directory at the
   same time.
6. **Extract batch operators from `time-series.ts`.** One operator
   family per PR. Each extraction preserves the public method signature
   and runs the perf check from the section above; the class file
   becomes the API shell.
7. **Extract live mechanics from `live-series.ts` and the partitioned
   variants.** One concern per PR (retention, ordering, subscription
   plumbing, JSON serialization), same discipline.
8. **Create `io/` and move row/object/json/point converters into it.**
   Triggered when steps 6–7 surface the relevant code paths; no empty
   folder created before then.
9. **Land and integrate columnar internally.** Operator-by-operator,
   without exposing it as public API.
10. **Delete remaining compatibility shims** in a labeled release
    before v1.0.

The goal state: `time-series.ts` tells you what the batch API is;
`batch/operators/*.ts` tells you how batch work is done.
`live-series.ts` tells you what a live source is; `live/*.ts` tells
you how live mechanics are implemented. `schema/*.ts` is the type
language. `columnar/*.ts` is the storage substrate. Public exports
remain stable unless a separate API-change PR explicitly says
otherwise.

### Per-method JSDoc warnings for cross-entity hazards

Every batch operator that reads neighboring events carries a
`**Multi-entity series:**` paragraph in its JSDoc, naming the
operator's specific hazard and pointing at `partitionBy`:

```
**Multi-entity series:** the rolling window includes events from
every entity within the window — `host-A`'s rolling average mixes
`host-B`'s and `host-C`'s values into the same number. On a series
carrying multiple entities (host, region, device id), use
`series.partitionBy(col).rolling(...).collect()` to scope per
entity. See {@link TimeSeries.partitionBy}.
```

Discoverability is ambient: surfaces in LSP hover, IDE quick-help, and
any type-definition consumer. We chose docs over runtime warnings
because the warning would either need to detect "is this multi-
entity?" (impossible without a declared schema flag) or fire on every
call (false positive on legitimate single-entity use).

### Performance discipline

Every new operator that walks events, allocates per-event, or has any
cost path that scales with input size must:

1. State its asymptotic complexity in JSDoc and PR description
2. Add a benchmark script at `packages/core/scripts/perf-<op>.mjs`
   matching the existing format (`makeSeries` + `median` +
   `benchmark` + JSON output, importing from compiled
   `../dist/index.js`)
3. Run the benchmark and pin before/after numbers in the commit
   message

Existing scripts:

- `perf-aggregate.mjs`
- `perf-align-linear.mjs`
- `perf-derived-construction.mjs`
- `perf-includes-key.mjs`
- `perf-rolling.mjs`
- `perf-smooth-loess.mjs`
- `perf-smooth-moving-average.mjs`
- `perf-materialize.mjs`
- `perf-partitioned-toMap.mjs`
- `perf-partitionby-groups.mjs`
- `perf-live-partitioned.mjs`

Policy in CLAUDE.md ("Performance check for new operators on large
data") is enforced via Layer 1 self-review.

---

## 4. Decision log / non-goals

### Out of scope (deliberate)

- **CSV parsing / ingest helpers.** Pond-ts is what happens _after_
  you have rows, not what gets you there. CSV agents repeatedly
  reach for `TimeSeries.fromCSV` but the project's position is that
  CSV parsing belongs in a separate module (or the user's own code).
  The library accepts JSON via `fromJSON` and row arrays via `new
TimeSeries`. Ingest-time normalization (timestamp parsing, missing-
  token handling) is the user's responsibility.

- **Runtime warnings on multi-entity unscoped operators.** We chose
  per-method JSDoc warnings over runtime detection. A runtime
  warning would either (a) require schema-level entity declaration
  (new API surface) or (b) fire on every multi-entity call (false
  positive on legitimate single-entity use after a `filter` or
  `select`).

- **Eviction mirroring in `LivePartitionedSeries.collect()/apply()`
  (v0.11 PR 1).** Documented as append-only fan-in instead. May be
  revisited if real usage hits the divergence.

- **Dense tabular / heatmap grids in `@pond-ts/charts`.** A heatmap
  table (rows × columns of coloured cells, sortable, sticky headers)
  is a DOM-table concern, not a canvas-plot concern — the SPARC
  consumer correctly built its bucket heatmaps as HTML tables, and we
  record that as the right call (Harbor issue #395, item 14, triaged
  2026-07-09). Charts owns time/value/(future categorical) x-axis
  plots; a 2-D coloured grid is a different rendering model with no
  shared axis machinery.

- **Two-phase commit at the `LiveSeries` level.** Partition view
  errors throw post-source-commit. Documented; could be addressed by
  `LiveSeries`-architecture changes (validate-then-commit-then-
  notify, or listener-error isolation) but not in the v0.11 wave.

### Type-level limitations (known, deferred)

- **`TimeSeries<S>` variance issue.** `toJSON()` returns
  `TimeSeriesJsonInput<SeriesSchema>` (loose) rather than
  `TimeSeriesJsonInput<S>`. Tightening the return type breaks
  overload-impl compatibility on `pivotByGroup` / `rolling` /
  `arrayAggregate`. A class-wide variance refactor is required;
  workaround: cast at the call site.

- **`RowForSchema` doesn't honor `required: false`.** Rows passed to
  `new TimeSeries({ rows })` reject `undefined` cells even when the
  schema marks the column optional. Workaround: use `fromJSON` with
  `null` cells. Documented in the cleaning page.

### Patterns we deliberately don't generalize

- **`{ groups }` as a runtime config object.** Each operator that
  uses it (`pivotByGroup`, `partitionBy`) declares it independently.
  Tempting to extract into a shared `TypedGroups<K>` helper, but the
  semantics differ subtly per operator (output shape, runtime
  validation, narrowing target). One-line copies are cheaper than a
  premature abstraction.

- **`static #fromValidated` pattern.** Three uses today, manually
  duplicated per class. Worth a shared utility if a fourth use shows
  up; not yet.

---

## 5. Where to find things

| Concern                                        | File                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Core values (Event, Time, TimeRange, Interval) | `Event.ts`, `Time.ts`, `TimeRange.ts`, `Interval.ts`                                              |
| Sequences (recurrence, bounded)                | `Sequence.ts`, `BoundedSequence.ts`                                                               |
| Schema types                                   | `types.ts`, `types-aggregate.ts`, `types-reduce.ts`                                               |
| Validation                                     | `validate.ts`                                                                                     |
| Calendar / timezone parsing                    | `calendar.ts`, `temporal.ts`                                                                      |
| Reducers (built-in + custom)                   | `reducers/`                                                                                       |
| Batch core                                     | `TimeSeries.ts`                                                                                   |
| Batch partitioning                             | `PartitionedTimeSeries.ts`                                                                        |
| Live source interface                          | `types.ts` (`LiveSource<S>`, `EMITS_EVICT`)                                                       |
| Live buffer                                    | `LiveSeries.ts`                                                                                   |
| Live derived views                             | `LiveView.ts`                                                                                     |
| Live aggregation                               | `LiveAggregation.ts`, `LiveRollingAggregation.ts`, `LivePartitionedSyncRolling.ts`, `triggers.ts` |
| Live partitioning                              | `LivePartitionedSeries.ts`                                                                        |
| React hooks                                    | `packages/react/src/`                                                                             |
| Public exports                                 | `packages/core/src/index.ts`                                                                      |
| Plan / status / roadmap                        | `PLAN.md`                                                                                         |
| Process / discipline / release                 | `CLAUDE.md`                                                                                       |
| Release notes                                  | `CHANGELOG.md`                                                                                    |

---

## 6. Conventions

- **Public method JSDoc** starts with `Example: \`series.foo(...)\``
  followed by a one-line description, then expanded behavior. The
  example-first convention makes the docstring useful in every IDE
  hover before the user reads the prose.
- **Error messages** include the user-facing concept, not the
  internal encoding. (E.g. unknown-partition errors decode the
  ` undefined` sentinel back to "undefined" for the message.)
- **Tests** live next to the source (`packages/core/test/`); each
  operator has a dedicated `*.test.ts` with describe-block grouping
  by behavior. New operators add a perf script in
  `packages/core/scripts/`.
- **Adversarial PR review** runs after CI passes via the agent
  protocol in CLAUDE.md. The two-comment record (review + response)
  is the durable trail.
