# RFC: Column-centric public API

**Status:** **draft, awaiting review.**

**Relationship to PLAN.md:** This RFC is strategic context, not a
commitment. [PLAN.md](../../PLAN.md) is the binding source of truth
for what is being built. Phases adopted into PLAN are commitments;
the rest of this document is forward-looking. See [CLAUDE.md → Strategic
RFCs](../../CLAUDE.md) for the layering.

**Relationship to other RFCs:** This RFC is a **deliberate, small,
scoped walkback** of [`columnar-core.md`](columnar-core.md)'s
commitment that "the public API remains event-shaped; columnar
storage is an internal representation." The walkback is scoped to
_single-column, time-agnostic_ operations — a public `Column`
object returned by `series.column('x')` that exposes scalar
reductions, ranges, and typed-array access. Multi-column composition
and time-aware operations stay event-shaped per the original
commitment.

The walkback is justified by the chart-extraction experiment's M1
friction evidence: the typed-array escape hatch the spike opened
(PR #152) wants to be the canonical single-column public surface,
with explicit guardrails to prevent it from sprawling into a
parallel TimeSeries-shaped API. The discipline in §5 ("Column is
detached from time") is what holds the scope.

Calling this a "supplement" would be disingenuous — once `Column`
is a documented public type with methods, it _is_ a parallel public
API, just a deliberately small one. The honest framing matters
because it shapes how future RFCs read it: walkbacks set precedent
for further walkbacks; supplements don't. The next person who wants
to add a method to `Column` is doing so against an acknowledged
walkback, and that's the right cost basis.

**Evidence base:**

- [`docs/notes/chart-spike-friction.md`](../notes/chart-spike-friction.md)
  — the in-pond chart spike's 7 design questions about substrate access
- [`pond-ts-charts-experiment/friction-notes/M1-line-chart-scaling.md`](https://github.com/pjm17971/pond-ts-charts-experiment/blob/main/friction-notes/M1-line-chart-scaling.md)
  — the cold validation of those 7 questions through real chart
  implementation, with 6 library-actionable items
- PR #152 (spike accessors `series.column('x')` / `series.keyColumn()`)
- PR #153 (step 3 reducer fast-path — internal `reduceColumn`
  machinery this RFC's public API would dispatch through)

**Authorship:**

| Section                                                      | Contributor                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| Original draft (thesis + tier model + division of labor)     | pond-ts library agent (Claude) + pjm17971, 2026-05-26            |
| Key insight: "Column is detached from the time axis"         | pjm17971, 2026-05-26                                             |
| Review notes — chart-experiment perspective                  | pond-ts charts experiment perspective agent (Claude), 2026-05-26 |
| Review notes — independent library perspective               | independent pond-ts library agent (Claude), 2026-05-26           |
| V2 amendment (response to reviews)                           | pond-ts library agent (Claude) + pjm17971, 2026-05-26            |
| Codex adversarial pass on V2                                 | Codex, 2026-05-26                                                |
| §7 type system rewrite (piece A)                             | pond-ts library agent (Claude) + pjm17971, 2026-05-26            |
| V3 amendment (single-spec restructure, pieces B + C + D + E) | pond-ts library agent (Claude) + pjm17971, 2026-05-27            |
| Codex adversarial pass on V3                                 | _pending_                                                        |

**Audience:** future pond-ts contributors deciding what should live on
the public `Column` surface vs. what should stay on `TimeSeries`;
chart-package authors choosing whether to use `series.column('x')`-shape
or `series.method(...)`-shape APIs.

## Thesis

Pond should expose a **column-centric public API for single-column,
time-agnostic operations**, returned by `series.column('x')`, sitting
alongside (not replacing) the TimeSeries-centric API for multi-column
and time-aware operations. The line between them is sharp and
testable: **if an operation can be implemented knowing nothing about
the key column, it lives on Column; otherwise it stays on TimeSeries.**
The chart use case is the proximate driver, but the API serves any
consumer that talks in single-column terms — statistical summaries,
typed-array interop, library-to-library bridges.

The discipline that prevents this from becoming Polars-shaped: Column
is **read-only and detached from time**. Transforms that produce a
modified series stay on TimeSeries. Operations that need to know
"what time does index `i` correspond to" stay on TimeSeries.

## Original draft: pond-ts library agent + pjm17971, 2026-05-26

### 1. The trigger

The chart-extraction experiment (PR #152 spike accessors + the
[`pond-ts-charts-experiment`](https://github.com/pjm17971/pond-ts-charts-experiment)
M1 milestone) validated cold that pond-ts's substrate can serve
high-N interactive charts at the data layer. The chain
`series.column('x').values` together with `series.keyColumn().begin`,
`series.bisect()`, and `Float64Array.subarray()` renders a 10M-point
series well under the 16.7 ms 60-fps frame budget. But the access
pattern surfaced friction:

1. **Kind/storage dispatch boilerplate at the call site.** Three
   guards — non-undefined, `kind === 'number'`, `storage === 'packed'`
   — just to confirm "yes I can read `.values`."
2. **Type re-exports missing.** `Column` / `KeyColumn` aren't exported
   from the pond-ts top-level barrel.
3. **`bisect` allocates a `Time` per probe.** Number-in, number-out
   would be cleaner once you've reached the typed-array layer.
4. **Per-frame Y-extent compute is a manual loop.** The chart writes
   `for (let i = start; i < end; i++) { if (visYs[i] < lo) lo = visYs[i]; ... }`
   when `series.reduce` could do the same — but `reduce` operates on
   the whole series, not a subarray view.
5. **No range-aware reducer entry point.** `series.aggregate(every('5s'))`
   does time-bucket reductions; nothing does index-range or
   subarray-range reductions.

Items 4 and 5 are the deepest. They're not "add a helper method" —
they ask whether the API should grow a column-shape that natively
expresses "reduce over a sub-range." The answer this RFC argues for is
**yes, but carefully**.

### 2. The three-tier model

Today, three tiers of API exist (one of them just internal):

| Tier  | Visibility | What lives here                                                                        | Examples                                                                                |
| ----- | ---------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **A** | Public     | Multi-column, time-aware, transform-producing operations on `TimeSeries`               | `series.aggregate`, `series.rolling`, `series.fill`, `series.joinMany`                  |
| **B** | Public     | Single-column, time-agnostic, read-only operations on `Column` (returned by `.column`) | `col.min()`, `col.slice(s, e)`, `col.values` _(future surface this RFC proposes)_       |
| **C** | Internal   | Reducer fast-path machinery, validity bitmap walks, typed buffer manipulation          | `ReducerDef.reduceColumn`, `Float64Column`, `ValidityBitmap`, `tryReduceColumnFastPath` |

Pre-PR-#152, Tier B was empty — `series.column('x')` didn't exist;
columns were a Tier C implementation detail. The spike accessors
opened a small Tier B surface: read the typed array, read the keys.
That was deliberately minimal — a typed-array escape hatch for chart
consumers who need raw access.

This RFC argues that Tier B should grow into the **canonical
single-column API**, with explicit constraints that prevent it from
turning into a column-shaped clone of TimeSeries.

### 3. The proposal in one paragraph

`series.column('x')` returns a `Column<K>` (one of `Float64Column`,
`BooleanColumn`, `StringColumn`, `ArrayColumn`, depending on the
schema's declared `kind`). The Column object exposes **scalar
reductions** (`.min()`, `.max()`, `.sum()`, `.mean()`, `.stdev()`,
`.median()`, `.percentile(q)`, `.count()`, `.minMax()`), **value-vector
predicates** (`.hasMissing()`, `.nullCount()`), **position-indexed
access** (`.first()`, `.last()`, `.firstDefined()`, `.lastDefined()`,
`.at(i)`, `.values`, `.validity`, `.length`), **index-based slicing**
(`.slice(s, e)`), and **index-based binning**
(`.binnedByIndex(W, reducer)`). Per-kind narrowing restricts each
method set: `Float64Column` gets the numeric reductions;
`StringColumn` gets `.uniqueCount()` and access methods but not
`.min()` / `.max()`; `BooleanColumn` gets `.all()` / `.any()` / `.none()`.

Column does **not** expose any operation that references the time
axis, takes a `KeyLike` argument, produces a modified TimeSeries,
or carries semantics that depend on time context — including
adjacency-based fills. `series.fill(...)` stays on TimeSeries, where
time-aware limits (e.g. "don't carry a value across a gap longer
than 1 hour") can be expressed.

### 4. The Column / TimeSeries division of labor

The test for "does this operation belong on Column?" is two clauses:
**can you implement it knowing nothing about the key column, AND is
the result meaningful without time context?** If both yes, Column.
If either no, TimeSeries. (The second clause is the addition that
catches operations like `isMonotonicIncreasing` — see §5.)

The table below is **illustrative, not exhaustive**; the test in §5
is the discipline. Adding new operations applies the test, not the
table.

| Operation                                                                                                                          | Belongs on                 | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `min`, `max`, `sum`, `mean`                                                                                                        | `Column`                   | Pure value-vector reductions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `stdev`, `median`, `percentile(q)`                                                                                                 | `Column`                   | Same — operate only on the value vector + validity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `minMax`                                                                                                                           | `Column`                   | Single-pass `[min, max]` — fused for chart Y-extent (§B.1 / §B.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `count`                                                                                                                            | `Column`                   | Defined-cell count via validity bitmap; no key needed. Diverges from `series.length` when validity has gaps — see §B.7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `any`, `all`, `none`                                                                                                               | `Column` (`BooleanColumn`) | Boolean predicates over validity-defined cells                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `uniqueCount`                                                                                                                      | `Column` (`StringColumn`)  | Distinct-value cardinality; no time needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `hasMissing`, `nullCount`                                                                                                          | `Column`                   | Validity-bitmap-only queries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `first`, `last`, `firstDefined`, `lastDefined`                                                                                     | `Column`                   | Position-indexed; time-agnostic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `at(i)`, `values`, `validity`, `length`                                                                                            | `Column`                   | Position-indexed access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `slice(start, end)`                                                                                                                | `Column`                   | Index-based; produces a Column view. `.length` on the view is O(1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `binnedByIndex(W, reducer)`                                                                                                        | `Column`                   | Equal-width **index** bins, scalar reducer per bin. The name spells out the index-domain semantics — see §5 close-cases for when it does and doesn't match per-pixel binning                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`fill(...)`** (all modes — `'forward'`, `'backward'`, `'linear'`, `'zero'`, `{ constant: N }`, with optional time-aware `limit`) | `TimeSeries`               | Fill stays on TimeSeries _entirely_. Even adjacency-based fills (`'forward'` / `'backward'`) carry implicit time-context in real use — gap limits like "don't carry across a 1-hour gap" need the key column to express. Putting fill on Column would smuggle time semantics into a time-detached object                                                                                                                                                                                                                                                                                                               |
| `aggregate(every('5s'))`                                                                                                           | `TimeSeries`               | Bucket boundaries are time-shaped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `rolling('5s')`                                                                                                                    | `TimeSeries`               | Window width is time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `align(every('1s'))`                                                                                                               | `TimeSeries`               | Explicitly aligns values to a time grid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `within(t0, t1)`                                                                                                                   | `TimeSeries`               | Time-based windowing — needs key column to translate `t` → index                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `bisect(t)`                                                                                                                        | `TimeSeries`               | The bridge from time-space to index-space; this **is** the place where you cross from TimeSeries-land to Column-land for the chart use case                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `join`, `concat`, `groupBy`                                                                                                        | `TimeSeries`               | Multi-series / multi-column ops                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `keyColumn().at(i)`, `keyColumn().slice(s, e)`                                                                                     | `KeyColumn`                | Position-indexed access on the time/interval/timeRange axis. KeyColumn does NOT get reductions in v1: for `TimeKeyColumn` (point keys, begin-sorted) min/max are trivially `begin[0]` / `begin[length - 1]`; for `TimeRangeKeyColumn` / `IntervalKeyColumn` min begin is `begin[0]` but **max end is NOT** `end[length - 1]` (a long early event can end later than the final row — see `packages/core/test/columnar/Concat.test.ts:239-246`). Range-key consumers who need the max end compute it themselves (`Math.max(...keys.end)` or a manual scan); a future RFC can promote it to a method if friction earns it |

The line should be drawn precisely. Close-call cases worth pinning:

- **Why `fill` stays entirely on TimeSeries.** Earlier drafts split
  fill modes — putting `'forward'` / `'backward'` / `'zero'` on
  Column (adjacency-based, no key needed) and `'linear'` on
  TimeSeries (time-aware interpolation). The split is correct in
  the syntactic sense (you _can_ implement forward-fill knowing
  only the value vector + validity), but it fails the §5 semantic
  clause: in real telemetry data, "carry the last value forward"
  almost always needs a gap limit (don't carry across a multi-hour
  gap), and the gap is time-shaped. Putting `fill` on Column would
  ship the easy API and force the time-aware option into a separate
  TimeSeries method, fragmenting the surface and inviting the
  unbounded forward-fill bug. Keeping all fill modes on TimeSeries
  forces the time-context decision to be explicit. Closes Codex's
  V2 review finding #3.
- **`slice` vs `within`.** `col.slice(startIdx, endIdx)` is
  index-based and lives on Column; `series.within(t0, t1)` is
  time-based and lives on TimeSeries. The bridge is `series.bisect(t)`.
- **`binnedByIndex` vs `aggregate`.** `col.binnedByIndex(W, reducer)`
  is index-bucket reduction (equal-width, W index bins);
  `series.aggregate(every('5s'), ...)` is time-bucket reduction
  (boundaries derived from time). The chart's per-pixel downsampler
  uses `binnedByIndex` when sampling is uniform; analytics pipelines
  computing "5-minute averages" use `aggregate`. For non-uniformly-
  sampled chart data the chart needs time-aware binning, which
  lives on TimeSeries — see the close-case below.
- **`binnedByIndex` (index-domain) vs `series.binnedByTime`
  (time-domain).** `col.binnedByIndex(W, reducer)` divides the
  column's index range into W equal-count bins. That's correct when
  adjacent samples are uniformly time-spaced; if the data is bursty
  / gappy / irregular, index bins won't align with pixel/time spans.
  The time-aware variant — proposed as
  `series.binnedByTime(name, W, range, reducer)` — lives on
  TimeSeries because it needs the key column to pick bin boundaries.
  The chart picks one or the other based on whether the data is
  known to be uniformly sampled. The two method names spell out
  which domain they bin in, so the call site is unambiguous.

### 5. The "detached from time axis" guardrail

Column instances **do not carry a reference to the key column.** A
`Float64Column` is a value vector + validity bitmap + length. It has
no idea what time `values[5]` corresponds to. That information lives
in the parent TimeSeries.

This is a deliberate constraint, not an oversight. It enforces:

- You cannot call any time-aware operation on Column without first
  going back through TimeSeries.
- The API surface stays small (no need for per-kind variants of
  every time-aware method).
- Columns are cheap to extract — no key-column copy / reference
  management.

The discipline that protects this is two-clause:

> **Can you implement it knowing nothing about the key column,
> AND is the result meaningful without time context?**

The first clause is structural: no method on Column takes a `KeyLike`
or anything time-shaped as an argument. The second clause catches a
class the first misses — **monotonicity-aware reducers** like
`isMonotonicIncreasing`, `maxRun`, `streakLength`. These can be
implemented from the value vector alone (no key column), but the
result is only meaningful because the caller assumes the column is
time-ordered. Without that assumption, "monotone in value order" is
just a fact about the array's contents — not a fact about the data.

If a future contributor proposes:

- `col.range(t0, t1)` → fails clause 1 (takes a KeyLike). Use
  `series.within(t0, t1).column('x')`.
- `col.aggregate(every('5s'), ...)` → fails clause 1. Use
  `series.aggregate(...)`.
- `col.isMonotonicIncreasing()` → passes clause 1, fails clause 2.
  Lives on `TimeSeries` as `series.isMonotonicIncreasing('x')` because
  the time-ordering assumption is what makes the result meaningful.

This matches Arrow's `Array` vs `RecordBatch` design exactly:
`arrow.Array` (single column) has no notion of an associated index;
`arrow.RecordBatch` is what owns the alignment invariant. Pond's
TimeSeries is the RecordBatch-equivalent — except pond's key column
has a semantic role (time-ordered, supports `bisect`) where Arrow
treats all columns symmetrically.

### 6. The bridge: `series.bisect`

The chart use case composes naturally across the boundary:

```ts
// Step 1: Bridge time-space to index-space (key-aware, on TimeSeries)
const startIdx = series.bisect(viewport.start);
const endIdx = series.bisect(viewport.end);

// Step 2: Column-space from here (no time involved)
const col = series.column('value').slice(startIdx, endIdx);
const extents = col.binnedByIndex(pixelWidth, 'minMax');
// extents.lo: Float64Array(W)  — per-pixel min
// extents.hi: Float64Array(W)  — per-pixel max
```

`series.bisect()` is the canonical bridge from time-space to
index-space. Once you have indices, column-space takes over. This
isn't a new pattern — it's how the chart already works under the
hood today (PR #152's spike).

The M1 friction note's item #3 (`bisect` allocates a `Time` per
probe) and proposed item #2 (`series.bisectBegin(timestamp: number):
number` for a number-in-number-out shape) are still valid
optimizations and fit cleanly with this RFC: `bisectBegin` is a
TimeSeries-shaped number bridge, not a Column-shaped one.

### 7. Type system design

The promise of `series.column('value').min()` returning `number | undefined`
while `series.column('host').min()` is a compile error needs actual
TypeScript machinery to back it. The pre-V3 draft asserted this without
designing it; the design follows.

#### 7.1 The chain of type-level lookups

Three type-level transforms compose:

1. **Schema → value-column-name union.** Constrain the `name` parameter
   so it must be a value column declared in the schema (and not a key
   column or a typo).
2. **(Schema, Name) → kind.** Look up the declared kind for the named
   column.
3. **Kind → public column type.** Map `'number' | 'boolean' | 'string'
| 'array'` to the corresponding public column class with its
   kind-appropriate method set.

Two of the three already exist in `packages/core/src/schema/series.ts`:

```ts
// Already exists — extracts the value-column tuple from a schema
export type ValueColumnsForSchema<S extends SeriesSchema> = S extends readonly [
  FirstColumn,
  ...infer Rest extends readonly ValueColumn[],
]
  ? Rest
  : never;

// Already exists — resolves the kind of a named value column
export type ValueColumnKindForName<
  S extends SeriesSchema,
  V extends string,
> = Extract<ValueColumnsForSchema<S>[number], { name: V }>['kind'];
```

Two new types complete the chain:

```ts
// New — the union of all value-column names in the schema
export type ValueColumnNameForSchema<S extends SeriesSchema> =
  ValueColumnsForSchema<S>[number]['name'];

// New — kind → public column class
export type PublicColumnForKind<K extends ScalarKind> = K extends 'number'
  ? Float64Column
  : K extends 'boolean'
    ? BooleanColumn
    : K extends 'string'
      ? StringColumn
      : K extends 'array'
        ? ArrayColumn
        : never;
```

Both go into `schema/series.ts` next to the existing helpers.

#### 7.2 The narrowed `column(name)` signature

`TimeSeries<S>.column` becomes a generic method:

```ts
column<N extends ValueColumnNameForSchema<S>>(
  name: N,
): PublicColumnForKind<ValueColumnKindForName<S, N>>;
```

Two consequences:

- **The `| undefined` in the return type goes away.** The compiler
  knows `name` is a schema-valid value column, so `column(name)` is
  guaranteed to return one. (Runtime can still throw if the substrate
  is in an unexpected state, but that's a programming-error path, not
  a normal-control-flow `undefined`.)
- **`series.column('not_in_schema')` is a compile error**, not a
  runtime `undefined`. Misspellings caught at the call site.

The chart's M1 access pattern collapses accordingly:

```ts
// Before (per the original draft of §1 friction item):
const valueCol = series.column('value');
if (!valueCol || valueCol.kind !== 'number' || valueCol.storage !== 'packed') {
  throw new Error(
    `expected packed Float64; got ${valueCol?.kind}/${valueCol?.storage}`,
  );
}
const ys: Float64Array = valueCol.values;

// After:
const ys: Float64Array = series.column('value').values;
```

The three guards collapse into a single `.values` read. The schema is
the contract; the call site trusts it.

(Storage discrimination — `packed` vs `chunked` — is handled by the
public column class internally: `.values` returns the typed array if
packed, throws if chunked, and `.materialize().values` is the explicit
path for the chunked case. See open question Q1 in §12.)

#### 7.3 Per-kind public column interfaces

The public column types are the existing internal classes in
`packages/core/src/columnar/column.ts`, augmented with the public
method set. Substrate IS public API — there's no wrapper layer.

```ts
// Float64Column — value-vector reductions + ranges + typed access.
// The richest method set.
export class Float64Column /* extends ColumnBase<number, 'number'> */ {
  // Scalar reductions
  min(): number | undefined;
  max(): number | undefined;
  sum(): number;
  mean(): number | undefined;
  stdev(): number | undefined;
  median(): number | undefined;
  percentile(q: number): number | undefined;
  count(): number; // count of defined cells (see §B.7)
  minMax(): [number, number] | undefined;

  // Value-vector predicates
  hasMissing(): boolean;
  nullCount(): number;

  // Position-indexed
  first(): number | undefined;
  last(): number | undefined;
  firstDefined(): number | undefined;
  lastDefined(): number | undefined;
  at(i: number): number | undefined;

  // Validity-aware iteration (the safe default; works uniformly
  // across packed + chunked storage, doesn't expose the .values
  // validity trap)
  scan(fn: (value: number, i: number) => void, options?: ScanOptions): void;

  // Range
  slice(start: number, end: number): Float64Column;

  // Binned reduction (index-bucketed; see §B.2)
  binnedByIndex<R extends BuiltinReducer>(
    bins: number,
    reducer: R,
  ): BinnedOutput<R>;

  // Typed-array escape hatch
  readonly values: Float64Array;
  readonly validity: ValidityBitmap | undefined;
  readonly length: number;
  readonly kind: 'number';
  readonly storage: 'packed' | 'chunked';

  // Storage handling
  materialize(): Float64Column; // returns self if packed
}

// StringColumn — kind-appropriate subset. No `min`/`max`/`sum`.
export class StringColumn {
  uniqueCount(): number;
  hasMissing(): boolean;
  nullCount(): number;
  first(): string | undefined;
  last(): string | undefined;
  firstDefined(): string | undefined;
  lastDefined(): string | undefined;
  at(i: number): string | undefined;
  scan(fn: (value: string, i: number) => void, options?: ScanOptions): void;
  slice(start: number, end: number): StringColumn;

  readonly values: ReadonlyArray<string> | Uint32Array; // dict indices for dict-encoded
  readonly validity: ValidityBitmap | undefined;
  readonly length: number;
  readonly kind: 'string';
  readonly storage: 'packed' | 'chunked';
  readonly encoding: 'dict' | 'fallback';

  materialize(): StringColumn;
}

// BooleanColumn — `all`/`any`/`none` over the truthy/falsy distribution.
export class BooleanColumn {
  all(): boolean;
  any(): boolean;
  none(): boolean;
  count(): number; // count of defined cells
  hasMissing(): boolean;
  nullCount(): number;
  first(): boolean | undefined;
  last(): boolean | undefined;
  firstDefined(): boolean | undefined;
  lastDefined(): boolean | undefined;
  at(i: number): boolean | undefined;
  scan(fn: (value: boolean, i: number) => void, options?: ScanOptions): void;
  slice(start: number, end: number): BooleanColumn;

  readonly values: Uint8Array; // bit-packed
  readonly validity: ValidityBitmap | undefined;
  readonly length: number;
  readonly kind: 'boolean';
  readonly storage: 'packed' | 'chunked';

  materialize(): BooleanColumn;
}

// ArrayColumn — minimal surface for v1; per-element predicates land
// when the use cases earn them (§11 step 5).
export class ArrayColumn {
  hasMissing(): boolean;
  nullCount(): number;
  first(): ReadonlyArray<ScalarValue> | undefined;
  last(): ReadonlyArray<ScalarValue> | undefined;
  firstDefined(): ReadonlyArray<ScalarValue> | undefined;
  lastDefined(): ReadonlyArray<ScalarValue> | undefined;
  at(i: number): ReadonlyArray<ScalarValue> | undefined;
  scan(
    fn: (value: ReadonlyArray<ScalarValue>, i: number) => void,
    options?: ScanOptions,
  ): void;
  slice(start: number, end: number): ArrayColumn;

  readonly values: ReadonlyArray<ReadonlyArray<ScalarValue>>;
  readonly validity: ValidityBitmap | undefined;
  readonly length: number;
  readonly kind: 'array';
  readonly storage: 'packed' | 'chunked';

  materialize(): ArrayColumn;
}
```

The reducer methods (`min`, `max`, `mean`, etc.) are thin wrappers
around the existing `ReducerDef.reduceColumn` machinery shipped in
PR #153 — no new perf work, just method-level access.

#### 7.4 Type-level acceptance tests

The narrowing claim only holds if it actually compiles the way the
RFC promises. The implementation PR ships a `.test-d.ts` file with
the following acceptance tests; CI's `tsc --noEmit` enforces them.

```ts
// packages/core/test/column-api-types.test-d.ts
import { expectType } from 'tsd'; // or manual `const _: T = expr`
import { TimeSeries, Float64Column, StringColumn, BooleanColumn } from '../src';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
  { name: 'active', kind: 'boolean' },
] as const;

const s = new TimeSeries({ name: 's', schema, rows: [] });

// ── Positive: schema-valid name → kind-narrowed column ──────────

expectType<Float64Column>(s.column('value'));
expectType<StringColumn>(s.column('host'));
expectType<BooleanColumn>(s.column('active'));

// ── Positive: kind-appropriate reducers compile + return narrowed types ─

expectType<number | undefined>(s.column('value').min());
expectType<number | undefined>(s.column('value').percentile(95));
expectType<[number, number] | undefined>(s.column('value').minMax());
expectType<Float64Array>(s.column('value').values);

expectType<number>(s.column('host').uniqueCount());
expectType<string | undefined>(s.column('host').at(0));

expectType<boolean>(s.column('active').all());
expectType<boolean>(s.column('active').any());

// ── Positive: composition stays narrowed ─────────────────────────

expectType<Float64Column>(s.column('value').slice(0, 100));
expectType<number | undefined>(s.column('value').slice(0, 100).min());

// ── Positive: generic Column methods exist on every kind ──────────

// Every public column exposes scan() + firstDefined() + lastDefined()
// so the generic-Column-shape contract from §3 / §4 / §12 holds.
s.column('value').scan((v, i) => {
  /* number, i */
});
s.column('host').scan((v, i) => {
  /* string, i */
});
s.column('active').scan((v, i) => {
  /* boolean, i */
});
expectType<number | undefined>(s.column('value').firstDefined());
expectType<string | undefined>(s.column('host').firstDefined());
expectType<boolean | undefined>(s.column('active').firstDefined());
expectType<number | undefined>(s.column('value').lastDefined());
expectType<string | undefined>(s.column('host').lastDefined());
expectType<boolean | undefined>(s.column('active').lastDefined());

// ── Negative: name not in schema ─────────────────────────────────

// @ts-expect-error — 'cpu' is not a value column in this schema
s.column('cpu');

// @ts-expect-error — typo on a real column name
s.column('valuue');

// ── Negative: key columns aren't reachable via column() ──────────

// @ts-expect-error — 'time' is the key column; use keyColumn() instead
s.column('time');

// ── Negative: kind-inappropriate reducers don't compile ──────────

// @ts-expect-error — StringColumn has no min()
s.column('host').min();

// @ts-expect-error — Float64Column has no uniqueCount()
s.column('value').uniqueCount();

// @ts-expect-error — BooleanColumn has no percentile()
s.column('active').percentile(50);

// @ts-expect-error — StringColumn.values isn't a Float64Array
const _: Float64Array = s.column('host').values;
```

These tests are the contract the RFC promises. If any of them break,
the schema-narrowing claim is broken.

#### 7.5 The KeyColumn parallel

The same shape applies to `keyColumn()`:

```ts
export type KeyColumnForSchema<S extends SeriesSchema> =
  S[0]['kind'] extends 'time'      ? TimeKeyColumn :
  S[0]['kind'] extends 'interval'  ? IntervalKeyColumn :
  S[0]['kind'] extends 'timeRange' ? TimeRangeKeyColumn :
  never;

keyColumn(): KeyColumnForSchema<S>;
```

`KeyColumn` variants don't get the scalar reductions (`min`/`max` are
trivially `begin[0]` / `end[length-1]` given the sortedness invariant),
but they do get `.at(i)`, `.slice(s, e)`, and the typed-array
accessors (`.begin`, `.end`, `.labels` per variant).

#### 7.6 Compared to today's row-API path

The same operation through `series.reduce(col, reducer)` is **less**
type-safe by design:

```ts
// Today's row-API path — compiles, fails at runtime
const x: ColumnValue | undefined = s.reduce('host', 'min');
// At runtime: numeric.length === 0 (no string is a number), so returns undefined.
// User sees `undefined` and wonders why; type system didn't help.

// Tomorrow's column-centric path — compile error
// @ts-expect-error — StringColumn has no min()
const y = s.column('host').min();
// Caught at the call site, with a precise error message.
```

This is a deliberate divergence: the column-centric idiom is
strictly safer. JSDoc on `series.reduce(col, reducer)` will point
single-column callers toward `series.column(name).reducer()` as the
recommended idiom (§10).

### 8. The chart use case worked out

The M1 chart's `useMemo` block today (post-#152 spike):

```ts
const series = new TimeSeries({ name: 'M1', schema, rows });
const valueCol = series.column('value');
if (!valueCol || valueCol.kind !== 'number' || valueCol.storage !== 'packed') {
  throw new Error(
    `expected packed Float64; got ${valueCol?.kind}/${valueCol?.storage}`,
  );
}
const xs: Float64Array = series.keyColumn().begin;
const ys: Float64Array = valueCol.values;
```

Under this RFC:

```ts
const series = new TimeSeries({ name: 'M1', schema, rows });
const xs = series.keyColumn().begin; // already number-narrowed for kind:'time'
const valueCol = series.column('value'); // typed as Float64Column by schema
const ys = valueCol.values; // Float64Array; no guards needed
```

The kind/storage dispatch becomes a type-system concern, not a
runtime guard. Storage discrimination (`packed` vs `chunked`) is
handled inside the public Column class: `.values` returns the typed
array directly when packed and throws when chunked; consumers who
expect a chunked column call `.materialize().values` explicitly.

Per-frame draw becomes:

```ts
function drawFrame() {
  // Time-space → index-space (bridge)
  const startIdx = series.bisect(viewport.start);
  const endIdx = series.bisect(viewport.end);

  // Column-space (everything below)
  const visible = series.column('value').slice(startIdx, endIdx);

  if (visible.length > cssWidth) {
    // Per-pixel min/max downsampling — single column-method call.
    // Returns two channels; canvas inner-loop reads `lo[px]` then
    // `hi[px]` (stride-1 access on each channel).
    const { lo, hi } = visible.binnedByIndex(cssWidth, 'minMax');
    // ... draw vertical lines from lo[px] to hi[px] per pixel
  } else {
    // No downsampling needed; draw raw values
    const ys = visible.values;
    // ... draw point per cell
  }
}
```

`visible.binnedByIndex(cssWidth, 'minMax')` is the column-centric
expression of M1 friction item #6 (`reduceColumnRange(col, start, end)`).
The shape is cleaner than the friction note proposed — the consumer
doesn't think in terms of "column ranges" as a primitive; they think
"give me min and max per pixel" as a single call.

**Uniform-sampling precondition.** `col.binnedByIndex(W, ...)` does
equal-width index binning. If the data's adjacent samples are
uniformly time-spaced (M1 chart's 1-per-second data, a 60Hz sensor,
etc.), pixel-aligned bins fall out naturally. If sample timing is
irregular (telemetry that emits-on-change, financial tick data,
sparse alarms), index bins don't align with pixel/time spans and
the rendered min/max strip will lie about which pixel-time each
extreme actually came from. For non-uniform data the chart uses
`series.binnedByTime(name, W, range, reducer)` — a TimeSeries
method that picks bin boundaries by time, not by index. See §11
for sequencing — the time-aware variant lands separately because
it lives on a different object.

### 9. Anti-patterns (what NOT to do)

These shapes would betray the design discipline. Reject them in
review:

**Time-aware operations smuggled onto Column:**

- **`col.aggregate(every('5s'), ...)`** — bucket boundaries are
  time; needs the key column. Use `series.aggregate(...)`.
- **`col.rolling('5s', ...)`** — window width is time. Use
  `series.rolling(...)`.
- **`col.range(t0, t1)`** — time-based range. Use
  `series.within(t0, t1).column('x')`.
- **`col.fill(...)` — _any_ fill mode.** Even adjacency-based fills
  (`'forward'`, `'backward'`) carry implicit time-context in real
  use (gap limits like "don't carry across a 1-hour gap"). The
  syntactic case for forward-fill on Column is sound — you can
  implement it from the value vector + validity alone — but the
  semantic case fails the §5 second clause. Use `series.fill({ x:
'forward', limit: ... })` and make the time-aware decision
  explicit at the TimeSeries layer. See §4 close-case for the
  full argument.
- **`col.binnedByTime(W, t0, t1, reducer)`** — time-based binning;
  needs the key column. Use `series.binnedByTime(name, W, range, reducer)`.
- **`col.isMonotonicIncreasing()` and other monotonicity-aware
  reducers** — passes the syntactic test (no key column needed) but
  fails the semantic test: the result is only meaningful when the
  caller knows the column is time-ordered. Lives on TimeSeries.

**Round-trips and mutation:**

- **`col.toSeries()`** — round-tripping back to TimeSeries reopens
  the "what about the key column?" question and creates a parallel
  reconstruction path. If you need a TimeSeries-shaped result, do
  the operation on TimeSeries. (When you genuinely need to ship a
  downsampled column out as a new series — e.g. for an M3-style
  overlay — build a fresh TimeSeries from `(slicedKeys.begin, col.values)`
  via the existing `new TimeSeries({...})` path; explicit, no hidden
  key-column reconstruction.)
- **Column mutation methods** (`col.set(i, v)`, `col.push(v)`).
  Column is read-only. Mutations go through TimeSeries (which has
  the schema and can validate). For "I want to modify one column and
  get a new series" semantics, use the existing transform methods on
  TimeSeries.

**Presentation / serialization on Column:**

- **`col.toArray(): number[]`** — `col.values` (the typed array) is
  the canonical surface. If a consumer specifically wants a plain
  `number[]` they write `Array.from(col.values)` at the call site.
  Pond doesn't ship the helper because typed arrays are the
  correct currency.
- **`col.toJSON()`** returning plain-array JSON — same rationale.
  Presentation / serialization belongs in adapters, not the substrate.
- **`col.toString()` / formatted output** — presentation. Adapters'
  job.
- **`col.equals(other)`** — deep equality across columns is a
  TimeSeries concern because schemas matter for comparison. (And
  if you really need it on a column, `col.length === other.length
&& col.values.every((v, i) => v === other.values[i])` is one line
  at the call site, and you've made the equality semantics explicit.)

The unifying anti-pattern is **anything that would make Column feel
like "TimeSeries minus key column"**, because then every TimeSeries
method gains a column equivalent and the API doubles in size. Column
is a strict subset: read-only, time-agnostic, scalar-producing.

### 10. Migration story

Existing call sites keep working unchanged. `series.reduce('value',
'min')` is still supported; under the hood it dispatches through the
same column fast path (PR #153) that `series.column('value').min()`
would use. The two paths return the same result on well-typed inputs.

Docs adopt the column-centric idiom as recommended going forward:

```ts
// Old idiom (still works, but type-loose)
const min = series.reduce('value', 'min');

// Recommended idiom
const min = series.column('value').min();
```

**Deliberate type-system divergence (be honest about it).** The two
paths agree on well-typed inputs but diverge on ill-typed ones:

```ts
// Old path — compiles, runtime-fails by returning undefined silently
const x: ColumnValue | undefined = series.reduce('host', 'min');

// New path — won't compile (StringColumn has no min())
// @ts-expect-error
const y = series.column('host').min();
```

This is an _improvement_. The row-API path's permissive typing
(`'min'` is just a string; nothing checks that the column is
numeric) is a known soft spot that lets ill-typed calls slip
through to runtime; the column-centric idiom catches them at the
call site. JSDoc on `series.reduce(col, reducer)` will note the
preferred column-centric path for single-column work — pointing
users toward the stricter idiom for new code without deprecating
the existing one.

The recommendation kicks in for single-column scalar reductions, the
chart-extraction access pattern, and statistical summaries. The
TimeSeries idiom stays canonical for:

- Multi-column reductions: `series.reduce({ a: 'min', b: 'max' })`
- Multi-column aggregates: `series.aggregate(every('5s'), { ... })`
- Anything time-aware

No deprecation cycle for `series.reduce(col, reducer)` is proposed —
it's a valid alternative shape for callers who prefer it, and
removing it would be a behavior break with no upside.

### 11. Sequencing

This RFC connects to several in-flight and proposed work items:

- **M1 friction items.** Items #1 (per-kind typed accessor helpers,
  `series.numberValues('name')`) and #5 (`reduceColumnRange`) get
  _redirected_ by this RFC: the column-centric API subsumes them.
  `series.numberValues('name')` becomes `series.column('name').values`
  (no new method needed); `reduceColumnRange` becomes
  `series.column('name').slice(s, e).min()` (composition of two
  existing primitives). Item #4 (re-export `Column` / `KeyColumn`)
  becomes a strict requirement of this RFC — `Column` is now a
  public type. Items #3 (`bisectBegin`) and #6 (`fromTrustedColumns`)
  are orthogonal and proceed independently.
- **Phase 4.7 step 3 Phase B (`series.aggregate` fast path).** Lands
  unchanged at the TimeSeries layer — `aggregate` is time-aware and
  stays on TimeSeries. The internal `reduceColumn` machinery is
  reused for the per-bucket reductions.
- **Phase 4.7 step 3 Phase C (`series.rolling` fast path).** Same —
  `rolling` is time-aware, stays on TimeSeries.
- **Principled NaN / Welford follow-up.** Orthogonal; affects
  reducer correctness across both column-centric and TimeSeries-centric
  paths uniformly.

Suggested sequencing once this RFC adopts:

1. **Public type re-exports.** Land `Column` / `Float64Column` /
   `BooleanColumn` / `StringColumn` / `ArrayColumn` / `KeyColumn`
   variants from the `pond-ts` top-level barrel (M1 friction #4).
   Prerequisite for everything else; small.
2. **`Float64Column` scalar reductions.** `min`, `max`, `sum`,
   `mean`, `stdev`, `median`, `percentile(q)`, `count`, `minMax`,
   `hasMissing`, `nullCount`, `first`, `last`, `firstDefined`,
   `lastDefined`. Implementation dispatches through the internal
   `ReducerDef.reduceColumn` machinery shipped in PR #153 — no new
   perf work, just method-level access. Ships with the type-level
   acceptance tests (§7.4) under `tsc --noEmit` CI enforcement.
3. **Slice + `binnedByIndex` together (single PR).**
   `Float64Column.slice(start, end)` (zero-copy view via the
   existing `sliceByRange` substrate primitive) and
   `Float64Column.binnedByIndex<R>(W, reducer)` (implementation is
   a loop over `reducer.reduceColumnRange`; the `'minMax'` variant
   is the fused single-pass min+max returning `{ lo, hi }`). They
   ship together because they're "useless apart" — `binnedByIndex`
   without `slice` would need a four-arg
   `(start, end, W, reducer)` signature; `slice` without
   `binnedByIndex` loses the chart's headline win.
4. **`KeyColumn` `.at(i)` + `.slice(s, e)`.** Mirrors Column's
   shape on the key axis. KeyColumn does NOT get scalar reductions.
   Unblocks M5 (heatmap) and tooltip / crosshair flows.
5. **M1 chart adopts the new API.** The chart-extraction experiment
   updates its M1 implementation to use the column-centric idiom;
   the friction report from that update loop feeds any V4 amendment
   to this RFC.
6. **`BooleanColumn` / `StringColumn` reductions, on demand.**
   `all` / `any` / `none` on `BooleanColumn`; `uniqueCount` on
   `StringColumn`. Each method lands when an actual consumer use
   case earns it — not on spec. Docs lead with the **generic
   `Column` shape** (length, at, slice, validity, values, kind,
   storage, materialize) and surface per-kind reductions as "what
   `Float64Column` adds" / "what `BooleanColumn` adds" so the
   asymmetry reads as additive rather than "strings are
   second-class."
7. **(Deferred) `series.binnedByTime(name, W, range, reducer)` on
   TimeSeries** — the time-aware variant for irregular-sample
   charts. Lives on TimeSeries because it needs the key column;
   lands when an experiment milestone hits irregular data and
   surfaces the friction.
8. **Update docs across the site** to recommend the column-centric
   idiom for single-column work. JSDoc on `series.reduce(col, reducer)`
   points single-column callers at the column-centric path.

Each step lands as its own PR with the standard two-pass review
(L2 + Codex).

### 12. Open questions

**Closed (decided in the spec body above, not open):**

- ~~_Q1: Storage-discriminator handling._~~ — Decided in §8 / §B.1:
  `.values` returns the typed array directly when packed and throws
  when chunked; `.materialize().values` is the explicit "I'll pay
  for it" path; `.scan()` (per pond's existing `scan(invalidValue?)`
  idiom) is the kind-uniform streaming access that works across
  both.
- ~~_Q2: `slice` vs `subarray` naming._~~ — Decided: `slice` (matches
  Polars / Pandas data-frame idiom; TypedArray's `subarray` is
  too-similar to the typed-array primitive and confuses the API
  surface).
- ~~_Q3: Reducer string vs callback._~~ — Decided: string union for
  built-ins (autocompletion via TypeScript literal narrowing),
  callback overload for custom reducers. Matches `series.reduce(col,
reducer)` shape.
- ~~_`'extent'` reducer output kind._~~ — Resolved by the V2 rename
  to `'minMax'`. The output shape is
  `{ lo: Float64Array(W); hi: Float64Array(W) }` for the
  `binnedByIndex` variant and `[number, number]` for the scalar
  variant. Special-cased in `binnedByIndex`'s implementation;
  doesn't introduce a new reducer-output kind.
- ~~_`series.column('x')` caching / identity stability._~~ —
  Decided: cached, identity-stable for the parent series' lifetime.
  `series.column('x') === series.column('x')` holds. A
  lazily-constructed wrapper memoized on first access. Safe because
  Column is immutable. (This closes the previous Q6/Q8
  contradiction in V2: V2 had Q6 claiming "don't assume identity-
  stable" and Q8 deciding "cached and memoized"; the answer is Q8
  — chart's per-frame draw closure depends on cheap re-invocation,
  and the immutability makes caching safe. Implementation reuses
  the existing `#store` field on TimeSeries.)

**Open (need decisions before or during implementation):**

- **`.values` validity trap.** `col.values` returns the dense
  underlying buffer; cells outside `col.validity` are unspecified
  (currently `0` for `Float64Column`, but not contractual). The §8
  worked example reads `.values` directly without a validity check
  — fine for the M1 use case (the chart is OK with whatever the
  buffer says at invalid cells; downsampling and rendering aren't
  validity-sensitive), but a real gotcha for statistical consumers.
  The RFC pins the contract: **`col.values` is the dense buffer;
  validity-aware code must consult `col.validity`.** `col.scan()`
  is the safe default for validity-aware iteration. Open question:
  rename `.values` to `.rawValues` to make the trap louder? Lean
  no — `.values` is the ergonomic name everyone expects.
- **Column lifetime semantics.** `Column` is a view over the
  parent series' typed buffers. The `Float64Array` survives via
  its `ArrayBuffer` reference even if the parent series goes out
  of scope (V8 GC honors live `ArrayBuffer` references). The
  contract should be pinned: "Column is safe to hold across
  parent-series GC."
- **`.slice()` on a chunked column.** Same shape as Q1 but
  reaches deeper. Probably: returns a chunked view if the slice
  spans multiple chunks; returns a packed view if the slice falls
  within one chunk. Defer to the chunked-column-aware methods
  implementation; not blocking on the spec.
- **`series.binnedByTime` shape.** Sequenced for after M1 + chart
  update loop reveal where irregular-sampling friction actually
  lives. Likely shape: `series.binnedByTime(name: ValueColumnName<S>,
bins: number, range: { begin: TimeLike; end: TimeLike }, reducer:
ReducerName | ReducerFn): BinnedResult`. Lives on TimeSeries (needs
  the key column). Open: should `binnedByTime` accept precomputed
  per-pixel index ranges as a fast-path? (chart already has
  `bisect()` results, doesn't need TimeSeries to re-compute them).

### 13. The line to hold

If this RFC adopts, the discipline that future contributors should
internalize:

> **Column is read-only and detached from time.** It owns operations
> that need only the value vector + validity. Time-aware operations,
> multi-column ops, and series-producing transforms stay on
> TimeSeries. The bridge between the two is `series.bisect`
> (time-space → index-space) and `series.column('x')` (TimeSeries →
> Column). Don't add anything to Column that would betray that line.

That's the one-paragraph version. If a contributor proposes a Column
method, the two-clause test is: **(1) does this need to know what
timestamp index `i` is at, or what other columns exist? (2) is the
result meaningful without time context?** If yes to (1) or no to (2)
→ TimeSeries. Only "no, and yes" → Column.

This is what keeps the API from sprawling into a Polars-shape
parallel surface. Pond's value proposition is the **time-aware**
composition that TimeSeries provides. Column is a small, well-bounded
public substrate for the operations where the time axis genuinely
doesn't matter — and that's exactly the case for charts (which just
need fast typed-array access) and for statistical summaries (which
just need the value distribution).

### Review notes — chart-experiment perspective

_Posted by the pond-ts charts experiment perspective agent (Claude), 2026-05-26_

#### 1. Coverage of M1 hot paths

Walking the per-frame loop (`M1LineChart.tsx:114-194`) against section 4:

- **Bisect bridge** (`L122-123`): stays on TimeSeries — correct. Number-in-number-out (F3) is orthogonal as the RFC notes.
- **Subarray slice** (`L127-128`): `col.slice(s, e)` covers it. **But** the chart slices both `xs` (keys) and `ys` (values). The RFC defines `slice` on `Column`; it does not say what `keyColumn().slice(s, e)` returns or whether the key column gets the same Tier-B treatment. M1 only uses `keyColumn().begin` once at extraction (`L74`), but M5 (interval heatmap) and any tooltip/crosshair flow will want `keys.at(i)` and `keys.slice(s, e)`. Worth pinning explicitly: does `KeyColumn` get scalar reductions? It shouldn't get `min`/`max` (the key is sorted, so it's `begin[0]` / `end[length-1]`), but it does want slice + at.
- **Y-extent loop** (`L141-147`): `slice(s, e).min()` + `.max()` is two passes. The chart literally writes the fused single-pass loop. `binned(1, 'extent')` would work but is overkill. Add **`col.extent(): [number, number]`** as a scalar reducer — the RFC lists `min`/`max` but extent is the chart-native primitive and is already a fused fast path internally.
- **Per-pixel min/max** (`L167-191`): this is where `binned(W, 'extent')` lands. Coverage is correct.
- **Empty-window guard** (`L133`): `visible.length === 0`. Covered by `.length`.

What's missing: the chart does **`visible.length > cssWidth`** branching (`L159`), so it needs `.length` on the sliced view to be cheap (O(1), not a re-walk). Pin that as a guarantee.

#### 2. Anti-patterns (section 9)

- **`col.toSeries()`** — the RFC rejects this, but the M3 chunked milestone and any future "let me draw the downsampled overlay as its own series" would want it. That said, the workaround is fine: build a new `TimeSeries` from `(slicedKeys.begin, col.values)`. Rejection holds, but add a one-liner showing the workaround so M3 doesn't reinvent it.
- **`col.fill('linear')`** — agreed it stays on TimeSeries. No chart counter-case.
- **Mutation methods** — agreed.

The list is right. None of the rejections bite the chart.

#### 3. Sequencing (section 11)

Step 4 (`binned`) is the one that lets M1 retire the hand-rolled per-pixel loop (`L171-190`) — the highest-value chart win. Steps 1, 2, 3 are prerequisites. The order is correct, but **step 3 (`slice`) blocks step 4** in a way the RFC understates: without `slice`, `binned` would have to take `(start, end, W, reducer)` as a four-arg primitive. Keep them strictly ordered, and consider landing step 3 + step 4 together as one PR — they're useless apart.

#### 4. `'extent'` layout

**Interleaved `Float64Array(2W)` is wrong for chart draw.** The draw loop wants `ctx.lineTo(px, pyHi); ctx.lineTo(px, pyLo)` (`L188-189`), which means the inner loop reads `lo[px]` then `hi[px]`. Interleaved forces stride-2 access and two index computations per pixel. **Two `Float64Array(W)` channels** (return `{ lo, hi }`) is faster on read and matches how the chart actually consumes it. It also lets the chart do `Math.min(...lo) / Math.max(...hi)` cheaply for the outer Y-extent (which it still needs — see F6).

**LTTB:** yes, eventually. Min/max-per-pixel is correct for dense data but loses local extrema visibility at heavy zoom-out. LTTB (Largest-Triangle-Three-Buckets) is the standard. Defer to M2/M3 friction, but the `binned` signature should accept a reducer that returns N points, not 1 or 2 — i.e. `binned<R>(W, reducer): ReducerOutput<R>`. Don't lock the return type to `Float64Array`.

#### 5. Open questions

The **`'extent'` reducer output kind** matters most — it's the one blocking M1's payoff. The chunked-column question (`.values` on chunked) is M3's problem, not M1's. The draft missed: **does `series.column('x')` cache the Column object across calls?** The chart calls `series.column('value')` inside the draw closure (`L296` in the RFC's worked example); if that allocates per frame, the chart needs to hoist. Pin caching semantics.

**Reviewer confidence: high** — grounded in the M1 implementation; the gaps flagged are concrete and tied to specific line numbers.

### Review notes — independent library perspective

_Posted by an independent pond-ts library agent (Claude), 2026-05-26_

**Net position:** adopt with amendments. The thesis is right and the
"detached from time" line is sharp, but the draft has one factual error
and several spots where the discipline it preaches is not quite the
discipline it embodies. Fixes are small.

#### 1. `series.between(...)` does not exist (factual)

Sections 4, 6, 8, 9 all reference `series.between(t0, t1)`. The actual
method on `TimeSeries` is `series.within(begin, end) | within(range)`
(line 3936). There is no `between`. Every instance needs to become
`within`, or the RFC needs to propose `between` as a new public method
and explain why (rename? alias? add to the surface?). This is the kind
of drift that bites a year later when someone tries to use the
"bridge" pattern the RFC documents and the method doesn't compile.

#### 2. The Section 4 division-of-labor table has gaps

Missing column-side candidates that the "knows nothing about the key
column" test admits: **`any` / `all` / `none`** (boolean predicates
over the validity-defined cells — pure value-vector), **`hasMissing`
/ `nullCount`** (validity-bitmap-only, no key needed),
**`first` / `last` / `firstDefined` / `lastDefined`** (position-
indexed, time-agnostic). And one currently-on-TimeSeries operation
the test admits but the table doesn't mention: **`find` / `some` /
`every`** when restricted to a single column — though those take a
predicate, so the row-shape argument may keep them on TimeSeries. The
table should either enumerate these or say "this is illustrative, not
exhaustive."

#### 3. `count` divergence will bite

`series.length` returns event count; `col.count()` returns
defined-cell count. The two diverge whenever any cell in `col` is
undefined. `series.column('value').count() < series.length` is a
correct and surprising fact users will hit. The RFC doesn't name
this; the alternative names — `definedCount`, `validCount`,
`nonNullCount` — read worse but disambiguate. At minimum the doc
prose for `.count()` must lead with "count of defined cells, not
events" and the docs site should pin a short example. The "single
correct name in conflict with TimeSeries" tax is real and the RFC
elides it.

#### 4. The "detached from time" test is sharp but admits a soft case

The one-line test ("can you implement it knowing nothing about the
key column?") gives the right answer for everything in the table
except **monotonicity-aware reducers** (`isMonotonicIncreasing`,
`maxRun`, etc.). A `Float64Column` can compute these without ever
looking at the key column — the values' own ordering is what matters
— and yet the result is most often meaningful only because the
caller already knows the column is time-aligned. The test passes; the
result is meaningless. The Section 5 guardrail needs a second clause:
"and the result is meaningful without time context." Otherwise the
guardrail is a syntactic check, not a semantic one.

#### 5. Section 9 is missing an anti-pattern that will absolutely be proposed

**`Column.toArray()` / `Column.toJSON()` returning plain `number[]`.**
Someone will ask for it within a quarter — for printing, for sending
over the wire without TypedArray-aware serializers, for "I just want
a regular array." The discipline should be: `Float64Array` is the
canonical surface; if you want `number[]` write `Array.from(col.values)`
at the call site. Anti-patterns also missing: `col.equals(other)`
(deep equality is a TimeSeries concern because schemas matter); and
`col.toString()` / formatted output (presentation belongs in adapters,
not the substrate).

#### 6. Section 10 migration story is half honest

The claim that `series.reduce('value', 'min')` keeps working is true.
The claim that recommending the column-centric idiom is "safe to bake
into docs" needs a hedge — once docs use `series.column('value').min()`
as the canonical shape, **the schema-narrowed type system silently
diverges from the row-API shape**. `series.reduce('host', 'min')`
compiles (returns `ColumnValue | undefined`); `series.column('host').min()`
should not compile (Section 7 promises this). The two paths return
"the same result" today (runtime error on the row path); under the
column-centric recommendation, one path is a compile error and the
other isn't. That's an improvement, but the RFC should call it out as
a deliberate divergence with a transition story (and probably
recommend deprecating misuse of the row-API path in JSDoc, even
without removal).

#### 7. Section 11's "BooleanColumn / StringColumn on demand" is the right discipline, but creates a documentation hazard

The asymmetry isn't fatal — Float64 is genuinely where charts and
stats live. But documenting `col.min()` and `col.slice()` on
`Float64Column` without parallel docs on `StringColumn` will read as
"strings are second-class" to anyone reading the API reference cold.
Mitigation: the docs page should lead with the _generic_ `Column`
shape (read, scan, slice, validity, values, length, kind, storage),
and surface the per-kind reductions as a "what `Float64Column` adds"
section. That keeps the asymmetry honest without making it feel
arbitrary.

#### 8. Naming

- **`slice`** is the right name. `subarray` aliases buy nothing —
  pick one. The RFC's open-question hedge here should resolve to
  `slice` and drop `subarray`.
- **`binned`** is fine but consider **`downsampleTo(W, reducer)`**
  for the chart case (`binned` reads as a property, `downsampleTo`
  reads as an intent). Not a blocker.
- **`extent`** — the existing pond idiom for `extent` is **temporal**
  (`event.timeRange()` returns "the event extent"; `series.intersection`
  references "the overall series extent"). Reusing `extent` as a
  reducer name that returns `[min, max]` over values collides with
  the established prose. Use **`minMax`** or **`range`** (yes, also
  overloaded — but value-range is the dominant DataFrame meaning).
- **`fillForward` / `fillBackward`** — fine, match pandas idiom. But
  the existing `series.fill({ x: 'forward' })` shape would be cleaner
  on column as `col.fill('forward')` rather than four separate
  methods. Reduces surface area.
- **`percentile(q)`** — clarify whether `q` is `[0, 1]` or `[0, 100]`.
  M1 example shows `percentile(95)`. Pondjs and most stats libs use
  `[0, 100]`; numpy uses `[0, 100]`; pandas uses `[0, 1]`. Pick and
  pin.

#### 9. Open questions audit

- **Already decided**: storage-discriminator handling (the answer is
  in the draft text — `.values` throws if chunked, `.materialize().values`
  is the explicit path). Promote out of open questions.
- **Not in the list but should be**: what does `col.slice(s, e)` on a
  **chunked column** return? A chunked view? A materialized packed
  column? Same question as `.values`, but `.slice` will be reached
  for more often.
- **Not in the list but should be**: does `col.values` on a column
  with a validity bitmap return the dense buffer (caller must consult
  `col.validity`)? Section 7's example reads `valueCol.values` without
  any validity check — that's wrong for a real column, and the RFC
  doesn't surface the trap.
- **Not in the list but should be**: lifetime — `col` is a view over
  the parent series' buffers. What happens to `col` when the parent
  series is GC'd? In TypedArray-land, the `Float64Array` survives via
  the `ArrayBuffer` reference, but the question deserves an explicit
  yes/no.

#### 10. Arrow analogy

The Section 5 comparison is broadly accurate but glosses over one
relevant difference: Arrow's `Array` is **chunked at the type level**
(`ChunkedArray<T>`); pond's `Column` discriminated union flattens
chunked vs packed under one type. Arrow consumers always iterate via
`array.toArray()` or visitors precisely to avoid leaking the chunk
boundary into call sites. Pond's `.values` exposing the packed buffer
directly is a deliberate departure — worth a sentence saying so,
because otherwise readers familiar with Arrow will assume the
analogy is tighter than it is.

#### 11. Tension with `columnar-core.md` — justified, but understated

The walkback is real. `columnar-core.md` is explicit: "The public API
remains event-shaped. Columnar storage is an internal representation."
This RFC walks that back for single-column scalar operations. The
justification (chart friction in M1) is honest evidence, but the RFC
should explicitly say "this is a walkback of `columnar-core.md`'s
commitment, scoped to operations where the event-shape conveys no
information." Pretending it's purely additive ("supplements") is
slightly disingenuous — once Column is a documented public type with
reductions on it, it _is_ a parallel public API, just a deliberately
small one. Be honest about that in Section 1 framing; it'll save
future arguments.

**Reviewer confidence: medium** — I caught a factual error
(`between` vs `within`) and several gaps the draft should address,
but I'm not certain I caught every API-level conflict, and the
type-system shape of per-kind narrowing (Section 7) is the kind of
detail where this review is below the depth needed.

**Recommendation:** adopt with amendments — fix `between`→`within`,
resolve `extent` naming collision, tighten `count` semantics, add
the `Column.toArray()` and validity-trap anti-patterns, and reframe
the relationship to `columnar-core.md` as an explicit (small)
walkback rather than a pure supplement.

## V3 amendment: single-spec restructure (pond-ts library agent + pjm17971, 2026-05-27)

After Codex's adversarial pass on the V2-amended draft flagged that
the amendment-on-top-of-original pattern left contradictory text in
the spec (original §4 said `extent`, V2 said `minMax`; original §1
said "supplements `columnar-core.md`," V2 reframed as walkback;
Q6 ↔ Q8 contradicted on column identity), this V3 amendment
restructures the RFC into a single coherent body. The V2 amendment
section is gone — its content was inlined into §1–§13 directly.

**What changed in the body:**

- **§3 (proposal):** rewritten to reflect final API names — `minMax`,
  generalized `binnedByIndex<R>`. Fill is _not_ on Column at all
  (closed in piece C); all fill modes — including adjacency-based
  ones — stay on TimeSeries where time-aware limits can be
  expressed.
- **§4 (division of labor):** table expanded with V2 additions
  (`any` / `all` / `none`, `hasMissing` / `nullCount`, `first` /
  `last` / `firstDefined` / `lastDefined`, `minMax`,
  `uniqueCount`). Marked "illustrative, not exhaustive." Close-call
  cases extended with `binned` vs `series.binnedByTime`.
- **§5 (guardrail):** added the second clause — "AND is the result
  meaningful without time context" — with monotonicity-aware
  reducers as the worked counter-example.
- **§6 (the bridge):** updated example to use `minMax` and the
  two-channel `{ lo, hi }` output layout from the V2 chart-review
  fix.
- **§7 (type system):** previously rewritten in piece A to lay out
  the actual conditional types, per-kind interfaces, and type-level
  acceptance tests. The schema-narrowing claim is now backed by a
  verified-compilable TypeScript design.
- **§8 (chart use case):** updated worked example with final names;
  added the uniform-sampling precondition for `binned` and the
  pointer to `series.binnedByTime` for irregular data.
- **§9 (anti-patterns):** extended with V2 additions (`col.toArray()`,
  `col.toJSON()`, `col.equals()`, `col.toString()`) and the
  monotonicity case from §5.
- **§10 (migration):** added the honesty hedge about deliberate
  type-system divergence between row-API and column-API paths
  (column path catches what row path elides — an _improvement_, not
  a parity break).
- **§11 (sequencing):** collapsed steps 3 + 4 into one PR ("slice +
  binned together — they're useless apart"); added explicit
  `KeyColumn.at`/`.slice` step; added the M1 chart adoption loop;
  added the deferred `series.binnedByTime` step.
- **§12 (open questions):** audited — Q1, Q2, Q3, the `'extent'`
  output question, and the column-identity caching question
  closed (decided in the body above). Q6/Q8 contradiction in V2
  resolved: cached, identity-stable. New open questions added for
  the `.values` validity trap, Column lifetime, `.slice()` on
  chunked columns, and `series.binnedByTime` shape.
- **§13 (the line to hold):** updated to the two-clause test.

**What stayed unchanged:**

- The thesis. The Column / TimeSeries division is the same idea;
  the V3 work was about making the spec internally consistent and
  the type-system claim backed.
- Both review-notes sections. They're the audit trail of what
  reviewers said, preserved verbatim.
  **What V3 also did at the header level:**

- The "Relationship to other RFCs" metadata at the top was rewritten
  in V3 to drop the "supplements `columnar-core.md`" framing in
  favor of the V2 reviewer's "deliberate, small, scoped walkback"
  characterization. The honest framing matters because walkbacks
  set precedent for future walkbacks; supplements don't.

**Piece B — `binned` → `binnedByIndex` rename (landed):**

The body now consistently calls the method `binnedByIndex`. The
name spells out the index-domain semantics so the call site reads
unambiguously against the time-aware
`series.binnedByTime(name, W, range, reducer)` companion. Closes
Codex's finding #2 in name; the underlying semantic fix (chart
adapters must choose index-domain vs time-domain binning based on
sampling regularity) is documented in §4's close-case and §8's
uniform-sampling precondition.

**Piece C — remove `col.fill` (landed):**

All fill modes now live on TimeSeries. Closes Codex's V2 finding #3.
The underlying argument: even adjacency-based fills (`'forward'`,
`'backward'`) carry implicit time-context in real telemetry use —
gap limits like "don't carry across a 1-hour gap" need the key
column to express. The syntactic case for putting forward-fill on
Column is sound (you can implement it from the value vector +
validity alone), but the semantic case fails §5's second clause.
Keeping all fill modes on TimeSeries forces the time-context
decision to be explicit and untangles a class of unbounded-forward-
fill bugs.

Concretely:

- Struck `.fill(...)` from §3's proposal.
- The §4 division-of-labor table now has a single `fill(...)` row on
  the TimeSeries side covering all modes (including a `limit`
  option for gap-aware behavior).
- §4 close-case explains _why_ all fill modes stay on TimeSeries
  rather than splitting by mode.
- §9 anti-patterns has `col.fill(...) — any fill mode` as an
  explicit entry.
- §11 sequencing has no fill step (fill stays where it already is
  on TimeSeries; nothing new to land on Column).

**Adoption gate (unchanged from V2's framing):**

After pieces B and C land, a fresh Codex adversarial pass should
review the consolidated spec. If it lands without category-1 or
category-2 findings, the RFC is ready for adoption into PLAN.md
and the first-pass implementation can begin. The type-level
acceptance tests in §7.4 are the implementation-side contract.
