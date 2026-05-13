# Streaming Semantics Roadmap

**Status:** planning note.

**Relationship to PLAN.md:** This RFC is strategic context, not a commitment.
[PLAN.md](../../PLAN.md) is the binding source of truth for what is actually
being built; phases adopted into PLAN are commitments, and the rest of this
document is forward-looking. See [CLAUDE.md → Strategic RFCs](../../CLAUDE.md)
for the layering.

**Authorship:** developed across multiple contributors. Each section below
carries inline attribution; this list is the index for cold readers.

| Section                                                               | Contributor                                         |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| Original RFC (sections 1 through "The line to hold")                  | pjm17971 + Codex                                    |
| Review notes                                                          | pond-ts library agent (Claude)                      |
| V2 amendment                                                          | Codex                                               |
| Use-case agent feedback (gRPC experiment)                             | gRPC experiment agent (Claude)                      |
| Library agent response to use-case feedback                           | pond-ts library agent (Claude)                      |
| V3 amendment                                                          | Codex                                               |
| "Why no watermarks" non-goals appendix (2026-05-10)                   | pond-ts library agent (Claude) + pjm17971           |
| "What 'waiting' actually trades" + bounded-latency timer (2026-05-10) | pjm17971 (framing) + pond-ts library agent (Claude) |
| Thesis sharpening — "right tool for a different problem" (2026-05-10) | pjm17971                                            |
| Sequencing addendum: columnar substrate first (2026-05-11)            | pond-ts library agent (Claude) + pjm17971           |

**Audience:** future pond-ts contributors deciding how far the live layer
should go toward Beam / Flink-style streaming aggregation without becoming a
distributed streaming engine.

**Thesis:** pond should not become "mini Beam." The sharper target is a
single-process, deterministic, TypeScript-native streaming aggregation engine:
fast enough for high-rate in-process telemetry, simple enough to reason about,
and explicit about the places where full distributed systems usually hide
complexity.

**Pond is not a simpler Beam.** Beam, Flink, and Spark Streaming are
correctly engineered for the problem they solve — millions of events per
second across distributed workers persisted to durable sinks under
failure-tolerant semantics. Pond targets a **different point in the design
space**: single-process, bounded volume, in-memory or single-DB-write paths,
where most "streaming" use cases actually live. Many workloads are
over-served by distributed-streaming infrastructure they didn't need.
Pond's design choices — data-clock close, single-process state, no
watermark protocol — make sense for that target and would be wrong for
Beam's. The positioning is **"right tool for a different problem,"** not
"lighter version of the same one."

Pond has already shown it can lightly process hundreds of thousands of events
per second while still answering many data-processing questions at lower rates.
The next step is not raw throughput. The next step is stronger streaming
semantics: time, lateness, finality, keyed state, replay, and predictable
outputs.

## North star

Pond should be excellent for:

- live dashboards
- telemetry rollups
- edge collectors
- in-process analytics inside servers
- browser / React-facing live data views
- low-to-medium-volume pipelines where Beam, Flink, Kafka Streams, or Spark
  Structured Streaming would be operationally too heavy

The ideal user story:

```ts
const ticks = live
  .keyBy('host')
  .window(Sequence.every('1m'), { grace: '5s' })
  .aggregate(
    {
      cpu: 'avg',
      latency: 'p95',
      requests: 'sum',
    },
    {
      output: 'upsert',
    },
  );

ticks.on('event', (event) => {
  // event.kind: 'update' | 'final'
  // event.key: { host, window }
  // event.value: current aggregate values
});
```

That API should feel like a pond object, not a streaming-runtime job graph. It
should preserve pond's current virtues:

- typed schemas
- immutable `Event` values
- deterministic data-clock defaults
- fast local reducers
- clean batch snapshots
- explicit trade-offs rather than hidden runtime magic

## Non-goals

These are intentionally out of scope unless a real user need forces them back
onto the table:

- distributed scheduling
- worker coordination
- autoscaling
- arbitrary-source exactly-once guarantees
- a general SQL engine
- unbounded connector ecosystem
- custom trigger language on par with Beam
- **wall-clock-driven window closure and the watermark machinery it implies**
  (see "Why no watermarks" below)

Pond can offer replay, idempotent output IDs, and deterministic state recovery.
It should not promise "exactly once" across arbitrary transports and sinks.

### Why no watermarks

> _Section added by pond-ts library agent (Claude) and pjm17971,
> 2026-05-10. Captures a design exchange that re-surfaces every time
> someone reads about Beam / Flink and wonders whether pond should
> grow watermarks._

Beam and Flink spend a non-trivial fraction of their conceptual
surface on watermarks, allowed-lateness, side outputs for late data,
and the algebra of progress modes. **That complexity is a consequence
of choosing wall-clock window closure, not a fundamental requirement
of streaming aggregation.** When you decide a window for `[12:00,
12:05)` closes at wall-clock `12:05 + something`, you need a separate
data-time tracker (the watermark) to know whether "all the data for
this window" has plausibly arrived — because the closure happens on
its own clock regardless of the input.

Pond's "data-is-the-clock" thesis (north star above) inverts the
choice. A window closes when an event with `time > boundary + grace`
arrives. The input _is_ the progress signal. No watermark mechanism
is needed because the data itself tells you what's settled. This
drops:

- Watermark generators per source
- Watermark joins across sources (min / max / per-partition)
- Watermark holds for late repair
- Operator state for tracking watermark progress
- Allowed-lateness configuration as a separate concept
- Watermark-driven vs event-driven trigger distinctions
- Side outputs for "events past the watermark"

Late events past grace become a single per-operator policy decision
(`LateAfterFinalPolicy` in milestone C: `'drop'` / `'error'` /
`'correction'`), not a deep semantic question requiring a probabilistic
model of clock skew.

**Where the trade-off bites.** Two real disadvantages, both honest
costs of the choice:

1. **Quiet sources never close their open buckets.** If a host goes
   silent at `12:04:55`, the `[12:00, 12:05)` bucket sits open
   indefinitely. Beam's wall-clock progress would close it at
   `12:05 + watermark`. Pond's workaround is application-side: ingest
   a heartbeat from outside the source if you need wall-clock
   closure, or use `live.eventRate()` / `live.timeRange()` to detect
   silence and act on it (alert, force-close, etc.). Pond gives you
   the primitives to detect silence; it doesn't bake silence-handling
   into bucket closure semantics.
2. **Emission latency is data-driven, not bounded.** A dashboard
   updating from a low-cadence stream "feels slow" because emissions
   happen on event arrival. The mitigations are consumer-side
   (`Trigger.every` to drive emission cadence, throttle on
   `useSnapshot` for render cadence) — but the mental model differs
   from "this widget refreshes every 200ms regardless."

For the workloads pond targets — typically dense in-process
telemetry — neither is a meaningful problem. Most sources don't go
quiet on the relevant timescales; firehose dashboards have plenty of
natural emission triggers. The trade-off is well-positioned for
single-process JS streaming and badly-positioned for distributed
multi-source aggregation — which is the line this RFC's non-goals
draw.

**The temptation to add watermarks "just for the quiet-source case"
is the slippery slope to mini Beam.** A watermark isn't a feature
you can add cleanly; it's a concept that drags in source-by-source
generators, cross-source joins, holds, operator state, and a separate
emission-semantics layer. Each piece is reasonable in isolation.
Together, they're a different library — one that competes with Beam
and Flink at their game, not at the game pond is good at.

If a use case ever forces wall-clock closure, the RFC has phase 4
(deferred indefinitely) as the door — but the bar is high
specifically because the cost being avoided is what makes pond
shippable as a TypeScript library that fits in a single Node
process.

### What "waiting" actually trades

> _Section by pjm17971, captured 2026-05-10. Frames the unified
> question that data-clock close, watermark, and any future timer-based
> close are all answering._

Every windowing approach — data-clock close, watermark, timer-based
close — is answering the same question: **how long do we wait before
we believe we have the window's events?**

It's a trade between:

- **Knowledge about the stream** — wait longer, gain more confidence
  the window is complete.
- **Lagged results** — but emission happens later.

For somewhat regular data, the mechanics are simple:

- Anchor the window's start at the first event in the window (or, more
  refined, at a hypothetical event whose `time` lands _on_ the
  boundary, interpolated from the first event's arrival).
- Wait `window_size + grace`.
- That's a perfectly serviceable estimate.

This framing is where pond's data-clock anchoring earns its keep.
Anchoring at the first event's arrival means the window's expected
close time absorbs the **systematic event-vs-processing lag** — if
events systematically arrive 50 ms after their timestamp, every
window's anchor is already adjusted by that 50 ms. Grace doesn't need
to model that lag.

That's why pond's grace is a small fixed value (5 s, 30 s, etc.) and
Beam's allowed-lateness is a whole subsystem: **Beam closes on
wall-clock regardless, so the lag has to be modeled separately. Pond
already absorbed the lag at the anchor — grace is just statistical
variance, a noise allowance for events arriving slightly later than
expected.**

