# Worker-threads spike — can Node threads close the polars-mt gap?

Two measurements behind
[`docs/notes/worker-threads-assessment-2026-07.md`](../../docs/notes/worker-threads-assessment-2026-07.md).
Run after `npm run build --workspaces` (the real pair imports compiled
`dist/`).

## `main.mjs` + `worker.mjs` — the floors

Toy kernels over a `SharedArrayBuffer`, measuring the fixed costs and the
two parallelism shapes in isolation:

- warm-pool dispatch/join: **~10 µs** round trip, **~72 µs** for an 8-way
  fan-out join — noise against 10–60 ms queries;
- four ~1 ms independent jobs scale **badly** (~1.4×) — scheduling jitter
  dominates below ~10 ms of work per job;
- one rolling mean chunked across k workers reaches ~2× at k=8, **but**
  each chunk's running sum starts fresh, so results differ from the
  single sweep in the last ulp and depend on the chunk grid — the same
  reassociation class blocked summation had to document.

```sh
node spikes/worker-threads/main.mjs
```

## `main-real.mjs` + `worker-real.mjs` — the real thing

The 5-study strategy stack (`bollinger`, `zScore`, `sma×3`) with **real
pond kernels**: input `time`/`close` columns on `SharedArrayBuffer`, each
worker builds its own resident `TimeSeries` over them once
(`fromColumns` adopts SAB-backed views zero-copy — today, unmodified),
then one study per worker, output buffers transferred back.

Measured (node 22, 10 cores, 500k bars): sequential **66.3 ms** →
parallel **27.4 ms** = **2.42×**, against a 22.9 ms critical path
(`bollinger`). Results are **bit-identical** to sequential — each study
runs the ordinary single-threaded kernel; only _which_ study runs where
is parallel.

```sh
node spikes/worker-threads/main-real.mjs
```

Numbers move a little run to run (2.3–2.4×); the shape does not.
