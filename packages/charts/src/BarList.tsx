import { useMemo, type ReactNode } from 'react';
import { ValueSeries } from 'pond-ts';
import type { SeriesSchema, TimeSeries, ValueSeriesSchema } from 'pond-ts';
import {
  listFraction,
  listRowsFromTimeSeries,
  listRowsFromValueSeries,
  resolveListDomain,
  sortListRows,
  type BarListColumn,
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
import { ListTable } from './ListTable.js';
import { defaultTheme, type ChartTheme } from './theme.js';

/** The props both BarList source doors share. */
export interface BarListCommon<R extends ListRow = ListRow> {
  /**
   * The bar lines, **top→bottom within each row** — each names a `values`
   * entry for its length and optionally a theme role (`as`). Several columns
   * stack as parallel lines per row (the to-site / from-site pairing), all on
   * the **one shared scale**, so lengths compare across lines and rows alike.
   */
  columns: readonly BarListColumn[];
  /**
   * The shared scale's `[min, max]`. **Omitted ⇒ resolved from the data**:
   * `[min(0, data min), data max]` over every bar column of every row. Set it
   * to pin the scale across live updates (a re-sorting traffic list whose max
   * changes every tick) or across sibling lists.
   *
   * Bars are **length-encoded from the domain minimum** — the component
   * assumes non-negative values. A negative value stays in-domain (the auto
   * fit widens below zero) but draws as a short left-anchored bar, not a
   * diverging one; diverging bar lists are out of scope (transform upstream,
   * or use {@link BoxList}, whose marks are positional).
   */
  domain?: readonly [number, number];
  /**
   * Name of the `values` entry that **ranks the list** — with several bar
   * columns, this is the decision of which one drives the order. Missing /
   * non-finite values sort last either direction. **Omitted ⇒ input order**
   * (the chronological splits case).
   */
  sortBy?: string;
  /** `'desc'` (default — largest on top, the ranked-list convention) or `'asc'`. */
  sortDirection?: ListSortDirection;
  /** Full custom comparator — **overrides** `sortBy`/`sortDirection`. */
  sort?: (a: R, b: R) => number;
  /** Data cell columns rendered **between the label and the bars**, in order. */
  before?: readonly ListCellSpec<R>[];
  /** Data cell columns rendered **after the bars**, in order (a split's
   *  speed / climb readouts). */
  after?: readonly ListCellSpec<R>[];
  /**
   * A row's expanded detail (any node — a stats grid, a nested chart).
   * **Providing it adds the chevron column**; expansion is per-row,
   * uncontrolled, keyed on `row.key` (so it survives a re-sort), seeded by
   * `defaultExpanded`. Omitted ⇒ no expander UI at all.
   */
  renderExpanded?: (row: R) => ReactNode;
  /** Row keys expanded on first render. */
  defaultExpanded?: readonly string[];
  /** Observe a toggle (`expanded` is the row's **new** state). */
  onExpandToggle?: (key: string, expanded: boolean) => void;
  /**
   * The selected row(s), marked with an inset edge in the annotation (marks)
   * register — selection is a user's mark, not data. Consumer-owned state:
   * pair with {@link onRowClick}. `null` / omitted ⇒ none.
   *
   * **Accepts one key or a set**, the same union {@link hovered} takes
   * ([PND-INTERACTCONF] / RFC `interaction.md` A3.1 — the list family speaks
   * the canvas's interaction vocabulary, not a parallel one). Plural because
   * a range of rows can be selected at once; passing a bare key still means
   * exactly what it looks like.
   *
   * The library applies **no set arithmetic** — it renders what you hand back.
   */
  selected?: string | readonly string[] | null;
  /** Row click (rows show the pointer affordance only when provided). */
  onRowClick?: (row: R) => void;
  /**
   * Controlled **hover-highlight** — the transiently lit row key(s), or `null`.
   * **Omitted ⇒ uncontrolled** (the list tracks its own pointer, as it always
   * has). The hover analog of {@link selected}: pass it to light rows from
   * _outside_ the list — the chart bar the pointer is on, a map segment, a
   * sibling list.
   *
   * **Accepts one key or a set**, the same union `<ChartContainer hovered>`
   * takes ([PND-INTERACTCONF] / RFC `interaction.md` A3.1 — the list family
   * speaks the canvas's interaction vocabulary, not a parallel one). Plural
   * because a sweep lights several marks at once; a plain pointer-over carries
   * 0 or 1, so passing a bare key still means exactly what it looks like.
   *
   * The library applies **no set arithmetic** — it reports what the pointer is
   * over and renders what you hand back.
   */
  hovered?: string | readonly string[] | null;
  /**
   * Fires when the pointer enters a row (with that row) or leaves every row
   * (`null`) — the hover analog of `onRowClick`, and the list's half of the
   * bidirectional channel: mirror it out to light the matching chart bar,
   * pairing with {@link hovered} to sync hover both ways.
   *
   * Notification only (fires controlled or uncontrolled) and **deduped by row
   * key**, so it reports a row transition, not every pointer move. Moving from
   * one row straight to the next reports the new row — no `null` in between;
   * `null` means the pointer genuinely left the rows.
   */
  onHover?: (row: R | null) => void;
  /** Each bar line's height in px. **Omitted ⇒ `8`.** */
  barHeight?: number;
  /** Rule between rows (`theme.axis.grid`). **Omitted ⇒ `true`.** */
  divided?: boolean;
  /**
   * Reference **markers** on the shared scale — each draws a dotted vertical
   * rule through every row (annotation-register ink) with its `label` printed
   * above the list, centred on the rule. An SLA line, a capacity, the fleet
   * average. Marker values **join the auto domain fit** (a threshold above
   * the data max widens the scale); under an explicit `domain` they clamp.
   */
  markers?: readonly ListMarker[];
  /**
   * The vertical **baseline rule** at the scale origin (the glyph cell's left
   * edge, the row dividers' `axis.grid` ink). **Omitted ⇒ `false`** — a bar's track
   * already shows where zero is; opt in when the tracks are visually quiet.
   * (`<BoxList>` defaults it **on**: its lines float at `lower`, so the shared
   * origin is what relates rows to each other.)
   */
  baseline?: boolean;
  /** Styling — the same {@link ChartTheme} the canvas charts read; bars
   *  resolve `theme.bar[as]`. **Omitted ⇒ {@link defaultTheme}.** */
  theme?: ChartTheme;
}

/**
 * `<BarList>`'s props: the shared knobs ({@link BarListCommon}) plus **exactly
 * one** source door ([PND-CHARTAPI]). Passing both `rows` and `series`, or
 * neither, is now a **compile** error rather than a render-time throw.
 *
 * The two members differ in their row type on purpose. Through `rows`, a
 * caller's `R` flows into every callback. Through `series` the rows are read
 * internally and are plain {@link ListRow}s, so that member pins the callbacks
 * to `ListRow` — annotating a callback with a custom row type while passing
 * `series` no longer compiles, where before it silently lied (#590 review).
 */
export type BarListProps<
  R extends ListRow = ListRow,
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
> =
  | (BarListCommon<R> & ListRowsSource<R>)
  | (BarListCommon<ListRow> & ListSeriesSource<S, VS>);

/**
 * A **ranked bar list** — the DOM sister of `<BarChart orientation="horizontal">`,
 * for the table-shaped cases: one row per *entity* (interface, split, symbol),
 * a label cell, one proportional bar line per configured column, optional data
 * cells before/after, optional per-row expander. react-timeseries-charts'
 * `HorizontalBarChart`, reconceived as what it always was: a table.
 *
 * **Standalone** — no `<ChartContainer>`; there is no time axis here. It takes
 * a `theme` directly and renders a plain `<table>` (label cells can be links,
 * cells align by table layout, the expander is a `colSpan` row).
 *
 * - **One shared scale.** Every bar of every row maps through one
 *   `[min, max]` (see `domain`), because cross-row comparison is the point.
 * - **Gaps.** A missing / non-numeric value renders an empty track and sorts
 *   last — absence reads as absence, never as zero-drawn-long.
 * - **Sorting.** `sortBy` + `sortDirection` for the common case, `sort` for
 *   anything else, input order otherwise.
 *
 * ```tsx
 * <BarList
 *   rows={listRowsFromTimeSeries(splits, { label: (i) => `${i + 1}` })}
 *   columns={[{ column: 'speed' }]}
 *   after={[{ key: 'speed', align: 'right', render: (r) => fmtMph(r.values.speed) }]}
 *   renderExpanded={(r) => <SplitDetail row={r} />}
 * />
 * ```
 */
export function BarList<
  R extends ListRow = ListRow,
  S extends SeriesSchema = SeriesSchema,
  VS extends ValueSeriesSchema = ValueSeriesSchema,
>(props: BarListProps<R, S, VS>) {
  // One normalized view of the union — `isSeriesSource` is the runtime
  // narrowing; the doors are mutually exclusive by construction now.
  const source = props as BarListCommon<R> & {
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
    hovered,
    onHover,
    markers,
    barHeight = 8,
    divided,
    baseline,
    theme = defaultTheme,
  } = source;
  // A runtime guard for JS consumers and `any`-typed call sites — the
  // props union makes both branches unreachable from typed TS, but a
  // silently-ignored source prop is a worse failure than a throw.
  if (isSeriesSource(props) === (rows !== undefined)) {
    throw new Error(
      '<BarList>: provide exactly one of `rows` (records) or `series` (one row per event)',
    );
  }
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
        columns.map((c) => c.column),
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
      kind="bar"
      markers={resolvedMarkers}
      before={before}
      after={after}
      renderExpanded={renderExpanded}
      defaultExpanded={defaultExpanded}
      onExpandToggle={onExpandToggle}
      selected={selected}
      onRowClick={onRowClick}
      hovered={hovered}
      onHover={onHover}
      divided={divided}
      baseline={baseline}
      theme={theme}
      renderGlyphs={(row) => (
        <>
          {columns.map((col, ci) => {
            const style = theme.bar[col.as ?? 'default'] ?? theme.bar.default;
            const frac = listFraction(row.values[col.column], scale);
            return (
              <div
                // Index-qualified so the same values entry drawn twice (say,
                // styled differently) never collides.
                key={`${ci} ${col.column}`}
                data-list-track={col.column}
                style={{
                  position: 'relative',
                  height: barHeight,
                  margin: '3px 0',
                  borderRadius: barHeight / 2,
                  overflow: 'hidden',
                }}
              >
                {/* The track: the bar's own hue, faint — reads on any ground
                    without a dedicated token. */}
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: style.fill,
                    opacity: 0.15,
                  }}
                />
                {frac !== null && frac > 0 && (
                  <div
                    data-list-bar={col.column}
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: 0,
                      width: `${frac * 100}%`,
                      background: style.fill,
                      opacity: style.opacity,
                      borderRadius: barHeight / 2,
                    }}
                  />
                )}
              </div>
            );
          })}
        </>
      )}
    />
  );
}
