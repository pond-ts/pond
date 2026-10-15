# offscreen-stream — report

**Question.** Can a pond chart of live market data hold 120 fps when a
WebSocket pushes ticks every 16 ms, the ticks are appended to a
`LiveSeries` in a Web Worker, and the chart is drawn there onto an
`OffscreenCanvas`? And how far does very-high-rate streaming into a
browser go?

**Short answer.** Yes. On a MacBook Pro at its real (Retina) resolution, a
`LiveSeries` in a worker took in 1M ticks a second and drew them at
120 fps with an 11 ms delay. Getting there meant working around three
parts of pond that can't keep up.

- **The worker does its job.** With the page busy 40 ms of every 50, the
  chart drawn in a worker held 120 fps while the same chart drawn on the
  page thread fell to 33 (§1).
- **But the thread doesn't set the ceiling. Three parts of pond do**, and
  moving to a worker changes none of them:
  - **Drawing** (§2). pond's line drawing goes over every point in view
    on every frame of a scrolling chart. On the M1 Pro it held 120 fps
    with 1M points in view (4.7 ms a frame) and not with 3M (74 fps). The
    spike's alternative, "buckets", held 120 fps in every run, at 0.6 ms
    a frame or less, up to 29M points in a full window.
  - **Reading data out of a `LiveSeries`** (§3, §4). Both public ways fall
    far short of that. `toTimeSeries()` rebuilds the series row by row:
    about half a second at 600k points. A `live.window()` view shifts its
    whole list of events for every tick it drops: 24–34 ms to take in one
    16 ms batch at a 50k-tick window. The spike got past both only
    through an internal callback (`LiveSeries._onChunk`).
  - **Pushing ticks in** (§5). With 160 or more ticks a push, `pushMany`
    costs 17–23 ms per 100k ticks in Node, against about 1 ms to copy
    them into a plain array. In a CPU profile, 89% of that is the check
    it runs on each row, including making a `Time` object per tick (27%).
    pond's existing column ingest takes the same ticks in 0.8–2.0 ms.
    It's affordable for now: at 1M ticks/s on the Mac it used under a
    tenth of the worker's time.
- **Receiving 1M ticks a second worked on the Mac, and needed help on a
  slow machine** (§6). On the Mac, a WebSocket on the drawing worker took
  in every tick until the chart's own code filled about 70% of that
  thread, and lost ticks from 89% up. On a 4-core cloud box it lost ticks
  even with the thread nearly idle. In both places, moving the socket to
  a separate worker that passes messages on got every tick through in
  every run.

Five library tasks come out of this, listed at the end and added to
[PLAN.md](../../PLAN.md).

## Where the numbers come from

- **A MacBook Pro** (M1 Pro, 32 GB, built-in 120 Hz ProMotion screen,
  Chrome 155, visible window): the only place frame rates mean anything.
  Two runs:
  - **At the screen's real resolution** (2 device pixels per CSS pixel,
    about 2,260 pixel columns in the plot):
    [`results/mac-m1pro-120hz-dpr2.txt`](results/mac-m1pro-120hz-dpr2.txt).
    The Mac was on battery, with Spotlight indexing in the background
    (about 60% of one core). Most tables below use this run.
  - **An earlier run at 1 device pixel per CSS pixel** (Playwright's
    default; about 1,130 columns):
    [`results/mac-m1pro-120hz.txt`](results/mac-m1pro-120hz.txt). It used
    an older version of the bench, which took each figure as the middle of
    four once-a-second readings, separately per figure. So in those rows
    the frame rate and the work per frame can come from different seconds,
    and there was no wait for the chart to catch up. Used here only for
    comparison.
- **A cloud container** (4 shared cores, headless Chromium, no GPU, frames
  capped at 60 Hz): good for **milliseconds of work per frame** and data
  rates, not for frame rates. The test server, the bench and the browser
  share the 4 cores. Runs at 1× and 2× pixel density
  ([`results/cloud-dpr1.txt`](results/cloud-dpr1.txt),
  [`results/cloud-dpr2.txt`](results/cloud-dpr2.txt)) and the receiving
  runs (`results/cloud-receive*.txt`), each with a `.json` holding the
  per-second figures.
