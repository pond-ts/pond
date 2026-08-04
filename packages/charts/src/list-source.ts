/**
 * The list family's **source union** — `rows` XOR `series`, shared by
 * {@link BarList} and {@link BoxList} ([PND-CHARTAPI]).
 *
 * Two things this fixes, both flagged on #590's review and deferred to here
 * so one union pattern serves the layers and the lists alike:
 *
 * 1. **The doors were both optional**, so `<BarList columns={…} />` with
 *    neither source, and `rows` + `series` together, type-checked and threw at
 *    render. Now each is a compile error.
 * 2. **The generic row type could lie.** `R` is inferred from the *callbacks*
 *    (`sort`, cell `render`, `renderExpanded`, `onRowClick`), so merely
 *    annotating one of them while passing `series` inferred a custom `R` that
 *    the series door cannot honour — it produces plain {@link ListRow}s. The
 *    series member pins `R` to `ListRow`, so the annotation now fails to
 *    compile instead of lying at runtime.
 */
import type { ReactNode } from 'react';
import type {
  SeriesSchema,
  TimeSeries,
  ValueSeries,
  ValueSeriesSchema,
} from 'pond-ts';
import type { ListRow, ListRowsOptions } from './list.js';

/**
 * The **record door**: entity rows built by hand or from partition facts.
 * `R` may extend {@link ListRow} with extra fields, which then flow into
 * every callback fully typed.
 */
export interface ListRowsSource<R extends ListRow> {
  readonly rows: readonly R[];
  readonly series?: never;
  readonly label?: never;
}

/**
 * The **series door**: one row per event, read internally — starting from a
 * pond series there is no shaping step. Rows are plain {@link ListRow}s (the
 * reader cannot know a caller's custom row shape), so this member does not
 * carry `R`.
 */
export interface ListSeriesSource<
  S extends SeriesSchema,
  VS extends ValueSeriesSchema,
> {
  readonly series: TimeSeries<S> | ValueSeries<VS>;
  readonly rows?: never;
  /**
   * The built-in label cell per row — from the row's ordinal and its axis key
   * (epoch ms / axis value). **Omitted ⇒ the stringified key renders.**
   */
  readonly label?: ListRowsOptions['label'];
}

/** `rows` XOR `series` — exactly one door, enforced at compile time. */
export type ListSource<
  R extends ListRow,
  S extends SeriesSchema,
  VS extends ValueSeriesSchema,
> = ListRowsSource<R> | ListSeriesSource<S, VS>;

/**
 * The row type a given source yields: a caller's `R` through the record door,
 * plain {@link ListRow} through the series door. Callback props resolve
 * against this, which is what stops the series door from claiming a custom
 * row shape it cannot produce.
 */
export type RowOf<Src> = Src extends { rows: readonly (infer T)[] }
  ? T extends ListRow
    ? T
    : ListRow
  : ListRow;

/** Narrowing helper for the components' runtime read of the union. */
export function isSeriesSource<
  R extends ListRow,
  S extends SeriesSchema,
  VS extends ValueSeriesSchema,
>(src: ListSource<R, S, VS>): src is ListSeriesSource<S, VS> {
  return (src as { series?: unknown }).series !== undefined;
}

/** Re-exported for the components' prop docs. */
export type ListLabel = (i: number, key: number) => ReactNode;
