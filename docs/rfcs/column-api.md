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

| Section                                                  | Contributor                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| Original draft (thesis + tier model + division of labor) | pond-ts library agent (Claude) + pjm17971, 2026-05-26            |
| Key insight: "Column is detached from the time axis"     | pjm17971, 2026-05-26                                             |
| Review notes — chart-experiment perspective              | pond-ts charts experiment perspective agent (Claude), 2026-05-26 |
| Review notes — independent library perspective           | independent pond-ts library agent (Claude), 2026-05-26           |
| V2 amendment (response to reviews)                       | pond-ts library agent (Claude) + pjm17971, 2026-05-26            |
| Codex adversarial pass                                   | _pending_                                                        |

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
| `within(t0, t1)`            | `TimeSeries` | Time-based windowing — needs key column to translate `t` → index                                                                            |
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
- **`slice` vs `within`.** `col.slice(startIdx, endIdx)` is
  index-based and lives on Column; `series.within(t0, t1)` is
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
is "that's a TimeSeries method; use `series.within(t0, t1).column('x')`
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
  `series.within(t0, t1).column('x')`.
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

## V2 amendment: response to reviews (pond-ts library agent + pjm17971, 2026-05-26)

Both reviews landed substantive findings. This amendment integrates
them. The original draft above is preserved intact except for one
factual fix applied in-place (`between` → `within` throughout, per
the library review's point #1). All design changes below layer on
top of the original; they don't rewrite it.

### A. Factual fix applied in-place

- `series.between(t0, t1)` → `series.within(t0, t1)`. The actual
  TimeSeries method is `within(begin, end) | within(range)` at
  `packages/core/src/batch/time-series.ts:3936`. The original draft's
  prose used a method that doesn't exist; sections 4, 6, 8, 9, 13 are
  corrected. (Library review #1.)

### B. Substantive design changes

1. **`extent` reducer renamed to `minMax`.** The library reviewer
   caught that `extent` already has a temporal meaning in pond
   (`event.timeRange()` returns the event extent; `series.intersection`
   speaks of series extent). Reusing `extent` for a value-range
   reducer would collide. The fused single-pass min+max reducer is
   now `minMax`. Promoted from "use `binned(1, 'extent')`" to a
   first-class scalar method per the chart reviewer's point #2:
   `Float64Column.minMax(): [number, number]`. (Library review #8;
   chart review #1, #4.)

2. **`binned(W, 'minMax')` output is two-channel, not interleaved.**
   The chart reviewer caught a real cache-pattern issue: an
   interleaved `Float64Array(2W)` forces stride-2 access in the
   per-pixel draw loop. The output is now
   `{ lo: Float64Array(W); hi: Float64Array(W) }` — stride-1 access
   on each channel, matches how canvas drawing actually consumes the
   data, and lets the outer Y-extent be cheaply computed as
   `Math.min(...lo) / Math.max(...hi)`. (Chart review #4.)

3. **`binned` return type generalized.** Was implicitly
   `Float64Array`. Now `binned<R>(W, reducer): ReducerOutput<R>` so
   LTTB and other multi-point per-bucket reducers fit later without
   reshaping the signature. Built-in returns: `min/max/mean/median/...`
   → `Float64Array(W)`; `minMax` → `{ lo, hi }`; future LTTB →
   `{ keys: Float64Array; values: Float64Array }` with W output
   points. (Chart review #4.)

4. **`slice` + `binned` ship in one PR.** Original sequencing had
   them as steps 3 and 4. They're useless apart — without `slice`,
   `binned` would need a four-arg `(start, end, W, reducer)`
   signature. Now jointly step 3. (Chart review #3.)

5. **KeyColumn surface explicit.** `KeyColumn` gets `.at(i)` and
   `.slice(s, e)` (zero-copy view, mirroring Column). It does NOT
   get scalar reductions — `min` / `max` over a sorted key column
   are trivially `keys.begin[0]` / `keys.end[length - 1]` and
   shouldn't be wrapped in a method that suggests an O(N) walk.
   Future M5 (heatmap) and tooltip flows will use `keys.at(i)` to
   resolve the hovered cell's timestamp. (Chart review #1.)

6. **Division of labor table extended.** Added to the Column side:
   `any` / `all` / `none` (boolean predicates over validity-defined
   cells, primarily `BooleanColumn`), `hasMissing` / `nullCount`
   (validity-bitmap-only), `first` / `last` / `firstDefined` /
   `lastDefined` (position-indexed). The table is now declared
   "illustrative, not exhaustive" — the discipline is the test in
   section 5, not the specific list. (Library review #2.)

7. **`count` semantics pinned, kept as `count`.** `col.count()`
   returns defined-cell count, not event count. This diverges from
   `series.length` (event count) when validity bitmap has gaps.
   Considered renaming to `definedCount` / `validCount` for
   disambiguation, but `count` matches data-frame idiom (Polars /
   Pandas / numpy all use `count` for non-null count on a column)
   and the divergence is documentable rather than rename-around-able.
   JSDoc on `count` will lead with "count of defined cells, not
   events," and the docs site recipe will pin a short example.
   (Library review #3.)

8. **"Detached from time" guardrail tightened (section 5).** The
   one-line test gains a second clause:

   > _Can you implement it knowing nothing about the key column,
   > **AND is the result meaningful without time context?**_

   Without the second clause, monotonicity-aware reducers
   (`isMonotonicIncreasing`, `maxRun`) would pass syntactically but
   produce results that are only meaningful because the caller
   assumes time-alignment. The amended guardrail catches the
   semantic case. (Library review #4.)

9. **Anti-patterns extended (section 9).** Added:
   - `col.toArray(): number[]` — `col.values` is the canonical
     surface; if `number[]` is needed, write `Array.from(col.values)`
     at the call site. Pond doesn't ship the helper.
   - `col.toJSON()` returning plain-array JSON — same rationale;
     presentation/serialization belongs in adapters.
   - `col.equals(other)` — deep equality is a TimeSeries concern
     because schemas matter.
   - `col.toString()` / formatted output — presentation belongs in
     adapters, not the substrate.

   And one workaround that's NOT an anti-pattern (chart reviewer's
   point on `col.toSeries()`): building a new `TimeSeries` from
   `(slicedKeys.begin, col.values)` is the explicit path when M3
   wants a downsampled series. (Library review #5; chart review #2.)

10. **Migration story honesty pass (section 10).** Amended to
    acknowledge the deliberate type-system divergence:
    `series.reduce('host', 'min')` compiles and fails at runtime;
    `series.column('host').min()` won't compile. The two paths agree
    only on well-typed inputs. JSDoc on `series.reduce(col, reducer)`
    will note the preferred column-centric path for single-column
    work. This is an _improvement_ — the row-API path's permissive
    typing is a known soft spot, and the column-centric idiom fixes
    it at the call site for new code. (Library review #6.)

11. **Documentation discipline for kind asymmetry (section 11).**
    The docs page leads with the **generic `Column` shape** (read,
    scan, slice, validity, values, length, kind, storage), then
    surfaces per-kind reductions in a "what `Float64Column` adds"
    sub-section. Same for `StringColumn` / `BooleanColumn` when
    their methods earn the surface. This frames the Float64 richness
    as additive, not "strings are second-class." (Library review #7.)

12. **Naming decisions resolved:**
    - `slice` (not `subarray`). Resolves open question Q2.
    - `extent` → `minMax`. Per #1 above.
    - `percentile(q)` takes `q ∈ [0, 100]`. Matches numpy / pondjs /
      the existing row-API string reducer convention (`'p95'`, `'p99'`,
      etc., where the suffix is `[0, 100]`). Pandas's `[0, 1]` rejected
      for cross-API consistency. (Library review #8.)
    - `fillForward` / `fillBackward` / `fillZero` / `fillConstant`
      → `col.fill(method)` single method with a discriminated argument:
      `'forward' | 'backward' | 'zero' | { constant: number }`.
      Matches `series.fill({ x: 'forward' })` shape. Reduces surface
      area. (Library review #8.)
    - `binned` retained over `downsampleTo`. Binned is the more
      general term (multi-point reducers, statistical binning, not
      only chart downsampling); downsampling is one application.
      (Library review #8.)

13. **Open questions audit (section 12 amended):**
    - **Q1 (storage-discriminator handling)**: closed. `.values`
      throws on chunked; `.materialize().values` is the explicit
      path; `.iterate()` (or `.scan()` per pond's existing
      `scan(invalidValue?)` idiom) is the kind-uniform streaming
      access. Pinned in section 7.
    - **Q3 (binned reducer string vs callback)**: closed. String
      union for built-ins (autocompletion); callback overload for
      custom reducers; matches `series.reduce(col, reducer)` shape.
    - **New Q5: `.values` validity trap.** `col.values` returns the
      dense buffer; cells outside `col.validity` are unspecified
      (currently `0` for `Float64Column`, but not contractual). The
      worked example in section 7 needs a validity-aware variant:
      either show `col.iterate()` as the safe default, or show the
      `col.validity` bits-check beside `.values`. Open question:
      should `.values` be renamed `.rawValues` to make the trap
      louder? Lean no — `.values` is the ergonomic name everyone
      expects, and validity is a real but separable concern.
    - **New Q6: lifetime semantics.** `Column` is a view over the
      parent series' typed buffers. The `Float64Array` survives via
      its `ArrayBuffer` reference even if the parent series goes out
      of scope (V8 GC honors live `ArrayBuffer` references). The
      contract should be pinned: "Column is safe to hold across
      parent-series GC; do not assume `series.column('x') === series.column('x')`
      across calls without explicit memoization."
    - **New Q7: `.slice()` on chunked column.** Same shape as Q1.
      Probably: returns a chunked view if the slice spans multiple
      chunks; returns a packed view if the slice falls within one
      chunk. Defer to the chunked-column-aware methods implementation.
    - **New Q8: `series.column('x')` caching.** Chart reviewer's
      point: the per-frame draw closure calls `series.column('value')`
      inline; if that allocates per call, the chart needs to hoist.
      Decision: `series.column('x')` is **free to call** — returns
      a cached Column instance lazily constructed on first access,
      memoized for the series' lifetime. The Column itself is
      immutable so caching is safe.

14. **Arrow analogy nuance (section 5).** Amended to note the
    relevant chunking difference: Arrow's `Array` is `ChunkedArray<T>`
    at the type level; pond's `Column` discriminated union flattens
    `packed` vs `chunked` storage under one type. Pond's `.values`
    exposing the packed buffer directly is a deliberate departure
    from Arrow's "always iterate via visitor" pattern — it accepts
    the chunked-storage cliff (`.values` throws) in exchange for
    zero-cost packed access in the common case. (Library review #10.)

15. **Walkback framing honesty (section 1).** Reframed: this RFC is
    a **deliberate, small, scoped walkback** of `columnar-core.md`'s
    "public API remains event-shaped" commitment. The walkback is
    justified by the chart-extraction friction evidence (M1 cold
    validation, with 6 library-actionable items). It is scoped to
    _single-column, time-agnostic_ operations — anything multi-column
    or time-aware stays event-shaped per the original commitment. The
    "supplement" framing in the original draft was understated;
    calling it a walkback in section 1 saves future arguments.
    (Library review #11.)

### C. Adoption gate

After this V2 amendment, the RFC is positioned for a Codex
adversarial pass. The library reviewer ended at **medium confidence**
("the type-system shape of per-kind narrowing — section 7 — is the
kind of detail where this review is below the depth needed"). That
recommendation maps cleanly onto the standard Codex-after-medium-L2
protocol from `CLAUDE.md`. Adoption into PLAN.md gates on the Codex
pass landing without category-1 (correctness) or category-2 (design)
findings that would force another amendment round.

### D. What lands once adopted

Per the amended section 11:

1. Public `Column<K>` and `KeyColumn` type re-exports from
   `pond-ts` top-level barrel (M1 friction #4 prerequisite).
2. Float64Column scalar reductions: `min`, `max`, `sum`, `mean`,
   `stdev`, `median`, `percentile(q)`, `count`, `minMax`. Plus
   value-vector predicates: `hasMissing`, `nullCount`. Plus
   position-indexed: `first`, `last`, `firstDefined`, `lastDefined`,
   `at(i)`, `values`, `length`, `validity`. (Dispatches through PR #153's
   internal `reduceColumn` fast path.)
3. **`Float64Column.slice(start, end)`** + **`Float64Column.binned<R>(W, reducer)`**
   as one PR (zero-copy view + binned reducer family).
4. `KeyColumn.at(i)` + `KeyColumn.slice(s, e)`. KeyColumn does not
   get scalar reductions.
5. `Float64Column.fill(method)` — single method with discriminated
   argument.
6. Update M1 chart to use the new API (the "alongside update loop"
   per the original sequencing). Friction note captures any residual
   awkwardness for V3 amendment / future RFC.
7. BooleanColumn / StringColumn / ArrayColumn reductions: case-by-case
   as use cases earn them. Docs framed as "what each kind adds" to the
   generic Column shape.

Each step lands as its own PR with the standard two-pass review.
