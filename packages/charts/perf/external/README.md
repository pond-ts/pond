# External benchmarks — `@pond-ts/charts` vs neighbouring libraries

Two third-party bench protocols run against pond-charts on 2026-07-22, kept
here so the runs are reproducible and the numbers auditable. **Results +
analysis live in docs/notes** (this directory is the harness):

- [charts-bench-vs-uplot-2026-07.md](../../../../docs/notes/charts-bench-vs-uplot-2026-07.md)
  — uPlot's own bench workload (load time, heap, mousemove sweep, 166k points).
- [charts-bench-vs-scichart-suite-2026-07.md](../../../../docs/notes/charts-bench-vs-scichart-suite-2026-07.md)
  — SciChart's chart-performance test suite (FPS ladders to 10M points,
  8 categories) + the CPU profiles behind the [PND-AFFINE] / [PND-GRADX] /
  [PND-DECKEY] / [PND-MARKDEC] perf tasks.

Neither upstream project is vendored; both are cloned at re-run time. The
committed raw results (`results-local*.json`, `suite-results.json`) are the
2026-07-22 run (Apple M1 Pro, Metal GPU for WebGL libs, ~120 Hz rAF cap);
re-runs overwrite them in place, same convention as `../baseline.json`.
Numbers are directional — cross-library ordering on one machine is the signal.

Both harnesses import `playwright` (hoisted to the repo root by the
workspaces install) and run compiled pond packages — `npm run build` first.

## `uplot-bench/` — the uPlot bench protocol

Mirrors [leeoniya/uPlot](https://github.com/leeoniya/uPlot) `bench/`
semantics: page-stamped create→painted time, CDP `Performance.getMetrics`
load profile, heap peak/final (forced GC), 10 s CDP mousemove sweep with an
in-page rAF FPS counter.

Setup (from this directory):

```sh
# 1. The workload + comparison target, from the uPlot repo:
curl -LO https://raw.githubusercontent.com/leeoniya/uPlot/master/bench/data.json
mkdir -p uplot-dist && cd uplot-dist \
  && curl -LO https://unpkg.com/uplot/dist/uPlot.iife.min.js \
  && curl -LO https://unpkg.com/uplot/dist/uPlot.min.css && cd ..

# 2. Bundle the pond bench page (repo already built):
npx esbuild src/pond-bench.jsx --bundle --minify \
  --define:process.env.NODE_ENV='"production"' --outfile=pond-bench.js

# 3. Bundle-size rows (the "js min/gz KB" column):
for lib in core react charts; do
  npx esbuild src/lib-$lib.js --bundle --minify \
    --define:process.env.NODE_ENV='"production"' --outfile=size-$lib.js
done

# 4. Serve this directory on :8123, then run:
npx serve -l 8123 .          # (any static server)
node run-bench.mjs           # → results-local.json (+ per-target screenshots)
node run-bench.mjs pond      # pond targets only → results-local-pond-fixed.json
node check-repaint.mjs       # hover-repaint counter (the #524 bug's detector)
```

`pond.html?decimate=0` is the draw-everything mode (apples-to-apples with
uPlot's no-decimation stroke). `uPlot.html` / `chartjs.html` are the upstream
bench pages instrumented with the same `window.__bench` stamps (uPlot's page
is from its MIT-licensed repo).

## `scichart-suite/` — the SciChart performance test suite

Adapter for
[abtsoftware/javascript-chart-performance-test-suite](https://github.com/abtsoftware/javascript-chart-performance-test-suite)
implementing the suite's `e*PerformanceTest` hook contract with the same
semantics as its uPlot adapter (800×600, cursor off, per-frame updates
through `flushSync` so React pays its full cost inside each timed frame).
Faithfulness notes + category skips are documented at the top of
`pond/pond_tests.src.jsx`.

Setup:

```sh
git clone https://github.com/abtsoftware/javascript-chart-performance-test-suite
cd javascript-chart-performance-test-suite && npm install

# Drop in the adapter and bundle it (repo already built):
cp -R <this dir>/pond public/pond
npx esbuild public/pond/pond_tests.src.jsx --bundle --minify \
  --define:process.env.NODE_ENV='"production"' \
  --outfile=public/pond/pond_tests.js

# Serve the suite on :8124 (vite root is public/):
npx vite --port 8124

# From <this dir>, drive the ladders / tables / profiles:
node run-suite.mjs                  # all libs, all groups → suite-results.json
node run-suite.mjs pond uplot       # subset; GROUPS=6,8 node run-suite.mjs …
node pivot.mjs                      # markdown FPS tables from suite-results.json
node gpu-check.mjs                  # verify Metal GPU + rAF cadence (not SwiftShader)
node profile-nxm.mjs 1000 1000      # V8 sampling profile, NxM line test, bucketed
node profile2.mjs mountain 1 1000000  # per-function top list, line|mountain
```

The profilers need an **unminified** bundle to give readable function names —
rebuild `pond_tests.js` without `--minify` before profiling. `run-suite.mjs`
launches Chromium with `--use-angle=metal --enable-gpu`; always confirm the
renderer line it prints (default headless falls back to SwiftShader, which
cripples the WebGL libraries and invalidates any cross-library comparison).
