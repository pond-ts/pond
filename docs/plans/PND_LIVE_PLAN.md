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

Plain views used to be worse than "does not re-flow" (found 2026-10-27
writing the pond-rs live fixture, case `partition-apply-and-retention`): on
an `ordering: 'reorder'` source, a late event the source accepted made every
`LiveView` built on it (even `filter(() => true)`) throw "processed event
has key … older than the previous tail", so `push` threw after the source
had already stored the event, and the source held it while the views did
not. **Fixed 2026-10-28** with pond-rs R3 step 3 (pjm17971 chose insert in
order over stateful views skipping it or refusing the push):
`#appendChecked` inserts an out-of-order event at its key position, after
equal keys, instead of throwing. Stateful views (`diff`, `rate`,
`pctChange`, `fill`, `cumulative`, `sample`) still work in arrival order,
so their value for a late event (and for the event after it) is computed
against the previous arrival, not the previous time; order-free folds
(cumulative sum / count / max / min) end up right. A re-keying `map` whose
output goes backwards, which threw since PR #125 to protect the
binary-search queries, now inserts in order too, which also keeps those
queries right. Fixture case `views-reorder-late` pins it for both
libraries. Still open under [PND-LATE]: recomputing the rows after a late
event in stateful views and in rolling windows.

### [PND-REDUCEMICRO] — done 2026-10-28

Found timing pond-rs R3 step 4 against pond-ts: `live.reduce` on a
`maxEvents: 10_000` series, 1M pushes in a plain loop, took 12.6 s, and
each repeat in the same process got slower (5.2, 5.7, 9.7, 9.0 s), with
~455 MB more held after every run. The [PND-REDUCETICK] fix flushed the
emission from the end-of-push hook, and that flush cleared the "backstop
microtask queued" flag, so the next push queued another one: a loop that
never yields queued one microtask per push, each holding the reduce (and
its emitted events) until the loop ended. Fix: only the microtask clears
the flag, so a loop queues one. Outputs unchanged (the backstop finds
nothing pending after a settle flush; fixture unchanged). 1M pushes, four
runs in one process: 5.2 / 5.7 / 9.7 / 9.0 s -> 4.4 / 4.3 / 4.5 / 4.3 s;
the bench case 12.6 -> 6.4 s (its seven runs never yield, so each run's
reduce is still held by its one queued microtask until the end). Test:
`test/live/reducetick.test.ts` counts `queueMicrotask` calls.

### [PND-EVICTSPLICE] — done 2026-10-28

Found timing pond-rs R3 step 3 against pond-ts: views on a
`maxEvents: 10_000` series took ~38 µs a push each (three `diff`-style views
on 1M pushes: 115 s). Every per-event buffer dropped its oldest events with
`splice(0, n)`, and V8 copies the whole remaining array for that (~20 µs at
10k events), where `shift()` moves the array's start in place. Same cost in
the row backing of `drop` / `reorder` roots with retention and in rolling
history. Fix: `removeFront` / `dropFront` (`src/live/array-front.ts`) shift
when under a quarter of the buffer goes and the buffer is at most 16k items,
else splice (one item: shift). The first version shifted at any size; the
Layer 2 review on #840 found that past ~16k items (V8's large-object space)
each `shift()` copies the whole array, so a 20k burst from a 1M buffer took
33 s against 14 ms for one splice. Large buffers still copy on every
eviction either way: [PND-EVICTDEQUE]. 100k pushes,
`maxEvents` 10k: reorder root 2.36 s -> 31 ms, root + filter view 2.26 s ->
164 ms, root + 3 diff views 5.66 s -> 247 ms; strict root alone and no
retention unchanged (`scripts/perf-live-evict.mjs`). Not changed: the
rolling buffers' `splice(0, frontIdx)` (already amortized by a front index)
and the chunked store's small `#pending` array.

### [PND-BATCHATOM] — done 2026-10-27

Found by the pond-rs live fixture (R3 step 1, cases `series-drop-late` /
`series-reorder`): on the per-row backing (`drop`, `reorder`, and non-time
keys under `strict`) `pushMany` validated and inserted row by row, so a bad
row threw after the earlier rows were committed and their `'event'`s fired,
and retention / `'batch'` / `'evict'` never ran for them (`maxEvents: 2`
held 4 rows). pjm17971 chose to fix pond-ts rather than have pond-rs copy
it. Fix: validate every row, then dry-run the ordering policy over the
batch (`#checkOrder`, tracking the latest key as the inserts would), then
commit. Error messages are unchanged; batches with no bad row behave as
before; 200k rows in 1k batches measured the same before and after (within
run-to-run noise, ~66-80 ms). `_pushTrustedEvents` gets the same order
check.

