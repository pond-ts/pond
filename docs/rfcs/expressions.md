# RFC: Column expressions

**Status:** draft for review. Not a commitment until PLAN.md adopts a phase
(see [CLAUDE.md → Strategic RFCs](../../CLAUDE.md)).

**Relationship to PLAN.md:** would sit beside the pond-rs bridges
([PND-RUST-R4] in [`PND_RUST_PLAN.md`](../plans/PND_RUST_PLAN.md)); pjm17971
chose (2026-10-31) to settle expressions before the bridge's J2 step.

**Authorship:**

| Section        | Contributor                                           |
| -------------- | ----------------------------------------------------- |
| Original draft | pond-ts library agent (Claude) + pjm17971, 2026-10-31 |

---

## Original draft: pond-ts library agent (Claude) + pjm17971, 2026-10-31

### 1. The problem

Several pond methods take a JavaScript function that runs once per row:
`filter`, `find`, `some`, `every`, `mapColumns`, `scan`, `collapse`, and
the live layer's `filter` / `map`. Most such functions are simple: "value
above 0", "host is `a`", "celsius to fahrenheit", "cpu divided by cores".

A function is opaque. The library cannot look inside it, so it must call it
once per row, and must hand it a row in the shape the function expects. That
costs a lot in two places:

- **Through the WebAssembly bridge** (`@pond-ts/rs`), each call crosses from
  WebAssembly into JavaScript. Measured on 1M rows (2026-10-30, merged J1b,
  median of 7 runs; benchmark script not committed):

  | operation                       | pond-ts | bridge   |
  | ------------------------------- | ------- | -------- |
  | `filter((e) => e.get(v) > 0)`   | 143 ms  | 1,191 ms |
  | `mapColumns({ v: (x) => x*2 })` | 13 ms   | 324 ms   |
  | `scan(v, running sum)`          | 30 ms   | 769 ms   |
  | `diff(v)` (no function)         | 6 ms    | 1.2 ms   |

- **In pond-ts itself**, `filter` builds an `Event` object per row so the
  function can call `e.get(...)`. That is most of its 143 ms; a hand-written
  loop over the column array doing the same test and copy took ~27 ms.

The Python bridge has the same shape of cost (each call takes the
interpreter lock and builds Python objects).

Faster function calls (the planned J2 "column handoff": give JavaScript the
columns once, read cells lazily) will narrow the bridge gap but cannot close
it, because a function call per row remains.

### 2. The proposal in one paragraph

Add a small **expression** vocabulary that describes per-row logic as data
instead of code: `col('value').gt(0)`. An expression is a plain tree that
pond can inspect, so it can run over whole columns at once: in JavaScript
for pond-ts, in Rust for pond-rs and both bridges. Every method that takes
a per-row function today also accepts an expression. Functions stay; they
remain the escape hatch for anything the vocabulary cannot say.

### 3. What it looks like

```js
import { col, lit } from 'pond-ts'; // the same names from '@pond-ts/rs'

// filter / find / some / every: a true/false expression
s.filter(col('value').gt(0).and(col('host').eq('a')));
s.find(col('status').in(['error', 'fatal']));

// mapColumns: each column maps to an expression (may read other columns)
s.mapColumns({ value: col('value').mul(1.8).add(32) });

// withColumn: a new column from an expression
s.withColumn('load', col('cpu').div(col('cores')));

// live
live.filter(col('value').gt(0));
```

Rust (pond-rs), same tree:

```rust
s.filter_expr(&col("value").gt(0.0).and(col("host").eq("a")))?;
s.with_column_expr("load", &col("cpu").div(col("cores")))?;
```

Python (`pond_rs`): `s.filter(col("value") > 0)` (operator overloading is
idiomatic there; same tree underneath).

### 4. First vocabulary

Kept deliberately small; grows only when real code asks.

