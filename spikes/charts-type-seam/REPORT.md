# [PND-CHARTAPI] type-seam spike — findings

**Verdict: go.** The feared cost (illegible union errors) did not
materialise, and the one genuine blocker found has a one-line fix that the
spike verified. Measured 2026-08-03 against `main` at `54d4b9e`, TypeScript
5.9.3.

The question this spike existed to answer: the 2026-08 API review calls
schema-derived column names + a discriminated mode union the highest-value
API change, but a **union of 4 modes × generic schema inference** is the
classic shape TypeScript reports worst. Would the errors be legible, would
JSX inference survive, and what does it cost to compile?

## What was measured

`variants.tsx` compiles three prop shapes against good and bad call sites:

- **V0** — today: everything optional, `column?: string`.
- **V1** — column names constrained to `NumericColumnNameForSchema<S>`, no
  union (the cheap half).
- **V2** — the full discriminated union of the four modes (`series+column`,
  `series+columns`, `bins+column`, `categories`).

## Findings

**1. The baseline bug is real, and now proven rather than asserted.** Two
`@ts-expect-error` probes on V0 came back as *unused directives* — i.e. TS
found nothing to complain about — confirming that today both
`<BarChart series column="cpuu" />` (a typo) and
`<BarChart series bins column="cpu" />` (two sources) compile and fail only
at runtime.

**2. JSX generic inference survives.** This was the main risk.
`<C series={cpuSeries} column="cpu" />` infers `S` from the `series` prop and
validates `column` against it, in both V1 and V2. No explicit type argument
is needed at any call site.

**3. Error messages are good — no "no overload matches" cascade.** The
reason is structural and worth recording: the union is on the **props object
type**, not on function overloads. JSX checks assignability to
`IntrinsicAttributes & Props<S>`, so TypeScript reports a targeted property
incompatibility instead of dumping candidate signatures.

| Call site (V2 unless noted)   | Message                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| V1 typo                       | `Type '"cpuu"' is not assignable to type '"cpu"'.` — one line        |
| V1 string column              | `Type '"host"' is not assignable to type '"cpu"'.`                   |
| Typo                          | 3 lines, ending in the same clean `'"cpuu"' is not assignable`       |
| Two sources (`series`+`bins`) | `Types of property 'bins' are incompatible … not assignable to 'undefined'` |
| `categories` + `column`       | targeted property incompatibility                                    |
| Missing required `column`     | worst case: names the missing property, lists 2 candidate members     |

The weakest message is the missing-`column` case, which lists union members
— still ~3 lines and it names the missing property. The `'undefined'` phrasing
in the two-sources case reads slightly cryptically ("bins should be
undefined here") and is the one place a doc note may earn its keep.

**4. Compile cost is negligible.** 400 call sites, three runs each,
`tsc --noEmit`:

| Variant             | Runs             | Median |
| ------------------- | ---------------- | ------ |
| V0 (today)          | 0.88 / 0.93 / 0.88 | 0.88 s |
| V2 (union + names)  | 0.95 / 0.92 / 0.94 | 0.94 s |

≈ **4% slower** at a call-site count no real app reaches. Not a factor.

**5. THE BLOCKER — and its fix.** `NumericColumnNameForSchema<SeriesSchema>`
resolves to **`never`**, verified two ways (`never` is assignable to
`string`; nothing is assignable to it). A naive constraint would therefore
make `column` accept *nothing at all* for any consumer holding a
loosely-typed series — a helper returning `TimeSeries<SeriesSchema>`, a prop
typed that way, or the components' own defaulted `S`. That is a large
silent breakage class that unit tests inside this repo (which use
`as const` schemas everywhere) would **not** have caught.

The fix is a `never`-guarded fallback, verified in the spike:

```ts
type ColumnName<S extends SeriesSchema> =
  [NumericColumnNameForSchema<S>] extends [never]
    ? string
    : NumericColumnNameForSchema<S>;
```

Narrow schemas keep the precise errors from finding 3; loose schemas keep
compiling exactly as today. The `[T] extends [never]` bracket form is
required — a bare `T extends never` distributes and yields the wrong answer
for unions.

## What this implies for the implementation

- Ship the fallback alias **first**, in one place, and derive every layer's
  column props from it. Never reference `NumericColumnNameForSchema`
  directly in a prop position.
- The union and the column names are separable: V1 alone fixes typos with
  the best messages; V2 additionally fixes mode mixing. Both are worth it,
  and V2's cost is only the slightly noisier missing-prop message.
- The lists' `rows` XOR `series` (and their generic-`R` cast hazard, deferred
  from #590) take the **same** union pattern — design once, apply to layers
  and lists together, as [PND-VSADAPT]'s review response promised.
- Add a test that a loosely-typed series still compiles. The blocker above is
  invisible to this repo's own suite otherwise.

## Reproduce

```bash
cd spikes/charts-type-seam && npx tsc -p tsconfig.json --pretty false
```

Expected: the V0 `@ts-expect-error` directives report as unused (finding 1),
and every V1/V2 bad call site reports the message in the table above.