### [PND-LIVEPUSHSCAN] — done 2026-10-27

Found timing pond-rs R3 step 2 against pond-ts: one-at-a-time `push` on a
`strict` time-keyed series got slower as the series grew (10k pushes 0.15 s,
50k 5.1 s, 100k 18.6 s; 1M would take most of an hour). Each `push` adds a
one-row chunk to the chunked backing, and the order check reads the last
row through `#locate`, which walked every chunk from the front. Fix:
`#locate` walks from the nearer end, so the newest rows are found at once
(10k 0.07 s, 50k 0.18 s, 100k 0.21 s). Not changed: one chunk per `push`
still costs an object per row; coalescing small pushes into the pending tier
(as partition routing does) would cut that, not measured.

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

### [PND-REDUCETICK] — `live.reduce` output count depends on where the caller awaits — **fixed 2026-10-25**

Found 2026-10-25 by a review of the pond-rs R3 plan, reproduced on main
(9bf0b1d). `LiveReduce` emits from a `queueMicrotask` (`live-reduce.ts`
`#ingest` / `#flushPendingEmit`) so its output reflects the buffer after
retention. Side effect: pushes with no `await` between them share one
emission.

| calls (sum reducer)                     | outputs             |
| --------------------------------------- | ------------------- |
| `push` ×3 (values 1, 2, 3), no `await`  | 6                   |
| `push` ×3, `await` after each           | 1, 3, 6             |
| `count(2)`, `push` ×4 (1..4), no await  | 10, 10              |
| `count(2)`, `push` ×4, await after each | 3, 10               |
| `count(2)`, `pushMany` of 4             | 10, 10 (documented) |

The class doc says "each individual `push()` is one row → one emission",
so the first and third rows are a bug: the output depends on the caller's
code layout, not on the data. It is the only deferred output in `live/`.
Proposed fix: emit at the end of each `push` / `pushMany` call, after
retention and `'evict'`, through an internal "push finished" hook on
`LiveSeries` instead of a microtask. Behaviour change for callers who push
several times without awaiting (they get one output per push again). The
pond-rs live layer ([PND-RUST-R3]) waits on this for `reduce` parity.

**Outcome (2026-10-25, pjm17971 said "fix it").** `LiveSeries` got an
internal end-of-push hook (`_onSettle`, `src/live/settle.ts`): it fires once
per push from the outermost re-entrancy guard, after `'evict'`, while still
guarded, so a push made by a settle listener is queued like any re-entrant
push. `LiveView`, `LiveAggregation`, `LiveRollingAggregation` and
`LiveReduce` forward it to their source, so a reduce over a view (or a view
over an aggregation) reaches the root series. `LiveReduce` flushes its
pending emission there. Kept, deliberately: the construction-replay
emission stays on a microtask (listeners attach after the constructor
returns, so a synchronous emit would reach nobody), and a custom
`LiveSource` without the hook falls back to the microtask. `count(n)` over
one `pushMany` still emits floor(K / n) copies of the post-push value
(documented; per-row values are not available after retention). Not
changed: `LiveFusedRolling` and partitioned sources don't forward the hook,
since neither is a `reduce` source today. Tests: `test/live/reducetick.test.ts`.

### [PND-REDUCETRIM] — `live.reduce` over a view drifted from what the view holds — **fixed 2026-10-29**

