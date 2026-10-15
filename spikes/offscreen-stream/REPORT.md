# offscreen-stream — report

**Question.** Can a pond chart of live market data hold 120 fps when a
WebSocket pushes ticks every 16 ms, the ticks are appended to a
`LiveSeries` in a Web Worker, and the chart is drawn there onto an
`OffscreenCanvas`? And how far does very-high-rate streaming into a
browser go?

**Short answer.**

- **The worker does its job.** On a MacBook Pro with a 120 Hz screen, with
  the page busy 40 ms of every 50, the chart drawn in a worker held
  120 fps while the same chart drawn on the page thread fell to 35 (§1).
- **But the thread doesn't set the ceiling. Three parts of pond do**, and
  moving to a worker changes none of them:
  - **Drawing** (§2). pond's line drawing re-reads every visible point on
    every frame of a scrolling chart. On the M1 Pro it held 120 fps with
    1M points in view (4.4 ms a frame) and not with 3M (79 fps). The
    spike's alternative, "buckets", took 0.1–0.45 ms a frame at every size
    tried, up to 16M points in view.
  - **Reading data out of a `LiveSeries`** (§3, §4). Both public ways stop
    far short of that. `toTimeSeries()` rebuilds the series row by row:
    470 ms at 600k points. A `live.window()` view shifts its whole event
    list for every tick it drops: 34 ms per 16 ms batch at a 50k-tick
    window. The spike got past both only through an internal hook.
  - **Pushing ticks in** (§5). `pushMany` costs about 20 ms per 100k
    ticks, against about 1 ms to copy them into a plain array. Most of
    that is checking each row and making a `Time` object per tick. pond's
    existing column ingest takes the same ticks in about 1.2 ms.
- **The 1M ticks/s rows had no `LiveSeries` in them.** Every run at
  1M ticks/s is the `raw` pipeline (straight into a typed array). With a
  `LiveSeries` in the loop, see §5 for how far ingest goes.

Five library tasks come out of this, listed at the end and added to
[PLAN.md](../../PLAN.md).

## Where the numbers come from