You could argue grace should auto-refine — online estimation of
arrival variance to tune itself adaptively. We don't, because the
fixed model is already a good estimate and the auto-refinement adds
machinery for marginal gain. If a workload reports that fixed grace
is the wrong shape for it, that's the friction signal that earns
revisiting.

### Bounded-latency closure for quiet sources (optional extension)

> _Section by pond-ts library agent (Claude) and pjm17971,
> 2026-05-10. Status: queued, not committed. Captures the mechanism
> we'd reach for if the quiet-source case ever earns library-side
> handling._

Given the framing above, an optional extension that closes a bucket on
wall-clock time when the data clock has gone quiet doesn't need
watermark machinery. It just needs a timer.

```text
on bucket open:
  expected_close_wall = first_event_wall_time + window_size + grace
  schedule timer → closeBucket() at expected_close_wall

on event crossing the current bucket's boundary:
  cancel timer
  closeBucket()  // same as today's data-clock path

on timer fires (source went quiet):
  closeBucket()  // emit whatever's accumulated, possibly empty
  open next bucket; schedule its timer
```

One timer per partition, one timestamp (next-expected-close). No
per-source watermark generators, no cross-source watermark joins, no
operator state for tracking watermark progress. The data-clock path
stays unchanged; the timer is purely a fallback for the silent case.

**It's not a watermark.** A watermark predicts when data has settled;
this is just a deadline on bucket emission. Late events past the
timer-driven close fall under the same `LateAfterFinalPolicy`
(`'drop'` / `'error'` / `'correction'`) they would under a data-driven
close. Same vocabulary, no new conceptual layer.

Plausible API:

```ts
live.aggregate(seq, mapping, {
  grace: '5s',
  closeOn: 'data' | 'data-or-timer', // default 'data'
});
```

`'data'` is today's behavior. `'data-or-timer'` opts into the timer
fallback; the data-clock path still closes the bucket if an event
crosses the boundary first. Anchoring uses the first event's wall
arrival; if the entire window passes with no events, the timer fires
and `emitEmpty: true` (already in milestone C) controls whether an
empty close emits.

**Why this isn't in current scope.** The active consumer dataset
(gRPC experiment, dashboard, webapp telemetry) doesn't have a
quiet-source case forcing it. Sources are either dense in-process
telemetry (no quiet periods at the relevant timescales) or have
natural emission triggers driven by user activity. The application-
side workaround (heartbeat events from outside, or
`live.eventRate()` / `live.timeRange()` for silence detection) covers
the few cases that surface today.

If a workload mixes always-on hosts with intermittent ones — typical
of multi-tenant monitoring, IoT fleets with sleeping devices, or
financial feeds with sparse instruments — the mechanism above
becomes the cheap library-side fix. Until then, queued.

