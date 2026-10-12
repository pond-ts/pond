# PND_LIVE_PLAN — live layer: robustness + queued workstreams

> Breakout plan for the **Live layer** roadmap section in
> [PLAN.md](../../PLAN.md). Full design write-ups for every queued workstream
> (the original PLAN sections with API sketches, lag trade-offs, PR splits)
> are preserved verbatim in
> [docs/archive/phase-4-live-composition.md](../archive/phase-4-live-composition.md)
> — this file summarizes and points there rather than restating.

## Tasks

### [PND-LIVFIX] — Live robustness P1 cluster — **shipped 2026-09-06**

The five confirmed wrong-answer defects from the 2026-06 audits
([technical-audit-2026-06-v2.md](../notes/technical-audit-2026-06-v2.md) §4),
each reproduced as a failing test first (`test/live/livfix-*.test.ts`), then
fixed. Decisions worth keeping:

- **Listener errors are isolated, and the first one is rethrown after the
  push completes.** The alternative — swallow and log — would hide bugs;
  the alternative the code had — unwind immediately — skipped retention
  and desynced every later subscriber. Rethrow-after-commit keeps the
  caller's "my listener threw" signal while guaranteeing `length`,
  `ingested`, retention and every view agree. `ListenerSet` caches its
  iteration snapshot (invalidated on add/delete) so isolation costs no
  allocation per event on the kHz path.
- **Re-entrant pushes are queued, not rejected or interleaved.** A push
  from inside a listener runs after the current push, in arrival order.
  Under strict ordering the nested rows are then order-checked against the
  buffer at their turn; the audit's "spurious out-of-order rejection" was
  the nested push racing the outer batch's own rows. Queueing gives
  monotonic emission on both backings with one counter, one array and one
  flag: only the OUTERMOST guard drains the queue, strictly FIFO. The
  first cut drained from every guard level, and the Layer-2 review showed
  a grandchild push jumping a queued sibling (1 queues 10 then 20; 10
  queues 30; 30 ran before 20 and strict ordering rejected it) — the
  very defect being fixed, one level deeper. A sweep requested while a
  partition is mid-dispatch is queued the same way rather than skipped.
- **Quiet partitions age out against the source watermark**, via an
  internal `LiveSeries._sweepAge(latestMs)`, throttled so a sweep
  (O(partitions)) runs at most once per `maxAge / 8` of data time — the
  bound on how long a quiet partition can overstay. Deliberately NOT done:
  dropping an emptied partition object. `toMap()` hands out partition
  references and spawn is observable; the per-partition fixed cost the
  audit measured (~1.7 KB × 50k keys) is a cardinality question for a
  `maxPartitions`-style policy, which would be a feature. Instead unknown
  option keys now throw, so a caller passing `maxPartitions` learns it
  does nothing.
- **Chain-aware dispose treats a subscriber-less source view as
  unreachable.** `live.filter(p).map(f)` has no handle on the
  intermediate; disposing the outer view now cascades into any source view
  left with zero listeners. The documented cost: a caller who keeps a
  reference to an intermediate and disposes a derived view must keep a
  listener on the intermediate to keep it live. Judged the right trade —
  the idiomatic one-liner is the common case, and the leak was unbounded.
- **Windowed reducers over a `reorder` source select any-order state.**
  `min` / `max` use a sorted array (removal by value, O(n)); `first` /
  `last` an index-keyed map. Selected by an internal `_evictionOrder`
  getter on `LiveSeries` (`'sorted'` for `reorder`), so append-only
  sources keep the O(1) deque. `first` / `last` still follow arrival
  order on a reorder source (the pre-existing, documented caveat); what
  changed is that they never report an evicted value.
