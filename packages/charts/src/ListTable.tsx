/**
 * @internal The shared row-table shell behind {@link BarList} / {@link BoxList}.
 *
 * Renders a real `<table>` — the point of the list family is table semantics
 * (label cells that can be links, aligned data cells, a `colSpan` detail row
 * for the expander, screen-reader-legible rows), which a canvas plot can't
 * carry and which hand-rolled flex rows re-implement badly (per-row cell
 * alignment is exactly what table layout solves). The glyph cell takes
 * `width: 100%` so it absorbs the free width; every text cell shrinks to fit.
 *
 * Not exported from the package: the public surface is the two sisters, so the
 * shared shell can evolve without a compatibility contract.
 */
import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import type { ListCellSpec, ListRow } from './list.js';
import type { ChartTheme } from './theme.js';

/** The turquoise the selected-row edge falls back to when the theme has no
 *  annotation register — the same built-in the annotation layer uses. */
const FALLBACK_ACCENT = '#0d9488';

export interface ListTableProps<R extends ListRow> {
  /** Rows in display order (the caller sorts). */
  readonly rows: readonly R[];
  /** Which sister is rendering — stamped as `data-list` for styling/tests. */
  readonly kind: 'bar' | 'box';
  /** The glyph cell's content for one row (the bar / box lines). */
  readonly renderGlyphs: (row: R) => ReactNode;
  readonly before?: readonly ListCellSpec<R>[] | undefined;
  readonly after?: readonly ListCellSpec<R>[] | undefined;
  readonly renderExpanded?: ((row: R) => ReactNode) | undefined;
  readonly defaultExpanded?: readonly string[] | undefined;
  readonly onExpandToggle?:
    | ((key: string, expanded: boolean) => void)
    | undefined;
  readonly selected?: string | null | undefined;
  readonly onRowClick?: ((row: R) => void) | undefined;
  readonly divided?: boolean | undefined;
  /** Draw the vertical **baseline rule** at the scale origin (the glyph
   *  cell's left edge) — the shared reference the eye aligns rows against. */
  readonly baseline?: boolean | undefined;
  readonly theme: ChartTheme;
}

/** The shared text ink: the band-label tone when the theme has one (stronger
 *  than tick labels — these cells are primary content), else the tick ink. */
export function listInk(theme: ChartTheme): string {
  return theme.axis.band?.label ?? theme.axis.label;
}

export function ListTable<R extends ListRow>({
  rows,
  kind,
  renderGlyphs,
  before = [],
  after = [],
  renderExpanded,
  defaultExpanded,
  onExpandToggle,
  selected,
  onRowClick,
  divided = true,
  baseline = false,
  theme,
}: ListTableProps<R>) {
  // Uncontrolled expansion, keyed on row identity so it survives a re-sort.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(defaultExpanded ?? []),
  );
  const [hovered, setHovered] = useState<string | null>(null);
  const interactive = onRowClick !== undefined;

  const toggle = (key: string) => {
    const open = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
    onExpandToggle?.(key, open);
  };

  const ink = listInk(theme);
  const accent = theme.annotation?.color ?? FALLBACK_ACCENT;
  const divider = divided ? `1px solid ${theme.axis.grid}` : undefined;
  // Label + before + glyph + after (+ expander) — the detail row spans them all.
  const span = 2 + before.length + after.length + (renderExpanded ? 1 : 0);

  const textCell = (align?: 'left' | 'right' | 'center'): CSSProperties => ({
    padding: '6px 12px',
    whiteSpace: 'nowrap',
    textAlign: align ?? 'left',
    verticalAlign: 'middle',
  });

  return (
    <table
      data-list={kind}
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        font: `${theme.font.size}px/${1.5} ${theme.font.family}`,
        color: ink,
        background: theme.background,
      }}
    >
      <tbody>
        {rows.map((row, i) => {
          const isSelected = selected != null && selected === row.key;
          const isOpen = renderExpanded !== undefined && expanded.has(row.key);
          return (
            <Fragment key={row.key}>
              <tr
                data-list-row={row.key}
                {...(isSelected ? { 'data-selected': '' } : {})}
                onClick={
                  onRowClick === undefined ? undefined : () => onRowClick(row)
                }
                // A clickable row is keyboard-reachable too: focusable, and
                // Enter / Space activate it (Space's default scroll is eaten).
                tabIndex={interactive ? 0 : undefined}
                onKeyDown={
                  onRowClick === undefined
                    ? undefined
                    : (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                }
                onPointerEnter={
                  interactive ? () => setHovered(row.key) : undefined
                }
                onPointerLeave={
                  interactive ? () => setHovered(null) : undefined
                }
                style={{
                  borderTop: i > 0 ? divider : undefined,
                  cursor: interactive ? 'pointer' : undefined,
                  background:
                    interactive && hovered === row.key
                      ? (theme.legend?.border ?? theme.axis.grid)
                      : undefined,
                  // The selection accent: an inset edge in the annotation
                  // register (a *user's* mark, so it takes the marks colour,
                  // not a data hue) — reads on any ground, moves no layout.
                  boxShadow: isSelected ? `inset 3px 0 0 ${accent}` : undefined,
                }}
              >
                <td data-list-cell="label" style={textCell()}>
                  {row.label ?? row.key}
                </td>
                {before.map((cell) => (
                  <td
                    key={cell.key}
                    data-list-cell={cell.key}
                    style={textCell(cell.align)}
                  >
                    {cell.render(row)}
                  </td>
                ))}
                <td
                  data-list-cell="glyphs"
                  // 100% absorbs the table's free width; every text cell
                  // shrinks to its content, staying aligned down the list.
                  // The baseline rule marks the scale origin: left padding
                  // narrows to a 5px breath so the glyphs start just off the
                  // rule, and border-collapse joins the rows' rules into one
                  // continuous vertical — the same thin `axis.grid` ink as
                  // the row dividers, so the two read as one quiet grid.
                  style={{
                    width: '100%',
                    padding: baseline ? '6px 8px 6px 5px' : '6px 8px',
                    verticalAlign: 'middle',
                    borderLeft: baseline
                      ? `1px solid ${theme.axis.grid}`
                      : undefined,
                  }}
                >
                  {renderGlyphs(row)}
                </td>
                {after.map((cell) => (
                  <td
                    key={cell.key}
                    data-list-cell={cell.key}
                    style={textCell(cell.align)}
                  >
                    {cell.render(row)}
                  </td>
                ))}
                {renderExpanded !== undefined && (
                  <td style={{ padding: '0 4px', verticalAlign: 'middle' }}>
                    <button
                      type="button"
                      data-list-expander=""
                      aria-expanded={isOpen}
                      aria-label={isOpen ? 'Collapse row' : 'Expand row'}
                      onClick={(e) => {
                        // The chevron toggles; it must not double as a row click.
                        e.stopPropagation();
                        toggle(row.key);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: theme.axis.label,
                        font: 'inherit',
                        padding: '2px 6px',
                        transform: isOpen ? 'rotate(90deg)' : undefined,
                        transition: 'transform 120ms',
                      }}
                    >
                      ▸
                    </button>
                  </td>
                )}
              </tr>
              {isOpen && (
                <tr data-list-detail={row.key}>
                  <td colSpan={span} style={{ padding: '2px 12px 12px' }}>
                    {renderExpanded!(row)}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
