# offscreen-stream — report

**Question.** Can a pond chart of live market data hold 120 fps when a
WebSocket pushes ticks every 16 ms, the ticks are appended to a
`LiveSeries` in a Web Worker, and the chart is drawn there onto an
`OffscreenCanvas`? And how far does very-high-rate streaming into a
browser go?

**Answer.** Yes, and the worker does what it promises: on a busy page the
chart keeps 120 fps while the page itself drops to 69. But the thread is
not what decides the frame rate. **How the chart turns points into pixels
decides it**, and so does **how the chart gets its data out of the
`LiveSeries`**. With the right drawing method, 1 million ticks a second
with 16 million points in view draws in under half a millisecond a frame.
With the method pond uses today, 120 fps ends at about a million points in
view, and the public way to read a `LiveSeries` into a chart cannot keep
up at even 60k points.

Numbers below are from two places, and they answer different questions:

- **Peter's MacBook Pro** (M1 Pro, 32 GB, built-in 120 Hz ProMotion
  display, Chrome 155, headed): the only place frame rates mean anything.
  [`results/mac-m1pro-120hz.txt`](results/mac-m1pro-120hz.txt).
- **A cloud container** (4 shared cores, headless Chromium capped at
  60 Hz): good for comparing **milliseconds of work per frame** between
  setups, not for frame rates. Its worker frame rate wobbles around 50
  even at 0.7 ms of work a frame. Why wasn't investigated; the test
  server, the harness and the browser share the 4 cores.
  [`results/capped.txt`](results/capped.txt) (+ `.json`).

## What was built

```
server.mjs ── WebSocket, binary frames every 16 ms ──▶ worker.ts
  synthetic tape: price random walk,                     engine.ts:
  ticks spread evenly across each frame,                   ingest  → LiveSeries (or a plain buffer)
  rate exact over time, history first                      draw    → OffscreenCanvas, every animation frame
                                                         page (main.ts) gets one stats object a second
```

The same `engine.ts` runs in the worker or on the page, so "worker vs main
thread" compares identical code. Three choices are switchable:

- **Pipeline** (how ticks get to the chart):
  - `raw`: straight into a typed buffer, no pond. This is the floor.
  - `chunk`: `LiveSeries.pushMany`, with every appended batch copied
    column by column into a typed buffer through `LiveSeries._onChunk`
    (an internal hook).
  - `snapshot`: `LiveSeries.pushMany`, then on each frame with new data
    the path a pond chart uses today, `live.toTimeSeries()` then
    `fromTimeSeries(ts, 'price')`.
- **Draw**:
  - `m4`: the real `@pond-ts/charts` line kernel (`drawLine` in
    `packages/charts/src/line.ts`). It trims the series to what's visible,
    then thins it to 4 points per pixel column before stroking.
  - `buckets`: new in the spike. Each tick is folded, as it arrives, into
    one bucket per pixel column of the window, keeping the bucket's
    first, lowest, highest and last price. A frame draws one line through
    the buckets. Same picture as `m4`; the work moves from every frame to
    each arrival.
- **Busy page**: the page thread spins for 20 or 40 ms of every 50 ms,
  standing in for a heavy app.

The chart scrolls smoothly: its right edge is the newest tick's time plus
the time since it arrived, so the tape moves every frame even though data
lands every 16 ms.

## 1. On a busy page, the worker keeps the chart at 120 fps

Mac, 100k ticks/s, 10 s window (~1M points in view), `chunk` pipeline.

| draw    | page busy | chart fps (worker) | chart fps (main thread) | page fps | data → screen delay, worker / main |
| ------- | --------- | ------------------ | ----------------------- | -------- | ---------------------------------- |
| m4      | 0         | 120                | 120                     | 120      | 14 / 14 ms                         |
| m4      | 20/50 ms  | 120                | 100                     | 100      | 14 / 15 ms                         |
| m4      | 40/50 ms  | **120**            | **35**                  | 69 / 35  | 14 / **60** ms                     |
| buckets | 40/50 ms  | **120**            | **60**                  | 60       | 10 / 32 ms                         |

On the main thread the chart can only draw when the page lets it, so it
falls to the page's own rate. In the worker it doesn't notice. The delay
from tick to screen also stays put in the worker (14 ms, which includes up
to 16 ms of the server batching ticks) while on the main thread it grows:
the WebSocket messages arrive on the same thread as the busy work and wait
for it.

The cloud run shows what happens when the main thread is overloaded
rather than just busy: with 40 of every 50 ms taken plus ~13 ms of drawing
a frame, there isn't enough thread left to take the ticks in as fast as
they come, and the screen falls seconds behind: 3 s at 20/50 and 10 s at
40/50 (`m4`), 8.6 s at 40/50 (`buckets`). In the worker the same setups
stayed at 10–26 ms.

