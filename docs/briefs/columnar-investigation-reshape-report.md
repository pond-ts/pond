# Columnar investigation — reshape + multi-series report

**For:** pond-ts core maintainers.
**From:** investigation agent (Claude), 2026-05-13.
**Status:** feasibility friction note. Read in the framing of the
[scope brief](./columnar-investigation-reshape.md) — columnar
adoption is decided; this is per-operator implementation cost +
upside.

## 1. Operators investigated

Read carefully in `packages/core/src/TimeSeries.ts`:

- `pivotByGroup` (lines ~1758–1907) — long-to-wide, dynamic schema
- `groupBy` (~1585–1629) — splits into `Map<string, TimeSeries<S>>`
- `join` (~1110–1203) — binary outer/left/right/inner on time axis
- `joinMany` (~690–722) — N-ary; implemented as repeated binary joins
- `concat` (~820–855) — vertical stack of N same-schema series, re-sort
- `align` (~1236–1307) — `'hold'` / `'linear'` onto a `Sequence`
- `materialize` (~1360–1462) — one row per bucket, `first`/`last`/`nearest`
- `dedupe` (~2540–2641) — one row per key with policy
- `sample` (~3385–3422) — stride or single-pass reservoir (Algorithm R)

Strategy types in `packages/core/src/sample.ts`.

## 2. Multi-source story — gap that the spike doesn't sketch

`join` / `joinMany` / `concat` need a vocabulary for "operate over
N stores." The spike brief at
`docs/briefs/core-columnar-store-spike.md` covers the single-store
shape carefully (`schema`, `keyMs`, `columns`) but says nothing
about merging buffers from multiple stores.

The natural shape, derived from the existing event-walked impls:

- `Store.merge(stores, { type: 'outer' | 'left' | 'right' | 'inner', onConflict })`
  — produces a fresh store. The output has a new `beginMs` buffer
  (the union/intersection of input keys depending on `type`), plus
  one column per source's value columns. **The output cannot reuse
  the input's buffers directly** because rows are interleaved by
  key; the output column at row `i` may come from any source. So
  each output column is a fresh `Float64Array` etc. of the merged
  length, with cells gathered from the relevant source's column at
  the matched index, and bits set in a validity bitmap for rows
  where that source had no match.
- `Store.concatSorted(stores)` for `concat` — same-schema N-way
  merge of pre-sorted key arrays. **This one can plausibly reuse
  input column buffers as copy-once slabs** (with offsets into the
  output for stable runs), but the moment keys interleave between
  inputs, you're back to gather-by-index per output cell. In the
  common case of "append later data after earlier data" the runs
  ARE long, so a chunked output store (each input becomes one
  chunk) is the right shape — that's why the spike's
  `ColumnarChunk` exists. Chunk-aware `concat` is essentially
  zero-copy when the inputs don't temporally overlap, which is the
  common case for "fetch this hour + last hour."

**Type-mismatch hazard for `join`.** The current `join` accepts
mixed schemas as long as column names don't collide
(`prepareSeriesForJoin` handles the `'prefix'` case). Under
columnar, every borrowed column carries a `kind` (`'number'`,
`'string'`, `'boolean'`, `'array'`). Two sides naming `cpu` as
different kinds is already a schema conflict (caught today by
`buildConflictRenameMap` upstream of `join` execution); the
columnar path doesn't introduce new failure modes here, it just
needs to preserve the column's existing buffer type when merging.
The new constraint is that the merge function must dispatch per
kind for the gather step — there's no single "copy this cell" path
that works across `Float64Array` and a string-dictionary side
table.

**Conflict policies and buffer borrowing.** `{ onConflict: 'prefix' }`
renames columns before the merge, which under columnar can be
implemented as `Store.renameColumn(store, oldName, newName)`
returning a new store metadata header that **borrows the buffer by
reference** (rename is a no-op at the buffer level). That's the
clean win the framework needs to express. The spike doesn't yet
sketch "borrow column buffer by reference under a new name"; it
should.

## 3. Dynamic schema story — `pivotByGroup`'s shape

This is the most schema-rewriting operator in pond.

Today's path: pre-scan all events to discover distinct group
values, build a nested `Map<ts, Map<group, Cell[]>>`, sort
timestamps, then emit one row per ts with one column per discovered
(or declared) group.

