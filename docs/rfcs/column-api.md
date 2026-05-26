# RFC: Column-centric public API

**Status:** **draft, awaiting review.**

**Relationship to PLAN.md:** This RFC is strategic context, not a
commitment. [PLAN.md](../../PLAN.md) is the binding source of truth
for what is being built. Phases adopted into PLAN are commitments;
the rest of this document is forward-looking. See [CLAUDE.md → Strategic
RFCs](../../CLAUDE.md) for the layering.

**Relationship to other RFCs:** This RFC **supplements**
[`columnar-core.md`](columnar-core.md), which committed to "public API
remains event-shaped; columnar storage is an internal representation."
That commitment is preserved for multi-column / time-aware operations.
This RFC proposes a deliberate, small, well-bounded _additional_ public
surface — a `Column` object returned by `series.column('x')` — that
serves single-column / time-agnostic operations on the substrate's
typed-array layer. The chart-extraction experiment surfaced friction
that justifies the addition; the discipline below is what prevents it
from sprawling into a parallel API.

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

| Section                                                  | Contributor                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Original draft (thesis + tier model + division of labor) | pond-ts library agent (Claude) + pjm17971, 2026-05-26                        |
| Key insight: "Column is detached from the time axis"     | pjm17971, 2026-05-26                                                         |
| Review notes — chart-experiment perspective              | _pending — to be added by pond-ts charts experiment agent_                   |
| Review notes — library perspective                       | _pending — to be added by a fresh pond-ts library agent (independent agent)_ |
| Codex adversarial pass                                   | _pending_                                                                    |

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
`.median()`, `.percentile(q)`, `.count()`), **index-based slicing**
(`.slice(s, e)`), **index-based binning** (`.binned(W, reducer)`),
**element access** (`.at(i)`, `.values`, `.validity`, `.length`),
and **adjacency-based fills** that don't need time spacing
(`.fillForward()`, `.fillBackward()`, `.fillZero()`,
`.fillConstant(c)`). It does **not** expose any operation that
references the time axis, takes a `KeyLike` argument, or produces a
modified TimeSeries. Those stay on `TimeSeries`.

### 4. The Column / TimeSeries division of labor

The test for "does this operation belong on Column?" is one line:
**can you implement it knowing nothing about the key column?** If yes,
Column. If no, TimeSeries.

| Operation                   | Belongs on   | Why                                                                                                                                         |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `min`, `max`, `sum`, `avg`  | `Column`     | Pure value-vector reductions                                                                                                                |
| `stdev`, `median`, `pN`     | `Column`     | Same — operate only on the value vector + validity                                                                                          |
| `count`                     | `Column`     | Defined-cell count via validity bitmap; no key needed                                                                                       |
| `slice(start, end)`         | `Column`     | Index-based; produces a Column view                                                                                                         |
| `binned(W, reducer)`        | `Column`     | Equal-width index bins, scalar reducer per bin; chart's per-pixel hot path                                                                  |
| `at(i)`, `values`           | `Column`     | Position-indexed read                                                                                                                       |
| `fillForward`, `fillZero`   | `Column`     | Adjacency- or constant-based — no time gap involved                                                                                         |
| **`fillLinear`**            | `TimeSeries` | Interpolation rate depends on time gaps; needs key column                                                                                   |
| `aggregate(every('5s'))`    | `TimeSeries` | Bucket boundaries are time-shaped                                                                                                           |
| `rolling('5s')`             | `TimeSeries` | Window width is time                                                                                                                        |
| `align(every('1s'))`        | `TimeSeries` | Explicitly aligns values to a time grid                                                                                                     |
| `between(t0, t1)`           | `TimeSeries` | Time-based windowing — needs key column to translate `t` → index                                                                            |
| `bisect(t)`                 | `TimeSeries` | The bridge from time-space to index-space; this **is** the place where you cross from TimeSeries-land to Column-land for the chart use case |
| `join`, `concat`, `groupBy` | `TimeSeries` | Multi-series / multi-column ops                                                                                                             |

The line should be drawn precisely. Three close-call cases:

- **`fill('linear')` vs `fill('forward')`.** Linear interpolation
  needs the time deltas between defined cells to compute the slope;
  forward fill just propagates the last defined value. So linear is
  TimeSeries, forward is Column. Today both live on TimeSeries
  uniformly; the column-centric split would put forward / backward /
  zero / constant on Column and keep linear on TimeSeries. That
  _exposes_ the dependency in the API shape, where today it's hidden.
- **`slice` vs `between`.** `col.slice(startIdx, endIdx)` is
  index-based and lives on Column; `series.between(t0, t1)` is
  time-based and lives on TimeSeries. The bridge is `series.bisect(t)`.
