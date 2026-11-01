# worker-chart — a live chart drawn off the main thread

A made-up market feed streams ticks over a WebSocket every 16 ms. One Web
Worker owns the socket and turns each message into columns. A second worker
keeps the ticks in a pond `LiveSeries` (fed with `pushSeries`) and draws the
chart onto an `OffscreenCanvas` on every frame the screen shows. The page
only passes its size and the pointer along, and shows a tooltip.

It is the worked example behind the how-to guide
[A live chart at 120 fps, off the main thread](https://pond-ts.org/docs/how-to-guides/live-chart-in-a-worker).

This directory is **not** part of the npm workspace: CI doesn't build,
format or test it. `npm run check` is how it was verified.

## Running it

`pushSeries` arrives in the first pond-ts release after 0.75.0. Until then
the example links the repo's own `packages/core`, so build that first:

```bash
npm install && npm run build --workspace=pond-ts   # repo root
cd apps/worker-chart && npm install
npm start                                          # http://localhost:8787/
```

URL parameters: `?rate=10000&window=60` (ticks a second, window seconds).
The "busy page" box burns 40 ms of every 50 on the page's thread; the
chart's frame rate shouldn't move.

## Checking it

```bash
npx playwright install chromium   # once
npm run check                     # RATE=100000 WINDOW=30 npm run check
```

It opens the page in headless Chromium and checks that frames are drawn,
every tick arrives, the series holds one window, the line spans the chart
(also after a resize), hovering answers, and the chart keeps its frame rate
while the page is busy. `CHROMIUM_PATH` points it at another Chrome or
Chromium binary. Headless frame rates are capped at 60 and are no measure
of a real screen; the work timings (`pushSeries`, buckets, frame) are.

## Files

| File                   | What it does                                                    |
| ---------------------- | --------------------------------------------------------------- |
| `server.mjs`           | the feed (random walk, history first, then live) + static files |
| `src/page.ts`          | hands over the canvas, wires the workers, size, pointer, stats  |
| `src/socket-worker.ts` | WebSocket → one `Float64Array` per column → render worker       |
| `src/render-worker.ts` | `LiveSeries` + buckets, the frame loop, hover lookups           |
| `src/buckets.ts`       | one min/max/first/last bucket per pixel column, and its draw    |
| `src/messages.ts`      | the messages between the three                                  |
| `check.mjs`            | the headless check                                              |
