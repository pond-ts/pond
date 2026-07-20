# PND_STREAMING_PLAN — Streaming semantics (Phase 4.5)

> Breakout plan for the **Streaming semantics** roadmap section in
> [PLAN.md](../../PLAN.md). Tasks: [PND-CHANGE], [PND-REPAIR], [PND-FINAL],
> [PND-KEYED]. Strategic context: [docs/rfcs/streaming.md](../rfcs/streaming.md).
> Moved from PLAN.md (Phase 4.5) on 2026-07-20; the content below is the
> adopted milestone plan, unchanged.

Status: not started.

Adoption of RFC phases 1–3 from
[`docs/rfcs/streaming.md`](../rfcs/streaming.md). The RFC is strategic
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