One Mac row doesn't fit: main thread, `buckets`, busy 20/50 reports the
page at 120 fps with no frame over 9 ms, yet the chart's slowest 5% of
frames took 22 ms. Either the busy load didn't run in that sample or the
page meter missed it. Not investigated; the busy 40/50 row next to it
behaves as expected.

## 2. The drawing method decides the ceiling, not the thread

Mac, worker, `raw` pipeline (no pond ingest cost), quiet page.

| ticks/s | window | points in view | m4 fps | m4 work/frame | buckets fps | buckets work/frame |
| ------- | ------ | -------------- | ------ | ------------- | ----------- | ------------------ |
| 1k      | 5 min  | 300k           | 120    | 2.3 ms        | 120         | 0.43 ms            |
| 10k     | 1 min  | 600k           | 120    | 3.2 ms        | 120         | 0.45 ms            |
| 100k    | 10 s   | 1M             | 120    | 4.4 ms        | 120         | 0.42 ms            |
| 10k     | 5 min  | 3M             | **79** | 12 ms         | 120         | 0.39 ms            |
| 100k    | 1 min  | 5.2M / 5.9M    | **44** | 22 ms         | 120         | 0.40 ms            |
| 1M      | 10 s   | 4.3M / 8M      | **70** | 16 ms         | 120         | 0.20 ms            |
| 1M      | 1 min  | 16M            | —      | —             | 120         | 0.12 ms            |

(Point counts differ slightly between columns because runs ended at
different moments while the window was filling; see "Caveats".)

**Why m4 grows with the data.** `drawLine` thins the visible points into a
few per pixel, which is what keeps big static charts fast. The thinned
result is cached, keyed on the series and the x scale
(`packages/charts/src/decimate.ts:372-401`). A scrolling chart changes the
x scale every frame, so the cache never hits and every frame walks every
visible point again. That is fine up to about a million points at 120 fps
on an M1 Pro and not beyond. Each 120 fps frame has 8.3 ms.

**Why buckets don't.** A bucket is updated once per tick when the tick
arrives (a compare and a store), and a frame draws one point per pixel
column, ~2,300 on a Retina screen. So a frame costs the same at 10k points
or 16M, and memory doesn't grow with the window either: in `raw` +
`buckets` the spike keeps no tick buffer at all. The price is that the
buckets are fixed to one zoom level: zooming in, hovering a single tick or
changing the window needs the raw data, which the `chunk` pipeline still
keeps in the `LiveSeries`.

Every bucket row on the Mac held 120 fps, from 10k points to 16M.

## 3. Reading a LiveSeries into a chart: today's path can't stream

Cloud, worker, `snapshot` pipeline. "view" is the time spent turning the
`LiveSeries` into arrays the chart can draw, on each frame that had new
data.

| ticks/s | window | points | view per frame | chart fps |
| ------- | ------ | ------ | -------------- | --------- |
| 1k      | 10 s   | 10k    | 3.8 ms         | 50        |
| 1k      | 1 min  | 60k    | 27 ms          | 21        |
| 10k     | 10 s   | 100k   | 43 ms          | 19        |
| 1k      | 5 min  | 300k   | 159 ms         | 5         |
| 10k     | 1 min  | 600k   | 497 ms         | 2         |

The same data through `chunk` (kept as plain number arrays as it
arrives) costs **0.01 ms** for the view at every size.

**Why.** `LiveSeries` stores its data as columns (the chunked store), but
`toTimeSeries()` doesn't hand those columns over. It rebuilds the whole
series row by row: one array per tick, then a fresh `TimeSeries` that
checks every row again (`packages/core/src/live/live-chunked-storage.ts:366-391`).
The code says why: _"A columnar fast-path snapshot … is a deferred
follow-up; snapshot isn't the hot path."_ For a live chart it is the hot
path. Then `fromTimeSeries` copies the column out again one value at a
time (`packages/charts/src/data.ts:254-265`, which explains it avoids the
bulk reader because of a bundler problem).

React live charts haven't hit this because `useSnapshot` refreshes at most
every 100 ms by default (`packages/react/src/useSnapshot.ts:30,43`). That
caps them at 10 updates a second, well short of 120.

Node, same data, for scale: `toTimeSeries()` takes 553 ms at 600k rows;
copying the same chunks' columns straight into two `Float64Array`s, still
reading one value at a time, takes 14 ms. A real column hand-over would
be cheaper again.

## 4. Getting ticks into a LiveSeries costs about 10× the floor

Cloud, worker, 100k ticks/s: ingest takes **3 ms per second** in `raw`
and **34–42 ms per second** in `chunk`. On the Mac `chunk` costs 11–21 ms
per second. That's 1–4% of one core at 100k/s, affordable, but it's the
part of pond that scales with the tick rate.

