/**
 * Schema-derived column-name types for the draw layers' column props —
 * [PND-CHARTAPI]'s foundation.
 *
 * The 2026-08 API review's finding: the layers are generic over the schema,
 * but their column props are bare `string`, so `<LineChart series={cpu}
 * column="cpuu" />` compiles and fails at runtime — out of character for a
 * library whose core exports `NumericColumnNameForSchema<S>`. These aliases
 * close that gap in one place; **no prop position should reference core's
 * helper directly.**
 *
 * ## Why the `never` guard is load-bearing
 *
 * `NumericColumnNameForSchema<SeriesSchema>` resolves to **`never`** — an
 * unparameterized schema names no columns. Constraining a prop to it
 * directly would therefore make `column` accept *nothing at all* for every
 * consumer holding a loosely-typed series: a helper returning
 * `TimeSeries<SeriesSchema>`, a React prop typed that way, or a component's
 * own defaulted `S`. That is a large, silent breakage class — and one this
 * repo's own suite cannot see, because its fixtures use `as const` schemas
 * throughout (measured in `spikes/charts-type-seam/REPORT.md`, finding 5).
 *
 * So each alias falls back to `string` when the derived union is empty:
 * a **narrow** schema gets precise names and a one-line error on a typo, a
 * **loose** one keeps compiling exactly as before. The bracketed
 * `[T] extends [never]` form is required — a bare `T extends never`
 * distributes over unions and answers the wrong question.
 */
import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  ValueColumnsForSchema,
  ValueSeriesSchema,
} from 'pond-ts';

/**
 * A **numeric** value column of `S` — the constraint for every prop naming a
 * column the layer reads as a number (a line's `column`, a band's
 * `lower`/`upper`, a box's quantiles, an OHLC price).
 *
 * The test is **"is the schema loose?"**, not "did it yield no numeric
 * columns" — those are different questions with different right answers, and
 * conflating them was a real bug. A schema that names columns but has no
 * numeric one (all-string) should reject *every* name, because there is
 * genuinely nothing numeric to plot; only an **unparameterized** schema, whose
 * column names are unbounded, should fall back to `string`. `string extends
 * AnyColumn<S>` distinguishes them: it is true only when the name union is
 * open.
 */
export type NumericColumn<S extends SeriesSchema> =
  string extends AnyColumn<S> ? string : NumericColumnNameForSchema<S>;

/**
 * **Any** value column name of `S`, of any kind — the looseness probe for
 * {@link NumericColumn}. On an unparameterized schema this is `string` (an
 * open union), which is exactly what distinguishes "cannot check" from
 * "checked, and nothing matches". Internal: no prop is typed with it, so it
 * stays off the public surface until one is.
 */
type AnyColumn<S extends SeriesSchema> =
  ValueColumnsForSchema<S>[number]['name'];

/**
 * The `ValueSeries` sibling of {@link NumericColumn} — a different schema type
 * family, so it needs its own derivation; the loose-schema rule is identical.
 *
 * **Layers do not union the two.** A prop typed `NumericColumn<S> |
 * ValueNumericColumn<VS>` is inert: only one of the two generics is ever
 * inferred at a call site, so the other falls back to `string` and widens the
 * union away. Each layer's props are instead a union **per series kind**, so
 * the names check against the schema that was actually passed. Measured in
 * `spikes/charts-type-seam/REPORT.md`.
 */
export type ValueNumericColumn<VS extends ValueSeriesSchema> =
  string extends VS[number]['name']
    ? string
    : NumericColumnNameForValueSchema<VS>;

/**
 * Names of `'number'`-kind value columns on a `ValueSeries` schema. Core
 * exports the `TimeSeries` equivalent but not this one; derived locally
 * rather than widening core's surface for a charts-only need.
 */
type NumericColumnNameForValueSchema<VS extends ValueSeriesSchema> = Extract<
  VS[number],
  { readonly kind: 'number' }
>['name'];
