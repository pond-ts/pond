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

| control    | what it changes                                                                 |
| ---------- | ------------------------------------------------------------------------------- |
| thread     | `worker` (OffscreenCanvas in a Web Worker) or `main` (same code, page thread)   |
| pipeline   | `raw` (no pond, the floor) · `chunk` (`LiveSeries`) · `snapshot` (today's path) |
| draw       | `m4` (the `@pond-ts/charts` line kernel) · `buckets` (one bucket per pixel)     |
| ticks/s    | 1k – 1M                                                                         |
| push every | 4 / 8 / 16 / 50 ms                                                              |
| window     | 10 s / 1 min / 5 min                                                            |
| busy page  | burns 20 or 40 ms of every 50 ms on the page thread, like a heavy app           |

The green dot under the chart is moved by the page thread. When the page
is busy it stutters; whether the chart stutters too is the point.

## Files

- `server.mjs` — static host + WebSocket tick generator. Binary frames,
  `Float64Array [sendTime, n, t, price, size, …]`, drift-corrected so the
  delivered rate is exact. `prefill=<s>` sends that much history first.
- `src/engine.ts` — ingest + draw loop. Runs unchanged in the worker or on
  the page, so the two modes compare like for like.
- `src/worker.ts`, `src/main.ts`, `src/index.html` — the two sides.
- `bench.mjs` — headless-Chromium sweep. `--uncapped` drops the 60 Hz
  frame cap; `--only <group>` runs one group (`space`, `busy`, `cadence`).
  Set `CHROMIUM_PATH` if Playwright's bundled browser isn't installed.
- `results/` — the sweep output the report quotes.

## What it reaches into

`engine.ts` imports two **internal** pieces, on purpose, because a worker
cannot run the React components:

- `packages/charts/src/line.ts` `drawLine` and `data.ts` `fromTimeSeries`
  (not exported from `@pond-ts/charts`).
- `LiveSeries._onChunk` (marked `@internal`) for the `chunk` pipeline.

Both are friction findings in REPORT.md.

`ws` is not a declared dependency of the monorepo; it is in
`node_modules` transitively (via the Storybook / Vite toolchain). If it
disappears, `npm i --no-save ws`.