- **A MacBook Pro** (M1 Pro, 32 GB, built-in 120 Hz ProMotion screen,
  Chrome 155, visible window): the only place frame rates mean anything.
  [`results/mac-m1pro-120hz.txt`](results/mac-m1pro-120hz.txt). These runs
  rendered at **1 device pixel per CSS pixel** (Playwright's default),
  not the screen's native 2. The plot was about 1,130 pixels wide.
- **A cloud container** (4 shared cores, headless Chromium, frames capped
  at 60 Hz): good for **milliseconds of work per frame** and data rates,
  not for frame rates. The test server, the bench and the browser share
  the 4 cores. Runs at 1× and 2× pixel density:
  [`results/cloud-dpr1.txt`](results/cloud-dpr1.txt),
  [`results/cloud-dpr2.txt`](results/cloud-dpr2.txt) (+ `.json`).
- **Node** for the pond-only costs, one script per figure:
  [`node-bench.mjs`](node-bench.mjs) →
  [`results/node.txt`](results/node.txt).

Each browser row: open the page, wait for the history to arrive, wait
until the chart is less than 1 s behind the feed (flagged
`NOT-CAUGHT-UP` if it never gets there within 60 s), settle 3 s, then
average every frame over 4 s. All figures in a row come from the same
frames.

**Delay** ("lat" in the result files) is the wall clock at the end of a
frame's drawing code minus the time of the newest tick drawn. The server
stamps the newest tick in each message with the time it sends it, so the
delay covers the network, waiting in the queue, ingest, the wait for the
next frame and the frame's own drawing. It does not include the browser
putting the frame on screen. Server and browser run on the same machine,
so there's one clock.

## What was built

```
server.mjs ── WebSocket, one binary message every 16 ms ──▶ worker.ts
  synthetic tape: price random walk,                        engine.ts:
  ticks spread evenly across each message,                    ingest → LiveSeries (or a plain buffer)
  rate exact over time, history first                         draw   → OffscreenCanvas, every animation frame
                                                            page (main.ts) gets one stats object a second
```

Each message is one `Float64Array` with the ticks interleaved:
`[sendTime, n, dropped, t0, price0, size0, t1, price1, …]`.

The same `engine.ts` runs in the worker or on the page, so "worker vs page
thread" compares identical code. The switches:

- **Pipeline** (how ticks get to the chart):
  - `raw`: straight into a typed buffer, no pond. The floor.
  - `chunk`: `LiveSeries.pushMany`, and every appended batch copied column
    by column into a typed buffer through `LiveSeries._onChunk`, an
    internal hook.
  - `snapshot`: `LiveSeries.pushMany`, then on each frame with new data,
    `live.toTimeSeries()` then `fromTimeSeries(ts, 'price')`: what a pond
    chart fed from a `LiveSeries` does today.
  - `view`: `LiveSeries.pushMany` with a `live.window('10s')`-style
    `LiveView` attached, read each frame through its public
    `keyColumn()` / `column('price')`.
- **Draw**:
  - `m4`: the real `@pond-ts/charts` line kernel (`drawLine`,
    `packages/charts/src/line.ts`). It trims to what's visible, thins to
    4 points per pixel column, then strokes.
  - `buckets`: new in the spike. Each tick is folded, as it arrives, into
    one bucket per pixel column of the window, which keeps the first,
    lowest, highest and last price. A frame draws one line through the
    buckets. Same picture as `m4`; the work moves from every frame to each
    tick's arrival.
- **Busy page**: the page thread spins for 20 or 40 ms of every 50 ms,
  standing in for a heavy app.

The chart's right edge is the newest tick's time plus the time since it
arrived, so the tape moves every frame even though data lands every 16 ms.

## 1. On a busy page, the worker keeps the chart at 120 fps

Mac, 100k ticks/s, 10 s window (~990k points in view), `chunk` pipeline.
"Busy" is ms of page work in every 50 ms.

| draw    | busy | chart fps, worker / page thread | page fps, worker run / page-thread run | delay, worker / page thread |
| ------- | ---- | ------------------------------- | -------------------------------------- | --------------------------- |
| m4      | 0    | 120 / 120                       | 120 / 120                              | 14 / 14 ms                  |
| m4      | 20   | 120 / 100                       | 100 / 100                              | 14 / 15 ms                  |
| m4      | 40   | **120 / 35**                    | 69 / 35                                | 14 / **60** ms              |
| buckets | 40   | **120 / 60**                    | 60 / 60                                | 10 / 32 ms                  |

On the page thread the chart can only draw when the page lets it, so it
drops to the page's own rate. In the worker it doesn't notice. The delay
from tick to screen also stays put in the worker, while on the page thread
it grows: the WebSocket messages arrive on the busy thread and wait their
turn.

The cloud run shows what happens when the page thread is overloaded
rather than just busy. There, an m4 frame at ~1M points takes 14–15 ms,
and with the page busy 40 of every 50 ms the page thread can't keep up
with both drawing and taking in ticks:

| draw    | busy | chart fps, worker / page thread | delay, worker / page thread     |
| ------- | ---- | ------------------------------- | ------------------------------- |
| m4      | 0    | 33 / 33                         | 29 / 54 ms                      |
| m4      | 20   | 35 / 20                         | 28 / 330 ms                     |
| m4      | 40   | 35 / **16**                     | 29 ms / **12 s, still growing** |
| buckets | 0    | 50 / 53                         | 11 / 27 ms                      |
| buckets | 20   | 49 / 32                         | 11 / 50 ms                      |
| buckets | 40   | 51 / **17**                     | 10 ms / **11 s, still growing** |

(Cloud, frame rate capped at 60 and noisy, see "Where the numbers come
from". The worker's frame rate here is the same busy or quiet; the
page-thread chart's drops with the page.)

One Mac row doesn't fit: page thread, `buckets`, busy 20 shows the page at
120 fps with no frame over 9 ms, yet the chart's slowest 5% of frames took
22 ms. Both meters run on the same thread there, so they should agree.
Not explained. The bench that produced it sampled the two meters over
different seconds and timed them with different clocks; both are fixed,
but the Mac wasn't re-run.

## 2. The drawing method decides the ceiling, not the thread

Mac, worker, `raw` pipeline (no `LiveSeries`), quiet page, 1 device pixel
per CSS pixel (about 1,130 pixel columns).

| ticks/s | window | points in view | m4 fps | m4 work/frame | buckets fps | buckets work/frame |
| ------- | ------ | -------------- | ------ | ------------- | ----------- | ------------------ |
| 1k      | 5 min  | 300k           | 120    | 2.3 ms        | 120         | 0.43 ms            |
| 10k     | 1 min  | 600k           | 120    | 3.2 ms        | 120         | 0.45 ms            |
| 100k    | 10 s   | 990k           | 120    | 4.4 ms        | 120         | 0.42 ms            |
| 10k     | 5 min  | 3.0M           | **79** | 12.1 ms       | 120         | 0.39 ms            |
| 100k    | 1 min  | 5.2M / 5.9M    | **44** | 22.3 ms       | 120         | 0.40 ms            |
| 1M      | 10 s   | 4.3M / 8.0M    | **70** | 15.5 ms       | 120         | 0.20 ms            |
| 100k    | 5 min  | 10.6M (35%)    | —      | —             | 120         | 0.26 ms            |
| 1M      | 1 min  | 16.0M (27%)    | —      | —             | 120         | 0.12 ms            |
| 1M      | 5 min  | 16.0M (5%)     | —      | —             | 120         | 0.09 ms            |

Where two point counts are given, the m4 and buckets runs had different
amounts of history in view when sampled. A percentage means the window
was only that full, because the history sent up front was capped at 10M
ticks; buckets then only had that share of the columns to draw, so those
three rows understate a full window. **Full-window bucket rows took
0.39–0.45 ms.** m4 wasn't run above 10M points.

**m4: 120 fps up to about 1M points, not at 3M.** Each 120 fps frame has
8.3 ms. m4's cost grows with the points in view at a steady ~3.5–4.5 ns a
point (4.4 ms at 990k, 12.1 ms at 3.0M, 22.3 ms at 5.2M), which puts the
limit around 2M points on this machine. That is arithmetic from these
rows, not a measured run.

**Why m4 grows with the data.** `drawLine` trims the series to what's
visible and thins it to a few points per pixel column, then caches the
result keyed on the series object and the x scale
(`packages/charts/src/decimate.ts:372-401`). On a scrolling chart both
change every frame (new ticks, a new time range), so the cache can't help
and every frame walks every visible point again. (The spike also scans
them once a frame for the y range; that's the "ext" figure in the result
files, about a tenth of the total.) That's fine for a still chart and
costly for one that moves every frame.

**Why buckets don't.** A bucket is updated once per tick when the tick
arrives (a compare and a store), and a frame draws one point per pixel
column. So a frame costs about the same at 10k points or 16M, and
`raw` + `buckets` keeps no tick buffer at all: memory doesn't grow with
the window either. The price is that the buckets are fixed to one zoom
level and one window. Zooming, panning or hovering a single tick needs the
raw data, which the `chunk` pipeline still keeps in the `LiveSeries`.

Bucket frame times also varied with the setup in ways not explained by
the drawing: in the §1 runs the same bucket chart took 0.36–0.38 ms on a
quiet page and 0.19–0.21 ms with the page busy. Not investigated; every
bucket row stayed under 0.5 ms, about 6% of a 120 fps frame.

<!-- CLOUD-DPR -->

## 3. Reading a `LiveSeries` into a chart: `toTimeSeries()` can't keep up

The path a pond chart uses today: on each frame with new data,
`live.toTimeSeries()` then `fromTimeSeries(ts, 'price')`. Cloud, worker,
`snapshot` pipeline. "Read" is the time to turn the `LiveSeries` into
arrays the chart can draw, on frames that had new data.

| ticks/s | window | points | read per frame | chart fps (cap 60) |
| ------- | ------ | ------ | -------------- | ------------------ |
| 1k      | 10 s   | 10k    | 4.0 ms         | 49                 |
| 1k      | 1 min  | 60k    | 27 ms          | 20                 |
| 10k     | 10 s   | 100k   | 52 ms          | 17                 |
| 1k      | 5 min  | 300k   | 182 ms         | 5                  |
| 10k     | 1 min  | 600k   | 362 ms         | 2                  |

The same data through `chunk` (copied into plain arrays as it arrives,
through the internal hook) costs **0.00–0.01 ms** to read at every size.
At 120 fps a frame has 8.3 ms in total, so this path is out of budget
somewhere between 10k and 60k points.

Node, one `LiveSeries` filled with N rows, time to get its time and price
columns out as two `Float64Array`s ([`results/node.txt`](results/node.txt)
section 1):

<!-- NODE-1 -->

**Why.** The `LiveSeries` already stores its data as columns, but
`toTimeSeries()` doesn't hand them over. It builds one array per row, then
a new `TimeSeries` that checks every row again
(`packages/core/src/live/live-chunked-storage.ts:366-390`). Its comment
says why: _"A columnar fast-path snapshot … is a deferred follow-up;
snapshot isn't the hot path."_ For a live chart it is the hot path. Then
`fromTimeSeries` copies the column out one value at a time
(`packages/charts/src/data.ts:236-263`), because the bulk reader gets
dropped by browser bundlers ([PND-COLAPI]).

React live charts already hit this. `useSnapshot` refreshes at most every
100 ms by default (`packages/react/src/useSnapshot.ts:30,43`), so at most
10 updates a second. An earlier benchmark against other chart libraries
measured pond's per-frame `toTimeSeries()` path at 31.6 fps with a
100k-point streaming window, where uPlot held 119
([PND-LIVELYR](../../docs/plans/PND_CHARTS_PLAN.md)).

## 4. A `live.window()` view costs more per tick the bigger the window

The other public route, a `LiveView` from `live.window(…)` read through
`keyColumn()` / `column()`, is cheap to read (third column above) but
expensive to keep up to date. It holds its window as a list of event
objects, and every arriving tick drops the oldest with
`events.splice(0, count)` (`packages/core/src/live/live-view.ts:181-187`,
`730-736`), which moves every remaining item down one place. So each tick
costs time in proportion to the window.

Node, one 160-tick push (100k ticks/s every 16 ms), steady state
([`results/node.txt`](results/node.txt) section 3):

<!-- NODE-3 -->

In the browser (cloud, worker, `view` pipeline) the cost lands in ingest,
and it climbs with the window, not the tick rate:

| ticks/s | window | points | ingest, ms per second | `chunk` ingest, same setup | read per frame | chart fps (cap 60) |
| ------- | ------ | ------ | --------------------- | -------------------------- | -------------- | ------------------ |
| 1k      | 10 s   | 10k    | 34                    | 9                          | 0.6 ms         | 56                 |
| 1k      | 1 min  | 60k    | 208                   | 12                         | 4.0 ms         | 39                 |
| 10k     | 10 s   | 100k   | **995**               | 10                         | —              | **0**              |

In the last row the worker spent the whole of every second taking in
ticks, got 1,846 of the 10,000 a second through, never filled its window,
and drew no frame during the sample. The sweep skips `view` above 100k
points for that reason.

## 5. Pushing ticks into a `LiveSeries` costs about 20× a plain copy

Ingest is the time the receiving thread spends on each WebSocket message:
reading the ticks out and getting them into the chart's data. Cloud,
worker, ms per second:

| ticks/s | `raw` (typed array, no pond) | `chunk` (`pushMany` + copy-out through the hook) |
| ------- | ---------------------------- | ------------------------------------------------ |
| 1k      | 1–2                          | 9–12                                             |
| 10k     | 1–2                          | 10–12                                            |
| 100k    | 3–4                          | 39–45                                            |
| 1M      | 17–22                        | 165 (at 500k received, see §6)                   |

On the Mac, `chunk` at 100k ticks/s cost 10–21 ms per second. That's 1–4%
of one core, affordable on its own, but it's the part of pond that grows
with the tick rate.

At 1k and 10k ticks/s the `chunk` cost hardly changes with the rate, so
most of it there is a fixed cost per message (62 messages a second, about
0.15 ms each), not per tick.

Node, cost per 100k ticks, by step ([`results/node.txt`](results/node.txt)
section 2):

<!-- NODE-2 -->

Building the row arrays is only about a tenth of it. A CPU profile of
`pushMany` (1,600-row batches) puts **45% of the time in the per-row
check loop** (`validateAndNormalizeColumnar`, `packages/core/src/batch/validate.ts`)
and **26% in making a `Time` object for each tick**, which the loop then
throws away after reading its number (`validate.ts:415-422`). pond already
has a column ingest without either cost: `TimeSeries.fromColumns` takes
the same ticks in the same batches in about 1.2 ms. `LiveSeries` has no
way in for columns.

How often the server pushes changes both delay and cost. Cloud, worker,
`chunk` + `buckets`, 100k ticks/s, 1 min window:

| push every | ingest, ms per second | delay (median) |
| ---------- | --------------------- | -------------- |
| 4 ms       | 80                    | 5 ms           |
| 8 ms       | 48                    | 7 ms           |
| 16 ms      | 40                    | 10 ms          |
| 50 ms      | 35                    | 31 ms          |

Going from every 50 ms to every 4 ms adds 230 messages a second and
45 ms/s of ingest, about 0.2 ms per message, which matches the fixed cost
seen at low rates above. <!-- NODE-PERCALL -->

## 6. Receiving: a worker busy drawing receives less

<!-- RECEIVE -->

## Appendix: what a worker render mode needs in `@pond-ts/charts`

The spike drew with `drawLine` imported from `packages/charts/src`
directly. The charts package as shipped can't be moved into a worker,
for these reasons:

1. **Layers hand the canvas a function with the data baked in.** Each
   chart type registers a `draw(ctx, xScale, yScale)` closure over its
   series and styles (`LineChart.tsx:422`, called from `Layers.tsx:450`).
   A function can't be sent to a worker; the data and style would have to
   be sent as plain values and drawn by code that already lives there.
2. **The drawing functions aren't exported.** `drawLine` and the other
   kernels are internal; only types like `DecimateOption` are public
   (`index.ts:191`).
3. **Drawing is tied to React's commit.** `<Canvas>` draws synchronously in
   `useLayoutEffect` on the page thread (`Canvas.tsx:38-66`).
4. **Hover and selection read the data on the page thread.** Hit-testing
   runs in pointer handlers against the chart's series (`LineChart.tsx:345`);
   with the data in a worker, each hover becomes a message round trip.
5. **Overlays are DOM.** Annotations, guides and the crosshair are SVG
   over the canvas (`Layers.tsx:2094`), so they stay on the page thread.
6. **Theme from CSS variables reads the DOM.** `cssVarTheme` uses
   `getComputedStyle`; in a worker it returns the fallbacks
   (`css-theme.ts:48`).
7. **Some options are callbacks.** For example scatter's per-point
   `labelAt(i)` (`scatter.ts:469`).

The charts RFC already lists "OffscreenCanvas + Worker rendering for the
multi-chart-per-page case" as a v2 idea (`docs/rfcs/charts.md:810`).
