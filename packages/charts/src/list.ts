/**
 * The **list family**'s data model + pure row logic — the shared substrate of
 * {@link BarList} and {@link BoxList}, the DOM-rendered *ranked row lists*
 * (react-timeseries-charts' `HorizontalBarChart`, the esnet "traffic by
 * interface" table, an activity's per-split bars).
 *
 * A list is a **table, not a plot**: rows are entities (interfaces, splits,
 * symbols), each row carries a label, optional data cells, and one glyph line
 * per configured column — a value bar ({@link BarList}) or a five-number
 * distribution box ({@link BoxList}). That is why this family renders DOM
 * rather than registering canvas layers in a `<ChartContainer>`: the defining
 * features (link labels, arbitrary cells, a per-row expander, custom sort) are
 * table semantics a band-scaled plot can't carry. The in-plot horizontal bars
 * remain `<BarChart orientation="horizontal">` — that's the histogram; this is
 * the table.
 *
 * Everything here is pure (no React rendering): row/column/cell types, the
 * shared value scale, and sorting. The components consume these so the two
 * sisters can never disagree on semantics.
 */
import type { ReactNode } from 'react';
import type {
  SeriesSchema,
  TimeSeries,
  ValueSeries,
  ValueSeriesColumnName,
  ValueSeriesSchema,
} from 'pond-ts';

/**
 * One cell value of a {@link ListRow}: a finite number renders (bar length,
 * box quantile, sortable), a string rides along for data cells and
 * lexicographic sort, and `undefined` / non-finite is a **gap** (no glyph,
 * sorts last). The tolerant union keeps one `values` record serving glyphs,
 * cells, and sort at once.
 */
export type ListValue = number | string | undefined;

/**
 * One row of a {@link BarList} / {@link BoxList}.
 *
 * - `key` is the row's **stable identity** — selection, expansion, and React
 *   keys all pin to it, so it must be unique in the list (a duplicate key
 *   would expand/select both rows at once).
 * - `label` is the built-in first cell's content (a plain string, or a link /
 *   any node). **Omitted ⇒ the `key` renders.**
 * - `values` is the row's flat data record. Glyph columns and `sortBy` read it
 *   by name; data cells may read it or any extra field a consumer adds (both
 *   components are generic over `R extends ListRow`, so custom fields ride
 *   through to `render` / `renderExpanded` fully typed).
 */
export interface ListRow {
  readonly key: string;
  readonly label?: ReactNode;
  readonly values: Readonly<Record<string, ListValue>>;
}

/**
 * One **bar line** of a {@link BarList} row — laid out top→bottom in `columns`
 * order within each row (the esnet to-site / from-site pairing is two of
 * these).
 */
export interface BarListColumn {
  /** Name of the {@link ListRow.values} entry holding this bar's length. A
   *  missing / non-numeric value is a gap — the track renders empty. */
  readonly column: string;
  /**
   * The bar's semantic identifier — what the data _is_. The theme maps it to a
   * `BarStyle` (`theme.bar[as] ?? theme.bar.default`), the same single
   * styling channel `<BarChart>` uses. **Omitted ⇒ the `default` bar style.**
   */
  readonly as?: string;
}

/**
 * One **box line** of a {@link BoxList} row — a five-number distribution
 * summary plus an optional *current value* tick, each field naming an entry of
 * {@link ListRow.values}. The quantile vocabulary (`lower`/`q1`/`median`/`q3`/
 * `upper`, `q1`+`q3` both-or-neither for a range-only box) mirrors the canvas
 * `<BoxPlot>` exactly, so moving between the plot and the list renames
 * nothing.
 */
export interface BoxListColumn {
  /** `values` entry for the lower whisker end (e.g. a `p5` / `min` fact). Required. */
  readonly lower: string;
  /** `values` entry for the box bottom (Q1). Omit with `q3` for a range-only box. */
  readonly q1?: string;
  /** `values` entry for the median line. Omit for no centre line. */
  readonly median?: string;
  /** `values` entry for the box top (Q3). Omit with `q1` for a range-only box. */
  readonly q3?: string;
  /** `values` entry for the upper whisker end (e.g. a `p95` / `max` fact). Required. */
  readonly upper: string;
  /**
   * `values` entry for the **current-value tick** — the dark now-marker over
   * the distribution (the esnet look: range band + tick + printed value).
   * Omit for a distribution-only box.
   */
  readonly value?: string;
  /** Semantic identifier → `theme.box[as] ?? theme.box.default`. */
  readonly as?: string;
  /**
   * Formats the current value's **inline label**, printed just right of the
   * tick (`"150Gbps"`). **Omitted ⇒ no label** (the tick still draws). Only
   * read when `value` is set.
   */
  readonly format?: (value: number) => string;
}