- **Node**, for the pond-only costs: [`node-bench.mjs`](node-bench.mjs) →
  [`results/node.txt`](results/node.txt), CPU profiles from
  [`profile.mjs`](profile.mjs) → [`results/profile.txt`](results/profile.txt).
  Node timings on the shared cloud box move between runs, some by a lot
  ([`results/node-window-reruns.txt`](results/node-window-reruns.txt)
  shows one section run three times). The conclusions rest on gaps of 10×
  or more.

Each browser row (current bench): open the page, wait for the history to
arrive, wait until the chart is less than 1 s behind the feed (flagged
`NOT-CAUGHT-UP` if it never gets there within 60 s), settle 3 s, then
measure every frame over 4 s. All figures in a row come from the same
frames.

What the figures mean:

- **Work** ("work" in the result files): time in the chart's own code each
  frame, from the start of the frame callback to the end of the drawing
  calls. It leaves out what the browser does afterwards to get the frame
  on screen.
- **Slowest 5%** ("p95"): the 95th-percentile time between the starts of
  two frames. At 120 fps frames are 8.3 ms apart.
- **Delay** ("lat"; medians unless stated): the wall clock at the end of a
  frame's drawing code minus the time of the newest tick drawn. The server
  stamps the newest tick in each message with the time it sends it, so the
  delay covers the network, waiting in the queue, ingest, the wait for the
  next frame and the frame's own code. It does not include the browser
  putting the frame on screen. Server and browser run on the same machine,
  so there's one clock.
- **Ingest**: ms per second the receiving thread spends handling WebSocket
  messages: reading the ticks out and getting them into the chart's data.

## What was built

```
server.mjs ── WebSocket, one binary message every 16 ms ──▶ worker.ts
  synthetic tape: price random walk,                        engine.ts:
  ticks spread evenly across each message,                    ingest → LiveSeries (or a plain buffer)
  rate exact over time, history first                         draw   → OffscreenCanvas, every animation frame
                                                            page (main.ts) gets one stats object a second
```

Each message is one `Float64Array` with the ticks interleaved:
`[sendTime, n, dropped, t0, price0, size0, t1, price1, …]`. The server
first sends a window's worth of past ticks ("history") so the chart
starts full.

The same `engine.ts` runs in the worker or on the page, so "worker vs page
thread" compares identical code. The switches:

- **Pipeline** (how ticks get to the chart):
  - `raw`: straight into a typed buffer, no pond. The fastest possible
    baseline.
  - `chunk`: `LiveSeries.pushMany`, and every appended batch copied column
    by column into a typed buffer through `LiveSeries._onChunk`, an
    internal callback.
  - `snapshot`: `LiveSeries.pushMany`, then on each frame with new data,
    `live.toTimeSeries()` then `fromTimeSeries(ts, 'price')`: what a pond
    chart fed from a `LiveSeries` does today.
  - `view`: `LiveSeries.pushMany` with a `live.window('10s')`-style
    `LiveView` attached, read each frame through its public
    `keyColumn()` / `column('price')`.
- **Draw**:
  - `m4`: the real `@pond-ts/charts` line drawing (`drawLine`,
    `packages/charts/src/line.ts`). It trims to what's visible, thins to
    4 points per pixel column (first, lowest, highest, last), then
    strokes.
  - `buckets`: new in the spike. The window is cut into one time slice
    per pixel column. Each tick, as it arrives, updates its slice's
    bucket, which keeps the first, lowest, highest and last price. A frame
    draws one line through the buckets. The picture is close to `m4`'s
    (both keep first/lowest/highest/last per column), but buckets sit on a
    fixed time grid and draw all four values at the slice's middle; the two
    weren't compared image to image. The work moves from every frame to
    each tick's arrival.
- **Busy page**: the page thread spins for 20 or 40 ms of every 50 ms,
  standing in for a heavy app. The page thread also runs its own frame
  counter (it moves a green dot), so the page's frame rate shows
  separately from the chart's.
- **Receiving** (§6 only): `spin` adds a fixed number of ms of busy work
  to every chart frame; `receiver=worker` moves the WebSocket into a
  separate worker that passes each message on to the chart's thread.

The chart's right edge is the newest tick's time plus the time since it
arrived, so the tape moves every frame even though data lands every 16 ms.

## 1. On a busy page, the worker keeps the chart at 120 fps