Under columnar, the natural shape is **a two-pass build**:

1. **Pass 1 — schema discovery.** Walk the group column (a string
   column, ideally dictionary-encoded already) to enumerate
   distinct group values. With dictionary encoding, this is
   "iterate the dictionary," not "scan N events" — a clean win
   when the source already has a dictionary column.
2. **Pass 2 — buffer fill.** Allocate one typed-array per discovered
   group column up front (length = unique timestamps in source).
   Walk the source in a single pass; at each event, look up its
   group's column index, write the value into that column's buffer
   at the row corresponding to this timestamp, and set the
   validity bit. The duplicate-detection logic (today's
   `cell.length === 1` check vs aggregator) becomes "is the
   validity bit already set at this row?"

The trickiest part is **resolving timestamps to row indices** when
the source has duplicate timestamps. The current impl builds a
`Map<number, ...>` keyed by `begin()`. Under columnar, the
equivalent is: sort source events by ts (they already are), then
sweep to find distinct timestamps and assign each its output row
index — a single linear pass that produces a `Float64Array` of
output timestamps plus a `Int32Array` mapping source-row → output-row.
Then each value-write looks up the source-row's output-row in
O(1).

**Typed groups (`{ groups: HOSTS as const }`)** allow Pass 1 to be
skipped entirely — we know the output schema before walking any
event. This is the path that should be optimized first; it's also
the only one where the existing typed-output guarantee
(`PivotByGroupSchema<S, V, Groups>`) gives the framework concrete
column kinds at compile time.

**Framework requirement, novel.** The framework needs **builder-style
column allocation**, not just frozen stores:

```ts
type ColumnBuilder<T> = {
  append(value: T | undefined): void;
  finalize(): ColumnBuffer; // produces a frozen ColumnBuffer
};
```

`pivotByGroup` allocates N builders (one per group), fills them
sparsely, finalizes. This is the same shape `LiveSeries`'s
append-only typed buffers need (the spike notes "ring buffer with
head/length/capacity"). Unifying them is a small win.

## 4. Per-operator conversion path

| Operator                 | Path                                                            | Trade                                              |
| ------------------------ | --------------------------------------------------------------- | -------------------------------------------------- |
| `pivotByGroup` (typed)   | builders × N + index map                                        | parity or modest win on numeric value cols         |
| `pivotByGroup` (untyped) | two-pass: enumerate, then fill                                  | parity; dictionary source = clean win              |
| `groupBy`                | gather-by-key into N substores                                  | **regression risk** — see §8                       |
| `join` (binary)          | two-cursor outer + per-column gather                            | parity; numeric-heavy = win on the gather phase    |
| `joinMany`               | left-fold of binary joins — **don't N-ary-fuse for v1.0**       | parity (today's shape is fine)                     |
| `concat`                 | sorted-run merge with chunked store output                      | **clean win** when inputs don't temporally overlap |
| `align('hold')`          | for each grid step, `atOrBefore` cursor advance, gather columns | clean win                                          |
| `align('linear')`        | numeric path interpolates two source rows                       | clean win                                          |
| `materialize`            | single-cursor sweep, index-select per bucket                    | clean win                                          |
| `dedupe`                 | hash-group source rows by key, pick-by-policy index             | parity or modest win                               |
| `sample({stride})`       | row-index selection on the store                                | clean win                                          |
| `sample({reservoir})`    | Algorithm R produces K indices, then gather + key-sort          | parity                                             |

## 5. Primitives needed (signatures sketched)

```ts
// Sub-store materialization from a row-index selection.
Store.selectRows(store, indices: Int32Array): Store;

// Buffer-borrowing rename (zero copy).
Store.renameColumn(store, oldName, newName): Store;

// Append-style construction for dynamic-schema and ring-buffer cases.
ColumnBuilder<T>: { append(v: T | undefined): void; finalize(): ColumnBuffer };
Store.fromBuilders(schema, keyBuffer, builders): Store;

// Multi-source merge (binary; left-fold for joinMany).
Store.joinByKey(left, right, { type, onConflict }): Store;

// Chunked vertical stack — keeps inputs as chunks when key ranges don't overlap.
Store.concatSorted(stores): Store; // produces chunked store if possible

// Sparse-fill builder for pivotByGroup-shaped writes.
ColumnBuilder.appendAt(rowIndex: number, value): void;
```

