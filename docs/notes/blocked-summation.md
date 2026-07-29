# Blocked summation — the reassociation decision (2026-07)

**pond-ts sums long runs of doubles into eight independent accumulators
rather than one.** That is 2.2–2.5× faster and it **can change the last
ulp of the answer**, because floating-point addition is not associative.

This note is the record of that trade: what changed, what it costs, and
where the line was drawn. Sibling of
[`reducer-nan-policy.md`](reducer-nan-policy.md) — both describe numeric
semantics a caller can observe.

Kernel: [`packages/core/src/reducers/blocked.ts`](../../packages/core/src/reducers/blocked.ts).
Tests: `packages/core/test/blocked-summation.test.ts`.

## What changed

`sum` and `avg` accumulate `s += values[i]` in a single running total.
Every add waits on the one before it, so the loop is **latency-bound** —
a core with several floating-point pipelines runs one of them. Eight
independent partial sums break that chain; the adds issue in parallel
and the loop runs at throughput instead.

Measured, 500k dense `f64`, node 24 on Apple silicon:

| path                        | sequential | blocked-8 |           |
| --------------------------- | ---------- | --------- | --------- |
| dense, no validity          | 0.472 ms   | 0.188 ms  | **2.51×** |
| validity bitmap, 4% missing | 0.620 ms   | 0.279 ms  | **2.22×** |

End to end on the agent-query benchmark, `close.mean()` over 500k bars:
**0.47 ms → 0.19 ms (2.47×)**.

## Where the line is

Blocking is **not free at every size**. Eight accumulator inits plus
seven combining adds is ~15 fixed operations, and below eight elements
the blocked loop does not execute at all — every cell falls through to
the scalar tail, so at tiny sizes the fixed cost buys nothing. Measured
over 4096 sliding windows with a monomorphic call site per kernel
(`scripts/perf-blocked-sum.mjs`, the durable form of this table):

| n    | speedup |                          |
| ---- | ------- | ------------------------ |
| 4    | ~1×     | ← noise floor; see below |
| 8    | 1.1×    |                          |
| 16   | 1.2×    |                          |
| 32   | 1.5×    |                          |
| 64   | 1.8×    |                          |
| 256  | 2.2×    |                          |
| 4096 | 2.4×    |                          |

So `BLOCKED_MIN = 32`: the point where the win is unambiguous, and above
any bucket size a reader would check by hand.

That threshold is doing **two** jobs. The lesser one is not bothering
where the win is noise. The load-bearing one is that every run below it
stays on the sequential path and therefore stays **bit-identical to what
pond-ts returned before blocking existed** — which is what keeps the
exact-equality row-path parity tests (`aggregate() columnar fast path —
parity with the row path`, comparing 3–4 element buckets with `toEqual`)
meaningful rather than merely passing.

### Two measurement artifacts, both worth keeping

This table was wrong twice before it was right, in instructive ways.

The first version showed blocking winning at _every_ size, including
2.69× at n=4. Artifact: the benchmark called `sum(v, 0, n)` with
identical arguments each rep, so V8 hoisted the loop-invariant call
entirely. Fixed with sliding windows.

The second version (and the one this note originally published) showed
n=4 as a **0.26× regression**. Also an artifact, of the opposite kind:
both kernels were timed through one shared harness closure `mk(f)`, so
the inner `f(...)` call site turned megamorphic after the first kernel
— deoptimizing whichever was measured later. Measured seq-first that
reads "blocked is 3.8× worse"; a later variant of the same bias read
"blocked is 1.9× better". With a separate, monomorphic harness per
kernel, n=4 is **near parity and unresolvable** — the work is a handful
of nanoseconds, below what an in-process microbenchmark can separate.

The a0659bc commit message repeats the 0.26× figure; this section is
its correction. The threshold's justification never rested on n=4: the
robust facts are the clear wins at ≥ 32 and the bit-identity guarantee
below.

## Blocking is _more_ accurate, not less

Worth being precise, because "reassociated floating-point sum" reads as
a precision compromise and this is the opposite.

Sequential summation accumulates rounding error as **O(n·ε)**: the
running total grows, and once it is large enough, each new addend loses
low bits to the exponent gap. Summing into `k` independent accumulators
accumulates error as **O((n/k)·ε + k·ε)** — eight partial sums each
carry a chain one-eighth as long.

Both are pinned as tests:

- 10⁶ copies of `0.1` (exact answer 100000) — the blocked result is
  strictly closer to the true sum than the sequential one.
- `1e16` followed by 8191 copies of `1` — sequential returns exactly
  `1e16`, having absorbed **every single 1** into the exponent gap.
  Blocked keeps seven of the eight chains small, so their contribution
  survives.

So the honest framing is not "faster but sloppier". It is faster **and**
tighter. What it is not is _bit-identical to pond-ts's previous output_,
and that is the property a caller may have been relying on.

## What a caller can observe

- A `sum()` / `mean()` over a run of **≥ 32 cells** may differ from the
  pre-change result in the last ulp or two. It will generally be the
  better answer. ("32 cells" counts **range positions, not defined
  values** — a 32-cell range with gaps still blocks; the gate is O(1) by
  design, and the threshold is a perf crossover, not a semantic
  boundary.)
- A `sum()` / `mean()` over **< 32 cells** is unchanged, bit for bit.
- The **row path** (`reduce(_d, numeric)`, a plain
  `numeric.reduce((s, v) => s + v, 0)`) is still sequential, so a
  columnar sum over ≥ 32 cells can differ in the last ulp from the row
  sum of the same values. pond-ts does **not** guarantee bit-identical
  results across those two paths; it guarantees each is a correctly
  rounded IEEE-754 double summation of the same contributors.
- Nothing about **which cells contribute** changed. The validity bitmap
  and the non-finite policy behave exactly as
  [`reducer-nan-policy.md`](reducer-nan-policy.md) describes; only the
  order of the additions moved.

## What was deliberately left sequential

- **The guarded path** (`allFinite: false`, where a per-element
  `Number.isFinite` check is required). Blocking measures **1.84×** there
  and the code is straightforward, but after [PND-WCNAN] chose
  NaN-as-missing at typed intake, `allFinite` is true for essentially
  every column the target workload builds — so this is a cold path
  carrying a semantics change for no measured benefit. Revisit if a
  workload lands on it.
- **`stdev`**. It is a Welford recurrence, not an accumulation loop;
  reassociating it is a different (and much more delicate) problem.
- **The rolling kernel.** `sweepRollingColumn` maintains an incremental
  add/remove window, not a sum over a range — it never calls these
  kernels, which is why the `@pond-ts/financial` pandas oracle is
  untouched by this change.

## Related: the 4-lane `minMax` is _not_ bit-identical

[PND-KERNEL] listed a lane-parallel `Float64Column.minMax` as
"bit-identical, 1.27–1.50×". **That claim is wrong**, found while
scoping this change.

`min`/`max` are exactly associative on ordinary doubles, but `+0` and
`-0` compare equal, so `lo = lo <= x ? lo : x` keeps whichever the
traversal reached first — and lane-parallel traversal reaches a
different one. Counterexample, verified: 16 cells, all `1` except
`values[1] = +0` and `values[4] = -0`. Sequential yields `+0`; 4-lane
yields `-0`. `===` calls them equal, `Object.is` does not — and vitest's
`toBe` uses `Object.is`.

That matters because `Float64Column.prototype.minMax` explicitly commits
to matching `[col.min(), col.max()]` (PR #153). Shipping the lane form
would break that commitment on `±0` input, for 1.27–1.50× on an
operation already costing 0.49 ms. Not taken; the plan entry is
corrected.