- **Not changed:** the audit's §4.5 (grace boundary — not a bug) and §4.6
  (evict-callback staleness for a source listener registered before a
  view's creation — order-fragile, undocumented). §4.6 is real but narrow;
  logged here rather than fixed, since the fix (fan-out ordering by
  registration) would change observable listener order for everyone.

Perf: `scripts/perf-live-columnar.mjs` before/after in the landing PR.

### [PND-LATE] — Late-event propagation through live transforms

A late event accepted at ingest does not re-flow through downstream stateful
transforms (`LiveRollingAggregation` windows, `LiveView.window()` eviction,
no "this was late" payload for subscribers). Needs a discriminated event
payload (`{ event, position: 'append' | number }`) and a recompute path per
stateful transform — overlaps with streaming Milestone A
([PND-CHANGE](PND_STREAMING_PLAN.md)). Archive has the full scope note and
test matrix.

### [PND-LJOIN] — Live merge / join

No way to combine multiple `LiveSeries` into one live source (interleave
same-schema; join cross-schema by time proximity). Open design: subscription
fan-in cadence, time alignment (tolerance window vs carry-forward vs required
`align()`), schema conflict (reuse batch `onConflict`), late-event
interaction. Workaround (documented): snapshot each source + batch `join()`.

### [PND-LALIGN] — Live align + materialize

Bounded-lag streaming `align` (and its sibling `materialize`) — needs a point
forward of each grid boundary, not history, so it's a lag problem, not a
structural gap. Driver: multi-stream joining (network counters,
`throughput = in − out`), which pondjs supported in production. Earns its
slot when a use-case agent hits the snapshot-then-batch friction concretely
or [PND-LJOIN] starts and needs it as a prerequisite.

### [PND-LDEDUP] — Live dedupe

The batch `dedupe({ keep })` shape is the convergence target. Open questions:
update-vs-emit on duplicate arrival, folding into the grace window
(likely: apply `keep` policy at grace close), a `'duplicate'` subscriber
event, interaction with closed aggregation buckets.

### [PND-BUFWIN] — Buffer-as-window Tier 1 + Tier 3

Tier 2 (query parity: `find`/`bisect`/`atOrBefore`/… ) shipped v0.16.0.
Remaining Tier 1: **`live.reduce(mapping)` sugar** (the `'buffer'` sentinel is
in the type but throws at runtime — design it as fused-rolling-with-one-entry),
`live.timeRange()`, `live.eventRate()` on `LiveSeries`, the
`count()`-vs-`length` naming decision. Tier 3 (range-slicing parity +
`window`-vs-`tail` naming) waits until Tier 1 usage shapes it.

### [PND-TRIG] — Trigger taxonomy expansion

From the post-v0.13.2 triage: **`Trigger.any(...)`** composition (mechanical
once singletons exist; reset semantics sketched in the archive) and the
**`Trigger.idle(duration)` RFC moment** — wall-clock by definition, which
commits pond to `setTimeout`, fake-timer test infra, and the
`Trigger.clock` → `eventClock`/`wallClock` naming reshuffle. Lean yes but
gate on a second user signal. Declined: `Trigger.threshold` (it's a filter),
`Trigger.manual` (it's `rolling.emit()` if ever needed).

### [PND-RESV] — Live-side reservoir sampling

Deferred from v0.17.0: Algorithm R's random-slot replacement produces
non-prefix evictions, which the current prefix-only eviction protocol can't
carry (Codex caught the silent-corruption path on PR #129). Gated on the
`LiveChange` exact-removal channel ([PND-CHANGE]). The Option-A
drift-on-eviction design is preserved in the archive; snapshot-side reservoir
already shipped.

### [PND-TAPOBS] — `tap()` per-partition observer

Pending evaluation (gRPC RFC #20): a per-partition observer callback for
slim observation (per-host gauges, debug instrumentation) without reducer
state. Re-triage now that fused rolling shipped — may be a small bolt-on on
the shared dispatch path; may earn its own RFC. Don't pre-decide.

## Decisions

### Live column reads promoted out of experimental — 2026-10-10 (1.0 readiness)

`LiveView.column()` / `keyColumn()` / `partitionBy().toMap()`, `LiveColumnGroup`
and `@pond-ts/react`'s `useLiveVersion` shipped in v0.19.0 marked "experimental —
may change in 0.19.x". The 1.0-readiness review (2026-10-10) required each to be
promoted, reshaped or removed before 1.0. **Promoted as-is.** Reasons: no change
request in 53 minors; the dashboard A/B measured a ~1.5–2× per-tick win over the
snapshot path; the 2026-06 live-columnar assessment found `useLiveVersion`'s
subscription model already correct; and every queued follow-up (non-numeric
`column()` kinds, the `TimeSeries.partitionBy().toMap()` gather-only dual in
[PND-GATHER]) only adds surface, so none needs the current shape to move.

## Parking lot

- Reducer batching (`addMany`) — deferred per the V4 bench; revisit only if a
  consumer is ceiling-bound (production target has 2.5× headroom).
- Shared lower-order moments for paired `avg`+`stdev` — measure first.
- `samples(n)` parameterized reservoir form; reducer composition/chaining
  (`avg.of(samples(20))`) — custom-function reducers cover both today.
- `Trigger.clock` naming wrinkle — held until a second signal or a wall-clock
  trigger forces the umbrella naming.
- Live equivalents of array-column operators.