Mac at Retina resolution, 100k ticks/s, 10 s window (~990k points in
view), `chunk` pipeline. "Busy" is ms of page work in every 50 ms.

| draw    | busy | chart fps, worker / page thread | slowest 5% of chart frames, worker / page thread | delay, worker / page thread | page's own fps (worker run) |
| ------- | ---- | ------------------------------- | ------------------------------------------------ | --------------------------- | --------------------------- |
| m4      | 0    | 120 / 120                       | 10.0 / 10.3 ms                                   | 14 / 15 ms                  | 120                         |
| m4      | 20   | 120 / 100                       | 10.2 / 25 ms                                     | 14 / 17 ms                  | 106                         |
| m4      | 40   | **120 / 33**                    | 10.3 / **47 ms**                                 | 15 / **56 ms**              | 62                          |
| buckets | 0    | 120 / 120                       | 10.2 / 10.0 ms                                   | 10 / 11 ms                  | 120                         |
| buckets | 20   | 120 / 120                       | 10.2 / **22 ms**                                 | 10 / 11 ms                  | 109                         |
| buckets | 40   | **120 / 60**                    | 10.2 / **44 ms**                                 | 10 / 30 ms                  | 62                          |

The earlier 1× run gave the same picture (m4 at busy 40: 120 / 35 fps;
buckets: 120 / 60).

On the page thread the chart can only draw when the page lets it, so it
drops to the page's own rate. In the worker it doesn't notice: the page
fell to 62 fps and the worker chart stayed at 120. The delay from tick to
drawn frame also stays put in the worker, while on the page thread it
grows, because the WebSocket messages arrive on the busy thread and wait
behind the page's work.

**Frame rate alone hides stutter.** The `buckets` busy-20 row averaged
120 fps on the page thread, yet 5% of its frames started 22 ms or more
after the one before. With an average gap of 8.3 ms, the other frames
must have come less than 8.3 ms apart: the chart's frame code ran in
bunches after each stall. So for busy pages the slowest-5% column is the
measure of smoothness, not fps.

The page's own counter in the earlier 1× run showed that same row at
120 fps with no frame over 9 ms, which didn't fit. It timed frames with
the timestamp Chrome hands to `requestAnimationFrame`, which under-reads
a stall after the page thread has been blocked. It now uses
`performance.now()` (`src/main.ts`), and the Retina run shows the stall:
119 fps with a slowest page frame of 25 ms.

The cloud run shows what happens when the page thread is overloaded
rather than just busy. There, an m4 frame at ~1M points takes 14–15 ms:

| draw    | busy | chart fps, worker / page thread | delay, worker / page thread     |
| ------- | ---- | ------------------------------- | ------------------------------- |
| m4      | 0    | 33 / 33                         | 29 / 54 ms                      |
| m4      | 20   | 35 / 20                         | 28 / 330 ms                     |
| m4      | 40   | 35 / **16**                     | 29 ms / **12 s, still growing** |
| buckets | 0    | 50 / 53                         | 11 / 27 ms                      |
| buckets | 20   | 49 / 32                         | 11 / 50 ms                      |
| buckets | 40   | 51 / **17**                     | 10 ms / **11 s, still growing** |

(Cloud, frame rate capped at 60 and noisy.) The worker chart's frame rate
is the same busy or quiet. With the page busy 40 of every 50 ms, both
page-thread charts fell seconds behind the feed. For m4 the page thread
was simply out of time (about a second of measured work per second). For
buckets, the chart's own drawing and ingest came to about 4% of the
thread, so why it fell behind wasn't established; the Mac's page-thread
buckets chart under the same load stayed 30 ms behind. Compare the
receiving results in §6, which also differ between the two machines.

## 2. The drawing method decides the ceiling, not the thread

Mac at Retina resolution, worker, `raw` pipeline (no `LiveSeries`), quiet
page, about 2,260 pixel columns. Percentages show how full the window
was (see below).

