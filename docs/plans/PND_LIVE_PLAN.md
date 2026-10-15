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

### [PND-LSNAP] — Columnar `toTimeSeries()`

**Source:** the offscreen-stream spike (2026-10-15,
[`spikes/offscreen-stream/REPORT.md`](../../spikes/offscreen-stream/REPORT.md)
§3), which streamed ticks into a `LiveSeries` in a worker and drew them at
120 fps.

`toTimeSeries()` rebuilds row by row. The chunked store already holds
columns, but `snapshot()` (`live-chunked-storage.ts:366-390`) makes one
array per row, then a `TimeSeries` that validates every row again. Its own
comment calls the columnar version "a deferred follow-up; snapshot isn't
the hot path." For a live chart it is. Node, snapshot plus reading the
price column out: 60 ms at 60k rows, 542 ms at 600k, 3.9 s at 3M, against
1.7 / 16 / 91 ms to copy the same stored chunks' columns (spike
`results/node.txt` section 1). In the browser (cloud) the `snapshot`
pipeline spent 4 ms a frame reading at 10k points and 27 ms at 60k, so it
runs out of a 120 fps frame's 8.3 ms somewhere between. This is the data
side of the 31.6 fps SciChart-suite finding under
[PND-LIVELYR](PND_CHARTS_PLAN.md).

Shape to consider: concat the stored chunks into a trusted `TimeSeries`
(the comment already names `concatSorted(chunks)`). Check it against the
dashboard A/B that promoted `LiveView.column()` (Decisions, 2026-10-10): a
fast snapshot may change which path live charts should use.

Scope: cheaper, not free. A snapshot still copies the whole window (the
spike's plain column copy took 16 ms at 600k rows, twice a 120 fps
frame), and the chart side's `fromTimeSeries` reads one value at a time
until [PND-COLAPI] lands. So this serves throttled snapshots (React's
`useSnapshot` refreshes every 100 ms) and modest windows; a chart reading
a large window every frame needs the appended-columns route below.

The spike's other need, a public "just appended, as columns" event, is the
existing [PND-COLOUT](PND_COLUMNAR_PLAN.md). The spike used the internal
`_onChunk` in its place, because the public `'batch'` / `'event'`
listeners make an `Event` per tick (`#commitChunk`,
`live-series.ts:759-762`).

### [PND-LPUSHCOL] — Columnar push into `LiveSeries`

**Source:** offscreen-stream spike §5. `pushMany` accepts rows only. From
160 ticks a push up it costs 17–23 ms per 100k ticks in Node, where copying
the same ticks into typed arrays takes about 1 ms; building the row arrays
is only 2–3 ms of that. A CPU profile of `pushMany` with 1,600-row batches
(spike `results/profile.txt` section 1) puts **89% of the time in
`validateAndNormalizeColumnar` and what it calls: 55 points in its own
per-row loop and 27 in the `Time` constructor** (`normalizeKey` makes a
`Time` per row and throws it away after reading its number,
`batch/validate.ts:415-422`). `TimeSeries.fromColumns`, pond's existing
column ingest, takes the same ticks in the same batches in 0.8–2.0 ms
(0.9 ms at 1,600). Each `pushMany` call also has a fixed cost of about
0.05 ms in Node. In the browser at 1M ticks/s the drawing worker spent
75–78 ms a second on ingest on an M1 Pro (under 8% of the thread) and
239 ms on the cloud box: affordable today, not free.

Shape: `live.pushColumns({ time: Float64Array, price: Float64Array, … })`
through `ingestColumnsToStore` then `#commitChunk` (cross-batch order check
already there). This is the in-process half of
[PND-WIRE](PND_CORE_PLAN.md)'s `SeriesUpdate` streaming append: a columnar
wire is only worth having if the `LiveSeries` takes columns. Adds a method
to `LiveSeries`, so it needs human approval before merge.

### [PND-LVWIN] — `live.window()` gets slower per tick as the window grows

**Source:** offscreen-stream spike §4. A `LiveView` from `live.window(…)`
keeps its window as an `Event[]` and, on every arriving event, evicts with
`this.#events.splice(0, count)` (`live-view.ts:181-187` →
`#applyEviction`, `live-view.ts:730-736`). Once the window is full, every
tick evicts about one event, and each `splice` shifts the whole array. A
CPU profile of a 50k-event window puts 98% of the time in
`#applyEviction` (spike `results/profile.txt` section 2).

Node, cost of one 16 ms push once the window is full, ranges across three
runs (spike `results/node.txt` section 3, `results/node-window-reruns.txt`):

| window (events) | 10k ticks/s (160 a push), no view / view | 100k ticks/s (1,600 a push), no view / view |
| --------------- | ---------------------------------------- | ------------------------------------------- |
| 1k              | 0.11–0.18 / 0.48–0.71 ms                 | 0.43–1.05 / 4.6–13 ms                       |
| 10k             | 0.04–0.06 / 2.3–6.9 ms                   | 0.51–0.79 / 6.3–68 ms                       |
| 50k             | 0.03–0.07 / **24–34 ms**                 | 0.27–0.62 / **271–326 ms**                  |
| 100k            | 0.03–0.06 / **56–77 ms**                 | 0.29–0.58 / **368–398 ms**                  |

A push every 16 ms has to be taken in within 16 ms. In the browser
(cloud) the `view` pipeline at 10k ticks/s with a 10 s window (100k
points) spent the whole second ingesting, took in 1,846 of 10,000 ticks a
second and drew no frame.

Fix: a head index into the array, compacted occasionally (the spike's
`Ring` in `engine.ts` is the pattern), instead of `splice` per event. This
fixes keeping the view up to date, not reading it: `keyColumn()` /
`column()` gather from the `Event[]` on every call (64 ms at 600k rows in
Node, 4 ms a frame at 60k points in the browser). The
count form (`window(n)`) and the source-evict mirror (`live-view.ts:200-211`)
go through the same array. Attaching the view also turns on per-tick
`Event` creation in the source, since the view listens to `'event'`.

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