Most of the gap is shape, not storage. The wire delivers columns (one
`Float64Array` per frame) but `pushMany` only takes rows, so the worker
builds one small array per tick (`src/engine.ts`, the `onmessage`
handler) and pond then takes them apart again into columns. Push
frequency matters too: at 100k/s, pushing every 4 ms costs 82 ms/s of
ingest against 32 ms/s every 50 ms (cloud `cadence` rows), so there's a
fixed cost per `pushMany` call as well as per tick. Pushing more often
buys lower delay (5 ms vs 31 ms from tick to screen).

## 5. Receiving: a thread busy drawing also receives slower

Observed, not explained: when the thread that owns the WebSocket spends
most of each frame drawing, ticks arrive more slowly than the server sends
them, and the chart falls behind. When frames are cheap, the same thread
takes the full rate.

- Mac, worker, `m4`, 1M ticks/s (24 MB/s): frames took 16 ms, the worker
  received 887k ticks/s instead of 1M, and the screen ran 0.4–0.6 s
  behind.
- Cloud, same setup, 73 ms frames: 123k ticks/s received, over a minute
  behind.
- With `buckets` (0.1–0.7 ms frames) both machines took the full 1M
  ticks/s, 11–15 ms behind (the cloud's 1-minute and 5-minute rows; its
  10 s row was still recovering from the history load when sampled).
- The server isn't the limit: a Node client received 6M ticks (144 MB)
  of history in 1.6 s.

So moving drawing into a worker doesn't help with receiving if the worker
itself is busy. Cheap frames help both. (Or a second worker that only
receives and passes data on; not tried here.)

The server stops sending to a client that falls more than 32 MB behind and
counts the ticks it skips. The first version held those ticks back and
sent them all at once later, which filled the queue again and stalled the
live feed for good after a large history load. That was a bug in the
spike's server, not in pond.

## What this means for pond

Library-actionable findings, roughly in order of payoff for live charts:

1. **A column hand-over from `LiveSeries` to charts.** Either a fast
   `toTimeSeries()` that passes the stored columns through instead of
   rebuilding rows, or a live column view a chart can read directly. This
   is the data side of the existing [PND-LIVELYR] task, and this spike
   gives it numbers: 497 ms vs 0.01 ms at 600k points.
2. **A streaming line/area draw mode** that folds ticks into per-pixel
   buckets as they arrive (`buckets` here), for scrolling live charts.
   It keeps 120 fps flat in rate and window. The existing M4 path stays
   for static, zoomed and hovered views.
3. **Columnar `pushMany`.** Accept a batch of columns (one typed array per
   column) so wire → `LiveSeries` doesn't allocate an array per tick.
4. **A worker render mode for charts** (the earlier discussion in this
   thread): draw kernels like `drawLine` aren't exported from
   `@pond-ts/charts`, and each chart type hands the canvas a function with
   its data baked in, which can't cross into a worker. The spike reached
   into `packages/charts/src` to get round both.
5. **`LiveSeries._onChunk` is internal.** The `chunk` pipeline needs a
   supported "here's what was just appended, as columns" event; today the
   public `'batch'` event creates an object per tick.
6. **A sharp edge in the M4 cache:** it's keyed on the identity of the
   series and the x scale (`decimate.ts:380-386`). Change a d3 scale's
   domain in place and keep the same series object, and the chart reuses
   a polyline thinned for the old domain. Charts always build new scales,
   so it doesn't bite there; the spike did change a scale in place at
   first (fixed, and the affected `snapshot` rows re-run). Worth a comment
   or a domain check before the kernels are exported.

## Caveats and what wasn't covered

- **One real machine, one browser.** 120 Hz was measured on one M1 Pro in
  Chrome. Safari and Firefox weren't run; the engine falls back to timers
  if a worker has no `requestAnimationFrame`, and that fallback wasn't
  exercised.
- **Cloud frame rates aren't trustworthy**, as above. Use the cloud for
  milliseconds of work and data rates only.
- **Windows weren't always full.** History sent up front is capped at 10M
  ticks (a 5-minute window at 1M/s would be 7 GB), so long windows at high
  rates show fewer points than rate × window. `buckets` cost doesn't
  depend on it; `m4` rows were capped at 10M points for the same reason.
- **Synthetic data, one line, no interaction.** No hover, tooltips,
  axes from `@pond-ts/charts`, or multiple series. A real worker mode has
  to answer hover against data that lives in the worker.
- **Delay is measured with one clock** (server and browser on the same
  machine) and includes up to 16 ms of batching on the server.
- **The `snapshot` rows stop at 600k points**: beyond that a frame takes
  seconds.
- **The `chunk` pipeline stops at 6M points** in the sweep, to keep the
  `LiveSeries` row memory in bounds on the cloud box.
