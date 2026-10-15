# offscreen-stream — live market data drawn off the main thread

A WebSocket pushes synthetic market ticks every 16 ms. A Web Worker
appends them to a pond `LiveSeries` and draws the chart onto an
`OffscreenCanvas`, so the page's own thread does nothing but show a stats
line. The goal is 120 fps, and a map of how far very-high-rate streaming
into a browser can go.

**→ Read [REPORT.md](REPORT.md) for the findings.**

This directory is **not** part of the npm workspace. It doesn't build,
test, format, or ship with `npm run verify`.

## Running it

From the repo root, after `npm ci && npm run build`:

```bash
node spikes/offscreen-stream/build.mjs     # bundles src/ → dist/
node spikes/offscreen-stream/server.mjs    # http://localhost:8787/
```

Open the page and use the dropdowns (they reload with new URL params):

| control    | what it changes                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| thread     | `worker` (OffscreenCanvas in a Web Worker) or `main` (same code, page thread)                                                                                                   |
| pipeline   | `raw` (no pond, the fastest baseline) · `chunk` (`LiveSeries`) · `snapshot` (`toTimeSeries()` each frame, what a pond chart does today) · `view` (a `live.window()` `LiveView`) |
| draw       | `m4` (the `@pond-ts/charts` line drawing) · `buckets` (one bucket per pixel column)                                                                                             |
| ticks/s    | 1k – 1M                                                                                                                                                                         |
| push every | 4 / 8 / 16 / 50 ms                                                                                                                                                              |
| window     | 10 s / 1 min / 5 min                                                                                                                                                            |
| busy page  | burns 20 or 40 ms of every 50 ms on the page thread, like a heavy app                                                                                                           |

Two more URL params have no dropdown: `spin=<ms>` adds that much busy
work to every chart frame, and `receiver=worker` moves the WebSocket into
a separate worker that hands each message to the chart's thread.

The green dot under the chart is moved by the page thread. When the page
is busy it stutters; whether the chart stutters too is the point.

## Files

- `server.mjs` — static host + WebSocket tick generator. Binary frames,
  `Float64Array [sendTime, n, dropped, t, price, size, …]`. Each message's
  tick count is worked out from the clock, so the rate over time is exact
  even when a timer fires late. `prefill=<s>` sends that much history
  first. A client more than 32 MB behind has ticks dropped (counted in
  `dropped`).
- `src/engine.ts` — ingest + draw loop. Runs unchanged in the worker or on
  the page, so the two modes compare like for like.
- `src/worker.ts`, `src/main.ts`, `src/index.html` — the two sides.
  `src/receiver.ts` — the optional receive-only worker.
- `bench.mjs` — Chromium sweep. `--only <group>` runs one group (`space`,
  `busy`, `cadence`, `receive`); `--where k=v,…` filters further;
  `--dpr 2` renders at Retina resolution; `--headed --channel chrome`
  uses a visible Chrome window (for a real 120 Hz display);
  `--max-prefill N` raises the 10M-tick history cap; `--print x.json`
  re-prints a saved run. Set `CHROMIUM_PATH` if Playwright's bundled
  browser isn't installed.
- `node-bench.mjs` — the pond-only costs (reading out of a `LiveSeries`,
  ingest by step, `live.window()` per-push cost, history download).
  `node-bench.mjs 3` runs only section 3.
- `profile.mjs` — CPU profiles of `pushMany` and of a `live.window()` view,
  showing which functions the time goes to.
- `fill-probe.mjs` — logs, once a second, how full the chart's window is
  and how many ticks the server dropped (why some sweep windows weren't
  full).
- `results/` — the output the report quotes. `mac-m1pro-120hz-dpr2.txt` is
  the MacBook Pro run at Retina resolution; `mac-m1pro-120hz.txt` the
  earlier 1× run; `cloud-*` the cloud runs; `node.txt`, `profile.txt`,
  `node-window-reruns.txt` the Node runs.

## What it reaches into

`engine.ts` uses two **internal** pieces, on purpose, because a worker
cannot run the React components:

- `drawLine` from `packages/charts/src/line.ts` (not exported from
  `@pond-ts/charts`). `fromTimeSeries` is exported, but is imported from
  the same source folder so the two match.
- `LiveSeries._onChunk` (marked `@internal`) for the `chunk` pipeline
  (and in `node-bench.mjs`).

Both are friction findings in REPORT.md.

`ws` is not a declared dependency of the monorepo; it is in
`node_modules` transitively (via the Storybook / Vite toolchain). If it
disappears, `npm i --no-save ws`.