That's six new framework operations, three of them
buffer-borrowing (`selectRows` when result is a view,
`renameColumn`, `concatSorted` in the chunked path). The other
three are real allocators (`joinByKey`, `fromBuilders`, the
materializing `selectRows`).

## 6. Clean wins

- **`concat`** with chunked store output — zero-copy when the
  inputs are temporally disjoint (the dashboard "fetch this hour
  plus last hour" pattern).
- **`align('hold')`** — the inner loop becomes "advance one
  cursor, copy one row from N typed arrays" instead of "build one
  event object per grid step." Should beat the current impl
  comfortably on dense grids.
- **`align('linear')`** numeric path — same row-gather plus
  pure-numeric interpolation on typed arrays. The existing impl
  already special-cases numeric and falls back to hold for other
  kinds; the columnar version preserves that fallback.
- **`materialize`** — single-cursor sweep over a typed source,
  single column-gather per bucket. The current impl is already
  cursor-based; the win is removing per-bucket `Object.freeze` and
  per-bucket `new Array(colCount + 1)`.
- **`sample({ stride })`** — row-index selection only.

## 7. Neutral parity

- **`pivotByGroup` (typed)** — net parity; the win on the value
  buffer fill is partly offset by the index-map build. Wins move
  proportionally with how numeric the value column is.
- **`join`** binary — the two-cursor outer-merge structure
  doesn't change; the wins are on the gather-into-typed-buffer
  step, lost on the prefix-rename plumbing if it forces a column
  copy.
- **`joinMany`** — today it's a left-fold of binary joins. The
  v1.0 path should keep that shape; an N-ary fused merge is a
  meaningful optimization the planner can add later. Parity is
  the baseline.
- **`dedupe`** — hash-bucket scan + policy resolution. Numeric
  `{ min: col }` / `{ max: col }` get faster (typed-array compare);
  custom-function and `'error'` paths are unchanged.
- **`sample({ reservoir })`** — Algorithm R is fundamentally
  RNG-bound; columnar doesn't make it faster, just removes the
  per-event object access. The post-sort by key is amortized over
  K rows so it's neutral.

## 8. Regression risk — specifics + mitigations

**`groupBy` returns `Map<string, TimeSeries<S>>` — N independent
stores per call.** Under columnar, naively each group allocates
its own column buffers compacted from the source. For a
dashboard-style call where a 1M-row source is split into 100
groups for per-host stats, that's 100 store constructions and a
fan-out of typed-array allocation.

**Mitigations:**

1. **Build a single index per group, materialize lazily** — return
   `Map<string, GroupView>` where each `GroupView` is a
   `{ source: Store, indices: Int32Array }` pair, materialized into
   a real `TimeSeries<S>` on first use. Most callers either run a
   transform per group then `TimeSeries.concat([...groups.values()])`
   immediately (the documented round-trip), or pick a single group
   by key and ignore the rest. The view shape avoids paying for the
   groups never read.
2. **Recognize the round-trip and short-circuit.** Today's
   `concat(values(groupBy(col, fn)))` pattern is widely used.
   `partitionBy(col).apply(fn).collect()` already exists and is
   the structurally correct shape for this — strongly recommend
   funneling `groupBy(col, fn) + concat` users toward
   `partitionBy` (this is adjacent to the partitioning scope but
   worth flagging here).
3. **If `groupBy` is left untouched for v1.0**, accept the
   regression and document it — most production code paths that
   care about perf-at-scale should be using `partitionBy` already.

**`pivotByGroup` (untyped) full enumeration scan.** First pass
walks every event to discover groups. On a high-cardinality group
column without a dictionary, that's an N-element string-set build.
**Mitigation:** if the source column is already
dictionary-encoded, enumerate the dictionary (length = distinct
values) instead of scanning the column. This requires the spike's
proposed dictionary encoding to actually exist for string columns
in the v1.0 wave (it's listed in the locked-in commitments — good).

**`join` with mixed string columns.** String columns under the
spike's shape (dictionary OR fallback array) need to be merged
carefully. If left has a dictionary and right has fallback, the
output's representation has to be decided per-column. **Mitigation:**
Normalize at merge time — the output side always materializes the
dictionary form if both sides agree on a string kind, else falls
back. Cost is bounded by the smaller side's dictionary size.

## 9. Knowns / unknowns

**Known:**

- The framework needs builder-style append construction
  (`ColumnBuilder`); it's required by both `pivotByGroup` and the
  spike's mentioned ring buffer.
- `concat` of temporally-disjoint inputs maps onto chunked stores
  and is essentially zero-copy. This is a real and obvious win.
- `align` and `materialize` are clean wins on the value-gather
  step.
- `groupBy`'s `Map<key, TimeSeries>` shape is awkward under
  columnar; flagged as the regression risk most worth fixing.

**Unknown:**

- Whether the multi-source merge primitives (`joinByKey`,
  `concatSorted`) are best implemented at the `Store` level or at
  the `TimeSeries` level. The brief's framework-vs-batch
  separation in the spike (`packages/core/src/columnar/`) suggests
  the lower layer, but the merge logic is closely entangled with
  schema-rewriting code in `prepareSeriesForJoin` that currently
  lives in `TimeSeries.ts`. Splitting these requires moving the
  conflict-resolution code into the framework layer or accepting
  that `TimeSeries.join` orchestrates the schema-merge while
  delegating buffer gather to the framework.
- How `pivotByGroup` should report duplicate-timestamp collisions
  under the validity-bit "already set" representation. The current
  error message names the count of colliding events
  (`${cell.length} events share timestamp ${ts}`); a single
  validity bit can't tell you "how many." The fix is to keep a
  separate Int32 collision-count column alongside the validity
  bitmap during the build, then drop it on finalize. Modest cost.
- The cost of buffer-borrowing semantics on subsequent operators.
  If `join`'s output borrows the source's buffer by reference,
  then a later `select`-then-`filter` chain on the result has to
  either copy or maintain "this output owns or borrows from store
  X" provenance. This is the same uncertainty the spike raises in
  Phase 3 ("does the store support cheap views"); the reshape
  scope sees the same friction. Not unique to reshape.

## 10. Recommendations

1. **Add `ColumnBuilder` to the framework layer first.** It's
   required by `pivotByGroup`, the `LiveSeries` ring buffer, and
   any future append-style construction. Sequencing this early in
   the framework-layer work (~step 1 of the PLAN sequence) is
   cheap and unblocks the reshape operators.
2. **Implement `concat` first among reshape operators.** It
   produces the cleanest demonstration of chunked-store wins and
   doesn't require new merge primitives — `concatSorted` is the
   smallest new operation.
3. **Implement `align` and `materialize` next.** Cursor-based
   sweeps, single store input, clean wins, no schema-rewriting
   complications.
4. **Defer `groupBy` columnarization.** Keep its current event-walked
   path. Drive users toward `partitionBy(col).apply(fn).collect()`
   for the perf-sensitive case (the partitioning scope owns this
   shape; check with that scope's report).
5. **For `pivotByGroup`, ship the typed-groups path columnar
   first.** Leave the dynamic path on the event-walked impl for
   v1.0, or ship it after dictionary-encoded string columns are
   real. The typed path is where the type system already does the
   schema work and where the wins compound.
6. **`join` / `joinMany`: implement the binary `Store.joinByKey`
   primitive, but keep `joinMany` as a left-fold over binary
   joins.** N-ary fusion is a planner-layer optimization that
   doesn't need to ship in v1.0.
7. **`dedupe`, `sample`** — straightforward conversions, no new
   framework concepts. Wait until other reshape work has shaken
   out the row-index-selection primitive (`Store.selectRows`),
   then dedupe and sample fall out cheaply.

Total framework additions for reshape scope: six primitives, of
which `Store.selectRows` and `ColumnBuilder` are shared with other
scopes (storage / partitioning). The reshape-specific additions
are `Store.joinByKey`, `Store.concatSorted`, `Store.renameColumn`
(zero-copy), and the chunked-output handling in `concatSorted`.
None of these block the framework-layer week-1 scope; they layer
on top in subsequent weeks.
