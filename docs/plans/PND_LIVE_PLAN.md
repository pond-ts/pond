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

### [PND-LVWIN] — `live.window()` evicts by head index — SHIPPED (#761)

**Outcome.** A window view keeps a start marker (`#head`) into its
`Event[]`. Eviction advances the marker and clears the evicted slots, so
their Events can be collected at once. The array is spliced only when the
evicted prefix outgrows the live window (`#head > length / 2`), so each
evicted event costs O(1) amortized instead of an O(window) `splice` on
every arriving event; the push that triggers the splice costs O(batch +
window). Every reader indexes from the marker. Built-in windows pass an
internal `keep: { count } | { ms }` option (`@internal`, so stripped from
the `.d.ts`). The older `evict` callback option still works: it is called
on a compacted array (same cost as before), and a fractional return is
truncated, as `splice` did.

Node 22, ms per push once the window is full
(`packages/core/scripts/perf-live-window.mjs`, as of 5ecbd26: a warm-up
pass, at least 2.2 compaction cycles, GC tracked per push). "Before" is
two runs of the same script against the pre-fix build, 30 pushes a row
(the old code has no cycle); "after" is three runs. Ranges are min–max
across runs, both window kinds (time and count):

| Window, push size  | Before (median) | After (median) | Compacting pushes | After (max) | After (max without GC) |
| ------------------ | --------------- | -------------- | ----------------- | ----------- | ---------------------- |
| 50k events, 160    | 45–53           | 0.07–0.12      | 0.7–1.1           | 8–11        | 1.0–1.7                |
| 100k events, 160   | 53–75           | 0.08–0.09      | 1.2–5.0           | 8–48        | 1.8–7.1                |
| 50k events, 1,600  | 478–507         | 0.8–1.9        | 1.4–3.0 (\*)      | 8–14        | 1.6–3.0                |
| 100k events, 1,600 | 503–680         | 0.8–1.7        | 1.9–3.6           | 9–63        | 2.6–4.9                |
| 1M events, 1,600   | —               | 0.8–1.3        | 11–19 (†)         | —           | —                      |

