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
import {
  Fragment,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { ListCellSpec, ListRow } from './list.js';
import type { ChartTheme } from './theme.js';

/** The turquoise the selected-row edge falls back to when the theme has no
 *  annotation register — the same built-in the annotation layer uses. */
const FALLBACK_ACCENT = '#0d9488';

/**
 * Stable identity for "nothing hovered" — the same module-constant trick
 * `ChartContainer` uses for `EMPTY_SELECTION`, so the (overwhelmingly common)
 * no-hover case doesn't mint a fresh set on every render.
 */
const EMPTY_HOVER: ReadonlySet<string> = new Set<string>();

/** The same trick for "nothing selected" — see {@link EMPTY_HOVER}. */
const EMPTY_SELECTED: ReadonlySet<string> = new Set<string>();

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
  /** Selected row(s) — one key, a set of them, or nothing. Widened to match
   *  {@link ListTableProps.hovered}; see `<BarList selected>`. */
  readonly selected?: string | readonly string[] | null | undefined;
  readonly onRowClick?: ((row: R) => void) | undefined;
  /** Controlled hover — one row key, a set of them, or nothing. Omitted ⇒
   *  uncontrolled (the shell tracks the pointer itself, as it always has). */
  readonly hovered?: string | readonly string[] | null | undefined;
  /** Hover out: the entered row, or `null` on leaving every row. Fires in
   *  controlled and uncontrolled mode alike, deduped by row key. */
  readonly onHover?: ((row: R | null) => void) | undefined;
  readonly divided?: boolean | undefined;
  /** Draw the vertical **baseline rule** at the scale origin (the glyph
   *  cell's left edge) — the shared reference the eye aligns rows against. */
  readonly baseline?: boolean | undefined;
  /**
   * Reference markers, **pre-resolved to track fractions** by the caller (the
   * shell knows pixels, not the scale): each draws a dotted vertical rule
   * through every row's glyph area, plus a label strip above the list when
   * any carries a `label`. A `null` fraction (out-of-scale gap) is skipped.
   */
  readonly markers?:
    | ReadonlyArray<{ readonly frac: number | null; readonly label?: string }>
    | undefined;
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
  hovered,
  onHover,
  divided = true,
  baseline = false,
  markers = [],
  theme,
}: ListTableProps<R>) {
  // Uncontrolled expansion, keyed on row identity so it survives a re-sort.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(defaultExpanded ?? []),
  );
  const interactive = onRowClick !== undefined;

  // Hover: controlled (`hovered`) or uncontrolled (internal), mirroring the
  // canvas layers' channel on `ChartContainer` (RFC `interaction.md` A3.1 —
  // the list family speaks the same vocabulary, not a parallel one).
  const [internalHovered, setInternalHovered] = useState<string | null>(null);
  const controlledHover = hovered !== undefined;
  // Rows track + light hover when there's a click affordance (as they always
  // have) or when the consumer wired either half of the hover channel.
  const hoverWired = controlledHover || onHover !== undefined;
  const tracksHover = interactive || hoverWired;
  // Normalize the prop's three accepted shapes — one key, a set, or nothing —
  // into the single shape the render asks its question in ("is this row in the
  // hovered set"), the same normalization `ChartContainer` does for its
  // `SelectInfo` union. `EMPTY_HOVER` keeps the empty case identity-stable.
  const hoveredKeys: ReadonlySet<string> = useMemo(() => {
    const raw = controlledHover ? hovered : internalHovered;
    if (raw === null || raw === undefined) return EMPTY_HOVER;
    return new Set(typeof raw === 'string' ? [raw] : raw);
  }, [controlledHover, hovered, internalHovered]);
  // …and the identical normalization for `selected`, which now takes the same
  // union. It is deliberately the same three shapes and the same question
  // ("is this row in the set"): the two channels of one vocabulary should not
  // differ in how a consumer spells them.
  const selectedKeys: ReadonlySet<string> = useMemo(() => {
    if (selected === null || selected === undefined) return EMPTY_SELECTED;
    return new Set(typeof selected === 'string' ? [selected] : selected);
  }, [selected]);

  const rowByKey = useMemo(
    () => new Map(rows.map((row) => [row.key, row])),
    [rows],
  );
  // The last key we reported, so `onHover` fires on a row transition rather
  // than on every pointer move within a row — the canvas `onHover` dedup rule.
  // A ref (not state): it must not drive a render of its own.
  const lastHoverRef = useRef<string | null>(null);
  const reportHover = (key: string | null) => {
    if (lastHoverRef.current === key) return;
    lastHoverRef.current = key;
    if (!controlledHover) setInternalHovered(key);
    onHover?.(key === null ? null : (rowByKey.get(key) ?? null));
  };
  // Delegated at the table rather than per-row, so moving from one row to its
  // neighbour reports the new row once — per-row enter/leave would emit a
  // spurious `null` in between, which the canvas channel never does.
  const handlePointerOver = (e: ReactPointerEvent<HTMLTableElement>) => {
    const rowEl = (e.target as Element | null)?.closest('[data-list-row]');
    // A row of a NESTED list (an expanded detail may hold one) is not ours to
    // report — only rows belonging to this table's own `data-list` count.
    const own =
      rowEl != null && rowEl.closest('[data-list]') === e.currentTarget;
    reportHover(own ? rowEl.getAttribute('data-list-row') : null);
  };

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

  // The glyph cell's shared horizontal geometry — the label strip must use
  // the SAME left/right padding (and baseline border) as the data rows, or
  // its percentages would resolve against a different content width and the
  // labels would sit off their rules.
  const glyphCellStyle = (vertical: string): CSSProperties => ({
    width: '100%',
    padding: baseline ? `${vertical} 8px ${vertical} 5px` : `${vertical} 8px`,
    verticalAlign: 'middle',
    borderLeft: baseline ? `1px solid ${theme.axis.grid}` : undefined,
  });

  const drawnMarkers = markers.filter(
    (m): m is { frac: number; label?: string } => m.frac !== null,
  );

  return (
    <table
      data-list={kind}
      onPointerOver={tracksHover ? handlePointerOver : undefined}
      onPointerLeave={tracksHover ? () => reportHover(null) : undefined}
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        font: `${theme.font.size}px/${1.5} ${theme.font.family}`,
        color: ink,
        background: theme.background,
      }}
    >
      <tbody>
        {drawnMarkers.some((m) => m.label !== undefined) && (
          // The marker label strip: one synthetic row above the data, its
          // glyph cell sharing the data rows' horizontal geometry so each
          // label centres exactly on its rule below.
          <tr data-list-marker-labels="">
            <td style={textCell()} />
            {before.map((cell) => (
              <td key={cell.key} style={textCell(cell.align)} />
            ))}
            <td style={glyphCellStyle('0px')}>
              <div
                style={{
                  position: 'relative',
                  height: theme.font.size + 6,
                }}
              >
                {drawnMarkers.map(
                  (m, mi) =>
                    m.label !== undefined && (
                      <span
                        key={mi}
                        data-list-marker-label=""
                        style={{
                          position: 'absolute',
                          left: `${m.frac * 100}%`,
                          bottom: 0,
                          transform: 'translateX(-50%)',
                          whiteSpace: 'nowrap',
                          color: accent,
                        }}
                      >
                        {m.label}
                      </span>
                    ),
                )}
              </div>
            </td>
            {after.map((cell) => (
              <td key={cell.key} style={textCell(cell.align)} />
            ))}
            {renderExpanded !== undefined && <td />}
          </tr>
        )}
        {rows.map((row, i) => {
          const isSelected = selectedKeys.has(row.key);
          const isHovered = hoveredKeys.has(row.key);
          const isOpen = renderExpanded !== undefined && expanded.has(row.key);
          return (
            <Fragment key={row.key}>
              <tr
                data-list-row={row.key}
                {...(isSelected ? { 'data-selected': '' } : {})}
                {...(isHovered ? { 'data-hovered': '' } : {})}
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
                style={{
                  borderTop: i > 0 ? divider : undefined,
                  cursor: interactive ? 'pointer' : undefined,
                  background: isHovered
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
                  style={glyphCellStyle('6px')}
                >
                  <div style={{ position: 'relative' }}>
                    {renderGlyphs(row)}
                    {drawnMarkers.map((m, mi) => (
                      // One dotted segment per row, bleeding through the
                      // row's vertical padding (+ divider) so adjacent rows'
                      // segments join into one continuous rule. Annotation
                      // register — a reference is a user's mark, not data.
                      <div
                        key={mi}
                        data-list-marker=""
                        style={{
                          position: 'absolute',
                          top: -7,
                          bottom: -7,
                          left: `calc(${m.frac * 100}% - 0.5px)`,
                          width: 0,
                          borderLeft: `1px dotted ${accent}`,
                          pointerEvents: 'none',
                        }}
                      />
                    ))}
                  </div>
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
