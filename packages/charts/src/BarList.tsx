import { useMemo, type ReactNode } from 'react';
import {
  listFraction,
  resolveListDomain,
  sortListRows,
  type BarListColumn,
  type ListCellSpec,
  type ListRow,
  type ListSortDirection,
} from './list.js';
import { ListTable } from './ListTable.js';
import { defaultTheme, type ChartTheme } from './theme.js';

export interface BarListProps<R extends ListRow = ListRow> {
  /**
   * The rows, one entity each (`key` is the stable identity; `label` the
   * first cell; `values` the flat data record). Generic — extra fields on a
   * row ride through to cell `render` / `renderExpanded` fully typed. Build
   * by hand, or read a per-event series with `listRowsFromTimeSeries` /
   * `listRowsFromValueSeries`.
   */
  rows: readonly R[];
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
   * The selected row's `key`, marked with an inset edge in the annotation
   * (marks) register — selection is a user's mark, not data. Consumer-owned
   * state: pair with `onRowClick`. `null` / omitted ⇒ none.
   */
  selected?: string | null;
  /** Row click (rows show hover + pointer affordances only when provided). */
  onRowClick?: (row: R) => void;
  /** Each bar line's height in px. **Omitted ⇒ `8`.** */
  barHeight?: number;
  /** Rule between rows (`theme.axis.grid`). **Omitted ⇒ `true`.** */
  divided?: boolean;
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
export function BarList<R extends ListRow = ListRow>({
  rows,
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
  barHeight = 8,
  divided,
  baseline,
  theme = defaultTheme,
}: BarListProps<R>) {
  const sorted = useMemo(
    () => sortListRows(rows, sortBy, sortDirection, sort),
    [rows, sortBy, sortDirection, sort],
  );
  const scale = useMemo(
    () =>
      resolveListDomain(
        rows,
        columns.map((c) => c.column),
        domain,
      ),
    [rows, columns, domain],
  );

  return (
    <ListTable
      rows={sorted}
      kind="bar"
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
          {columns.map((col) => {
            const style = theme.bar[col.as ?? 'default'] ?? theme.bar.default;
            const frac = listFraction(row.values[col.column], scale);
            return (
              <div
                key={col.column}
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
