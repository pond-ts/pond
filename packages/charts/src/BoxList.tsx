import { useMemo, type ReactNode } from 'react';
import { ValueSeries } from 'pond-ts';
import type { SeriesSchema, TimeSeries, ValueSeriesSchema } from 'pond-ts';
import {
  listFraction,
  listRowsFromTimeSeries,
  listRowsFromValueSeries,
  resolveListDomain,
  sortListRows,
  validateBoxListColumn,
  type BoxListColumn,
  type ListCellSpec,
  type ListMarker,
  type ListRow,
  type ListRowsOptions,
  type ListSortDirection,
} from './list.js';
import {
  isSeriesSource,
  type ListRowsSource,
  type ListSeriesSource,
} from './list-source.js';
import { ListTable, listInk } from './ListTable.js';
import { defaultTheme, type BoxStyle, type ChartTheme } from './theme.js';

/** The props both BoxList source doors share. */
export interface BoxListCommon<R extends ListRow = ListRow> {
  /**
   * The box lines, **top→bottom within each row** — each names the `values`
   * entries for its five-number summary (`lower`/`upper` required; `q1`+`q3`
   * both-or-neither; `median` optional — the `<BoxPlot>` vocabulary), plus an
   * optional current-value tick (`value`) with an inline `format`ted label.
   * All lines share the **one scale** so distributions compare across the
   * whole list.
   */
  columns: readonly BoxListColumn[];
  /**
   * The shared scale's `[min, max]`. **Omitted ⇒ resolved from the data**
   * over every box's `lower`/`upper`/`value`: `[min(0, data min), data max]`.
   */
  domain?: readonly [number, number];
  /**
   * Name of the `values` entry that ranks the list. The box columns are
   * plain `values` names, so any stat sorts — the current value
   * (`sortBy="in_now"`), a p95, a median — with no stat-picking rule to
   * remember. Missing sorts last. **Omitted ⇒ input order.**
   */
  sortBy?: string;
  /** `'desc'` (default) or `'asc'`. */
  sortDirection?: ListSortDirection;
  /** Full custom comparator — **overrides** `sortBy`/`sortDirection`. */
  sort?: (a: R, b: R) => number;
  /** Data cell columns between the label and the boxes. */
  before?: readonly ListCellSpec<R>[];
  /** Data cell columns after the boxes. */
  after?: readonly ListCellSpec<R>[];
  /** A row's expanded detail; providing it adds the chevron column (see
   *  `BarListProps.renderExpanded`). */
  renderExpanded?: (row: R) => ReactNode;
  /** Row keys expanded on first render. */
  defaultExpanded?: readonly string[];
  /** Observe a toggle (`expanded` is the row's new state). */
  onExpandToggle?: (key: string, expanded: boolean) => void;
  /** The selected row's `key` (inset accent edge). Pair with `onRowClick`. */
  selected?: string | null;
  /** Row click (also gates the hover affordance). */
  onRowClick?: (row: R) => void;
  /** Each box line's height in px. **Omitted ⇒ `10`.** */
  barHeight?: number;
  /** Rule between rows. **Omitted ⇒ `true`.** */
  divided?: boolean;
  /**
   * Reference **markers** on the shared scale — a dotted vertical rule
   * through every row with the `label` printed above the list (see
   * `BarListProps.markers`; identical semantics, including joining the auto
   * domain fit).
   */
  markers?: readonly ListMarker[];
  /**
   * The vertical **baseline rule** at the scale origin (the glyph cell's left
   * edge, the row dividers' `axis.grid` ink). **Omitted ⇒ `true`** — box lines float
   * at their `lower` quantile, so the shared origin is what lets the eye
   * relate rows to each other. Pass `false` to drop it.
   */
  baseline?: boolean;
  /** Styling — boxes resolve `theme.box[as]`. **Omitted ⇒ {@link defaultTheme}.** */
  theme?: ChartTheme;
}