| ticks/s | window | points in view, m4 / buckets | m4 fps | m4 work per frame | buckets fps | buckets work per frame |
| ------- | ------ | ---------------------------- | ------ | ----------------- | ----------- | ---------------------- |
| 1k      | 10 s   | 10k                          | 120    | 0.71 ms           | 120         | 0.58 ms                |
| 1k      | 1 min  | 60k                          | 120    | 1.0 ms            | 120         | 0.56 ms                |
| 10k     | 10 s   | 100k                         | 120    | 1.6 ms            | 120         | 0.53 ms                |
| 1k      | 5 min  | 300k                         | 120    | 2.2 ms            | 120         | 0.59 ms                |
| 10k     | 1 min  | 600k                         | 120    | 3.4 ms            | 120         | 0.60 ms                |
| 100k    | 10 s   | 990k                         | 120    | 4.7 ms            | 120         | 0.56 ms                |
| 10k     | 5 min  | 3.0M                         | **74** | 12.8 ms           | 120         | 0.59 ms                |
| 100k    | 1 min  | 5.2M (86%) / 5.9M (98%)      | **43** | 22.6 ms           | 120         | 0.48 ms                |
| 1M      | 10 s   | 5.9M (59%) / 8.0M (80%)      | **48** | 19.7 ms           | 120         | 0.31 ms                |
| 100k    | 5 min  | 29.4M (98%)                  | —      | —                 | 120         | 0.55 ms                |
| 1M      | 1 min  | 39.1M (65%)                  | —      | —                 | 120         | 0.25 ms                |
| 1M      | 5 min  | 39.0M (13%)                  | —      | —                 | 120         | 0.12 ms                |

**Why some windows weren't full.** Two reasons, both about how the bench
loads history, not about drawing:

- The history sent up front was capped (30M ticks in this run), so the
  1M ticks/s rows with 1 and 5 minute windows started part full.
- At high rates the history itself takes seconds to arrive. While the
  browser is still working through it, more than 32 MB is waiting for it,
  and the server then drops live ticks (by design, so a slow client
  doesn't build an endless queue). That leaves a hole in the data. When
  live ticks resume, the history is older than the window and drops out,
  and the window refills from live ticks. A cloud probe of the 1M ticks/s,
  10 s row shows exactly this: the history took about 11 s to arrive,
  8.1M live ticks were dropped meanwhile, and the window then fell to
  0.5M points and refilled at 1M a second
  ([`fill-probe.mjs`](fill-probe.mjs) →
  [`results/cloud-fill-probe.txt`](results/cloud-fill-probe.txt); the
  100k ticks/s, 1 minute m4 case is in `cloud-fill-probe-m4.txt`). The
  Mac's 1M ticks/s, 10 s rows held 8.0M points in both runs, which fits
  8 s of refill; that wasn't checked on the Mac itself.

Buckets cost less on emptier windows because there are fewer columns to
draw. With the window 98–100% full, every bucket frame took
0.46–0.60 ms.

**m4: 120 fps up to about 1M points, not at 3M.** Each 120 fps frame has
8.3 ms, and the code has to finish well inside that: with 8.3 ms of
work a frame (the 8 ms extra-work runs in §6) the Mac ran at 85 fps.
m4's cost grows with the points in view at about 4 ns a point (4.7 ms
at 990k, 12.8 ms at 3.0M, 22.6 ms at 5.2M), so on this Mac its 120 fps
limit is somewhere between 1M and 2M points. That's arithmetic from
these rows, not a measured run.

**Why m4 grows with the data.** `drawLine` trims the series to what's
visible and thins it to a few points per pixel column, then caches the
result keyed on the series object and the x scale
(`packages/charts/src/decimate.ts:372-401`). On a scrolling chart both
change every frame (new ticks, a new time range), so the cache can't help
and every frame walks every visible point again. (The spike also scans
the points for the y range on each frame that has new data; averaged over
all frames that's the "ext" figure in the result files, 7–17% of m4's
frame time from 300k points up.) That's fine for a still chart and costly
for one that moves every frame.

**Why buckets don't.** A bucket is updated once per tick when the tick
arrives (a compare and a store), and a frame draws one point per pixel
column. So a frame costs about the same at 10k points or 29M, and
`raw` + `buckets` keeps no tick buffer at all: memory doesn't grow with
the window either. The price is that the buckets are fixed to one zoom
level and one window. Zooming, panning or hovering a single tick needs the
raw data, which the `chunk` pipeline still keeps in the `LiveSeries`.