The reason for capturing this even though it's not committed: the
"all approaches just trade waiting for lag" framing above is durable.
Without this section, every six months someone reads about Beam,
notices pond's lack of wall-clock closure, and either re-proposes
watermarks (which we'd reject) or proposes the simpler timer
mechanism from scratch. The writeup short-circuits that loop.

## Current strengths

The current live layer is already useful:

- `LiveSeries` is a mutable bounded buffer with strict/drop/reorder ingest.
- `graceWindow` bounds late-event acceptance in `reorder` mode.
- `LiveAggregation` performs sequence-bucketed aggregation and honors source
  grace for bucket closure.
- `LiveRollingAggregation` maintains sliding-window reducers incrementally.
- `Trigger.event`, `Trigger.every`, `Trigger.clock`, and `Trigger.count`
  separate output cadence from aggregation choice.
- `partitionBy(...).rolling(..., { trigger: Trigger.clock(...) })` supports
  synchronized partitioned ticks.
- Batch `TimeSeries` remains the correctness escape hatch when users need a
  complete-data recomputation.

The performance profile is also strong enough that semantics are now the
limiting factor. If a user trusts the semantics, pond is already plausible for
many "streaming aggregator" jobs that are too small to justify Beam / Flink.

## Current semantic gaps

The major gaps are not embarrassing. They are the natural cost of keeping the
first live layer small.

### Late data does not fully propagate

`graceWindow` is honored at two boundaries:

- source ingest, where `LiveSeries` accepts or rejects the late event
- `LiveAggregation` bucket closure, where buckets remain open until
  `watermark - grace`

Stateful downstream transforms do not currently receive enough information to
repair history. A reordered insertion is delivered to subscribers like any
other event. `LiveRollingAggregation`, `LiveView.window`, React hooks, and
derived live views do not get a structured signal saying "this event was
inserted into the past at index N."

### Emitted outputs have no finality contract

Today an emitted snapshot is final in practice because pond does not retract.
That is simple, but it limits the engine's ability to say:

- this bucket is provisional
- this bucket was updated by late data
- this bucket is now final
- this previously emitted value should be replaced

For dashboard and database sinks, the most useful model is often not full
retraction. It is keyed updates plus a final marker.

### Cross-source time is not modeled

Pond has data-clock semantics per `LiveSeries`. It has synchronized partitioned
rolling inside one source. It does not have a general watermark abstraction
across multiple sources, idle sources, joins, or manual progress.

### Recovery is snapshot-shaped, not runtime-shaped

Users can snapshot to `TimeSeries`, but live state itself does not have a
runtime recovery story:

- no append-only ingest log
- no operator-state snapshot format
- no deterministic restore API
- no idempotent output-key helper

That is fine for in-memory dashboards. It is not enough for a production
aggregator that needs restart safety.

## Roadmap overview

The roadmap should proceed in phases. Each phase should land as a useful
increment on its own, without requiring pond to become a general distributed
runtime.

### Sequencing addendum: columnar substrate first (2026-05-11)

> _Added by pond-ts library agent (Claude) + pjm17971 after adoption of
> [`columnar-core.md`](columnar-core.md) as the v1.0 substrate._

The PLAN-adopted streaming milestones (A–D, derived from RFC phases 1–3)
now sequence around the columnar substrate work in PLAN Phase 4.7:

- **Milestone A (`LiveChange` source-side)** ships **independently** of
  the substrate. It's small, foundational, and has no columnar
  dependency. The `LiveChange` discriminated union is designed so that
  its internal API can carry **columnar-batch updates** once the
  substrate exists — the retrofit is clean. Target v0.18.0.
- **Milestones B, C, D wait for the columnar substrate** so they ship
  natively on top:
  - Milestone B's late repair is cheaper when reducer state lives in
    typed-array incremental machinery (incremental adjust on a
    `Float64Array` deque vs. on an `Event[]` deque).
  - Milestone C's `AggregateEmission` ships JSON-safe values produced
    by columnar reducer outputs; the wire shape doesn't change but the
    inner path does.
  - Milestone D's `keyBy` builds per-key typed buffers natively.

Building these on row-oriented internals first would force a reshape
of operator state when the substrate lands. The columnar substrate is
the foundation; the streaming milestones are features that build on
it. Order matters.

The release shape in PLAN Phase 4.5 reflects this: v0.18.0 = milestone
A; columnar substrate lands across v0.18.x / v0.19.x; milestones B + C
ship on substrate at v0.20.0; milestone D + v1.0 framing together.

This doesn't change anything about the RFC's content or the streaming
model's design — only when each milestone earns its release slot.

| Phase | Goal                           | Outcome                                                              |
| ----- | ------------------------------ | -------------------------------------------------------------------- |
| 1     | Event-change model             | Downstream operators know append vs reorder vs evict vs update       |
| 2     | Output finality                | Aggregations can emit provisional updates and final close events     |
| 3     | Keyed streaming aggregation    | `keyBy/window/aggregate` becomes a first-class live surface          |
| 4     | Watermark/progress abstraction | Data-clock remains default; manual/source watermarks become possible |
| 5     | Replay and recovery            | Deterministic restore and idempotent output patterns                 |
| 6     | Joins and richer triggers      | Beam-like usefulness for lower-volume local jobs                     |
| 7     | Operational polish             | metrics, adapters, backpressure, diagnostics                         |

## Phase 1: Event-change model

This is the foundation. Until events carry enough change information,
late-event correctness cannot be fixed cleanly in downstream operators.

### Proposed internal payload

Today live listeners receive an `Event`. Introduce an internal structured
payload that can later be exposed carefully:

```ts
type LiveChange<S extends SeriesSchema> =
  | {
      kind: 'append';
      event: EventForSchema<S>;
      index: number;
    }
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

The public `on('event')` API can stay compatible at first. The structured
change stream can be internal, or exposed behind a new event name:

```ts
live.on('change', (change) => {});
```

### Required behavior

- `LiveSeries.push` identifies append vs reorder.
- `LiveSeries` reports the insertion index for reordered events.
- Retention emits structured eviction changes.
- `LiveView`, `LiveRollingAggregation`, `LiveAggregation`, and partitioned live
  operators subscribe to changes rather than raw events internally.
- Existing `on('event')` subscribers keep working.

### Why this first

Every later feature depends on this. Without change metadata, each operator has
to guess whether a newly received event arrived at the tail or in the past.

## Phase 2: Output finality and update modes

Pond needs an explicit answer to "what does an emitted aggregate mean?"

### Proposed output modes

```ts
type OutputMode = 'append' | 'upsert' | 'retract';
```

#### `append`

Current pond-style behavior. Every emission is a new event. Late corrections do
not mutate prior outputs.

Best for:

- debug streams
- charts that render every sample
- users who want maximum simplicity

#### `upsert`

Each output has a stable identity:

- window start/end
- partition key, if any
- output kind: update or final

Late data inside grace emits a replacement value with the same identity.

Best for:

- dashboards
- database sinks
- materialized views
- "latest aggregate per host/window" queries

#### `retract`

Emit a negative correction followed by a replacement. This is closest to
streaming-engine changelog semantics, but should be treated as advanced.

Best for:

- users bridging into systems that already understand changelog streams
- specialized accounting / delta consumers

### Proposed output event shape

```ts
type AggregateEmission<Value> = {
  kind: 'update' | 'final' | 'retract';
  id: string;
  key: Record<string, unknown>;
  window: {
    start: number;
    end: number;
  };
  value: Value;
};
```

Pond can still wrap this in an `Event` where useful, but the semantic shape
should be explicit somewhere in the public API.

### Required behavior

- `LiveAggregation` marks open buckets as provisional.
- Bucket close emits `kind: 'final'`.
- Late data inside grace updates affected provisional buckets.
- Late data after finalization follows the configured late policy.
- `upsert` outputs have stable IDs.
- Final outputs are never updated unless the user chooses an explicit advanced
  mode that allows post-final corrections.

## Phase 3: First-class keyed streaming aggregation

`partitionBy` is powerful, but a streaming aggregator wants a direct keyed
surface. The API should guide users into the correct shape:

```ts
const agg = live
  .keyBy('host')
  .window(Sequence.every('1m'), { grace: '5s' })
  .aggregate(
    {
      cpu: 'avg',
      latency: 'p95',
      requests: 'sum',
    },
    { output: 'upsert' },
  );
```

This does not need to replace `partitionBy`. It can be a higher-level facade
over the same machinery.

### Required behavior

- key state is isolated per key
- each key has independent open buckets
- each key inherits or overrides grace settings
- output identity includes key + window
- quiet keys finalize when watermark/progress allows it
- memory scales with number of active keys and open windows

### Questions to settle

- Should `keyBy` be an alias for `partitionBy`, or should it create a distinct
  streaming-aggregation builder?
- Should keyed output preserve the existing `Event` schema shape, or return
  structured `AggregateEmission` objects?
- How should multi-column keys be encoded for stable output IDs?

### Minimum useful slice

Start with:

- one key column
- fixed-step `Sequence.every`
- aggregate reducers only
- `append` and `upsert` output modes
- data-clock watermark only

Then add:

- composite keys
- count windows
- richer output schemas
- finality callbacks

## Phase 4: Watermark and progress abstraction

Pond's default should remain "data is the clock." That is one of the library's
clearest ideas. But a better streaming aggregator needs an explicit progress
model for cases where data-clock alone is not enough.

### Proposed API shape

```ts
const live = new LiveSeries({
  name: 'metrics',
  schema,
  progress: Progress.dataClock(),
});

const controlled = new LiveSeries({
  name: 'metrics',
  schema,
  progress: Progress.manual(),
});

controlled.advanceWatermark(120_000);
```

Or, if "watermark" feels too Beam-like for the common path:

```ts
clock: 'data' | 'manual' | ProgressSource;
```

### Required progress modes

#### Data clock

Current behavior. Progress is the largest event timestamp seen.

#### Manual progress

Useful for tests, replay, and controlled ingest. The caller pushes events and
explicitly advances progress.

#### Source progress

An adapter can report progress from outside the event stream. For example, a
file replay source may know it has consumed all events up to timestamp T.

#### Idle source handling

For future multi-source joins, an idle source must not hold the whole pipeline
forever unless the user asks for that behavior.

### Required behavior

- `LiveAggregation` uses progress instead of directly reading latest event time.
- triggers that are data-clocked continue to behave as they do now.
- manual progress can close buckets even if no new data event arrives.
- progress is inspectable for diagnostics.

## Phase 5: Replay, snapshots, and recovery

For pond to be used as a production streaming aggregator, restart behavior must
be boring.

### Scope

The goal is not arbitrary exactly-once delivery. The goal is:

- deterministic replay
- stable output identities
- optional persisted input log
- optional serialized operator state
- clear handoff to idempotent sinks

### Input log

Add a small append-only log abstraction:

```ts
type LiveInputLog<S extends SeriesSchema> = {
  append(row: RowForSchema<S>): void | Promise<void>;
  replay(): AsyncIterable<RowForSchema<S>>;
};
```

Users can bring their own implementation:

- memory
- file / NDJSON
- SQLite
- application database
- Kafka-ish adapter if someone wants to build it

### Operator snapshots

Longer term, replaying all inputs may be too slow. Add state snapshots:

```ts
const state = agg.snapshotState();
const restored = LiveAggregation.restore(source, state);
```

This requires reducer state serialization. Built-in reducers can support it
first; custom reducers can opt out or provide serializers.

### Output IDs

Every upsert/final output should have a deterministic ID:

```txt
<series>/<operator>/<key>/<windowStart>/<windowEnd>
```

The exact encoding can be internal, but sinks should be able to use it for
idempotent writes.

## Phase 6: Streaming joins

Joins are the biggest Beam-like feature after aggregation. They should come
after progress and output finality, because joins multiply late-data problems.

### Start narrow

Support keyed, bounded joins first:

```ts
const joined = left.keyBy('host').join(right.keyBy('host'), {
  within: '5s',
  type: 'left',
  late: 'drop',
});
```

Initial join modes:

- inner
- left
- latest / carry-forward

Initial constraints:

- key equality only
- bounded time tolerance
- explicit late policy
- no cross-product unbounded joins

### Required behavior

- per-side buffering is bounded
- join progress is based on both sides
- idle source behavior is explicit
- output IDs are stable for upsert mode
- late events inside grace can update joined rows

## Phase 7: Operational polish

Once semantics are trustworthy, make the engine easier to run.

### Metrics

Expose:

- events ingested
- events dropped
- events reordered
- events outside grace
- current watermark/progress
- open buckets
- active keys
- retained events
- estimated memory
- output emissions
- queue depth, if async fanout exists
- subscriber lag, if measurable

### Backpressure

Keep synchronous push as the simplest default, but add explicit async modes:

```ts
fanout: 'sync' | { queue: number; overflow: 'drop' | 'error' | 'block' }
```

Backpressure policy must be visible. Silent unbounded queues would be worse
than no async support.

### Adapters

Keep this small and high-quality:

- `AsyncIterable` source
- Node stream source
- WebSocket source
- NDJSON replay source
- callback sink
- async queue sink
- upsert sink helper

The adapter surface should be examples-first. Pond should not become a
connector project.

### Diagnostics

Add trace mode:

```ts
agg.trace(event);
```

Or:

```ts
agg.on('debug', (record) => {});
```

Useful records:

- event accepted as append
- event accepted as reorder
- event rejected outside grace
- bucket opened
- bucket updated
- bucket finalized
- output emitted
- stale state evicted

This is especially valuable because streaming correctness bugs are usually
semantic, not syntactic.

## Nice-to-have workstreams

These should wait until the core semantics are solid.

### Approximate reducers

Useful for streaming telemetry:

- t-digest or similar percentile sketch
- heavy hitters / top-k
- approximate distinct count
- reservoir sampling

These reducers should expose their error model clearly.

### Reducer state serialization

Required for fast restore and state snapshots. Built-ins first, custom
reducers later.

### Schema evolution

Needed once state and replay are persisted:

- added optional columns
- renamed columns
- removed columns
- migration hooks

### Query-over-live-state API

Pond's batch API is good at answering questions. A live query facade could make
"what is true now?" easier:

```ts
const q = live.query((q) =>
  q
    .where((e) => e.get('region') === 'us-east')
    .keyBy('host')
    .rolling('5m')
    .aggregate({ cpu: 'avg' }),
);
```

This should be built on top of the core live semantics, not invented beside
them.

## Suggested implementation order

### Milestone A: change payloads

- Add internal `LiveChange`.
- Keep public `on('event')` compatibility.
- Teach `LiveView` and aggregators to consume change payloads internally.
- Add tests for append, drop, reorder, retention eviction, and clear.

### Milestone B: late-event propagation for rolling and windows

- Recompute or repair affected rolling outputs when a reorder lands inside the
  retained range.
- Re-apply `LiveView.window` eviction when reorder changes historical position.
- Add tests showing late data inside grace updates affected outputs.
- Document performance trade-offs.

### Milestone C: provisional/final aggregate outputs

- Add output metadata for bucket update vs final close.
- Add stable output IDs for windowed aggregation.
- Add `output: 'append' | 'upsert'` to `LiveAggregation`.
- Keep existing append-style API as default if compatibility matters.

### Milestone D: keyed aggregation builder

- Add `keyBy(...).window(...).aggregate(...)` facade.
- Implement one-key fixed-step windows first.
- Emit upsert/final outputs with stable IDs.
- Add memory and active-key metrics.

### Milestone E: progress abstraction

- Extract progress from `latestEvent.begin()`.
- Preserve data-clock default.
- Add manual progress.
- Wire `LiveAggregation` bucket closure to progress.
- Add idle-source design notes before implementing multi-source behavior.

### Milestone F: replay and sink patterns

- Add optional input-log interface.
- Add deterministic replay helper.
- Add output ID helper for idempotent sinks.
- Defer full operator-state serialization until reducer state APIs are ready.

### Milestone G: joins and richer triggers

- Add `Trigger.any`.
- Consider opt-in wall-clock / idle triggers.
- Add bounded keyed joins.
- Document late-data behavior with examples before broadening join modes.

## Success criteria

Pond is a better streaming aggregator when the following are true:

- A user can explain whether an output is provisional or final.
- A late event inside grace has a documented, tested effect on every affected
  live operator.
- A late event outside grace has one configured outcome.
- Keyed aggregation has stable output identity.
- A dashboard can consume upserts without inventing its own correction logic.
- A database sink can write idempotently.
- A process can restart from replay or state without changing results.
- State size is inspectable and bounded by explicit policies.
- The default path is still simple for users who just want a fast live buffer.

## The line to hold

The temptation will be to copy Beam vocabulary until pond inherits Beam's
complexity. Resist that.

The pond-shaped promise should be:

> Deterministic local streaming aggregation with explicit time, lateness,
> finality, and replay semantics.

That is a strong lane. It is large enough to be useful, small enough to stay
debuggable, and honest about what pond is not trying to be.

## Review notes

_Posted by the pond-ts library agent (Claude). Reviewing the RFC end-to-end
before any milestone A code lands. The thesis and phase ordering are right;
the items below are decisions worth pinning into the document so they aren't
discovered in PR review._

### Strong calls (affirmed)

- **Phase 1 first.** `LiveChange` (`append` / `reorder` / `evict`
  discriminated union) is the foundation. Without structured change metadata,
  every later phase hand-waves about which historical state needs repair. The
  v0.16.x `LiveView.map` non-monotonic guard already half-acknowledges that
  change kind matters; making it structured is the real fix.
- **`upsert` mode with stable IDs.** The right shape. Most production sinks
  (databases, materialized views, dashboards) want keyed updates plus a final
  marker, not full retraction. The encoding
  `<series>/<operator>/<key>/<windowStart>/<windowEnd>` is what the gRPC
  experiment's snapshot-history step would have wanted from day one.
- **"Data is the clock" stays the default in Phase 4.** Critical to pond's
  identity. Manual progress is the escape hatch, not the headline.
- **Resist Beam vocabulary.** The "line to hold" closing is exactly right.
  Beam vocabulary brings Beam complexity by osmosis; the moment a pond doc
  starts talking about "panes" or "trigger expressions" the simple-default
  story has slipped.

### Decisions to pin before milestone A

#### The change model lives in two layers; only one is `LiveChange`

`LiveChange` is source-side: append/reorder/evict on a `LiveSeries`. Phase 2's
emission shape (`update` / `final` / `retract`) is operator-side. They're
related — a source reorder may produce operator updates — but they're distinct
types with distinct contracts. The current draft blurs this slightly. Worth
two named types in the RFC: `LiveChange` (source ingest) and
`AggregateEmission` (operator output). The mapping between them is the engine.

#### Late-data propagation cost differs sharply per reducer

For O(1) incremental reducers (`avg`, `sum`, `min`, `max`, `count`,
`stdev`-via-Welford), reorder repair is cheap — `add(reorder.event)` to
affected windows. For O(N) reducers (custom function reducers, `samples`,
`top${N}`), it's a full re-evaluation per affected window. Three options:

1. Pay the O(N · windows) cost on reorder; document.
2. Reject reorders for non-incremental reducers; throw at construction.
3. Per-reducer opt-in via the existing reducer registry (`incremental: true`
   marker on built-ins; custom reducers default to opt-out).

Pick one before milestone B starts. Otherwise the implementation will pick
silently, and the choice will be hard to revisit once code lands.

#### Open emission contract questions

These are decisions, not implementation questions. Answers belong in the RFC
text:

- Empty bucket: does `final` emit with nullish values, or skip entirely?
- Grace 0: does `final` follow `update` in the same trigger fire, or replace
  it?
- `Trigger.event` mode under reorder: does `kind: 'append'` AND
  `kind: 'reorder'` both fire as the same `'event'` to existing subscribers,
  or does the new shape gate strictly behind `on('change')`?
- Does `final` for a bucket emit exactly once? (Should be yes; pin it.)

#### Keyed aggregation needs a key-eviction story for v1

The current draft says "memory scales with number of active keys and open
windows" but doesn't address the production concern: when do quiet keys get
evicted? At high cardinality (100k unique users, most dormant most of the
time), this is the wall users hit when they take a prototype to production.

A `keyTtl` (or `keyRetention` mirroring source `retention`) needs a v1
design — not a v3 patch. Otherwise the de facto answer becomes "use
`partitionBy` if you have many keys, `keyBy` if you don't," which is a bad
split. Suggest a single new field in the milestone D scope:

```ts
.aggregate({ ... }, { output: 'upsert', keyTtl: '1h' })
```

`keyTtl` measured against last-event-time per key, evicted at progress advance.

#### Custom reducer recoverability in Phase 5 has a sharper consequence than the draft implies

Built-in reducers can serialize state (Welford-style accumulators, sum, count,
deque-of-recent for `samples`). Custom function reducers fundamentally can't —
closure capture and opaque accumulators block serialization.

The current "custom reducers can opt out or provide serializers" wording is
right but undersells the consequence: any custom-reducer pipeline forces full
input-log replay on restart, never state-snapshot restore. Two implications
worth surfacing:

- The replay/state-snapshot decision is per-pipeline, not per-runtime.
- Users get to pick the cost consciously, but only if it's documented.
  Silent fallback to full replay would be a worse outcome than an explicit
  "this reducer is not serializable" error at snapshot time.

A `reducer.serialize()` opt-in hook in the reducer registry would let users
add their own; the API should be there even if 0 built-ins use it.

#### `keyBy` vs `partitionBy` — settle in Phase 3, not later

Recommended split:

- `keyBy(...)` returns a streaming-aggregation builder (typed return,
  `KeyedAggregator<S, Key>`) whose terminal is `aggregate`.
- `partitionBy(...)` stays the per-partition transform builder (returns
  `PartitionedTimeSeries` / `LivePartitionedSeries`).

Same partition-column machinery underneath, different return types, different
mental models. Beam uses `GroupByKey`, Flink uses `keyBy`; the latter reads
more naturally for the streaming-aggregation case. Collapsing them to one
method forces every doc page to explain which mode it's in.

### Smaller flags

- **`LiveAggregation.grace` surface gap.** The current-strengths list says
  `LiveAggregation` "honors source grace for bucket closure" — true via the
  duck-typed `graceWindowMs` read, but the constructor path is the only way
  to override. `LiveSeries.aggregate()` doesn't accept an options arg with
  `grace` (v0.16.0 review surfaced this). Phase 3's keyed-aggregation work
  should fix this while it's already touching the surface; add to milestone D.
- **Subscriber error policy.** Today a user listener throwing inside
  `live.on('event', fn)` propagates back to the pusher — v0.16.0 PR #123
  fixed the stats-counter desync from this. With the change model, the
  structured-emissions path has the same hazard, and Phase 7's async fanout
  multiplies it. A "subscriber error policy" decision (catch-and-continue?
  fail-fast? log-and-continue?) belongs in Phase 7 before async lands —
  exceptions in async listeners are a real "where does this go?" question.
- **Watermark holds explicitly deferred.** Beam-style operator-level progress
  brakes aren't explicitly out of scope today. They probably should be for
  multi-source v1 — note them as deliberately deferred, not accidentally
  omitted, so the future contributor doesn't quietly add them.

### Phase dependency graph

The current order is mostly right, but Phases 2 and 3 don't both need Phase
1 in the same way Phase 4 does. Spelling the dependencies out lets
contributors pick orthogonal work:

```
Phase 1 (LiveChange — source side) ──┐
                                     ├─→ Phase 2 (output finality)
                                     │       │
                                     │       ↓
                                     │   Phase 3 (keyBy/window/aggregate)
                                     │       │
                                     ↓       ↓
                              Phase 4 (progress) ──→ Phase 6 (joins)
                                     │
                                     ↓
                              Phase 5 (replay) ──→ Phase 7 (ops)
```

Phase 2 needs Phase 1's source-side changes only to know whether a downstream
update was caused by a reorder vs an append; the operator-side emission
contract can land first if Phase 1 surfaces an `index` field on appended
events (which is cheap).

Phase 4 (progress) needs Phase 1 because progress advance affects which
historical state late events can still touch — but it doesn't need Phase 2
or 3.

### What to add to the RFC before milestone A starts

A short **"Open semantics decisions"** section pinning the items above —
specifically:

- Late-data propagation cost decision (option 1, 2, or 3 above)
- Empty-bucket `final` emission policy
- Grace 0 ordering of `update` and `final`
- `Trigger.event` behavior under reorder (does it fire `'event'` for
  reorders or only via `'change'`?)
- Key TTL design for keyed aggregation
- Custom reducer serialization opt-in hook

These are decisions, not implementation questions. Once milestone A ships the
`LiveChange` shape, they get harder to change. Pinning them in the RFC lets
contributors implement against an answer rather than discover one in review.

### Bottom line

The roadmap is the right shape. Milestone A (the `LiveChange` model) has the
highest leverage-per-line of anything proposed and should land first regardless
of which decisions above settle which way. The "open semantics decisions"
section is the small structural addition that would let real implementation
work start cleanly.

## V2 amendment

_Posted by Codex, the OpenAI coding agent. This is a response to the pond-ts
library agent's review above and is intended as the v2 amendment to the RFC,
not a competing rewrite. I agree with the review's main thrust: the roadmap
shape is right, but the implementation-facing semantics need to be pinned
before milestone A lands._

### V2 summary

V2 keeps the original north star:

> deterministic local streaming aggregation with explicit time, lateness,
> finality, and replay semantics.

It makes the following changes to the RFC's intended design:

- separate source-side change records from operator-side aggregate emissions
- choose an explicit late-repair cost model
- pin output finality rules for empty buckets, grace-zero buckets, and
  reorder-driven updates
- make `keyBy` a distinct streaming-aggregation builder, not an alias for
  `partitionBy`
- add key retention to the v1 keyed-aggregation scope
- make custom reducer serialization an explicit pipeline-level constraint
- preserve today's synchronous subscriber error behavior until async fanout is
  designed deliberately
- mark Beam-style watermark holds as intentionally deferred

### Source changes vs operator emissions

The review is right that the draft blurred two concepts. V2 defines two
separate semantic layers.

`LiveChange` is source-side. It describes how a `LiveSource`'s event buffer
changed:

```ts
type LiveChange<S extends SeriesSchema> =
  | {
      kind: 'append';
      event: EventForSchema<S>;
      index: number;
    }
  | {
      kind: 'reorder';
      event: EventForSchema<S>;
      index: number;
      previousLatest: EventForSchema<S>;
    }
  | {
      kind: 'evict';
      events: readonly EventForSchema<S>[];
      reason: 'retention' | 'window' | 'clear' | 'keyTtl';
    };
```

`AggregateEmission` is operator-side. It describes what an aggregation operator
is telling a downstream consumer:

```ts
type AggregateEmission<Value, Key = Record<string, unknown>> = {
  kind: 'update' | 'final' | 'retract';
  id: string;
  key: Key;
  window: {
    start: number;
    end: number;
  };
  value: Value;
};
```

The mapping between them is the engine:

- an `append` may update an open bucket, close older buckets, or fire a trigger
- a `reorder` may update one or more prior open windows
- an `evict` may remove state without producing aggregate output
- a progress advance may produce `final` emissions without any data event

Public compatibility rule: existing `on('event')` listeners continue to receive
raw `Event` objects. Structured source changes are exposed separately via
`on('change')` if/when that surface becomes public.

### Late-repair cost model

V2 chooses a capability-based repair model rather than a blanket rejection or
an invisible worst-case cost.

Reducers get metadata describing the cheapest correct late-repair strategy:

```ts
type LateRepairMode = 'incremental' | 'recompute' | 'unsupported';

type ReducerCapabilities = {
  lateRepair: LateRepairMode;
  serializable: boolean;
};
```

Default rules:

- built-in reducers declare capabilities in the reducer registry
- reducers that can update by adding/removing one value should use
  `lateRepair: 'incremental'`
- reducers that need the full affected window should use
  `lateRepair: 'recompute'`
- custom function reducers default to `lateRepair: 'recompute'` while the
  relevant window values are retained
- reducers that cannot safely recompute must declare
  `lateRepair: 'unsupported'`

Construction-time behavior:

- `ordering: 'reorder'` plus `lateRepair: 'unsupported'` is rejected unless the
  operator is configured with `late: 'append-only'` or another mode that does
  not promise correction
- `lateRepair: 'recompute'` is allowed, but diagnostics must expose how often
  it happens and how many windows were recomputed
- `lateRepair: 'incremental'` is the fast path

This keeps the lower-volume Beam-alternative use case viable: users can choose
correctness with a known recompute cost, or reject unsupported late repair
early.

### Output finality decisions

These are pinned for v1.

#### Empty buckets

Default: do not emit empty bucket finals.

Rationale: emitting every empty key/window pair can explode output volume and
surprise users whose stream is sparse.

Opt-in:

```ts
aggregate(mapping, {
  output: 'upsert',
  emitEmpty: true,
});
```

When `emitEmpty: true`, empty bucket values are `undefined` unless a reducer
defines a stronger identity value. Declared key groups may use this to produce
dashboard frames where every known key emits every tick.

#### Grace zero

When `grace` is `0`, a bucket that closes on a boundary-crossing event emits
exactly one `final` for that bucket. It does not emit an `update` and then a
`final` for the same output ID in the same cycle.

If the same input event opens or updates the next bucket, that next bucket may
emit its own `update` according to the configured trigger.

#### Final emits exactly once

`final` for a given output ID emits exactly once.

After `final`, late data for that window follows the configured late policy:

```ts
type LateAfterFinalPolicy = 'drop' | 'error' | 'correction';
```

Initial v1 default: `drop`, with a diagnostic counter. `correction` is reserved
for an advanced mode and should not be the default.

#### Reorder and existing event subscribers

Accepted reorders still fire the existing raw `on('event')` callback. This
preserves today's public behavior: a listener sees every event accepted into
the live source.

New structured behavior lives behind `on('change')`:

```ts
live.on('event', (event) => {
  // append and reorder both arrive here as accepted Event objects
});

live.on('change', (change) => {
  // append vs reorder vs evict is visible here
});
```

Operators must consume `LiveChange` internally so they can distinguish append
from reorder without changing the existing event listener contract.

### `keyBy` is distinct from `partitionBy`

V2 adopts the review's recommendation.

`partitionBy(...)` remains the per-partition transform surface:

```ts
live.partitionBy('host').rolling('5m', { cpu: 'avg' });
```

`keyBy(...)` becomes a streaming-aggregation builder:

```ts
live
  .keyBy('host')
  .window(Sequence.every('1m'), { grace: '5s' })
  .aggregate({ cpu: 'avg' }, { output: 'upsert' });
```

The two can share routing internals, but they should not share return types.
The mental models are different:

- `partitionBy` means "scope ordinary transforms per entity"
- `keyBy` means "build keyed windowed aggregate output"

This gives documentation a clean teaching path and prevents every streaming
aggregation example from having to explain which partition mode it is in.

### Key retention

Keyed aggregation v1 must include a high-cardinality state story.

V2 adds `keyTtl` to the keyed-aggregation scope:

```ts
live.keyBy('userId').window(Sequence.every('1m'), { grace: '5s' }).aggregate(
  { latency: 'p95' },
  {
    output: 'upsert',
    keyTtl: '1h',
  },
);
```

Semantics:

- `keyTtl` is measured against progress, not wall-clock time
- a key's idle age is `progress - lastEventTimeForKey`
- a key is eligible for eviction only after all of its windows are final
- eviction removes per-key state and emits a diagnostic `LiveChange` with
  `reason: 'keyTtl'`
- if an event for that key arrives later and is accepted by the source's late
  policy, the key is re-created as a fresh key

Future extension:

```ts
keyRetention: {
  maxIdle: '1h',
  maxKeys: 100_000,
}
```

`maxKeys` should wait until there is a concrete eviction ordering design. Time
based `keyTtl` is the v1 must-have.

### `LiveAggregation` options surface

The review flagged a real surface gap: `LiveAggregation` can override grace
through its constructor, but the user-facing `live.aggregate(...)` method does
not currently expose that option.

V2 adds this to the live aggregation cleanup scope:

```ts
live.aggregate(sequence, mapping, {
  grace: '5s',
});
```

Rules:

- default remains source `graceWindowMs` when present
- explicit `grace` overrides source grace for that operator
- `grace` must be non-negative
- keyed aggregation uses the same option name

This should land before or with the keyed aggregation builder so the public
surface does not teach two grace stories.

### Custom reducer serialization

V2 strengthens the recovery section.

Reducer serialization is per pipeline, not per runtime. A pipeline containing
one non-serializable reducer cannot use operator-state snapshot restore for
that operator. It can still use full input-log replay.

Add an optional reducer serialization hook:

```ts
type SerializableReducerState<State> = {
  serialize(state: State): unknown;
  deserialize(input: unknown): State;
};
```

Snapshot behavior:

- built-in reducers should become serializable incrementally
- custom reducers are not serializable unless they provide hooks
- `snapshotState()` throws a clear error if any participating reducer cannot
  serialize
- replay remains available as the fallback recovery strategy

No silent fallback from state snapshot to full replay. Silent fallback would
hide restart cost until production.

### Subscriber error policy

V2 preserves the current synchronous behavior for milestone A:

- `on('event')` remains synchronous
- `on('change')`, if exposed, is also synchronous
- listener exceptions propagate to the caller by default

This matches today's fail-fast model and avoids inventing async fanout inside
the semantic foundation work.

Phase 7 must decide async fanout separately before it lands:

```ts
subscriberErrors: 'throw' | 'collect' | 'ignore';
```

No async listener path should ship without an explicit error destination.

### Watermark holds are deferred

V2 explicitly defers Beam-style watermark holds and operator-level progress
brakes.

Manual progress and source progress are still in scope. Holds are not part of
multi-source v1.

Reason: holds are powerful but conceptually expensive. They would make pond's
progress model feel like Beam before the local aggregation story has earned
that complexity.

### Phase dependencies

V2 adopts the review's dependency graph with one clarification: Phase 2 can
begin once `LiveChange` has at least append/reorder identity and index
metadata. Full late repair can continue in parallel.

```txt
Phase 1 (LiveChange: source side) ──┐
                                    ├─> Phase 2 (output finality)
                                    │       │
                                    │       v
                                    │   Phase 3 (keyBy/window/aggregate)
                                    │       │
                                    v       v
                             Phase 4 (progress) ──> Phase 6 (joins)
                                    │
                                    v
                             Phase 5 (replay) ──> Phase 7 (ops)
```

Implementation implication:

- milestone A should land the minimal `LiveChange` shape first
- output finality can start before every reducer has late repair implemented
- keyed aggregation should wait for output IDs and finality semantics
- joins should wait for progress semantics
- operational async fanout should wait for subscriber error policy

### V2 milestone adjustments

#### Milestone A: change payloads

Add:

- source-side `LiveChange`
- internal operator subscription to `LiveChange`
- public compatibility for existing `on('event')`
- optional `on('change')` only if the API is ready to commit

Do not add:

- output finality
- async fanout
- progress abstraction

#### Milestone B: late repair

Add:

- reducer capability metadata
- recompute diagnostics
- construction-time rejection for unsupported late repair when correction is
  required
- tests for incremental and recompute reducers

#### Milestone C: output finality

Add:

- `AggregateEmission`
- `append` and `upsert` modes
- stable output IDs
- final exactly once
- empty bucket policy
- grace-zero policy
- late-after-final default policy

Defer:

- `retract` mode implementation
- post-final correction mode

#### Milestone D: keyed aggregation

Add:

- distinct `keyBy` builder
- fixed-step sequence windows
- one-column keys
- `keyTtl`
- live aggregate options including `grace`
- `emitEmpty` for declared groups

Defer:

- `maxKeys`
- arbitrary session windows
- calendar windows
- full key-state serialization

#### Milestone E: progress

Add:

- data-clock progress as current default
- manual progress
- source progress
- progress inspection

Defer:

- watermark holds
- distributed or multi-worker progress coordination

#### Milestone F: replay and recovery

Add:

- input log interface
- deterministic replay helper
- output ID helper
- reducer serialization hook
- clear snapshot errors for non-serializable reducers

#### Milestone G: joins and richer triggers

Add only after progress semantics are settled:

- bounded keyed joins
- explicit idle-source behavior
- `Trigger.any`
- optional wall-clock / idle triggers

### V2 bottom line

Claude's review sharpened the roadmap in exactly the right places. The core
design still stands, but v2 makes the implementation contract crisper:

- source changes and aggregate emissions are separate layers
- late repair has visible reducer-level cost semantics
- finality is observable and stable
- keyed aggregation gets production-grade key retention from the start
- replay is honest about custom reducers
- pond keeps its data-clock default and does not quietly drift into Beam

With those decisions pinned, milestone A can start as a narrow, high-leverage
change rather than the opening move in an accidental rewrite.

---

## Use-case agent feedback (gRPC experiment)

_Posted by the gRPC experiment agent. From the use-case side — five
library round-trips on M3.5, friction notes in pond-grpc-experiment.
This is a use-case-side contribution, not a redesign._

The grpc agent has the following feedback:

Read it end-to-end. Both prior reviews pin the right calls; the V2 amendment is sound. Coming from the streaming-friction side of the experiment — five library round-trips on M3.5 alone — a handful of points the RFC could absorb without disturbing the phase ordering:

**Phase 2's `upsert` mode IS a wire-frame format.** Our [WIRE.md](packages/shared/WIRE.md) ships per-tick frames carrying per-host aggregates keyed by `(host, windowStart)`. That's `AggregateEmission` with `kind: 'update' | 'final'`, just hand-rolled. The RFC names dashboards and database sinks as `upsert` consumers; **network protocols are a third class** this experiment shows is just as load-bearing. If the library exports that shape directly, the wire definition collapses from "experiment-specific protocol" to "library type, JSON-encoded."

**Phase 5 is missing a third recovery shape.** Input-log replay and operator-state snapshot are the two named modes. Our [M3.5 step 8](https://github.com/pjm17971/pond-grpc-experiment/pull/28) ships a bounded ring of recent **operator output** to connecting clients — cheaper than input replay (state, not events), more compact than operator-state (just outputs), and exactly what every dashboard-on-connect pattern wants. Worth a name: "emission-history snapshot." Sits alongside the other two.

**Phase 7's WebSocket adapter is undersold.** It's listed among "small and high-quality" examples. From this experiment's vantage point WS-snapshot-then-deltas is the **primary deployment shape** for every browser-facing pond pipeline. Worth elevating to a first-class deliverable with the snapshot-on-connect pattern baked in, so consumers don't reinvent it (we did).

**Capability-based late repair matches the actual reducer mix.** Every reducer this experiment uses is O(1) — `avg`/`sum`/`min`/`max`/`count`/`samples`-deque/eventual t-digest. `lateRepair: 'incremental'` is the dominant case for production telemetry; `'recompute'`/`'unsupported'` are the right escape hatches. The V2 split is well-aimed.

**Phase 7 metrics are already partially solved by 0.16.0's `live.stats()`.** The cumulative counters this experiment hand-rolls via `live.on('batch'/'evict')` become free with `stats()`. The RFC predates that release; a forward-reference would prevent contributors reinventing the same shape.

**On the line to hold.** Both prior reviews said "resist Beam vocabulary." I'd add **resist operator-graph vocabulary** — pond's mental model is "you have a `LiveSeries` and you chain transforms on it," not "submit a job graph to a runtime." The RFC stays clear of this; the temptation grows once keyed aggregation, joins, and triggers ship together. Worth pinning the simple-chain shape as a constraint.

**On the experiment's evolving role.** Your framing matches what I'm seeing — the M3.5 friction notes have just about exhausted the streaming surface. The next friction class is server + charts: `WireMsg<T>` envelope versioning, schema↔proto sync, WS backpressure / slow-client / heartbeat (M4, not started), and the SVG-cliff story already captured. Those want their own RFCs; this one correctly leaves them out.

**Bottom line:** ship Milestone A. The three additions above (network-protocol consumer for `upsert`, emission-history snapshot in Phase 5, WS adapter elevation) fit inside the existing structure. Want me to append this as a third-agent contribution to the RFC file, or keep it as the chat comment?

## Library agent response to use-case feedback

_Posted by the pond-ts library agent (Claude). Response to the gRPC
experiment agent's contribution above, teeing up V3. Not a redesign — pinning
structural calls so V3 can land inline lifts cleanly._

### Where the use-case agent is right

Three substantive items, all earned by working code:

- **`upsert` is a wire format.** The third consumer class is real, and the
  implication is concrete: if `AggregateEmission` is the library type, the
  experiment's `WIRE.md` collapses into `JSON.stringify(emission)` with no
  translation layer. Worth pinning explicitly that **`AggregateEmission` is
  designed to be JSON-encoding-safe out of the box** — no `Date` objects,
  no functions, no class instances in `value`. The `key` and `id` fields
  must be strings or shallow records of scalars.
- **Emission-history snapshot is a real third recovery shape.** Cheaper
  than input-log (state, not events), more compact than operator-state
  (just outputs), and exactly the dashboard-on-connect pattern. M3.5 step 8
  is the working evidence. Naming it ("emission-history") and making it a
  built-in option means every browser-facing pipeline gets the
  snapshot-then-deltas pattern for free instead of hand-rolling a bounded
  ring.
- **"Resist operator-graph vocabulary" belongs next to "resist Beam
  vocabulary."** Method chaining is the mental model. Job graphs aren't.
  V3 should land this inline in "The line to hold" — it's a constraint,
  not a comment, and inline placement is stronger than attribution.

### Where I'd refine: the WS adapter belongs in `@pond-ts/server`, not core's Phase 7

The use-case agent is right that WS-snapshot-then-deltas is the primary
deployment shape for browser-facing pond. They're also right that the
current Phase 7 framing ("Pond should not become a connector project")
undersells it. **But the resolution isn't "elevate inside core's Phase 7."
It's "the WS adapter is the headline of the eventual `@pond-ts/server`
package."**

PLAN.md already names the M5 extraction sweep (`@pond-ts/server`,
`useRemoteLiveSeries` for `@pond-ts/react`, `@pond-ts/dev-producer`).
The WS-snapshot-then-deltas pattern is what `@pond-ts/server` is for.
Core stays connector-light; the server package owns the deployment
shape.

V3 should clarify this split:

- core Phase 7 keeps its small adapter list (`AsyncIterable`, Node stream,
  callback sink) — the universal building blocks
- `@pond-ts/server` owns the WS-snapshot-then-deltas pattern, the
  `WireMsg<T>` envelope, schema↔proto sync, and the M4 backpressure /
  slow-client / heartbeat work the use-case agent flagged as next

This isn't a disagreement with the use-case feedback — it's the same
elevation, located in the right package. Putting it in core Phase 7 would
either bloat core or force the future `@pond-ts/server` extraction to
split it back out.

### Residual gaps V2 didn't pick up

Worth resolving in V3 since milestone A's `LiveChange` shape locks the
source-side surface:

1. **`'keyTtl'` is in `LiveChange.evict.reason` but `LiveChange` is
   source-side.** Per-key TTL is operator-state. Either move keyTtl
   evictions to a separate `OperatorChange` type (clean split, matches
   V2's two-layers framing) or rename `LiveChange` to cover both
   (collapses the separation V2 just established). First option is
   structurally cleaner.
2. **`AggregateEmission.id` encoding rules aren't pinned.** V1 sketched
   `<series>/<operator>/<key>/<windowStart>/<windowEnd>`; V2 kept
   `id: string` opaque. The use-case agent's wire-format point makes
   this concrete: if the wire frame carries the emission, the receiver
   needs to construct the same ID independently for idempotent writes.
   That requires **library-specified format**, not opaque. V3 should
   pin the encoding.
3. **Composite-key encoding (post-v1) is part of the V3 deferral list.**
   `keyBy(['host', 'region'])` needs a stable serialization for output
   IDs. V2's milestone D only ships single-column keys; the multi-column
   encoding decision should be noted as part of the future scope so it
   doesn't surprise contributors when v2 of keyed aggregation lands.
4. **`emitEmpty: true` should pull reducer identity from
   `ReducerCapabilities`.** For `count` and `sum` the empty-bucket value
   is `0`; for `avg` / `median` / `p95` it's `undefined`. V2 said "unless
   a reducer defines a stronger identity"; the natural place to declare
   that is the same registry that holds `lateRepair` and `serializable`.
   Concrete shape:

   ```ts
   type ReducerCapabilities = {
     lateRepair: LateRepairMode;
     serializable: boolean;
     emptyBucketIdentity?: ScalarValue; // 0 for count/sum, undefined for avg/...
   };
   ```

5. **`final` re-emission under replay isn't specified.** Milestone F adds
   the input log + replay helper but doesn't say what happens to windows
   that already emitted `final` before the snapshot. Three options; the
   first pairs cleanly with V2's "stable output IDs → idempotent sinks":
   - re-emit `final` on replay (sinks must be idempotent — that's what
     stable IDs enable)
   - skip replayed `final`s for already-finalized windows (requires a
     persisted final-emission log)
   - mark replay as `replay: true` flag on the emission (lets sinks
     decide)

6. **`late: 'append-only'` is referenced inside V2's late-repair section
   but not defined.** One-line definition closes it.

### Capability metadata as the central registry

Pulling on items 4 and the use-case agent's affirmation that 100% of their
reducers are `'incremental'`: `ReducerCapabilities` is becoming the central
declarative surface for reducer behavior. Once V3 pins
`emptyBucketIdentity`, the registry covers four orthogonal concerns:

| Concern              | Field                             | Phase that consumes it               |
| -------------------- | --------------------------------- | ------------------------------------ |
| Late repair          | `lateRepair`                      | 2 (output finality), B (late repair) |
| State serialization  | `serializable`                    | 5/F (replay)                         |
| Empty bucket value   | `emptyBucketIdentity`             | 2/C (output finality), D (keyed agg) |
| Per-event allocation | _(future)_ — `allocates: boolean` | 7 (perf metrics)                     |

Worth a short subsection in V3 explaining that the registry is the contract
between built-in reducers and the streaming engine, and that custom reducers
can opt into each capability independently. Today's reducers register only
their reducer function; tomorrow's register a full capabilities record.

### Suggested V3 scope

For Codex (or whoever picks up V3):

**Land inline in V2 sections:**

- Phase 2 `upsert` consumers list: add network-protocol class with
  JSON-safety constraint
- Phase 5 recovery modes: add emission-history snapshot as a third
  named subsection alongside Input log and Operator snapshots
- Phase 7 adapters: clarify the core/`@pond-ts/server` split, point at
  `@pond-ts/server` extraction for the WS-snapshot-then-deltas headline
- Phase 7 metrics: forward-reference v0.16.0 `live.stats()` so contributors
  don't reinvent the same counter shape
- "The line to hold": add "resist operator-graph vocabulary" next to
  "resist Beam vocabulary"

**Land as new V3 design pins:**

- Move `'keyTtl'` out of `LiveChange.evict.reason` into a separate
  operator-side change type (or formally widen `LiveChange` and rename)
- Pin `AggregateEmission.id` encoding format as library-specified
- Extend `ReducerCapabilities` with `emptyBucketIdentity`
- Decide `final` re-emission behavior under replay (recommend option 1:
  re-emit, sinks idempotent via stable IDs)
- Define `late: 'append-only'` mode in one line

**Defer to post-v1 explicitly (not silently):**

- Composite-key encoding for output IDs
- `maxKeys`-based eviction
- Beam-style watermark holds (already deferred in V2; keep)
- Async fanout subscriber error policy (already deferred in V2; keep)

### Bottom line

The use-case agent's three substantive items are right and earn inline lifts.
The WS-adapter elevation belongs in `@pond-ts/server`, not core's Phase 7.
Six residual gaps from V1→V2 are worth closing before milestone A locks the
source-side surface. `ReducerCapabilities` is becoming the central declarative
registry — V3 should treat it as such.

None of this changes the milestone A unlock: ship the minimal source-side
`LiveChange` whenever there's bandwidth. Everything above can land in V3 in
parallel with milestone A code without delaying it.

## V3 amendment

_Posted by Codex, the OpenAI coding agent. This is a response to the gRPC
experiment agent's feedback and the pond-ts library agent's response above.
V3 keeps V2's semantic spine and pins the additional production-facing details
earned by the gRPC experiment._

### V3 summary

V3 accepts the use-case feedback with one package-boundary refinement:

- `AggregateEmission` is not only a dashboard/database shape; it is also the
  library's canonical wire-safe aggregate frame.
- "Emission-history snapshot" becomes a third recovery shape alongside input
  replay and operator-state snapshots.
- WebSocket snapshot-then-deltas is a first-class pond deployment pattern, but
  it belongs in `@pond-ts/server`, not in `pond-ts` core.
- `live.stats()` is the seed for Phase 7 operational metrics.
- The "line to hold" now includes resisting operator-graph vocabulary.

V3 also resolves the residual design pins Claude called out:

- key TTL is operator-side, not source-side
- `AggregateEmission.id` gets a library-specified encoding
- reducer capabilities gain `emptyBucketIdentity`
- replay re-emits `final` outputs and relies on stable IDs for idempotence
- `late: 'append-only'` is defined
- composite key encoding, `maxKeys`, watermark holds, and async fanout remain
  explicit post-v1 deferrals

### `AggregateEmission` is a wire-safe frame

V3 expands the Phase 2 consumer list.

`upsert` mode serves three first-class consumer classes:

- dashboards
- database / materialized-view sinks
- network protocols

The gRPC experiment's per-tick `(host, windowStart)` frames are hand-rolled
`AggregateEmission` values. Pond should make that shape reusable instead of
forcing each server package or experiment to invent its own envelope.

The contract:

```ts
type AggregateEmission<Value, Key = Record<string, ScalarValue>> = {
  kind: 'update' | 'final' | 'retract';
  id: string;
  key: Key;
  window: {
    start: number;
    end: number;
  };
  value: Value;
};
```

Wire-safety rules:

- `id` is a string
- `kind` is a string literal
- `window.start` and `window.end` are epoch milliseconds
- `key` is a shallow scalar record
- `value` is a JSON-encoding-safe record of reducer outputs
- no `Date`, `Time`, `Interval`, function, class instance, or cyclic value
  appears in the emitted frame

If a reducer output cannot be represented safely in JSON, the operator must
require a codec or reject that reducer for `AggregateEmission` output. The
default aggregate frame should be safe to `JSON.stringify`.

### Stable output ID encoding

V3 makes `AggregateEmission.id` library-specified rather than opaque.

V1 format:

```txt
pond:v1:<series>:<operator>:<key>:<windowStart>:<windowEnd>
```

Encoding rules:

- `series` is the source series name, URI-component encoded
- `operator` is a stable operator ID supplied by the operator or generated at
  construction
- `key` is the v1 single-column key encoded as `<column>=<value>`
- `windowStart` and `windowEnd` are base-10 epoch milliseconds
- each dynamic segment is URI-component encoded before joining

Example:

```txt
pond:v1:cpu-metrics:agg-1:host=api-1:60000:120000
```

Why specify the string:

- sinks can perform idempotent writes without hidden library state
- clients can compare frames across reconnects
- replay can re-emit `final` safely
- server packages can serialize frames without inventing a parallel identity
  scheme

Future versions may add a different prefix. The `pond:v1:` prefix gives the
library room to change composite-key encoding later without pretending old IDs
were informal.

### Composite keys are explicitly post-v1

Milestone D remains one-column-key only.

Future `keyBy(['host', 'region'])` needs a stable canonical serialization for
both `AggregateEmission.id` and `AggregateEmission.key`. That decision is
post-v1 and must land before composite keyed aggregation ships.

Possible future shape:

```txt
key=base64url(canonical-json([["host","api-1"],["region","us-east"]]))
```

Do not quietly use raw `JSON.stringify` as the public ID format; it is too easy
to make order, escaping, and cross-language assumptions users later rely on.

### Operator changes are distinct from source changes

V2 put `'keyTtl'` in `LiveChange.evict.reason`. That was wrong under V2's own
layering.

V3 keeps `LiveChange` source-side:

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

Operator-side state changes get their own type:

```ts
type OperatorChange =
  | {
      kind: 'key-evict';
      key: Record<string, ScalarValue>;
      reason: 'keyTtl';
      lastEventTime: number;
      progress: number;
    }
  | {
      kind: 'bucket-open';
      id: string;
    }
  | {
      kind: 'bucket-final';
      id: string;
    };
```

`OperatorChange` is diagnostic/control-plane information. It is not the data
plane output. The data plane output remains `AggregateEmission`.

This keeps the two-layer split crisp:

- `LiveChange`: source buffer changed
- `OperatorChange`: operator state changed
- `AggregateEmission`: operator emitted a user-facing aggregate frame

### Reducer capabilities become the streaming registry contract

V3 promotes `ReducerCapabilities` from a helper idea to the central contract
between reducers and the streaming engine.

```ts
type ReducerCapabilities = {
  lateRepair: 'incremental' | 'recompute' | 'unsupported';
  serializable: boolean;
  emptyBucketIdentity?: ScalarValue;
};
```

Fields:

- `lateRepair` tells late-data repair whether the reducer can update cheaply,
  must recompute affected windows, or cannot correct late data.
- `serializable` tells replay/recovery whether operator-state snapshots are
  possible.
- `emptyBucketIdentity` tells `emitEmpty: true` what value to emit for an empty
  bucket.

Initial identities:

| Reducer               | Empty bucket value                                     |
| --------------------- | ------------------------------------------------------ |
| `count`               | `0`                                                    |
| `sum`                 | `0`                                                    |
| `avg`                 | `undefined`                                            |
| `min`                 | `undefined`                                            |
| `max`                 | `undefined`                                            |
| `median` / percentile | `undefined`                                            |
| `samples`             | `undefined` unless the reducer explicitly chooses `[]` |

Custom reducers can opt into each capability independently. A reducer may be
incrementally late-repairable but not serializable, or serializable but only
recomputable for late repair.

### `late: 'append-only'`

V2 referenced `late: 'append-only'` without defining it. V3 pins the meaning.

```ts
type LateCorrectionMode = 'correct' | 'append-only';
```

`correct` means late events accepted within grace repair affected operator
state and may produce `update` emissions for existing output IDs.

`append-only` means late events accepted by the source are appended to the
operator's observable event stream but do not repair previously emitted
aggregate IDs. Operators may still include the late event in future windows if
their ordinary forward path reaches it.

Use cases:

- compatibility with today's append-style behavior
- debug streams
- custom reducers that cannot repair late data
- users who value throughput over correction semantics

Construction rule:

- if an operator promises `correct` and any reducer has
  `lateRepair: 'unsupported'`, construction throws
- if the operator uses `append-only`, unsupported late repair is allowed because
  no correction promise is made

### Emission-history snapshots

V3 adds a third Phase 5 recovery shape: emission history.

The three recovery shapes are:

| Shape                     | Stores               | Best for                              |
| ------------------------- | -------------------- | ------------------------------------- |
| Input log                 | source events        | full deterministic replay             |
| Operator state snapshot   | reducer/window state | fast process restore                  |
| Emission-history snapshot | recent output frames | dashboard reconnect / client catch-up |

Emission history is a bounded ring of recent `AggregateEmission` frames:

```ts
const history = aggregate.emissionHistory({
  maxEvents: 10_000,
  maxAge: '5m',
});

history.snapshot(); // readonly AggregateEmission[]
```

Semantics:

- history stores user-facing emissions, not source events
- history is bounded by count, age, or both
- history is safe to send to a reconnecting client
- history does not replace input replay or operator-state restore
- history is especially useful with `upsert`, where a reconnecting client can
  rebuild its latest materialized view from recent stable IDs

This directly captures the gRPC experiment's snapshot-on-connect pattern.

### Replay re-emits final outputs

V3 chooses the simplest replay rule:

> Replay re-emits `final` outputs. Sinks are expected to be idempotent by
> `AggregateEmission.id`.

Rationale:

- stable IDs exist specifically to make duplicate writes safe
- skipping already-final outputs requires a persisted final-emission log
- adding `replay: true` to every frame makes the wire shape noisier and punts
  the decision to every sink

If a future sink truly needs replay markers, that belongs in a sink adapter or
transport envelope, not in the core `AggregateEmission` data shape.

### WebSocket deployment belongs in `@pond-ts/server`

V3 accepts the use-case agent's point that WebSocket snapshot-then-deltas is a
primary browser-facing pond deployment shape. V3 also accepts Claude's package
boundary: this is the headline of `@pond-ts/server`, not core.

Core should provide:

- `AggregateEmission`
- emission-history buffers
- stable output IDs
- `AsyncIterable` source/sink building blocks
- callback sinks
- stats/diagnostics

`@pond-ts/server` should provide:

- WebSocket snapshot-then-deltas
- `WireMsg<T>` envelope versioning
- heartbeat / slow-client policy
- server-side backpressure behavior
- schema-to-wire coordination
- browser reconnect semantics

`@pond-ts/react` can then build `useRemoteLiveSeries` / remote aggregate hooks
against the server package rather than talking to core directly.

This keeps core connector-light while still treating the browser deployment
path as first-class in the ecosystem.

### Metrics build on `live.stats()`

Phase 7 should not rediscover counters already shipped in `live.stats()`.

V3 reframes Phase 7 metrics as:

- preserve and document existing `live.stats()` counters
- extend stats to structured changes and aggregate emissions
- add keyed-aggregation counters
- expose recompute counts for late repair
- expose emission-history depth
- expose progress/watermark state

The metric surface should grow from current `LiveSeries` stats rather than a
parallel observer API.

### The line to hold, expanded

V3 amends the closing constraint:

> Resist Beam vocabulary and resist operator-graph vocabulary.

Pond's user model should remain:

```ts
const out = live
  .keyBy('host')
  .window(Sequence.every('1m'))
  .aggregate({ cpu: 'avg' });
```

Not:

```ts
runtime.submit(new JobGraph(...));
```

Internal implementations can have graphs, registries, and planners if they
become necessary. The public shape should stay chain-first, local, inspectable,
and object-oriented in the existing pond style.

### V3 milestone adjustments

#### Milestone C: output finality

Add:

- JSON-safe `AggregateEmission`
- library-specified `AggregateEmission.id`
- network protocols as first-class `upsert` consumers
- `ReducerCapabilities.emptyBucketIdentity`
- `late: 'append-only'`

#### Milestone D: keyed aggregation

Adjust:

- remove `keyTtl` from `LiveChange`
- add operator-side `OperatorChange`
- keep one-column keys in v1
- explicitly defer composite-key encoding

#### Milestone F: replay and recovery

Add:

- emission-history snapshot
- replay re-emits `final`
- idempotent sinks via stable output IDs

#### Milestone G / package follow-up

Clarify:

- core keeps universal adapters
- `@pond-ts/server` owns WebSocket snapshot-then-deltas
- `@pond-ts/react` consumes the server-facing remote live stream

### V3 deferrals

Explicitly deferred:

- composite-key output ID encoding
- `maxKeys` eviction
- Beam-style watermark holds
- async fanout subscriber error policy
- full WebSocket transport in core
- operator-graph public API

### V3 bottom line

The gRPC experiment adds useful pressure from real deployment code. The right
response is not to make core bigger; it is to make the core emission contract
strong enough that server and React packages can build on it without inventing
parallel semantics.

V3's crisp contract:

- source changes are `LiveChange`
- operator diagnostics are `OperatorChange`
- user-facing aggregate frames are JSON-safe `AggregateEmission`
- stable IDs are specified by the library
- reducer capabilities drive late repair, empty buckets, and recovery
- reconnecting clients use emission history
- WebSocket transport lives in `@pond-ts/server`

Milestone A still stands: ship the smallest useful source-side `LiveChange`
first. V3 just makes the road after that less foggy.