/**
 * `<BoxList>`'s props: the shared knobs ({@link BoxListCommon}) plus **exactly
 * one** source door ([PND-CHARTAPI]). Passing both `rows` and `series`, or
 * neither, is now a **compile** error rather than a render-time throw.
 *
 * The two members differ in their row type on purpose. Through `rows`, a
 * caller's `R` flows into every callback. Through `series` the rows are read
 * internally and are plain {@link ListRow}s, so that member pins the callbacks
 * to `ListRow` — annotating a callback with a custom row type while passing
 * `series` no longer compiles, where before it silently lied (#590 review).
 */
export type BoxListProps<
  R extends ListRow = ListRow,
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
> =
  | (BoxListCommon<R> & ListRowsSource<R>)
  | (BoxListCommon<ListRow> & ListSeriesSource<S, VS>);

/**
 * A **distribution row list** — {@link BarList}'s sister, drawing a horizontal
 * five-number box per configured column instead of a value bar: the light
 * `lower→upper` range band, the stronger `q1→q3` body, the `median` line, and
 * an optional **current-value tick** with a printed label (the esnet
 * traffic-by-interface look: where traffic *ranges* vs where it *is now*).
 *
 * Same table contract as {@link BarList} (standalone, cells, sort, expander,
 * one shared scale, gap-aware), same quantile vocabulary as the canvas
 * `<BoxPlot>` (`lower`/`q1`/`median`/`q3`/`upper`, both-or-neither body,
 * quantiles **pre-computed upstream** — `series.reduce` facts; the chart never
 * computes them).
 *
 * ```tsx
 * <BoxList
 *   rows={ifaceRows}
 *   columns={[
 *     { lower: 'in_p5', q1: 'in_p25', median: 'in_p50', q3: 'in_p75',
 *       upper: 'in_p95', value: 'in_now', format: fmtBps },
 *     { lower: 'out_p5', q1: 'out_p25', median: 'out_p50', q3: 'out_p75',
 *       upper: 'out_p95', value: 'out_now', format: fmtBps, as: 'secondary' },
 *   ]}
 *   sortBy="in_now"
 * />
 * ```
 */
export function BoxList<
  R extends ListRow = ListRow,
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
>(props: BoxListProps<R, S, VS>) {
  // One normalized view of the union — `isSeriesSource` is the runtime
  // narrowing; the doors are mutually exclusive by construction now.
  const source = props as BoxListCommon<R> & {
    rows?: readonly R[];
    series?: TimeSeries<S> | ValueSeries<VS>;
    label?: ListRowsOptions['label'];
  };
  const {
    rows,
    series,
    label,
    columns,
    domain,
    sortBy,
    sortDirection = 'desc',
    sort,
    before,
    after,
    renderExpanded,
    defaultExpanded,
    onExpandToggle,
    selected,
    onRowClick,
    markers,
    barHeight = 10,
    divided,
    baseline = true,
    theme = defaultTheme,
  } = source;
  // A runtime guard for JS consumers and `any`-typed call sites — the
  // props union makes both branches unreachable from typed TS, but a
  // silently-ignored source prop is a worse failure than a throw.
  if (isSeriesSource(props) === (rows !== undefined)) {
    throw new Error(
      '<BoxList>: provide exactly one of `rows` (records) or `series` (one row per event)',
    );
  }
  for (const col of columns) validateBoxListColumn(col);
  // The series door reads internally — starting from a pond series there is
  // no shaping step (with `series`, R stays the default ListRow).
  const allRows = useMemo(
    () =>
      rows ??
      ((series instanceof ValueSeries
        ? listRowsFromValueSeries(series, label !== undefined ? { label } : {})
        : listRowsFromTimeSeries(
            series as TimeSeries<S>,
            label !== undefined ? { label } : {},
          )) as unknown as readonly R[]),
    [rows, series, label],
  );
  const sorted = useMemo(
    () => sortListRows(allRows, sortBy, sortDirection, sort),
    [allRows, sortBy, sortDirection, sort],
  );
  const scale = useMemo(
    () =>
      resolveListDomain(
        allRows,
        columns.flatMap((c) =>
          c.value !== undefined
            ? [c.lower, c.upper, c.value]
            : [c.lower, c.upper],
        ),
        domain,
        markers?.map((m) => m.value),
      ),
    [allRows, columns, domain, markers],
  );
  const resolvedMarkers = useMemo(
    () =>
      markers?.map((m) => ({
        frac: listFraction(m.value, scale),
        ...(m.label !== undefined ? { label: m.label } : {}),
      })),
    [markers, scale],
  );

  return (
    <ListTable
      rows={sorted}
      kind="box"
      markers={resolvedMarkers}
      before={before}
      after={after}
      renderExpanded={renderExpanded}
      defaultExpanded={defaultExpanded}
      onExpandToggle={onExpandToggle}
      selected={selected}
      onRowClick={onRowClick}
      divided={divided}
      baseline={baseline}
      theme={theme}
      renderGlyphs={(row) => (
        <>
          {columns.map((col, ci) => (
            <BoxLine
              // Index-qualified so two lines over the same quantile names
              // (say, styled differently) never collide.
              key={`${ci} ${col.lower} ${col.upper}`}
              row={row}
              col={col}
              scale={scale}
              height={barHeight}
              style={theme.box[col.as ?? 'default'] ?? theme.box.default}
              ink={listInk(theme)}
              fontSize={theme.font.size}
            />
          ))}
        </>
      )}
    />
  );
}