- **`binned` vs `aggregate`.** `col.binned(W, reducer)` is
  index-bucket reduction (equal-width, W bins); `series.aggregate(every('5s'), ...)`
  is time-bucket reduction (boundaries derived from time). The
  chart's per-pixel downsampler uses `binned`; an analytics pipeline
  computing "5-minute averages" uses `aggregate`.

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

The discipline that protects this: **no method on Column takes a
`KeyLike` or anything time-shaped as an argument.** That's the
single-line guardrail. If a future contributor proposes
`col.range(t0, t1)` or `col.aggregate(every('5s'), ...)`, the answer
is "that's a TimeSeries method; use `series.between(t0, t1).column('x')`
or `series.aggregate(...)`."

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
const extents = col.binned(pixelWidth, 'extent'); // Float64Array(2W)
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

### 7. Type-narrowing benefit

`series.column('value')` returns `Float64Column` narrowed by the
schema (the existing `Column<EventForSchema<S>>` machinery already
handles this for the spike accessors). Each kind-narrowed column
exposes only the methods that make sense for its kind:

```ts
// Float64Column: reductions, ranges, typed access
series.column('value').min();
series.column('value').values; // Float64Array
series.column('value').percentile(95);

// StringColumn: kind-appropriate methods only
series.column('host').uniqueCount();
series.column('host').values; // ReadonlyArray<string> or Uint32Array dict indices
// series.column('host').min()  ← compile error
```

Compared to today's `series.reduce('host', 'min')` — which compiles
fine (the reducer name is just a string) and fails at runtime when
the row-API path tries to take `min` of strings — this is a
significant correctness improvement. The type system enforces
kind-appropriate operations at the call site.

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
runtime guard. (Storage discrimination — `packed` vs `chunked` — is
covered by the existing materialize-or-direct-access dispatch inside
Column; consumers don't have to think about it. If a chunked column
appears, methods either materialize internally or expose a `.values`
that returns the chunk array — TBD which is right; see open
questions.)

Per-frame draw becomes:

```ts
function drawFrame() {
  // Time-space → index-space (bridge)
  const startIdx = series.bisect(viewport.start);
  const endIdx = series.bisect(viewport.end);

  // Column-space (everything below)
  const visible = series.column('value').slice(startIdx, endIdx);

  if (visible.length > cssWidth) {
    // Per-pixel min/max downsampling — single column-method call
    const extents = visible.binned(cssWidth, 'extent');
    // extents[2*px] = lo for pixel px; extents[2*px+1] = hi
    // ... draw vertical lines per pixel
  } else {
    // No downsampling needed; draw raw values
    const ys = visible.values;
    // ... draw point per cell
  }
}
```

`visible.binned(cssWidth, 'extent')` is the column-centric expression
of M1 friction item #6 (`reduceColumnRange(col, start, end)`). The
shape is cleaner than the friction note proposed — the consumer
doesn't think in terms of "column ranges" as a primitive; they think
"give me min and max per pixel" as a single call.

### 9. Anti-patterns (what NOT to do)

These shapes would betray the design discipline. Reject them in
review:

- **`col.aggregate(every('5s'), ...)`** — bucket boundaries are
  time; needs the key column. Use `series.aggregate(...)`.
- **`col.rolling('5s', ...)`** — window width is time. Use
  `series.rolling(...)`.
- **`col.range(t0, t1)`** — time-based range. Use
  `series.between(t0, t1).column('x')`.
- **`col.fill('linear')`** — interpolation slope is time-based. Use
  `series.fill({ x: 'linear' })`.
- **`col.toSeries()`** — round-tripping back to TimeSeries reopens
  the "what about the key column?" question and creates a parallel
  reconstruction path. If you need a TimeSeries-shaped result, do
  the operation on TimeSeries.
- **Column mutation methods** (`col.set(i, v)`, `col.push(v)`).
  Column is read-only. Mutations go through TimeSeries (which has
  the schema and can validate). For "I want to modify one column and
  get a new series" semantics, see `series.mutate(...)` if/when
  added, or the existing transform methods on TimeSeries.

The unifying anti-pattern is **anything that would make Column feel
like "TimeSeries minus key column"**, because then every TimeSeries
method gains a column equivalent and the API doubles in size. Column
is a strict subset: read-only, time-agnostic, scalar-producing.

### 10. Migration story

