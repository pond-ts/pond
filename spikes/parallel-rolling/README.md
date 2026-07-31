# Parallel rolling windows — the two slowest studies

`bollinger` and `zScore` are the most expensive things on the
[benchmarks page](../../website/docs/reference/benchmarks.mdx) (26.7 ms
and 19.1 ms over 500k bars). Neither is a recurrence: each output cell
depends only on the window `[i-p+1, i]`, so partitioning by **output
range** with a `p-1` element overlap is embarrassingly parallel. Each
chunk reads a little before its range and is otherwise independent.

## Measured (node 22, 10 cores, 500k bars, period 20, 8 workers)

| study       | pond today | spike, 1 worker | spike, 8 workers |                     |
| ----------- | ---------- | --------------- | ---------------- | ------------------- |
| `bollinger` | 25.4 ms    | 26.0 ms         | **1.89 ms**      | **13.8× vs itself** |
| `zScore`    | 18.2 ms    | 21.2 ms         | **2.14 ms**      | **9.9× vs itself**  |

The single-worker spike lands within a few percent of pond's own study,
so it is a fair stand-in for the kernel rather than a faster algorithm
in disguise.

### Why it is superlinear

13.8× on 8 workers is not a measurement error, and it is worth
understanding before trusting it. Per element: 52 ns single-threaded
against 30 ns per worker when partitioned — **1.7× better per element**,
times 8 workers. The cause is cache. One sweep streams 4 MB of input and
12 MB of output past a single core; a 62.5k-row chunk works in ~500 KB
of input and 1.5 MB of output, which stays resident. Partitioning buys
locality on top of parallelism.

## The numerics, which differ per study

Chunk 0 shares the sequential sweep's history exactly, so 1/8 of cells
are bit-identical; the other seven chunks start their Welford state fresh
and differ.

| study       | bit-identical | median rel. | p99     | worst      | cells > 1e-9  |
| ----------- | ------------- | ----------- | ------- | ---------- | ------------- |
| `bollinger` | 12.51%        | 7.1e-14     | 3.5e-13 | 5.3e-13    | **0** of 1.5M |
| `zScore`    | 12.50%        | 4.5e-11     | 1.2e-9  | **5.3e-6** | 5,261 of 500k |

**`bollinger` is comfortably safe** — not one cell in 1.5 million differs
by more than 1e-9 relative.

**`zScore` is not, and the reason is inherent to the study rather than to
chunking.** It divides by the rolling standard deviation, so wherever the
window is nearly flat, a last-ulp difference in `mean` or `sd` is
amplified without limit. ~1% of cells land beyond 1e-9, and the worst is
5.3e-6. That is a visible change to a published number, and
`@pond-ts/financial` pins its studies bar-for-bar against a pandas
oracle — so this one needs a decision, not just a benchmark.

## Run

```sh
node spikes/parallel-rolling/main.mjs
N=2000000 node spikes/parallel-rolling/main.mjs
```

## Caveats before anyone quotes the speedups

- The spike writes into **pre-allocated** `SharedArrayBuffer`s. A real
  implementation still has to produce output columns, so end-to-end will
  be slower than 1.89 ms. (Single-worker spike ≈ pond suggests that cost
  is small next to the kernel, but it is not zero.)
- It needs SAB-backed inputs, or a copy.
- Two barriers, ~72 µs; irrelevant at 500k rows, decisive below ~100k.
- Like [`../parallel-scan/`](../parallel-scan/), this needs **no**
  process-engine change. It is a kernel concern, not blocked behind
  [PND-PROCPAR]'s injection seam.