**Retina resolution costs little on the Mac.** Against the earlier 1×
run at the same number of points, m4 took between 0.1 ms less and
0.7 ms more a frame, and its frame rate where it fell short barely moved
(3.0M points: 79 → 74 fps; 5.2M: 44 → 43). Buckets took 0.1–0.2 ms more
(twice the columns). Most of m4's cost is per point, not per pixel.

The cloud box paid more for the extra pixels: m4 gained 0.6–2.9 ms a
frame and buckets 1.4–2× at 2×
([`results/cloud-dpr2.txt`](results/cloud-dpr2.txt)), and its frame rate
at 2× fell to 21–30 fps where the chart's code took only 1.1–1.5 ms a
frame. So something outside the chart's code held its frames back. Not
investigated; that box draws without a GPU.

Bucket frame times also moved with the page's load in ways the drawing
doesn't explain: in the §1 runs the same bucket chart took 0.50–0.52 ms
on a quiet page and 0.31–0.34 ms with the page busy (0.36–0.38 vs
0.19–0.21 ms at 1×). Not investigated; every bucket frame stayed at
0.6 ms or less, about 7% of a 120 fps frame.

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
through the internal callback) costs **0.00–0.01 ms** to read at every
size. At 120 fps a frame has 8.3 ms in total, so the `snapshot` path is
out of budget somewhere between 10k and 60k points.

Node, one `LiveSeries` filled with N rows
([`results/node.txt`](results/node.txt) section 1). The first column
reads the price column out; the other two also copy the time column.

| rows | `toTimeSeries()` + read the column | `LiveView` `keyColumn()` + `column()` | copy the stored chunks' columns |
| ---- | ---------------------------------- | ------------------------------------- | ------------------------------- |
| 60k  | 60 ms                              | 7.6 ms                                | 1.7 ms                          |
| 600k | 542 ms                             | 64 ms                                 | 16 ms                           |
| 3M   | 3.9 s                              | —                                     | 91 ms                           |

The last column is a rough guide to what a column hand-over would cost,
not a floor or a ceiling: it reads one value at a time, which a bulk copy
would beat, but it builds no `TimeSeries`.

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
`keyColumn()` / `column()`, is cheap to read (middle column above) but
expensive to keep up to date. It holds its window as a list of event
objects, and every arriving tick drops the oldest with
`events.splice(0, count)` (`packages/core/src/live/live-view.ts:181-187`,
`730-736`), which moves every remaining item down one place. In a CPU
profile of a 50k-event window, 98% of the time was in the function that
makes that `splice` call (`#applyEviction`;
[`results/profile.txt`](results/profile.txt) section 2).

Node, time to push one 16 ms batch once the window is full, with and
without a view attached. Ranges are across three runs
([`results/node.txt`](results/node.txt) section 3 and
[`results/node-window-reruns.txt`](results/node-window-reruns.txt)):

| window (events) | 10k ticks/s (160 a push), no view | with a view  | 100k ticks/s (1,600 a push), no view | with a view    |
| --------------- | --------------------------------- | ------------ | ------------------------------------ | -------------- |
| 1k              | 0.11–0.18 ms                      | 0.48–0.71 ms | 0.43–1.05 ms                         | 4.6–13 ms      |
| 10k             | 0.04–0.06 ms                      | 2.3–6.9 ms   | 0.51–0.79 ms                         | 6.3–68 ms      |
| 50k             | 0.03–0.07 ms                      | **24–34 ms** | 0.27–0.62 ms                         | **271–326 ms** |
| 100k            | 0.03–0.06 ms                      | **56–77 ms** | 0.29–0.58 ms                         | **368–398 ms** |

A batch arriving every 16 ms has to be taken in within 16 ms. At 10k
ticks/s that fails from a window of a few tens of thousands of ticks; at
100k ticks/s, sometimes at 10k. The smaller windows varied a lot from run
to run (6–68 ms for a 10k window at 100k ticks/s), which wasn't
explained; the large ones were consistently far over.

In the browser (cloud, worker, `view` pipeline) the cost lands in ingest,
and it grows with both the window and the tick rate:

| ticks/s | window | points | ingest, ms per second | `chunk` ingest, same setup | read per frame | chart fps (cap 60) |
| ------- | ------ | ------ | --------------------- | -------------------------- | -------------- | ------------------ |
| 1k      | 10 s   | 10k    | 34                    | 10                         | 0.6 ms         | 56                 |
| 1k      | 1 min  | 60k    | 208                   | 12                         | 4.0 ms         | 39                 |
| 10k     | 10 s   | 100k   | **995**               | 11                         | —              | **0**              |

