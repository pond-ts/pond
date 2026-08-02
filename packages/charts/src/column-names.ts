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
 * `lower`/`upper`, a box's quantiles, an OHLC price). Falls back to `string`
 * for a schema that names no numeric columns (see the module doc).
 */
export type NumericColumn<S extends SeriesSchema> = [
  NumericColumnNameForSchema<S>,
] extends [never]
  ? string
  : NumericColumnNameForSchema<S>;

/**
 * **Any** value column of `S` — for props that read a column without
 * requiring it to be numeric (a scatter's `label` text column). Same
 * fallback rule as {@link NumericColumn}.
 */
export type AnyColumn<S extends SeriesSchema> = [
  ValueColumnsForSchema<S>[number]['name'],
] extends [never]
  ? string
  : ValueColumnsForSchema<S>[number]['name'];

/**
 * The `ValueSeries` sibling of {@link NumericColumn}. A `ValueSeries` schema
 * is a different type family, so it needs its own derivation; the fallback
 * rule is identical.
 *
 * Layers accept **either** series kind on one `column` prop, so their props
 * take the *union* of both derivations — `NumericColumn<S> |
 * ValueNumericColumn<VS>`. With one side loose that union widens to `string`,
 * which is the intended behaviour: a chart typed loosely on either axis
 * cannot be checked, and must not be broken.
 */
export type ValueNumericColumn<VS extends ValueSeriesSchema> = [
  NumericColumnNameForValueSchema<VS>,
] extends [never]
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
