# worker-chart — a live chart drawn off the main thread

A made-up market feed streams ticks (trades: time, price, size) over a
WebSocket every 16 ms. One Web Worker owns the socket and turns each message
into columns. A second worker keeps the ticks in a pond `LiveSeries` (fed
with `pushSeries`) and draws the chart onto an `OffscreenCanvas` on every
frame the screen shows. The page only passes its size and the pointer
along, shows a tooltip, and shows worker errors or a closed feed.

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
`PORT=9000 npm start` uses another port. The "busy page" box burns 40 ms of
every 50 on the page's thread; the chart's frame rate shouldn't move.

## Checking it

```bash
npx playwright install chromium   # once
npm run check                     # RATE=100000 WINDOW=30 npm run check
```

It opens the page in headless Chromium and checks that frames are drawn;
that every tick the feed sends arrives (the feed numbers them), none is
dropped, and the newest is drawn within 250 ms; that the series holds one
window and the line spans the chart; that hovering picks the tick under
the pointer and shows it in local time, with the tooltip kept on the page;
that the chart keeps its frame rate, and doesn't fall behind, while the
page is busy; and that a resize gives the canvas new pixels. It runs in
the Asia/Tokyo time zone, so a clock shown in UTC would stand out, and at
one device pixel per CSS pixel. `CHROMIUM_PATH` points it at another
Chrome or Chromium binary. Headless frame rates are capped at 60 and are
no measure of a real screen; the work timings (`fromColumns`,
`pushSeries`, buckets, frame) are. `npm run typecheck` checks the page
against the DOM types and the workers against the worker types.

At a million ticks a second (`RATE=1000000 WINDOW=5`) the feed, the browser
and the check share the machine's cores, so run it on an otherwise idle
machine: with other work running it can fall behind and fail.

## Benchmarks

`npm run bench` runs the Node scripts behind the guide's numbers, against
the same `pond-ts` build:

- `bench/lookups.mjs`: what a hover lookup costs, and what lookups do to
  later pushes (guide section 7).
- `bench/retention.mjs`: `fromColumns` and `pushSeries` at 1M ticks a
  second with `maxAge`, `maxEvents` and no retention (section 8).
- `bench/clear.mjs`: `live.clear()` against a new `LiveSeries` (section 11).

`results/` holds the output of these and of `npm run check` at four feed
rates, from the run the guide quotes.

## Files

| File                   | What it does                                                    |
| ---------------------- | --------------------------------------------------------------- |
| `server.mjs`           | the feed (random walk, history first, then live) + static files |
| `src/clock.ts`         | local `hh:mm:ss` for the axis and the tooltip                   |
| `src/page.ts`          | hands over the canvas, wires the workers, size, pointer, stats  |
| `src/socket-worker.ts` | WebSocket → one `Float64Array` per column → render worker       |
| `src/render-worker.ts` | `LiveSeries` + buckets, the frame loop, hover lookups           |
| `src/buckets.ts`       | one min/max/first/last bucket per pixel column, and its draw    |
| `src/messages.ts`      | the messages between the three                                  |
| `check.mjs`            | the headless check                                              |