/**
 * One **data cell** column, rendered before or after the glyph cell (the
 * split's `15.3 mph`, an interface's type tag). `render` receives the whole
 * row — including any consumer-added fields beyond {@link ListRow} — and
 * returns any node; the table gives every cell of a spec its own shrink-to-fit
 * table column, so cells align down the list.
 */
export interface ListCellSpec<R extends ListRow = ListRow> {
  /** Stable identity for the cell column (React key). */
  readonly key: string;
  /** Horizontal text alignment. **Omitted ⇒ `'left'`.** */
  readonly align?: 'left' | 'right' | 'center';
  /** The cell's content for one row. */
  readonly render: (row: R) => ReactNode;
}

/** Row order: `'desc'` puts the largest value at the top (the ranked-list
 *  default), `'asc'` the smallest. */
export type ListSortDirection = 'asc' | 'desc';

/**
 * Sort rows for display. Precedence: a `custom` comparator wins outright;
 * else `sortBy` names the {@link ListRow.values} entry that drives the order
 * (with several glyph columns, this is how you decide which one ranks the
 * list); else the input order stands (the splits case — chronological rows).
 *
 * Value semantics under `sortBy`: numbers order numerically, strings
 * lexicographically (`localeCompare`); when the two kinds meet, numbers come
 * first; a missing / non-finite value sorts **last regardless of direction**
 * (a dead interface stays at the bottom whether you rank best-first or
 * worst-first). The sort is stable, so ties keep input order.
 */
export function sortListRows<R extends ListRow>(
  rows: readonly R[],
  sortBy: string | undefined,
  direction: ListSortDirection,
  custom?: (a: R, b: R) => number,
): readonly R[] {
  if (custom !== undefined) return [...rows].sort(custom);
  if (sortBy === undefined) return rows;
  const dir = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a.values[sortBy];
    const bv = b.values[sortBy];
    const aNum = typeof av === 'number' && Number.isFinite(av);
    const bNum = typeof bv === 'number' && Number.isFinite(bv);
    const aStr = typeof av === 'string';
    const bStr = typeof bv === 'string';
    // Missing sorts last in BOTH directions — absence is not a small value.
    const aMissing = !aNum && !aStr;
    const bMissing = !bNum && !bStr;
    if (aMissing || bMissing)
      return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
    if (aNum && bNum) return dir * ((av as number) - (bv as number));
    if (aStr && bStr) return dir * (av as string).localeCompare(bv as string);
    // Mixed kinds: numbers rank before strings, direction-independent (a
    // deliberate tie-break, not an ordering claim across kinds).
    return aNum ? -1 : 1;
  });
}

/**
 * The shared value scale's domain: every glyph line of every row maps through
 * **one** `[min, max]` so lengths compare across the whole list (the point of
 * a ranked list). Resolved from the data — `keys` names every `values` entry
 * that lands on the scale (bar columns; box lower/upper/value) — as
 * `[min(0, data min), data max]`: bars grow from zero, but a below-zero
 * whisker still fits. An explicit `domain` prop overrides both ends. An empty
 * / all-missing list resolves `[0, 1]` so the mapping stays finite.
 */