In the last row the worker spent the whole of every second taking in
ticks, got 1,846 of the 10,000 a second through, never filled its window,
and drew no frame during the sample. The sweep skips `view` above 100k
points for that reason.

## 5. Pushing ticks into a `LiveSeries` costs 10–20× a plain copy

Cloud, worker, ingest in ms per second:

| ticks/s | `raw` (typed array, no pond) | `chunk` (`pushMany` + copy-out through the callback) |
| ------- | ---------------------------- | ---------------------------------------------------- |
| 1k      | 1–2                          | 8–12                                                 |
| 10k     | 1–2                          | 8–12                                                 |
| 100k    | 3–4                          | 33–45                                                |
| 250k    | —                            | 77–86                                                |
| 500k    | —                            | 145–160 (441k–481k a second got through)             |
| 1M      | 17–22                        | 165–182 (500k–703k a second got through, see §6)     |

On the Mac, `chunk` cost 10–21 ms per second at 100k ticks/s (1–2% of
one core) and 75 ms per second at 1M ticks/s (under 8%). The Mac took
in ticks about three times faster than the cloud box.

At 1k and 10k ticks/s the `chunk` cost hardly changes with the rate, so
most of it there is a fixed cost per message (about 62 messages a second,
about 0.15 ms each), not per tick.

Node, cost per 100k ticks, by step ([`results/node.txt`](results/node.txt)
section 2):

| ticks per push | build row arrays | `pushMany` | `pushMany` + copy-out | plain typed copy | `TimeSeries.fromColumns` |
| -------------- | ---------------- | ---------- | --------------------- | ---------------- | ------------------------ |
| 16             | 4.7              | 300        | 316                   | 3.4              | 15.5                     |
| 160            | 2.5              | 23         | 36                    | 1.1              | 2.0                      |
| 400            | 2.7              | 19         | 21                    | 1.0              | 1.1                      |
| 800            | 2.2              | 20         | 19                    | 1.0              | 1.0                      |
| 1,600          | 2.0              | 17         | 22                    | 1.5              | 0.9                      |
| 5,000          | 2.5              | 18         | 28                    | 1.3              | 0.8                      |

(ms per 100k ticks. 16 ticks a push is 1k ticks/s every 16 ms; 1,600 is
100k ticks/s.)

From 160 ticks a push up, `pushMany` costs 11–21× a plain typed copy in
Node (about 90× at 16 a push), and in the browser at 100k ticks/s about
10–15×. Building the row arrays is only about a tenth of it. A CPU profile
of `pushMany` with 1,600-row batches
([`results/profile.txt`](results/profile.txt) section 1) puts **89% of
the time in the per-row check** (`validateAndNormalizeColumnar`,
`packages/core/src/batch/validate.ts`, and what it calls). Of that, 55
points are its own loop and **27 are making a `Time` object for each
tick**, which the loop then throws away after reading its number
(`validate.ts:415-422`). pond already has a column ingest without either
cost: `TimeSeries.fromColumns` takes the same ticks in 0.8–2.0 ms from
160 a push up (0.9 ms at 1,600). `LiveSeries` has no way in for columns.

Each `pushMany` call also has a fixed cost. In Node it is about 0.05 ms
(300 ms over 6,250 calls of 16 ticks), against about 0.0025 ms for
`fromColumns`.

How often the server pushes changes both delay and cost. Cloud, worker,
`chunk` + `buckets`, 100k ticks/s, 1 min window:

| push every | ingest, ms per second | delay (median) |
| ---------- | --------------------- | -------------- |
| 4 ms       | 80                    | 5 ms           |
| 8 ms       | 48                    | 7 ms           |
| 16 ms      | 40                    | 10 ms          |
| 50 ms      | 35                    | 31 ms          |

Going from every 50 ms to every 4 ms adds about 220 messages a second
(worked out from the bytes received) and 45 ms/s of ingest, about 0.2 ms
per message, which matches the fixed cost seen at low rates above. That's
about 4× Node's per-call cost; why the browser costs more per call wasn't
established.

## 6. Receiving 1M ticks a second