Existing call sites keep working unchanged. `series.reduce('value',
'min')` is still supported; under the hood it dispatches through the
same column fast path (PR #153) that `series.column('value').min()`
would use. The two paths return the same result.

Docs adopt the column-centric idiom as recommended going forward:

```ts
// Old idiom (still works)
const min = series.reduce('value', 'min');

// Recommended idiom
const min = series.column('value').min();
```

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

1. Land the public `Column` / `KeyColumn` type re-exports
   (M1 friction #4) — small, prerequisite.
2. Add scalar reduction methods to `Float64Column` (`min`, `max`,
   `sum`, `mean`, `stdev`, `median`, `percentile`, `count`).
   Implementation dispatches through the existing internal
   `ReducerDef.reduceColumn` path; no new perf work.
3. Add `Float64Column.slice(start, end)` returning a Column view
   over the underlying buffer. Zero-copy.
4. Add `Float64Column.binned(W, reducer)` returning `Float64Array`.
   Implementation is a loop over `reducer.reduceColumnRange`; the
   `'extent'` variant is a fused single-pass min+max.
5. Repeat (2) for `BooleanColumn` (`all`, `any`, `count`) and
   `StringColumn` (`uniqueCount`, top-N) as the use cases earn
   them — not on spec.
6. Update docs to recommend the column-centric idiom for single-column
   work.

Each step lands as its own PR with the standard two-pass review.

### 12. Open questions

- **Storage-discriminator handling.** Today `series.column('x')` may
  return a `ChunkedFloat64Column` if the series was built via
  `concatSorted`. Should Column methods auto-materialize chunks, or
  should `.values` throw on chunked storage and force the caller to
  call `.materialize()` first? Auto-materialize is friendlier but
  hides an O(N) cost behind a property access. Throwing is honest
  but pushes the dispatch back to the caller (the M1 friction item
  #1 we're trying to eliminate). Probably: provide `.values` that
  returns the typed array if packed, throws if chunked; provide
  `.materialize().values` as the explicit "I'll pay for it" path;
  provide `.iterate()` (or similar) for streaming access that works
  uniformly across both. Worth a dedicated decision before #2 above.
- **`Float64Column.subarray(start, end)`** as a name. Better than
  `slice`? `slice` is the data-frame idiom (Polars, Pandas); but
  TypedArray's `subarray` is exactly what we want semantically
  (view, not copy). Or both, with `slice` as the documented name
  and `subarray` as an alias?
- **`binned` reducer string vs callback.**
  `col.binned(W, 'extent')` — string-typed reducer name. Same
  string-discoverability issue as today's `series.reduce(col,
reducer)`. Should `binned` take a callback (`(slice) => [number,
number]`)? Or a `BinnedReducerDef`? Or just a hand-typed string
  union of `'min' | 'max' | 'mean' | 'extent' | ...`? Lean toward
  string union for autocompletion; rich callback for power users
  via a separate overload.
- **`'extent'` reducer.** Defined as "min and max in one pass,
  returns `[lo, hi]`." Doesn't fit `kind: 'number'` output (it's
  array-shaped). New reducer-output kind, or chart-only utility?
  If the latter, `col.binned(W, 'extent')` returns `Float64Array(2W)`
  by special-casing it in the `binned` implementation. Worth a
  decision before #4.
- **`StringColumn` / `BooleanColumn` surface scope.** This RFC's
  thrust is mostly motivated by `Float64Column`. The same shape
  generalizes — but BooleanColumn doesn't have `min` (or does:
  `false`); StringColumn has `top` / `unique` but not `mean`. Per-kind
  method sets need to be drawn carefully. Probably scope to the
  driving use case (chart needs Float64; defer Boolean/String/Array
  expansion to when a real consumer earns each method).
- **Per-pixel binning semantics for chunked columns.** If
  `binned(W, 'extent')` is called on a chunked column, does it
  materialize first? Stream chunk-by-chunk? Probably the same
  decision as the `.values`-on-chunked question above.

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
method, the test is: "does this need to know what timestamp index
`i` is at, or what other columns exist?" If yes → TimeSeries. If no
→ Column.

This is what keeps the API from sprawling into a Polars-shape
parallel surface. Pond's value proposition is the **time-aware**
composition that TimeSeries provides. Column is a small, well-bounded
public substrate for the operations where the time axis genuinely
doesn't matter — and that's exactly the case for charts (which just
need fast typed-array access) and for statistical summaries (which
just need the value distribution).

## Review notes

_To be added by reviewers. Per CLAUDE.md, this RFC follows the
multi-agent review pattern: original draft, review notes from
relevant agents, amendments by the original author, each section
carrying inline attribution. Don't merge competing rewrites — layer
responses as new sections so the contributor chain stays visible._

Suggested reviewers:

- **pond-ts charts experiment agent (Claude)** — does this API
  serve the M1 / M2 / M3 use cases cleanly? Are the operations on
  Column the right ones for chart consumers?
- **Fresh pond-ts library agent (Claude)** — independent read of
  whether the Column / TimeSeries division of labor holds up;
  whether the anti-patterns list is complete; whether the migration
  story is honest.
- **Codex adversarial pass** — type-system shape, naming, anti-pattern
  enforcement, anything the draft glossed over.