export function resolveListDomain(
  rows: readonly ListRow[],
  keys: readonly string[],
  explicit?: readonly [number, number],
): readonly [number, number] {
  if (explicit !== undefined) return explicit;
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    for (const key of keys) {
      const v = row.values[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (min === Infinity) return [0, 1];
  return [Math.min(0, min), max];
}

/**
 * Map one value onto the shared scale as a **fraction of the track width**,
 * clamped to `[0, 1]` (an out-of-domain value pins to an edge rather than
 * escaping the row). `null` for a gap (missing / non-numeric / non-finite) —
 * the caller draws nothing. A degenerate `min === max` domain maps everything
 * to `0` (nothing to proportion against).
 */
export function listFraction(
  value: ListValue,
  domain: readonly [number, number],
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const [d0, d1] = domain;
  if (d1 === d0) return 0;
  const f = (value - d0) / (d1 - d0);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * Reject a half-specified box body — `q1`/`q3` are both-or-neither, the same
 * contract as the canvas `<BoxPlot>` / `BoxColumns` (a box needs two body
 * edges or none). Throws on exactly one.
 */
export function validateBoxListColumn(column: BoxListColumn): void {
  if ((column.q1 === undefined) !== (column.q3 === undefined)) {
    throw new RangeError(
      `BoxList: 'q1' and 'q3' are both-or-neither — a box body needs both edges ` +
        `(got q1=${column.q1 ?? 'undefined'}, q3=${column.q3 ?? 'undefined'}). ` +
        `Omit both for a range-only box (a lower→upper band).`,
    );
  }
}

/** Options for {@link listRowsFromTimeSeries} / {@link listRowsFromValueSeries}. */
export interface ListRowsOptions {
  /**
   * The built-in label cell's content per row, from the row's ordinal position
   * and its axis key (epoch ms for a `TimeSeries` — an interval key passes its
   * `begin` — or the axis value for a `ValueSeries`). **Omitted ⇒ no label**,
   * so the cell falls back to the row `key` (the stringified axis key);
   * real-world lists almost always want this (`(i) => \`${i + 1}\`` for
   * splits, a date formatter for daily rows).
   */
  readonly label?: (i: number, key: number) => ReactNode;
}

/**
 * Read a series into {@link ListRow}s — **one row per event**, every value
 * column (numeric *and* string) landing in `values` under its own name. The
 * split-table reader: an `aggregate` per-split rollup feeds straight in, glyph
 * columns pick the columns to draw, cells format the rest. The row `key` is
 * the stringified axis key (an interval key's `begin`), which is unique in a
 * series by construction.
 *
 * Reads per event via `event.get()` (row counts here are table-sized; the
 * typed-array fast paths stay with the canvas readers).
 */
export function listRowsFromTimeSeries<S extends SeriesSchema>(
  series: TimeSeries<S>,
  options: ListRowsOptions = {},
): ListRow[] {
  const begin = series.keyColumn().begin;
  return buildListRows(
    valueColumnNames(series.schema),
    (name) => columnReader(series.column(name)),
    series.length,
    (i) => begin[i]!,
    options,
  );
}

/**
 * The value-axis sibling of {@link listRowsFromTimeSeries} — one row per axis
 * key (`series.byValue('dist')` per-km splits). The row `key` is the
 * stringified axis value.
 */
export function listRowsFromValueSeries<VS extends ValueSeriesSchema>(
  series: ValueSeries<VS>,
  options: ListRowsOptions = {},
): ListRow[] {
  const axis = series.axisValues();
  return buildListRows(
    valueColumnNames(series.schema),
    (name) => columnReader(series.column(name as ValueSeriesColumnName<VS>)),
    series.length,
    (i) => axis[i]!,
    options,
  );
}

/** A schema's value column names in order (the key column excluded). */
function valueColumnNames(schema: unknown): string[] {
  const cols = schema as ReadonlyArray<{ name: string; kind: string }>;
  return cols.slice(1).map((c) => c.name);
}

/**
 * A column handle's per-cell reader. `read(i)` is a method on the column
 * *class* (the same access path `data.ts` uses — the bulk readers are mounted
 * by a side-effect import that bundlers tree-shake away); the cast mirrors
 * `assertNumericColumn`'s. `undefined` for an unknown column name.
 */
function columnReader(col: unknown): ((i: number) => unknown) | undefined {
  if (col === undefined || col === null) return undefined;
  const c = col as { read(i: number): unknown };
  return (i) => c.read(i);
}

/** Shared body of the two readers: walk rows, lift each value column. */
function buildListRows(
  names: readonly string[],
  readerOf: (name: string) => ((i: number) => unknown) | undefined,
  length: number,
  keyAt: (i: number) => number,
  options: ListRowsOptions,
): ListRow[] {
  const readers = names.map((name) => ({ name, read: readerOf(name) }));
  const out: ListRow[] = [];
  for (let i = 0; i < length; i += 1) {
    const values: Record<string, ListValue> = {};
    for (const { name, read } of readers) {
      const v = read?.(i);
      values[name] =
        typeof v === 'number' || typeof v === 'string' ? v : undefined;
    }
    const key = keyAt(i);
    out.push({
      key: String(key),
      ...(options.label !== undefined ? { label: options.label(i, key) } : {}),
      values,
    });
  }
  return out;
}