Found by a Codex review of pond-rs (2026-10-29, findings R01 and R02);
both were pond-ts behaviour that pond-rs had copied, and the live replay
fixture pinned them (`reduce-and-rolling-reorder`: "one on a window view
never hears of what the window trims").

- **Window trims (R01).** A `window` view trims itself silently (no
  `'evict'`), so a reduce on it never removed what it trimmed:
  `window(2).reduce({ s: sum, n: count })` after pushing 1, 2, 3 gave
  6 / 3, not 5 / 2, and `bufferSize` grew without bound.
- **Reorder through a view (R02).** `LiveReduce` picks "remove any event"
  reducer states only when its own source reports `_evictionOrder:
'sorted'`, which only `LiveSeries` did. A view of a `reorder` series
  evicts the key-order prefix too (it mirrors the root), so a reduce on it
  corrupted `min` / `max` / `first` / `last`: reorder root with
  `maxEvents: 2`, `filter`, `reduce(max, last)`, push (1000, 10),
  (2000, 20), (500, 100) gave max `undefined`, last 100, not 20 / 20.

**Outcome.** `LiveView` has an internal `_onTrim` channel: when a reduce
listens, a window trim hands over what it dropped, after the `'event'` that
caused it (so a late event trimmed on arrival is added, then removed, under
the same index). Views built on the window still keep what it trimmed and
see no `'evict'`, as before. `LiveView` and `LiveRollingAggregation`
forward their source's `_evictionOrder`. pond-rs mirrors both: the owner
hands a view's event on, then trims it (`trim_view`, the reduces built on
it removing the cells first), and `reduce` walks up through views to the
nearest series for its ordering. Known gap left: a pond-ts `map` that
re-keys events out of order still reports its source's order (pond-rs has
no re-keying map). Tests: `test/live/reducetrim.test.ts`, three pond-rs
unit tests in `live/tests.rs`, live replay case `reduce-on-window`, and the
`reduce-and-rolling-reorder` case regenerated.

### [PND-LIVELABEL] / [PND-MAPGAP] — live schema checks — **fixed 2026-10-29**

Codex review of pond-rs, R03 and R04, both shared with pond-ts. A live
interval-keyed series never checked label types (pond-rs checked each row
only against the events held), so a mixed batch was stored and every later
snapshot threw; now the whole batch is checked against the held events
before anything is stored (`#checkLabels`). A live `map` kept its source's
`required` flags although the mapping may return a gap (a non-finite number
becomes one), so the push worked and each snapshot threw; now every value
column of a `map` view is optional. Chosen over refusing the gap at push
time, which would throw inside a push after the root stored the row.
Tests: `test/live/livelabel.test.ts`, `test/live/mapgap.test.ts`, pond-rs
`live/tests.rs`.

### [PND-LPUSHCOL] — Column push into `LiveSeries`: `pushSeries` — **shipped 2026-11-01**