/** One horizontal box line: range band → body → median → current tick + label. */
function BoxLine<R extends ListRow>({
  row,
  col,
  scale,
  height,
  style,
  ink,
  fontSize,
}: {
  row: R;
  col: BoxListColumn;
  scale: readonly [number, number];
  height: number;
  style: BoxStyle;
  ink: string;
  fontSize: number;
}) {
  const at = (name: string | undefined) =>
    name === undefined ? null : listFraction(row.values[name], scale);
  const lo = at(col.lower);
  const hi = at(col.upper);
  const q1 = at(col.q1);
  const q3 = at(col.q3);
  const med = at(col.median);
  const tick = at(col.value);
  const raw = col.value !== undefined ? row.values[col.value] : undefined;
  const label =
    col.format !== undefined && typeof raw === 'number' && Number.isFinite(raw)
      ? col.format(raw)
      : null;

  const pct = (f: number) => `${f * 100}%`;
  // The row keeps its slot height even when everything is missing — a gap
  // reads as an empty line, not a collapsed row.
  return (
    <div
      data-list-boxline=""
      style={{ position: 'relative', height: height + 4, margin: '2px 0' }}
    >
      {lo !== null && hi !== null && (
        <div
          data-list-range=""
          style={{
            position: 'absolute',
            top: 2,
            bottom: 2,
            left: pct(lo),
            width: pct(Math.max(hi - lo, 0)),
            background: style.whisker,
            opacity: 0.55,
            borderRadius: height / 2,
          }}
        />
      )}
      {q1 !== null && q3 !== null && (
        <div
          data-list-body=""
          style={{
            position: 'absolute',
            top: 2,
            bottom: 2,
            left: pct(q1),
            width: pct(Math.max(q3 - q1, 0)),
            background: style.fill,
            opacity: Math.min(style.fillOpacity * 2, 1),
            borderRadius: 1,
          }}
        />
      )}
      {med !== null && (
        <div
          data-list-median=""
          style={{
            position: 'absolute',
            top: 2,
            bottom: 2,
            left: `calc(${pct(med)} - ${style.medianWidth / 2}px)`,
            width: style.medianWidth,
            background: style.median,
          }}
        />
      )}
      {tick !== null && (
        <>
          <div
            data-list-tick=""
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `calc(${pct(tick)} - 1.5px)`,
              width: 3,
              background: style.stroke,
              borderRadius: 1,
            }}
          />
          {label !== null && (
            <span
              data-list-value=""
              style={{
                position: 'absolute',
                left: `calc(${pct(tick)} + 8px)`,
                top: '50%',
                transform: 'translateY(-50%)',
                whiteSpace: 'nowrap',
                fontSize: fontSize + 1,
                color: ink,
              }}
            >
              {label}
            </span>
          )}
        </>
      )}
    </div>
  );
}
