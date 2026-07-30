# Worker threads — assessed, and worth a task (2026-07)

**Question.** polars at 10 threads runs the 5-study strategy pass 3.39×
ahead of pond-ts (18.95 ms vs 64.32 ms), and nothing in pond-ts is
parallel. Limited to Node.js, can Worker Threads close that gap?

**Answer: yes — measured 2.42× on the real strategy stack, with
bit-identical results, using only what exists today.** Recorded as
[PND-PROCPAR] (breakout:
[PND_PROCESS_PLAN.md](../plans/PND_PROCESS_PLAN.md)); the reproducible
spike is [`spikes/worker-threads/`](../../spikes/worker-threads/).

Sibling of
[polars-as-core-assessment-2026-07.md](polars-as-core-assessment-2026-07.md),
whose "threads are the other half" section this note resolves.

## polars' own data says which parallelism works

The st→mt columns of the polars comparison
(`packages/financial/scripts/perf-vs-polars.mjs`, 500k bars, 10 threads)
split cleanly:

| query                 | st       | mt       | thread win |
| --------------------- | -------- | -------- | ---------- |
| 5-study strategy pass | 77.35 ms | 18.95 ms | **4.08×**  |
| `bollinger(20)`       | 43.16 ms | 13.78 ms | **3.13×**  |
| `envelope(20)`        | 16.75 ms | 6.06 ms  | **2.76×**  |
| `sma(20)`             | 5.55 ms  | 5.52 ms  | 1.00×      |
| `ema(20)`             | 6.33 ms  | 6.27 ms  | 1.00×      |
| `close.mean()` etc.   | ≤0.31 ms | ≤0.30 ms | ~1×        |

Ten threads bought polars **nothing** on a lone rolling window, nothing
on a sequential recurrence, nothing on sub-ms reductions. Every win is a
**multi-output expression** — independent output columns computed
concurrently. So the opportunity is _inter-operator_ parallelism, not
splitting a kernel's loop.

## Measured in Node (spike, node 22, 10 cores, 500k bars)

**Fixed costs are noise at query scale.** Warm-pool dispatch/join round
trip **10 µs**; 8-way fan-out join **72 µs**; pool spin-up 25 ms (bare
workers) / 84 ms (5 workers importing pond + financial dist), once per
process.

**The real experiment** — the 5-study stack with real pond kernels:
`time`/`close` on `SharedArrayBuffer`, each worker builds a resident
`TimeSeries` over the shared buffers once, one study per worker, outputs
transferred back (zero-copy move):

|                                | ms        |           |
| ------------------------------ | --------- | --------- |
| sequential (main thread)       | 66.27     | 1.00×     |
| one study per worker           | **27.41** | **2.42×** |
| critical path (`bollinger` 20) | 22.91     | — floor   |

Within ~20% of the floor for this decomposition, and the **results are
bit-identical to sequential** — each study runs today's single-threaded
kernel unmodified; parallelism only chooses _where_.

**Three boundary findings**, each load-bearing:

- `TimeSeries.fromColumns` **already adopts SAB-backed `Float64Array`
  views zero-copy** — the input-sharing door needs no library change.
- Jobs must be **≳10 ms** to amortize scheduling jitter: four ~1 ms toy
  jobs scaled at only ~1.4× despite a 72 µs join floor.
- **Intra-kernel chunking is the wrong first move**: a chunked rolling
  mean reached ~2× at 8 workers, but each chunk's fresh running sum
  shifts the last ulp and ties results to the chunk grid — the same
  reassociation class `blocked-summation.md` documents — for a shape
  polars itself doesn't bother parallelising (`sma` mt = 1.00×).

## The residency lesson, third appearance

Resident wins, bridged dies — the WASM spike's conclusion, then the
polars sidecar framing, now workers. Shipping columns per query would
eat every win; a one-time load into `SharedArrayBuffer`, amortized over
an agent session's thousands of queries, costs nothing. Any design that
copies inputs per call is dead before it is benchmarked.

## Two distinct wins — don't conflate them

- **Latency** of one composite query: the 2.42× above, bounded by the
  critical path. Helps the slow queries (composites ≥ 10 ms), which is
  where the agent workload hurts.
- **Throughput** under concurrent queries: a pool of resident workers
  each running _whole queries_ single-threaded, with zero decomposition
  logic and zero numeric-semantics questions. For multi-agent load this
  may be worth more than the latency shape, and it is strictly simpler.

  **Built and measured** — `HostPool`, `@pond-ts/process/pool`. It does
  **not** scale near-linearly, as predicted above; see
  [the correction](#correction-throughput-does-not-scale-near-linearly).

## Why `@pond-ts/process` is the scheduling layer

The plan layer made — for its own reasons — the three commitments
worker execution needs:

1. **Plans are data, ops are a registry.** A `Spec` is
   `{op, params, inputs}` with JSON-only param values; behaviour lives
   in `OpDef.run`, ordinary module code both isolates import. Dispatch
   is `postMessage` of plain data. This dissolves the closure wall that
   makes pond's chaining API unparallelisable (the same wall
   [PND-BOXFREE] hit at `mapColumns`).
