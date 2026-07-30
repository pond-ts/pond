> **Shipped.** This prototype became `rollingDeviationSd` in
> `packages/financial/src/kernels/rolling.ts`, and `zScore` now uses it.
> The landed kernel differs from the probe in one way that mattered: it
> shifts the **Welford accumulator** as well as the mean. Shifting only
> the mean left σ computing `x − wMean` on raw values — the same
> cancellation — and capped the improvement three orders of magnitude
> short. See [PND-SHIFTFRAME] in PLAN.md.

# Shifted-frame rolling — the `zScore` hazard is removable

A correction to
[`docs/rfcs/numerical-classes.md`](../../docs/rfcs/numerical-classes.md)
and to three committed docstrings, all of which explain the parallel
`zScore` divergence as **"dividing by a near-zero σ."** Decomposition
says that is not the dominant mechanism, and the real one has a fix.

## What is actually going on

At the worst-disagreeing row of the `1e15 + ((i % 7) - 3)` counterexample:

| quantity       | sequential | partitioned | relative difference    |
| -------------- | ---------- | ----------- | ---------------------- |
| `mean`         | —          | —           | **3.75e-16** (one ulp) |
| **`v − mean`** | −1.0000    | −0.6250     | **6.0e-1**             |
| `σ`            | 2.042899   | 2.062879    | 9.7e-3                 |

σ contributes ~1%. **The numerator contributes 60%.**

`ulp(1e15)` is `0.125`, so a window spanning ±3 covers about **48 ulps**.
Computing `v − mean` where both are ≈1e15 and the answer is ≈1.0 leaves
roughly **three bits** of information. A one-ulp disagreement in `mean`
is then ~12% of the answer.

So the exposure is **catastrophic cancellation in the numerator**, set by
the ratio of the data's magnitude to its spread — not by σ, and **not by
parallelism**. Both sweeps run the same Welford add/remove chain; they
merely carry different rounding histories and land one ulp apart, which
this input amplifies.

## The fix

Accumulate `v − anchor` instead of `v`, where `anchor` is any value near
the window (here, the first row the chunk touches). The variance is
translation-invariant, so σ is unchanged. The mean is then carried as
`anchor + offset` with `offset` small — and the quantity the consumer
actually wants becomes

```
v − mean  ≡  (v − anchor) − offset
```

both operands small, so nothing cancels. `v − anchor` is itself exact
when the two are close (Sterbenz).

## Measured

`node spikes/shifted-frame/probe.mjs` — 200k rows, period 20, 4 chunks,
worst relative error against an exact reference:

| input                  | current           | shifted frame |
| ---------------------- | ----------------- | ------------- |
| `1e15 + ((i % 7) − 3)` | **6.5e+0** (650%) | **8.8e-15**   |
| random walk ≈100       | 8.5e-9            | 2.0e-10       |

It removes the pathological case outright and is ~40× better on benign
data too — because the cancellation is a matter of degree everywhere,
not a cliff that only appears at 1e15.

## A measurement note, because it nearly fooled me again

The first version of this probe used a two-pass "exact" reference that
summed 20 values of ~1e15. That sum is ~2e16, where `ulp` is **4**, so
the reference itself carried ~0.2 of error in the mean — 20% of a
deviation of ~1. It was not a reference; it was a third wrong answer,
and it reported the shifted frame as barely better (8.0e-1 vs 1.0e+0).
Anchoring the reference too is what made the real result visible.

The tell was that the measurement contradicted the theory. That is worth
more than the result.

## What it implies

**`zScore` is not inherently `U`-class.** The unboundedness was a
property of the _formulation_, not the operator — which means the
numerical classification should drive **reformulation**, not just
refusal. That is a materially better position than "do not parallelise
this study."

Note also that the sequential path has the same exposure: pond's
`zScore` today computes `(v − mean) / σ` from an absolute rolling mean,
so this is a **correctness improvement for every caller**, not a
parallel-only fix.