| group      | operations                                        | result     |
| ---------- | ------------------------------------------------- | ---------- |
| leaves     | `col(name)`, `lit(value)`; plain values auto-wrap | cell kind  |
| compare    | `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `in([...])`   | true/false |
| logic      | `and`, `or`, `not`                                | true/false |
| arithmetic | `add`, `sub`, `mul`, `div`, `neg`, `abs`          | number     |
| gaps       | `isMissing()`, `fill(value)`                      | as named   |
| choice     | `when(cond, then, otherwise)`                     | cell kind  |

Not in v1: string functions (`startsWith`, `contains`), rounding, time
functions (hour of day, weekday), array columns. Each is a candidate once a
friction report needs it.

### 5. Gaps: match what functions do today

The rule is that an expression gives the same answer as the obvious function
it replaces. Today a function sees a gap as `undefined`, so:

- **Comparisons with a gap are false.** `col('v').gt(0)` drops gap rows,
  exactly as `(e) => e.get('v') > 0` does (`undefined > 0` is `false`).
- **`not` flips plainly.** `col('v').gt(0).not()` keeps gap rows, as
  `(e) => !(e.get('v') > 0)` does. This is JavaScript's two-valued logic,
  not SQL's "unknown"; it surprises SQL users, so the docs say it loudly
  and point at `isMissing()`.
- **`eq` with a gap is false**; test for gaps with `isMissing()`.
- **Arithmetic with a gap is a gap**, as `undefined * 2` is `NaN`, which a
  number column stores as a gap. Division by zero gives a gap too (pond
  stores non-finite numbers as gaps).
- **`mapColumns` with an expression** follows today's rule: a gap cell stays
  a gap even if the expression would produce a value, so `fill` only does
  something in `withColumn`. Open question 3 asks whether that is right.

Each rule gets parity cases (function form and expression form must give
identical series) in the shared core fixture, so pond-ts, pond-rs and both
bridges are checked against the same answers.

### 6. Checking

An expression is checked against the schema when a method receives it,
before any row runs:

- unknown column: error naming the column and listing the real ones;
- kind mismatch (`col('host').gt(0)` on a text column, `add` on text,
  `filter` given a number expression): error naming the operation;
- `in([...])` values must match the column's kind.

In TypeScript, `col(name)` takes a plain string, so names are checked at
run time, not by the compiler. Open question 1 covers a typed form.

### 7. How it travels

An expression serialises to JSON, e.g.

```json
{ "op": "gt", "args": [{ "col": "value" }, { "lit": 0 }] }
```

The bridge already sends method arguments as JSON, so an expression needs
no new transport: Rust parses the tree and evaluates it over columns. The
same JSON form is what a stored dashboard config or an agent's tool call
could carry, which a function never can.

### 8. Expected gains (estimates, to be measured in phase E1/E2)

- Bridge `filter` on a numeric comparison: the work is close to `diff`'s
  (one pass over one column, plus copying the kept rows), so a few
  milliseconds instead of ~1,200 ms. **Estimate.**
- pond-ts `filter`: no per-row `Event`; the column-loop proxy above took
  ~27 ms against 143 ms. **Estimate.**
- pond-ts `mapColumns` is already column-based (13 ms), so expressions there
  gain reading other columns, not speed.

### 9. Not doing

- Not a query language: no aggregation inside expressions (that is
  `aggregate` / `rolling`), no looking at other rows (that is `shift` /
  `diff` / `cumulative`), no joins.
- No user-defined functions inside expressions: that is what a function
  argument is for.
- `scan` and `collapse` keep functions only. `scan`'s common use, a running
  total, already has `cumulative({ v: 'sum' })`; arbitrary state does not
  fit a fixed vocabulary.
- No string parsing (`"value > 0"`): a parser is a second language to
  maintain; the builder is enough.

### 10. Phases

- **E1, pond-ts:** `col` / `lit`, the v1 vocabulary, accepted by `filter`,
  `find`, `some`, `every`, `mapColumns`, `withColumn`, live `filter`.
  Column-wise evaluator. Parity fixture cases (function vs expression).
  Perf script per CLAUDE.md. New public API, so it needs pjm17971's
  approval before merge.
- **E2, pond-rs + bridges:** `Expr` in pond-rs evaluated over columns;
  `@pond-ts/rs` and `pond_rs` pass the JSON tree through. Same fixture.
- **E3:** vocabulary growth driven by friction reports.

Bridge J2 (studies, `LiveSeries`, column handoff for functions) follows E2.

### 11. Open questions

1. **Typed column names in TypeScript.** Proposed: plain `col('name')` in
   v1 (runtime checks, mirrors polars). A typed form could come later, e.g.
   `s.filter(($) => $.value.gt(0))`, where the function runs **once** to
   build the tree, not per row. Worth it in v1?
2. **Naming.** `col` / `lit` follow polars, which agents already know. Any
   clash with pond's own vocabulary (`column(name)` exists on `TimeSeries`
   and returns the values)?
3. **`mapColumns` and gaps.** Keep "a gap stays a gap" (matches today), or
   let an expression that reads other columns fill it (more useful for
   `col('a').fill(col('b'))`)? Proposed: keep today's rule for
   `mapColumns`, and use `withColumn` for anything that should fill.
4. **`when`.** Include in v1 or wait for a request?