At 1M ticks/s the WebSocket carries 24 MB a second. The server and
network keep up: a plain Node client took in 6M ticks (144 MB) of history
in 2.1 s ([`results/node.txt`](results/node.txt) section 4). The question
is the browser.

To see how receiving holds up as the chart's thread gets busier, these
runs add a fixed amount of busy work to every frame (`spin`), on the
cheapest setup (`raw` + `buckets`, 1M ticks/s, 1 s of history so there's
no backlog), with the socket either on the drawing worker or on a separate
worker that passes each message on. "Busy" is the share of each second the
thread spent in the chart's measured code (fps × work); the browser's own
time on that thread isn't counted.

**Mac, Retina resolution**
([`results/mac-m1pro-120hz-dpr2.txt`](results/mac-m1pro-120hz-dpr2.txt)):

| extra work per frame | busy      | ticks/s taken in, socket on the drawing worker | ticks/s taken in, socket on its own worker |
| -------------------- | --------- | ---------------------------------------------- | ------------------------------------------ |
| 0 ms                 | 3%        | 997k (12 ms behind)                            | 1,003k (12 ms behind)                      |
| 4 ms                 | 51%       | 1,000k (16 ms behind)                          | not run                                    |
| 8 ms                 | 69–70%    | 1,001k (24 ms behind)                          | 996k (20 ms behind)                        |
| 12 ms                | 89%       | **894k** (0.9 s behind)                        | not run                                    |
| 16 ms                | 94% / 98% | **499k** (1.9 s behind, never caught up)       | **998k** (28 ms behind)                    |
| 24 ms                | 97%       | **326k** (3.4 s behind, never caught up)       | not run                                    |

**Cloud box**
([`results/cloud-receive.txt`](results/cloud-receive.txt),
[`results/cloud-receive-rx.txt`](results/cloud-receive-rx.txt), two runs):

| extra work per frame | busy   | ticks/s taken in, socket on the drawing worker     | ticks/s taken in, socket on its own worker |
| -------------------- | ------ | -------------------------------------------------- | ------------------------------------------ |
| 0 ms                 | 3–4%   | **841k–885k** (still falling behind in the sample) | 998k (19 ms behind)                        |
| 4 ms                 | 23–24% | 635k–715k (1.0–1.3 s behind)                       | not run                                    |
| 8 ms                 | 35–37% | 714k–749k (1.4–1.6 s behind)                       | 997k (26 ms behind)                        |
| 12 ms                | 48–49% | 458k–558k (2.2–2.7 s behind)                       | not run                                    |
| 16 ms                | 56–63% | 308k–361k (3.2–3.9 s behind)                       | 1,004k (36 ms behind)                      |
| 24 ms                | 71–76% | 246k–257k (4.7–4.9 s behind)                       | not run                                    |

The messages, their size and the work done on each were the same in both
columns; only the thread that owned the socket changed.

- **On the Mac**, a socket on the drawing worker took in every tick until
  the chart's code filled about 70% of the thread, and lost ticks from
  89% up. With the socket on its own worker, every tick got through even
  at 98%.
- **On the cloud box**, a socket on the drawing worker lost ticks in
  every run, even with the thread 3–4% busy, and lost more as the work
  grew. With the socket on its own worker, every tick got through again.

Why the cloud box loses ticks so early wasn't investigated (its 4 cores
are shared with the server and the bench). What both machines agree on:
a socket on its own worker never lost ticks here.

m4 drawing at 1M ticks/s fills the thread on its own: on the Mac at
Retina resolution it took 19.7 ms a frame at 48 fps (94% of the thread)
and took in 427k ticks a second. That matches the 16 ms extra-work row
above.

**With a `LiveSeries` in the loop** (`chunk` + `buckets`, socket on the
drawing worker or on its own worker; Mac rows from the same file, cloud
rows from [`results/cloud-receive-chunk.txt`](results/cloud-receive-chunk.txt)
and `cloud-receive.txt`):

| ticks/s sent | Mac, drawing worker's socket | Mac, own worker's socket | cloud, drawing worker's socket        | cloud, own worker's socket |
| ------------ | ---------------------------- | ------------------------ | ------------------------------------- | -------------------------- |
| 250k         | 250k (10 ms behind)          | not run                  | 250k (13–16 ms behind)                | not run                    |
| 500k         | 501k (11 ms)                 | 499k (11 ms)             | 441k–481k (36–50 ms)                  | 499k (14 ms)               |
| 1M           | **1,000k (11 ms)**           | 1,002k (12 ms)           | 607k–703k (1.4–1.5 s, falling behind) | **994k (18 ms)**           |