2. **`specId` is scheduler, dedup, and cache in one.** Content-addressed
   identity means `bollinger(20)` and `zScore(20)` expressed over shared
   primitives collide on `rollingMean(close,20)` / `rollingStd(close,20)`
   — one node, computed once. The op-level cache keyed on the same ids
   turns an agent's repeated sub-expressions into skipped dispatches
   (the reductions-as-nodes change already showed the warm path at
   0.09 ms).
3. **Columns are the wire shape.** `packColumn` / `appendColumn` /
   `columnBytes` are the vocabulary for moving node outputs across the
   boundary and budgeting what comes back.

The engine change is contained: `run()`'s synchronous memoized pull
becomes a **ready-set loop** over the already-compiled DAG — dispatch
ready nodes to the pool, on completion mark dependents ready — with the
existing per-node timing badges as cost estimates for critical-path-first
order. `RunResult` (`nodes` / `explain` / `cached` / `skipped`) is
unchanged; worker failures map onto the collectable error policy.

With the stack decomposed over shared primitives (mean20/std20 computed
once, pointwise derivations ~ms), the critical path is the slowest
primitive — estimated ~15 ms, i.e. polars-mt territory (18.95 ms) from
TypeScript. Estimate, not a measurement; the 2.42× is measured.

**Determinism throughout:** answers never depend on worker count,
scheduling order, or completion order — nodes are single-threaded
kernels merged by id. The semantics question that intra-kernel chunking
raises never arises.

## What it cannot help

Sequential recurrences (`ema`, `cumulative`, `smooth`); anything already
under ~3 ms (every summary fact); a _lone_ rolling-window query (polars'
own mt data says as much). Browser is out of scope by the question's own
framing (SAB there needs COOP/COEP headers).

## Correction: what decides whether a pool pays

This note predicted "near-linear" scaling. **It measures 3.1–4.0× on 8
workers** (`packages/process/scripts/perf-pool.mjs`, 32 requests/batch,
median of 3 distinct batches) — real, but not 8×.

The more useful correction is about _what_ decides it. An earlier version
of this section reported a **crossover**: the pool losing below ~2 ms per
request (0.94× at 50k rows), with a rule that requests had to be big
enough to be worth routing. **That was a measurement artifact**, and from
a cause this repo had already documented: each worker was warmed with a
single request, so it ran unoptimised code while the in-process baseline
— timed over repeated passes — was fully JIT-warm. V8's optimising tier
is a cliff around 800 iterations, not a curve
([blocked-summation.md](blocked-summation.md) says so in as many words).
Warm against cold.

Warmed properly, there is **no crossover in the swept range**:

| workload | rows | per request | in-process | pool(8) |           |
| -------- | ---- | ----------- | ---------- | ------- | --------- |
| distinct | 50k  | 0.5 ms      | 15 ms      | 4 ms    | **4.02×** |
| distinct | 200k | 1.1 ms      | 35 ms      | 11 ms   | 3.14×     |
| distinct | 500k | 2.8 ms      | 89 ms      | 26 ms   | 3.39×     |
| distinct | 2M   | 10.3 ms     | 330 ms     | 104 ms  | 3.17×     |
| repeated | any  | ~0 ms       | ~0 ms      | 2–26 ms | **0.01×** |

**What actually decides it is the cache-hit rate.** On distinct work the
pool wins ~3–4× at every size tested. On _repeated_ work it is
catastrophic — in-process, a re-asked question is a memo hit that returns
the same column object for approximately nothing, while a pool copies and
ships every answer no matter how cheap it was. Each worker also warms its
own graph, so N workers hold up to N copies of a hot column. **Pooling
and caching compete; they do not compose.**

### The op matters more than the worker count

The pool's ceiling turned out to be a property of the _op_, not the pool.
The same rolling mean, written two ways, 32 requests over 2M rows:

| op output              | in-process | pool(8) | speedup |
| ---------------------- | ---------- | ------- | ------- |
| boxed (`new Array`)    | 1849 ms    | 632 ms  | 2.92×   |
| typed (`Float64Array`) | **482 ms** | 121 ms  | 3.98×   |

Read the in-process column first. **Fixing the op was worth 3.8× on one
thread — more than eight workers bought the unfixed one** (482 ms
single-threaded versus 632 ms across eight). Boxing does not merely cost
more; it parallelises worse, because it contends on memory bandwidth and
per-isolate GC, which is exactly the resource extra workers cannot add.

A corollary worth keeping: **a high pool speedup can be a symptom of a
slow op.** The boxing version showed a _better_ ratio before the op was
fixed, because parallelism was hiding the waste.

## What's missing (the task)

Three pieces, none conceptual — see [PND-PROCPAR] in
[PND_PROCESS_PLAN.md](../plans/PND_PROCESS_PLAN.md):

1. an **async engine path** (`OpDef.run` and `run()` are sync; the
   ready-set loop needs an awaitable executor seam);
2. a **financial op pack** — the studies as registry ops decomposed over
   shared rolling primitives (vocabulary work, the same shape the fluent
   layer was);
3. **pool plumbing** — lifecycle, per-isolate JIT warm-up (the ~800-
   iteration tier-up cliff applies per worker), source-version
   invalidation broadcast, SAB residency convention at ingest.

Cache stays main-side; workers are stateless compute, so there is no
coherence problem. Sequencing: process is deliberately WIP and
[PND-PROCIDENT] blocks interactive consumers — this task queues behind
the package's own gates, and arrives as the friction signal the RFC
model wants rather than jumping the line.
