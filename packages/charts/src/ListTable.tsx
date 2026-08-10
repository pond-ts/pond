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
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { SelectModifiers } from './context.js';
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

/**
 * A row's interaction state, handed to {@link ListTableProps.renderGlyphs} so
 * the glyphs can follow it — the fill is the one channel the shell cannot
 * paint for them.
 *
 * `dimmed` is derived, not passed in: it means *something else* is selected.
 * Nothing dims while the selection is empty, because with nothing selected
 * there is nothing to recede from — the same rule `BarStyle.dimmed` states
 * for the canvas.
 */
export interface ListRowState {
  readonly selected: boolean;
  readonly hovered: boolean;
  readonly dimmed: boolean;
}

export interface ListTableProps<R extends ListRow> {
  /** Rows in display order (the caller sorts). */
  readonly rows: readonly R[];
  /** Which sister is rendering — stamped as `data-list` for styling/tests. */
  readonly kind: 'bar' | 'box';
  /** The glyph cell's content for one row (the bar / box lines). */
  readonly renderGlyphs: (row: R, state: ListRowState) => ReactNode;
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
  /** Plural select — a click's one row, or a drag's run. See `<BarList
   *  onRowSelect>`; mounting it is what enables the drag. */
  readonly onRowSelect?:
    | ((rows: readonly R[], modifiers: SelectModifiers) => void)
    | undefined;
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
  onRowSelect,
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
  const interactive = onRowClick !== undefined || onRowSelect !== undefined;
  // The drag-range gesture, armed by the MOUNT (interaction RFC A4.2 rule 1 —
  // the same reason a bare `<MultiSelector />` enables the canvas sweep).
  const ranges = onRowSelect !== undefined;

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
  /**
   * The live drag-range: the row index the press landed on, the one the
   * pointer is over now, and whether it has ever left the first.
   *
   * **Crossing into another row is what makes it a range** — not a pixel slop.
   * A row is tall and discrete, so "did the pointer reach a different row" is
   * the question the gesture actually turns on, and asking it directly means a
   * press-and-release on one row can never accidentally commit a range (nor
   * can a horizontal wobble, which on a stack of rows means nothing at all).
   * It also needs no coordinates: `pointerenter` per row answers it.
   *
   * A ref, not state, for the reason the canvas gesture keeps one: the
   * handlers must never read a state mirror that may not have committed.
   */
  const dragRef = useRef<{
    anchor: number;
    current: number;
    /**
     * Whether the pointer is **currently** on a different row than the anchor
     * — not whether it ever was.
     *
     * So wandering out to another row and back again lands on a *click*, not a
     * one-row range: the user changed their mind, and the forgiving reading is
     * the one every other drag in the library takes. It also matters to a
     * consumer with both callbacks mounted, since a range commits through
     * `onRowSelect` and swallows the click `onRowClick` would otherwise hear.
     */
    ranged: boolean;
  } | null>(null);
  /** The run the drag currently covers — the live preview, painted as hover. */
  const [dragRun, setDragRun] = useState<ReadonlySet<string> | null>(null);
  /**
   * A press is armed — used only to suppress **native text selection** for the
   * gesture's duration.
   *
   * It has to be state rather than the ref above, because the suppression is a
   * style: `user-select` must already be `none` in the DOM before the browser
   * starts extending a selection, which it does on the first move after the
   * press. `pointerdown` is a discrete event, so React flushes this update
   * synchronously — the style lands before any `pointermove` arrives.
   *
   * Scoped to the press rather than to the whole list on purpose: a data list's
   * labels are hostnames and ticker symbols, and people copy them. Mounting a
   * range gesture should not cost the list its selectable text.
   */
  const [armed, setArmed] = useState(false);
  /**
   * The **selection anchor** — the row a range extends *from*, shared by both
   * input methods so they are one model rather than two: click a row, then
   * Shift-Arrow, and the run starts where you clicked.
   *
   * A plain move (arrow, click, Enter) re-anchors; a shift-extend deliberately
   * does not, so repeated Shift-Down grows one run instead of walking a
   * two-row window down the list.
   */
  const anchorRef = useRef<number | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);

  /**
   * This table's own row elements, in display order.
   *
   * Scoped with `:scope >` because an expanded row's detail may contain a
   * whole nested list, whose rows carry the same attribute — a plain
   * descendant query would walk into it and the arrow keys would navigate
   * somebody else's list. (`handlePointerOver` guards the same hazard.)
   */
  const rowEls = (): readonly HTMLElement[] =>
    Array.from(
      tableRef.current?.querySelectorAll<HTMLElement>(
        ':scope > tbody > tr[data-list-row]',
      ) ?? [],
    );
  /** A ranged drag ends in a `click` too; this swallows that one. */
  const rangedClickRef = useRef(false);

  /**
   * Keyboard parity with the pointer: there is no drag on a keyboard, so the
   * range has to arrive as a **modifier** there.
   *
   * That is not the contradiction with `SelectModifiers`' "an ordinal range is
   * a gesture, not a modifier" that it looks like. The note is about not
   * overloading a *pointer* chord that already means something else (a region
   * drag); a keyboard has no competing gesture and Shift-Arrow is the one
   * range idiom every platform already teaches.
   *
   * - **Arrow Up/Down** — move focus one row; re-anchor.
   * - **Home/End** — move focus to the first/last row; re-anchor.
   * - **Shift** with any of those — move focus and report the run from the
   *   anchor, which stays put.
   * - **Enter/Space** — select the focused row (with modifiers, so ⌘/Ctrl-Enter
   *   adds); re-anchor.
   *
   * Focus is moved by focusing the row element rather than by tracking an
   * index in state: the browser is already the source of truth for what has
   * focus, and a second copy of that would be one more thing to keep in sync.
   */
  const onRowKeyDown = (e: ReactKeyboardEvent, i: number) => {
    if (!interactive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      anchorRef.current = i;
      onRowClick?.(rows[i]!);
      onRowSelect?.([rows[i]!], mods(e));
      return;
    }
    const last = rows.length - 1;
    const to =
      e.key === 'ArrowDown'
        ? Math.min(i + 1, last)
        : e.key === 'ArrowUp'
          ? Math.max(i - 1, 0)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (to === null) return;
    // Claim the key before anything else can act on it: Arrow and Home/End
    // would otherwise scroll the page out from under the list.
    e.preventDefault();
    rowEls()[to]?.focus();
    if (!e.shiftKey || !ranges) {
      anchorRef.current = to;
      return;
    }
    // Extending: the anchor holds, so Shift-Down repeatedly grows ONE run.
    // With no anchor yet (arrowing in from a Tab, never having selected), the
    // row we left is the honest one to start from.
    const from = anchorRef.current ?? i;
    anchorRef.current = from;
    onRowSelect?.(runOf(from, to), mods(e));
  };

  /** The rows of the inclusive index run `[a, b]`, in display order. */
  const runOf = (a: number, b: number): readonly R[] =>
    rows.slice(Math.min(a, b), Math.max(a, b) + 1);

  const mods = (e: {
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }): SelectModifiers => ({
    // `metaKey || ctrlKey`, character-for-character what `Layers` resolves
    // for a canvas select. Deliberately NOT a `navigator.platform` sniff:
    // whatever the better rule might be, a list and a chart in the same app
    // must not disagree about what "add to selection" means — and
    // `navigator.platform` is deprecated and absent in some hosts anyway.
    additive: e.metaKey || e.ctrlKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
  });

  /** Press: arm a potential range on this row. Nothing commits yet. */
  const beginDrag = (i: number, e: ReactPointerEvent) => {
    if (!ranges) return;
    // **Touch is excluded, deliberately.** A vertical drag over a list on a
    // touch device is how you SCROLL, and claiming it for a range would make
    // the list impossible to scroll past. A touch range gesture needs its own
    // affordance (a long-press, or an explicit multi-select mode) rather than
    // stealing the one gesture the platform already spent. Touch keeps
    // click-to-select, which still reports through `onRowSelect`.
    if (e.pointerType === 'touch') return;
    // The press is a plain move: it re-anchors, so a later Shift-Arrow
    // extends from the row the user actually grabbed.
    anchorRef.current = i;
    dragRef.current = { anchor: i, current: i, ranged: false };
    setArmed(true);
    setDragRun(null);
  };
  /** The pointer reached row `i` with the button still down. */
  const extendDrag = (i: number) => {
    const d = dragRef.current;
    if (d === null || i === d.current) return;
    d.current = i;
    d.ranged = i !== d.anchor;
    setDragRun(new Set(runOf(d.anchor, i).map((r) => r.key)));
  };
  /** Release: a range commits here; a single row is left to the click. */
  const endDrag = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragRun(null);
    setArmed(false);
    if (d === null) return;
    // Hand the hover channel back, to the row the pointer actually ended on.
    // The press suppressed reporting for its whole duration, so without this
    // the list believes nothing is hovered until the pointer moves again —
    // the row under the cursor would go dark on release and light again on
    // the next twitch.
    reportHover(rows[d.current]?.key ?? null);
    if (!d.ranged) return;
    rangedClickRef.current = true;
    onRowSelect?.(runOf(d.anchor, d.current), mods(e));
  };

  // A release **outside** the rows would otherwise leave the drag armed, so a
  // later stray `pointerenter` would resume a gesture the user had finished. It
  // commits rather than cancels: the run the user let go of is the run they
  // meant, and where the pointer happened to be when they did is not the
  // library's business. Registered only while a range gesture is possible — a
  // list with no `onRowSelect` adds no listener at all.
  useEffect(() => {
    if (!ranges) return;
    const onUp = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (d === null) return;
      dragRef.current = null;
      setDragRun(null);
      setArmed(false);
      // Released off the rows, so there is no row under the pointer to hand
      // the hover back to — unlike `endDrag`, which knows exactly which.
      reportHover(null);
      if (!d.ranged) return;
      rangedClickRef.current = true;
      onRowSelect?.(runOf(d.anchor, d.current), mods(e));
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  });

  // The last key we reported, so `onHover` fires on a row transition rather
  // than on every pointer move within a row — the canvas `onHover` dedup rule.
  // A ref (not state): it must not drive a render of its own.
  const lastHoverRef = useRef<string | null>(null);
  const reportHover = (key: string | null) => {
    // **A held press owns the hover channel** — the same rule the canvas
    // follows (`Layers` clears the single-mark hover the moment a sweep arms).
    // Reporting "you are hovering row d" while a run b→d is being previewed
    // would have the two channels contradict each other, with no way for the
    // consumer to tell which was current.
    //
    // Gated on the press being ARMED, not on the run having started: hover is
    // delegated at the table (`handlePointerOver`) while the range extends
    // per row, and React dispatches the ancestor's handler FIRST — so
    // checking `ranged` here would let the crossing that *starts* the run
    // report a hover on its way past, and only suppress the ones after it.
    if (dragRef.current !== null) return;
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
  // The row-chart register. Absent ⇒ the pre-token look exactly: a hover band
  // borrowed from `legend.border`, a selection rail from the annotation
  // register, and no dimmed state — so a hand-built theme's rows do not
  // shift under it (the same back-compatibility `theme.brush` was given).
  const reg = theme.list;
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
      ref={tableRef}
      data-list={kind}
      onPointerOver={tracksHover ? handlePointerOver : undefined}
      onPointerLeave={tracksHover ? () => reportHover(null) : undefined}
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        // Suppress native text selection **only while a press is armed**. A
        // drag across rows would otherwise sweep up the label text along the
        // way — the run gets picked out in the browser's own selection colour,
        // fighting the band and the rail for the same meaning. Released, the
        // labels are selectable again (see `armed`).
        ...(armed ? { userSelect: 'none' as const } : {}),
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
          // **A live drag owns the surface**, exactly as the canvas sweep does
          // (`Layers` clears the single-mark hover the moment a sweep arms):
          // while a run is being drawn it IS what "would be selected if you
          // released now", so it replaces the pointer's own hover rather than
          // being unioned with it. `hovered` and `onHover` are untouched — the
          // consumer's channel is not hijacked, it is simply out-ranked for
          // the duration.
          const isHovered =
            dragRun !== null ? dragRun.has(row.key) : hoveredKeys.has(row.key);
          // Dimmed means *something else* is selected — nothing recedes while
          // the selection is empty. Only meaningful once a register exists;
          // without one there is no dimmed state at all.
          const isDimmed =
            reg !== undefined && selectedKeys.size > 0 && !isSelected;
          // **Selection outranks hover on the band**, because selection is
          // committed and hover is transient: a hovered selected row must not
          // read as merely hovered. The rail follows the band so the two
          // never disagree about which state the row is in.
          const band = isSelected
            ? reg?.selectedBand
            : isHovered
              ? (reg?.hoverBand ?? theme.legend?.border ?? theme.axis.grid)
              : undefined;
          const rail = isSelected
            ? (reg?.selectedRail ?? accent)
            : isHovered
              ? reg?.hoverRail
              : undefined;
          const isOpen = renderExpanded !== undefined && expanded.has(row.key);
          return (
            <Fragment key={row.key}>
              <tr
                data-list-row={row.key}
                {...(isSelected ? { 'data-selected': '' } : {})}
                {...(isHovered ? { 'data-hovered': '' } : {})}
                onClick={
                  !interactive
                    ? undefined
                    : (e) => {
                        // A ranged drag also fires a click; swallow that one,
                        // or the release would both commit the run and then
                        // immediately report the single row under the pointer.
                        if (rangedClickRef.current) {
                          rangedClickRef.current = false;
                          return;
                        }
                        anchorRef.current = i;
                        onRowClick?.(row);
                        // `onRowSelect` is a strict SUPERSET of `onRowClick`,
                        // the way `<MultiSelector>` is of `<Selector>`: below
                        // the range gesture a click is still a click, and it
                        // reports one row plus its modifiers. Both fire when
                        // both are mounted — each consumer does its own job.
                        onRowSelect?.([row], mods(e));
                      }
                }
                {...(ranges
                  ? {
                      onPointerDown: (e: ReactPointerEvent) => beginDrag(i, e),
                      // Per-row `pointerenter` rather than pointer capture:
                      // capture would route every later event to the pressed
                      // row and the other rows would never hear the pointer
                      // arrive. The cost is that a release outside the table
                      // is not seen here — the window listener below is what
                      // covers that.
                      onPointerEnter: (e: ReactPointerEvent) => {
                        if (e.buttons !== 0) extendDrag(i);
                      },
                      onPointerUp: endDrag,
                    }
                  : {})}
                // A clickable row is keyboard-reachable too: focusable, and
                // Enter / Space activate it (Space's default scroll is eaten).
                tabIndex={interactive ? 0 : undefined}
                onKeyDown={interactive ? (e) => onRowKeyDown(e, i) : undefined}
                style={{
                  borderTop: i > 0 ? divider : undefined,
                  cursor: interactive ? 'pointer' : undefined,
                  background: band,
                  // The rail: a 3px inset edge — reads on any ground and
                  // moves no layout. It is chrome for the whole ROW, so it
                  // resolves from the list register rather than from
                  // `bar[as]`; a row may carry several metrics and there is
                  // only ever one rail.
                  boxShadow:
                    rail === undefined ? undefined : `inset 3px 0 0 ${rail}`,
                  // The row is the target, not the bar (see `ChartTheme.list`):
                  // a 4% row would otherwise be a sliver to aim at, so the
                  // whole band is one hit area of at least 44px.
                  // (`height`, not `minHeight`: a table row ignores the
                  // latter, while the former is treated as a MINIMUM — the
                  // used height is max(specified, content).)
                  ...(interactive || hoverWired ? { height: 44 } : {}),
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
                    {renderGlyphs(row, {
                      selected: isSelected,
                      hovered: isHovered,
                      dimmed: isDimmed,
                    })}
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
