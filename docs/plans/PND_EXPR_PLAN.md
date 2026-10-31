# PND_EXPR — column expressions

Breakout plan for [PND-EXPR] in [PLAN.md](../../PLAN.md). Design and
reasoning: [`docs/rfcs/expressions.md`](../rfcs/expressions.md).

## Decisions (pjm17971, 2026-10-31)

- Expressions before bridge step J2.
- Plain `col('name')`, checked when the expression is applied (no typed
  column names in v1).
- Names `col` / `lit`, as polars.
- `mapColumns`: a gap cell stays a gap; `withColumn` is where gaps get
  filled.
- `when(cond, then, otherwise)` is in v1.

## Steps

- **E1, pond-ts:** expression builder, schema checks, column-wise
  evaluator; `filter`, `find`, `some`, `every`, `mapColumns`, `withColumn`,
  live `filter` accept an expression. Tests pin "expression gives the same
  answer as the function it replaces"; `scripts/perf-expr.mjs`.
- **E2, pond-rs + bridges:** `Expr` in pond-rs, JSON form through
  `@pond-ts/rs` and `pond_rs`; the core parity fixture gains expression
  cases.
- **E3:** more operations only when a friction report asks.

## E1 outcome (PR #865, awaiting pjm17971's OK)

- `packages/core/src/core/expression.ts`: builder, `checkExpr`, per-row
  `evaluateRow` (live). `src/batch/operators/expression.ts`: column-wise
  evaluator. Values in flight: `Float64Array` (NaN gap), `Int8Array`
  (1 / 0 / -1 gap), string arrays.
- Cost: O(N × nodes) per expression; `filter` then copies the kept rows.
- Fast paths that mattered (1M rows): a number literal is used as a scalar,
  not spread to a full array; text `eq` / `ne` / `in` against fixed values
  on a dictionary-coded column decide once per dictionary entry; the
  evaluator writes over its own intermediate results in place (each fresh
  1M-row array costs ~4 ms to touch).
- Measured, function vs expression (ms): filter `v > 0` 52 vs 17;
  `v / w > 10 and host = h3` 47 vs 19; sparse 24 vs 5.4; `some` no match
  123 vs 4; `withColumn v / w` 37 vs 4.1; `mapColumns v * 1.8 + 32` 4.7 vs
  8.6 (slower: four passes against one; the gain there is reading other
  columns).
- Not done: `scan` / `collapse` keep functions only (RFC §9).
