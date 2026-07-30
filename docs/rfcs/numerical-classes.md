# RFC: numerical classes — making accuracy a property, not a measurement

**Status:** draft, not adopted. RFCs are context, not commitments; only
tasks adopted into [PLAN.md](../../PLAN.md) are.

**Author:** pond-ts library agent (Claude), 2026-07

---

## 1. The problem, stated by a failure

`@pond-ts/financial/parallel` shipped `zScore` with a documented accuracy
figure: _"~2.6e-6 across ~0.8% of cells."_ It appeared in the docstring,
the CHANGELOG, API.md and the plan. The decision to ship a parallel
`zScore` at all was taken on the strength of it.

It was not a bound. It was a measurement of one benign random walk that
the author generated. A Codex adversarial pass supplied a legal
near-flat series at large magnitude — `1e15 + ((i % 7) - 3)`, period 20,
four chunks — on which the partitioned answer differs from the
sequential one by **38% relative**, with 5–15% at other offsets
(verified independently; now a regression test).

The mechanism is not a bug. `zScore` divides by the rolling σ. On a
near-flat window σ carries almost no significant digits, so a last-ulp
difference between two sweeps becomes an arbitrarily large relative
difference in the quotient. **No care in the kernel fixes it, and no
quantity of testing establishes a bound, because there isn't one.**

Four claim-or-measurement errors in that single work stream were caught
only by adversarial review. That is a base rate, not bad luck, and the
common shape is always the same: **a property was inferred from a
sample.**

## 2. Why this gets worse, not better

pond is being aimed at agent-driven query flurries. An agent composes
operators however it likes — that is the point of the declarative plan
layer, and `registry.toJsonSchema()` exists precisely so a model can
assemble pipelines nobody enumerated.

So the input distribution is not ours to choose. An agent is an
unbounded generator of inputs the library author did not imagine, which
is exactly the thing that broke the `zScore` figure. Waiting for a
friction report is not a strategy when the friction is a silently wrong
number in a trading decision.

And the control surface is wrong. A careful docstring warns a human
reading source. **An agent composing a plan never reads it.** The
registry is what an agent sees.

## 3. The proposal: classify, don't measure

Numerical robustness under partitioning (and under reassociation
generally) is a property of an operator's **form**, derivable by reading
it once, rather than of any workload.

| Class             | Meaning                                                                                                        | Examples                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **E — exact**     | Associative and state-free. Partitioning cannot change the answer at all.                                      | `min`, `max`, `first`, `last`, `count`, `sum` of exact integers                                  |
| **B — bounded**   | Reassociation shifts the result, with an error bound that is provable and small (relative, O(ε·√n) or better). | `sum`, `mean`, rolling mean, blocked summation, `bollinger`'s bands                              |
| **U — unbounded** | Divides by, or subtracts, a quantity that can cancel to near zero. Relative error has no bound.                | `zScore`, `percentChange` near a zero base, σ on flat windows, ratios and correlations generally |

Three claims, each cheap to check and each stronger than a benchmark:

- **E is a proof**, not a tolerance. An `E` op needs no accuracy test at
  all, only a partition-equivalence test.
- **B is provable** from the reassociation argument already written down
  in [`blocked-summation.md`](../notes/blocked-summation.md).
- **U is a refusal.** There is nothing to measure and nothing to
  document that makes it safe; the only honest options are "do not
  parallelise this" or "the caller states they accept it".

## 4. Composition is where this earns its keep

The rule is closed under composition, which is what makes it survive an
agent:

> A pipeline's class is the **worst** class of any operator in it, and a
> `U` operator poisons everything downstream of it.

That holds for pipelines nobody enumerated, which is the whole
requirement. It also means the classification effort is bounded.

**The unit is kernels, not studies.** The financial indicator assessment
([financial-indicators-assessment-2026-07.md](../notes/financial-indicators-assessment-2026-07.md))
maps roughly **120 studies onto 11 kernels (K1–K11)**. Classify eleven
things once, and every study — the ten shipped, the ~110 planned, and
ones not yet conceived — inherits its class from the kernels it is
assembled from. A first pass, to be argued with rather than accepted:

