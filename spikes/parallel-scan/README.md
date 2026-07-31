# Parallel scan — the "sequential" recurrences are not sequential

A correction to
[`docs/notes/worker-threads-assessment-2026-07.md`](../../docs/notes/worker-threads-assessment-2026-07.md),
which listed `ema` / `cumulative` / `smooth` under "what it cannot help"
because they are sequential recurrences. **That was wrong.** A
first-order linear recurrence

```
y[i] = a·y[i-1] + b[i]
```

is the textbook case for a parallel scan: affine maps compose
associatively — `(f∘g)(y) = (a_f·a_g)·y + (a_f·b_g + b_f)` — so the
prefixes can be computed in parallel even though each value "depends on"
the last.

The practical form needs only **two barriers**, not a log-depth tree:

1. **parallel** — each chunk runs the ordinary recurrence assuming its
   incoming value is `0`, recording its last value and `A = aⁿ`;
2. **sequential, K steps** — fold those K summaries into each chunk's
   true incoming value. K is the worker count (8), not the row count;
3. **parallel** — each chunk adds `aᵏ · incoming` to its cells.

## Measured (node 22, 10 cores, 2M rows, 8 workers)

| EMA period | sequential | parallel scan |           | bit-identical | max rel. error |
| ---------- | ---------- | ------------- | --------- | ------------- | -------------- |
| 20         | 4.45 ms    | 1.42 ms       | **3.14×** | **99.91%**    | 5.2e-16        |
| 2,000,000  | 4.46 ms    | 1.23 ms       | **3.64×** | 12.62%        | 1.1e-13        |

The two rows are the same algorithm in two regimes, and the difference
is worth understanding:

- **When the recurrence decays** (a real EMA, `a ≈ 0.905`), the
  correction term `aᵏ` underflows to exactly zero a few hundred cells
  into each chunk — so all but the cells near a chunk boundary are
  computed by literally the same arithmetic as the sequential version.
  **99.91% bit-identical, and the rest within 2 ulps.**
- **When it barely decays** (`a → 1`, i.e. a cumulative sum), the
  correction reaches every cell and the result is a reassociation — the
  same class, and the same magnitude of difference, as
  [`blocked-summation.md`](../../docs/notes/blocked-summation.md)
  already documents and ships.

So the numerical objection that rules out chunking a _rolling window_
does not rule this out: for a decaying recurrence the answer is very
nearly the same bits, and for a non-decaying one it is the trade the
library has already made deliberately.

## Run

```sh
node spikes/parallel-scan/main.mjs            # EMA(20)
PERIOD=2000000 node spikes/parallel-scan/main.mjs
N=500000 K=4 node spikes/parallel-scan/main.mjs
```

## What this does and does not mean

It needs **no process-engine change**: this is raw workers over a
`SharedArrayBuffer`, so it belongs to the kernels, not to
[PND-PROCPAR]'s blocked injection seam.

It also wins on an operation that is _already fast_ — `ema(20)` over
500k bars is 2.08 ms on the benchmarks page. Two barriers measured
~72 µs, so the technique needs work well above ~150 µs to pay, and
below ~100k rows it will not. The prize is not `ema`; it is that the
same reasoning applies to the operations that _are_ slow, and that
"this algorithm is inherently sequential" is a much weaker claim than
it looks.