The drawing worker's ingest at 1M ticks/s was 75–78 ms per second on the
Mac and 239 ms per second on the cloud box (own-worker socket). That's
`pushMany` (rows) on the write side and the internal `_onChunk` callback
on the read side. Going by the Node comparison with `fromColumns`,
[PND-LPUSHCOL] should cut much of that ingest cost; that wasn't measured.

The server stops sending to a client that falls more than 32 MB behind and
counts the ticks it skips ("DROP" in the result files), so a slow client
shows up as fewer ticks taken in rather than an ever-growing queue.

## What this means for pond

Five tasks, added to [PLAN.md](../../PLAN.md) with write-ups in the
breakout plans:

1. **[PND-LSNAP] — A columnar `toTimeSeries()`** (live layer). Pass the
   stored columns through instead of rebuilding rows. §3. The other half
   of what the spike needed, a public "just appended, as columns" event to
   replace the internal `_onChunk` callback, is the existing
   **[PND-COLOUT]**; the spike is a second user for it.
2. **[PND-LVWIN] — `live.window()` at a flat cost per tick** (live
   layer). Keep a marker for where the window starts instead of `splice`
   on every tick. Internal only. §4.
3. **[PND-LPUSHCOL] — Columns into `LiveSeries`** (live layer). A push
   that takes one typed array per column through the existing column
   ingest, skipping the per-row checks and the `Time` object per tick.
   Adds a method to `LiveSeries`. §5.
4. **[PND-STREAMDRAW] — A streaming draw for scrolling live charts**
   (charts). Buckets filled as ticks arrive, for line/area charts whose
   window scrolls. The m4 path stays for still, zoomed and hovered views.
   §2.
5. **[PND-OFFSCREEN] — A worker render mode for charts** (charts). What
   blocks it is listed in the appendix. Before the draw functions are
   exported, `drawLine`'s `boundaries = []` default (`line.ts:131`) needs
   fixing: it makes a new array on every call, and the m4 cache compares
   `boundaries` by identity, so a caller that leaves it out never hits the
   cache. `LineChart` passes a stable empty array, so shipped charts are
   unaffected. A worker mode should also offer to take its data on a
   separate receiving worker: it never lost ticks in these runs, and the
   drawing worker's own socket did once that thread was nearly full (Mac)
   or even when it wasn't (cloud). §1, §6.

Evidence was also added to existing tasks: [PND-LIVELYR] (live chart
inputs), [PND-COLOUT] (column-native output) and [PND-WIRE] (columnar wire
format).

## Caveats and what wasn't covered

- **One real machine, one browser.** Frame rates were measured on one
  M1 Pro in Chrome, on battery with Spotlight indexing in the background.
  Safari and Firefox weren't run. The engine falls back to timers if a
  worker has no `requestAnimationFrame`; that path wasn't exercised.
- **Cloud frame rates aren't trustworthy.** Use the cloud for
  milliseconds of work and data rates.
- **Windows weren't always full** (see §2): history was capped, and at
  high rates the server's drops while history arrives leave a hole. The
  tables give the percentage where a window was part full.
- **Synthetic data, one line, no interaction.** No hover, tooltips,
  `@pond-ts/charts` axes or multiple series. A real worker mode has to
  answer hover against data that lives in the worker.
- **Delay** uses one clock (server and browser on one machine) and
  includes up to 16 ms of batching on the server.
- **Sweep limits:** `snapshot` stops at 600k points (a frame takes
  seconds beyond that), `view` at 100k (§4), and everything except
  `raw` + `buckets` at 10M points (memory).
- **The spike reaches into internals**: `LiveSeries._onChunk` and
  `drawLine` from `packages/charts/src`. See the README.

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
   drawing functions are internal; only types like `DecimateOption` are public
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
   `labelAt(i)` (`scatter.ts:473`).

The charts RFC already lists "OffscreenCanvas + Worker rendering for the
multi-chart-per-page case" as a v2 idea (`docs/rfcs/charts.md:810`).