| Kernel | What it is                   | Class                    | Why                                                                                                                                |
| ------ | ---------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| K1     | Rolling window reducer       | E / B / U **by reducer** | `min`/`max` are E; `sum`/`avg` are B; `stdev` is B in isolation but feeds U consumers                                              |
| K2     | Moving-average engine        | B                        | EMA is a linear recurrence — parallel scan is B (see [`spikes/parallel-scan/`](../../spikes/parallel-scan/), 99.91% bit-identical) |
| K3     | Per-bar arithmetic           | inherits inputs          | Row-wise, no state; adds no error of its own                                                                                       |
| K4     | Previous/N-bar reference     | E                        | A shift is exact                                                                                                                   |
| K5     | Cumulative-from-anchor       | B                        | Prefix sum; reassociation-stable                                                                                                   |
| K6     | Path-dependent state machine | **not partitionable**    | Regime flips depend on unbounded history; a chunk boundary changes the state, not the last ulp                                     |
| K7     | Rolling linear regression    | **U**                    | Closed-form slope divides by a variance that cancels on flat windows — the `zScore` failure with more steps                        |
| K8     | Two-series bivariate moments | **U**                    | Correlation divides by the product of two σ; same cancellation, squared                                                            |
| K9     | Value-domain histogram       | E                        | Binned counts and sums                                                                                                             |
| K10    | Band combinator              | inherits centre/width    | `bollinger` is B because its inputs are                                                                                            |
| K11    | Session-anchored windows     | E                        | Partition on session boundaries and it is exact                                                                                    |

If that table is right, two things follow immediately that no
per-study benchmark would have told us: **K7 and K8 are `U`**, so
regression slopes, Beta and Correlation carry the `zScore` hazard before
anyone has written them; and **K6 is not partitionable at all**, so
PSAR/SuperTrend must be excluded by construction rather than by someone
remembering.

## 5. Making it a control surface

`OpDef` already carries a typed property the engine **enforces**:
`unit`. A mismatched unit raises `UnitError` at compile time in
`BoundGraph.compile`, naming both sides. Numerical class is the same
shape of thing and should work the same way.

1. **`OpDef.numericalClass: 'exact' | 'bounded' | 'unbounded'`** —
   declared per op, defaulting to `unbounded` so an unclassified op is
   refused rather than silently trusted. (Conservative defaults are the
   `allFinite` lesson: a missed `true` is slower, a wrong `true` is a
   silent wrong answer.)
2. **`withWorkers` refuses a `U` op** unless the caller passes something
   explicit — `{ workers: 8, allowUnbounded: ['zScore'] }`, naming what
   they are accepting. Today the hazard lives only in prose; this
   inverts the default from _opt into parallel and inherit a footgun_ to
   _opt into the footgun specifically_.
3. **`registry.toJsonSchema()` carries the class**, so a composing agent
   can see it before building a plan, and a refusal names the operator
   and the reason in terms it can act on.

This is the anticipatory move the whole RFC is for: arbitrary
composition gets **checked**, rather than enumerated in advance or
discovered in production.

## 6. Tests must generate, not sample

Every accuracy figure in the parallel work came from one benign random
walk. Codex broke it in a single pass by hand-picking an input. The
replacement is property-based:

- **Generators**: near-flat series, large-magnitude offsets, mixed
  scales, long gap runs, denormals, alternating signs, values straddling
  zero.
- **Assertions are the class contract**, not a number: an `E` op must be
  **bit-identical** under any partitioning; a `B` op must stay inside its
  stated relative bound; a `U` op is not tested for accuracy at all
  because the claim is that it has none.

An `E` claim that fails is a real bug. A `B` claim that fails means the
bound is wrong. Neither can be papered over by widening a tolerance —
which is what the `zScore` test did, asserting `<1e-4` against a
documented `2.6e-6`, 38× looser than the claim it existed to protect.

## 7. What this costs

Honest accounting. Declaring a class per op is small but not free, and
it is **a promise** in the same way `allFinite` is — a wrong `exact` is
a silent wrong answer, so the default must be the conservative one. The
refusal in `withWorkers` will annoy someone who knows their data is
well-conditioned, which is what the explicit escape hatch is for.

The classification in §4 is an argument, not a result. K1's split by
reducer in particular deserves attack, and the K7/K8 calls are made from
the closed forms rather than from a shipped implementation.

## 8. Relationship to existing work

- [`blocked-summation.md`](../notes/blocked-summation.md) is the `B`
  argument, already written and shipped: reassociation with a stated
  error model and a threshold that keeps small runs bit-identical.
- [`worker-threads-assessment-2026-07.md`](../notes/worker-threads-assessment-2026-07.md)
  and `[PND-SCANKERN]` are what produced the failure that motivates this.
- `[PND-PROCPAR]`'s latency half is still blocked on an engine seam;
  this RFC argues it should also be blocked on a class for every op it
  would schedule.
- The `unit` system in `plan/identity.ts` and `BoundGraph.compile` is the
  working precedent for a declared, enforced, agent-visible property.

## 9. Open questions

- Is three classes the right granularity, or does `B` need splitting by
  bound magnitude?
- Should class be **derived** from a kernel dependency graph rather than
  declared per op, so a study cannot mis-declare itself?
- Does `U` deserve to exist at all in a parallel path, or should
  `withWorkers` simply never accelerate a `U` op regardless of what the
  caller says?
- Do the classes extend usefully beyond parallelism — to a
  `float32` storage mode, to GPU offload, to any future reassociating
  optimisation?