(\*) Plus two compacting pushes a GC pause overlapped, 7.6 and 7.8 ms.
(†) A scratch probe, not the script: 16 of 18 compacting pushes over nine
runs took 11–19 ms, the other two 27 and 30 ms. At 1M events GC pauses
are far bigger than that (one run's max was 394 ms, 393 of it GC).

"Max without GC" is the slowest push that no GC pause overlapped
(`PerformanceObserver` on `'gc'`); every slower push in those rows
overlapped a GC pause. A view creates an `Event` per arriving row and keeps a
window of them, which is what the collector walks; the old code allocated
the same Events. Smaller windows got faster too: at 10k events, 4.4–5.3 →
0.8–0.9 ms a 1,600-row push into a time window; 1k-event windows are
within noise. The 50k column read measured 4.6–5.5 ms before and 2.5–3.3
after; the read walks the same events either way, and I have not looked
into why it measured faster, so read it only as "not slower".

**Why this shape.** It is the `#frontIdx` pattern already used by
`LiveRollingAggregation` and the fused rolling paths, so no new vocabulary.
Alternatives set aside:

- Evict once per push (listen to `'batch'`) instead of per event. Cheaper
  still, but a view's `'event'` listeners would then see it over-full in
  the middle of a batch, which changes what they observe.
- Trim before every read instead of indexing from the marker. Fewer lines
  touched, but a frame's `column()` read would then pay an O(window)
  `splice` on top of its O(window) gather.
- Compact with `copyWithin` or a copy loop instead of `splice`. On a
  compacting push at 100k events `splice` won every paired run; medians
  2.1 ms vs 4.1 for a copy loop and 8.3 for `copyWithin` (20, 20 and 18
  pushes over two probes).

**Trade-offs kept.** The array holds up to 2× the window's slots between
compactions, but only the window's Events stay alive: a 100k-event view
holds 20.5 MB vs 19.3 MB before (`node --expose-gc` probe). The first
version (239977b) left evicted Events in their slots until the next
compaction, 21–39 MB for the same view; the Layer 2 review caught it.
`dispose()` leaves the buffer as it is: compacting there would shift the
array under a `find` predicate that disposes mid-scan (it did, briefly, in
5e78882), and the slots it would free are already empty. The compacting
push is O(window), about one 16 ms frame at a 1M-event window, once per
million events. Reads (`keyColumn()`
/ `column()` / `toTimeSeries()`) still walk every event: 64 ms at 600k rows
in Node, 4 ms a frame at 60k points in the browser. That cost is
[PND-COLOUT]'s and [PND-LSNAP]'s to cut, not this task's. A view on a
retention-capped source also pays [PND-LVMIRROR], found while
benchmarking this.

**Source:** offscreen-stream spike §4 (#760). Before the fix, evicting with
`this.#events.splice(0, count)` on every arriving event took 98% of a
50k-event window's profile, and one 16 ms push cost 24–34 ms at 10k
ticks/s and 271–326 ms at 100k (spike `results/node.txt` section 3,
`results/node-window-reruns.txt`). In the browser (cloud) the `view`
pipeline at 10k ticks/s with a 100k-point window took in 1,846 of 10,000
ticks a second and drew no frame.

### [PND-LVCHAIN] — Views chained after a window view never evict

**Source:** found while building the [PND-LVWIN] fix (2026-10-15). A
`LiveView` mirrors its source's evictions by listening to the source's
`'evict'` event (`live-view.ts:200-214`). A window view drops events in
`#applyEviction` (`live-view.ts:730-736`), which never emits `'evict'`; it
emits only when mirroring its own source. So a child of a window view
(`live.window('1m').filter(p)`, `.map(f)`, `.select(…)`) hears nothing
when events leave the window, and keeps every event it was ever given. A
retention-capped source doesn't help: by the time the source evicts an
event, the window has already dropped it, so the window view finds
nothing to mirror and emits nothing either.

Checked against `dist` built from `main`: a `LiveSeries` with
`retention: { maxAge: '1m' }`, `w = live.window('1s')`,
`f = w.filter(() => true)`, 10,000 events 10 ms apart: `w.length` 101,
`f.length` 10,000; `w.eventRate()` 101, `f.eventRate()` 10,000. The
pattern is meant to work (`LiveView.window-count-rate.test.ts:164-188`
tests `window('1m').filter(…).eventRate()`), but that test pushes three
events, none old enough to leave the window.

Fix to consider: have window eviction emit `'evict'` with the dropped
events (a slice only when a listener is attached). That changes what a
window view's `'evict'` listeners see (today they fire only for mirrored
source evictions), so it needs a CHANGELOG `Changed` line. The other
option, documenting `filter().window()` as the only safe order, leaves the
existing test's pattern broken.

### [PND-LVMIRROR] — A view makes its source build Events for every retention eviction

**Source:** found while benchmarking [PND-LVWIN] (#761, 2026-10-15). Every
`LiveView` subscribes to its source's `'evict'` so it can mirror retention
(`live-view.ts`, the `EMITS_EVICT` block in the constructor). It reads only
`evicted[evicted.length - 1].begin()`. But `LiveSeries.#applyRetention`
skips building Events only when no `'evict'` listener is attached
(`#onEvict.size === 0` → `dropPrefix`); with one, it calls `evictPrefix`,
which builds an `Event` per dropped row from the chunked columns.

Measured in Node (median ms per push; scratch probe on the 5ecbd26 build,
filled to 2.2× the window so retention is dropping rows; three runs of two
reps):

| Setup                                      | 50k window, 1,600 a push | 100k window, 160 a push |
| ------------------------------------------ | ------------------------ | ----------------------- |
| no view, retention 2× the window           | 0.28–0.51                | 0.033–0.063             |
| same + a bare `live.on('evict', () => {})` | 0.88–1.83                | 0.094–0.12              |
| time window view, no retention             | 0.81–1.26                | 0.083–0.18              |
| time window view, retention 2× the window  | 1.62–1.94                | 0.16–0.19               |

Paired within a rep, retention adds 0.7–1.0 ms a push to a window view at
1,600 a push (0.01–0.1 at 160), and a bare listener on a source with no
view adds 0.4–1.6 (0.03–0.07): the same order, as expected if the cost is
the listener rather than the window. An earlier probe on an interim build
(`copyWithin` compaction) put the view's share at 1.8–2.3 ms; superseded.

So a windowed chart over a retention-capped source pays about as much for
the mirror as for the window itself at 100k ticks/s. Fix to consider: let a
view hear just the cutoff timestamp (an internal channel next to
`'evict'`), so the source builds Events only for listeners that want them.
Relates to [PND-CHANGE]'s eviction channel and [PND-LVCHAIN] (same
listener).

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