**Source:** the offscreen-stream spike (PR #760): `pushMany` takes rows only,
and its per-row check made 100k ticks cost 17-23 ms where
`TimeSeries.fromColumns` takes about 1 ms. Peter approved starting the work
2026-10-31.

**What shipped.** `live.pushSeries(ts: TimeSeries<S>)`. Column data comes in
through the existing door: `live.pushSeries(TimeSeries.fromColumns({...}))`.
Follows `pushMany`'s rules for the batch's rows. On the chunked backing
(top-level `strict` + `time` key) the batch's own key and value columns are
re-wrapped against the live schema (`ColumnarStore.fromTrustedStore`, O(C), no
row read) and committed through `#commitChunk`; on the per-row backings the
store becomes `Event`s (`materializeEventsFromStore`, which now builds
`Interval` keys too) and runs pushMany's row loop, moved unchanged into
`#commitPerRow`. Matching follows pond-rs `push_series`: same key kind (key
name may differ), value columns by name in any order with the same kind, no
missing or extra column, `required` judged by the live schema (the batch's own
flag proves nothing: `fromColumns` doesn't enforce it, [PND-COLSREQ]), shape
checked even on an empty batch.

**Measured** (`scripts/perf-live-push-series.mjs`, 100k rows, middle of three
runs, 4-core Linux, Node 22.22, 2026-11-01, build 58d75170, before the review
fixes; pushSeries includes `fromColumns`):

| Case                                  | pushMany | pushSeries | fromColumns alone |
| ------------------------------------- | -------- | ---------- | ----------------- |
| 1,600 rows/push                       | 18.7     | 1.6        | 1.1               |
| one 100k push                         | 14.7     | 0.9        | 0.9               |
| 1,600/push, maxEvents 10k             | 17.4     | 1.2        | 0.9               |
| 1,600/push, maxAge                    | 18.3     | 5.6        | 1.4               |
| 16 rows/push                          | 56.1     | 21.2       | 12.1              |
| 1 row/push                            | 359      | 436        | 182               |
| 'event' listener, 1,600/push          | 48.0     | 33.0       | 0.9               |
| window(1000) view, 1,600/push         | 72.0     | 52.7       | 0.9               |
| partitionBy host (100), 1,600/push    | 87.7     | 62.6       | 4.3               |
| drop, 1,600/push                      | 69.3     | 62.4       | 1.2               |
| reorder grace 5s, 1,600/push          | 71.3     | 68.1       | 1.1               |
| timeRange key, 1,600/push             | 82.2     | 82.5       | 1.4               |
| + host string column, 1,600/push      | 25.5     | 4.4        | 4.2               |
| `.slice()` each column first, 1,600   | 15.2     | 2.4        | 2.5               |
| `.slice()` each column first, 16/push | 49.1     | 42.9       | — (\*)            |

(\*) 61–97 ms across the three runs, more than the `pushSeries` time that
includes it: garbage left by the scenario before it, since the script doesn't
force a collection between samples. Not a real floor.

After the Layer 2 review (below), the final build (5a16db27) and 58d75170 ran
three times each, alternating, so both builds saw the same machine state. The
two builds' `pushSeries` ranges overlapped on 16 of the 21 rows. Of the other
five, the final build was faster on three (`drop`, `reorder`, `.slice()` first
at 1,600/push; 6–10%, not explained by the change, so likely drift) and slower
on two: 100k empty calls (about 8 ns more per call) and the new scenario,
1,600-row `slice()`s of one 100k series, which `pushSeries` now copies:
1.5–1.7 ms against 0.33–0.51 before the copy (`pushMany` 17.5–22.0). One row at
a time the two builds matched (383–453 against 366–443 ms; `pushMany` faster in
5 of the 6 runs, middle ratio 1.1×). Two sequential sets of runs before this
(final build 456–478, the earlier build 395–423) had suggested the fix cost
~10% there; alternating the builds showed that was drift between sessions. The
docs table uses the final build's alternating runs.

Retained heap for a full 100k window is the same both ways (8.4 MB heap,
2.3 MB array buffers); pushing views into a buffer twice the batch's size
doubles the array buffers held (4.6 MB), as documented. Seeding a live
series with `history.slice(-100)` of a 1M-row history and letting the
history go left 22.9 MB of array buffers alive before the review fix and
0.1 MB after (`--heap=slice`). `perf-live-columnar.mjs`
before/after (main a363dc63 vs branch, three runs each) moved by no more than
run-to-run noise (chunked with an `'event'` listener: 160-164 vs 157-172 ms).

**Decisions and why.**

- **A `TimeSeries`, not raw columns** (`pushColumns` rejected). `fromColumns`
  stays the one door that turns typed arrays into a series, so adoption, gap
  and ordering rules live in one place; pond-rs has the same shape
  (`push_series`, and it turned down `push_columns`); the most a raw-columns
  method could save over `pushSeries(fromColumns(...))` is `fromColumns`' own
  cost, ~2 µs per call (`fromColumns` alone at one row per push, 172–212 ms
  per 100k calls across both builds' alternating runs). Shipping both would be two verbs for one thing.
- **Share the batch's buffers, don't copy.** Pond never writes a column
  buffer; the caller is the only possible writer, which is the contract
  `fromColumns` already documents. A defensive copy (the `.slice()` rows
  above) costs 1.5× the shared path at 1,600/push and 2× at 16/push. Callers
  who pool buffers push `buf.slice(0, n)`; the JSDoc and docs say so.
- **Except a batch that would keep a much bigger buffer alive** (Layer 2
  review). `TimeSeries.slice()` returns views into its parent's buffers, so
  keeping a slice kept the whole parent. A batch whose key sits in a buffer
  more than twice the size of all its columns is now copied first (number
  columns and the key with one `slice` each, other kinds by gather; a per-row
  gather for everything measured 7.4 ms against 2.0–2.8 for this per 100k
  rows, in a scratch probe). Views into a buffer about the batch's size, such
  as one worker message holding every column, are still kept. The check reads
  the key's `.buffer`, which costs about 1 µs the first time it is read on a
  fresh typed array (1M fresh arrays of up to 8 numbers: ~1 µs each with the
  read, ~0.05 µs without): noise at 1,600 rows a push, about 10–20% on one-row
  pushes made from fresh arrays (100k one-row batches, the two builds
  alternating, medians of 7: 436–464 ms before, 505–530 after), which the docs
  already steer to `push`. Reusing the same arrays every push it is about
  2–11% (medians 379–417 ms before, 412–424 after; +11%, +2%, +9% pair by
  pair). Always copying batches of up to 8 rows instead measured 576–607 in an
  earlier sequential session, no better than the check in that session
  (532–625).
- **Per-row backings accept the batch** rather than refusing it: the method
  then works in every ordering mode and key kind (as pond-rs's does), at
  `pushMany`'s speed.
- **Required-gap errors name the first bad row**, scanning the required
  columns in row order as `pushMany` does (review finding; the message now
  matches `pushMany`'s on the chunked backing, `pushMany`'s per-row backings
  word it differently).
- **No order re-scan of the batch on the chunked path.** A `TimeSeries` is
  sorted (checked when built); a scan only guards against a caller writing an
  adopted key buffer between `fromColumns` and the push, and no scan can catch
  a write after it. It was measured at ~0.18 ms per 100k, about a tenth of the
  fast path. Left as a question for Peter.
- **Noted, not built:** [PND-ONCHUNKISO] (a partition router error skips the
  source's retention on the chunked backing; `pushSeries` matches `pushMany`
  there, pinned by a test that will keep passing either way it is fixed),
  [PND-AGESCAN] (the maxAge row above), [PND-RSPUSHSERIES], [PND-PUSHTIME],
  [PND-COLSTYPED], [PND-LIVEFASTDROP], [PND-CLAMPHINT]; see PLAN.md.

Supersedes the 2026-06 columnar-arc assessment's "keep `pushColumns` dead (no
wire-batching producer yet)" (`docs/notes/columnar-arc-assessment-2026-06.md`).
Tests: `test/live/LiveSeries.pushSeries.test.ts` (differential vs `pushMany`
over 8 configurations × 3 retentions × with/without listeners, 40 seeds each,
plus targeted cases; 12 of 12 planted bugs caught, and 6 of 6 more for the
review fixes),
`test-d/live-push-series.test-d.ts`, `live-chunked-storage.test.ts`.

### [PND-ONCHUNKISO] — A partition error on a default series skips the source's own push steps

**Found** 2026-10-31 designing [PND-LPUSHCOL]. On the chunked backing,
`#commitChunk` calls its `_onChunk` consumers (the partition router) with no
`try`, after the chunk is stored and counted. A router throw (a row for a
group a typed `partitionBy` doesn't declare, or a partition listener's error
that `_stageRowsClose` rethrows) escapes there, so the source skips its own
`'event'`, retention, `'batch'` and `'evict'`: 5 rows pushed into a
`maxEvents: 2` source are all kept, with no `'batch'` or `'evict'`. The
per-row backing, where the router is an ordinary `'event'` listener, finishes
the push and then throws. `pushSeries` and `pushMany` behave the same here
(pinned by a test that keeps passing whichever fix lands).

**Two fixes.** (a) Finish, then throw: isolate each `_onChunk` call like a
listener and rethrow the first error at the end, as the per-row backing does
(about 15 lines in `#commitChunk`; drafted in the authoring session, not
committed). (b) Refuse the whole batch before storing anything, as pond-rs's
`check_partitions` does. Either changes what the live parity fixture
(`packages/core/scripts/parity/live.mjs`) records, and three bridge harnesses
read that fixture, so the fix lands with their updates. Waiting on Peter's
pick.

### [PND-LATCACHE] — Reading every row with `at()` slows later pushes until retention drops those rows

**Found** 2026-11-01 while re-measuring [PND-LVWIN]. On the chunked backing
`at(i)` builds an `Event` and caches it in a `Map` keyed by row index, so
`at(i) === at(i)`. Each retention eviction remaps that cache by building a
new `Map` of every cached entry (`#shiftCacheBy` in
`live-chunked-storage.ts`), so with a full cache every push pays for the
whole cache until retention has dropped the cached rows. A new `LiveView`
fills itself by calling `source.at(i)` for every row the source holds, so
building a view over a big series is enough to set it off.

Measured on main (a363dc63, Node 22, one run; `maxEvents: 200_000`, 130
pushes of 1,600 first, then every row read with `at()`): pushes before the
read 0.29 ms (median); the next 50 pushes 47 ms; the 50 after 19 ms; the 100
after that 0.22 ms. With no retention the read leaves pushes at 0.28 ms, and
with no read they stay at 0.21–0.23 ms. Building a `window(1)` view
mid-stream on a 200k-row series with no other view put the next 100 pushes
at 21–23 ms (median) on both main and the [PND-LVWIN] build, and the 100
after at 1.6 ms. Fix to consider: remap only the entries that
survive (most are dropped, oldest first), drop the cache on eviction, or let
a view fill itself without going through the cache.

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
