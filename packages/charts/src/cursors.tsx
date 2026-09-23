import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { Sequence, BoundedSequence } from 'pond-ts';
import {
  ContainerContext,
  RowContext,
  type CursorEntry,
  type CursorSnap,
  type CursorWants,
  type RangeSpan,
  type ResolvedCursorFrame,
  type ResolvedCursorSample,
} from './context.js';
import { renderBrushBand } from './brush.js';
import type { ChartTheme } from './theme.js';
import type { CursorFormat } from './format.js';
import {
  flagChipStyle,
  flagChipX,
  axisPillStyle,
  axisPillX,
  axisPillConnector,
} from './chip.js';
import { useSlotKey } from './use-slot-key.js';
import { isDev } from './dev.js';

/**
 * Cursor **presets** (interaction RFC §4 / A4.1): `<LineCursor>`,
 * `<PointCursor>`, `<InlineCursor>`, `<FlagCursor>`, `<CrosshairCursor>`,
 * `<RangeCursor>`. **A chart shows a cursor only when one is mounted** —
 * mounting none means no in-chart cursor (hover still reports through
 * `onTrackerChanged`).
 *
 * Each preset registers a `CursorSpec` with the container (the
 * `registerAxis` / `registerLayer` idiom): **declared** snap plus render slots
 * taking resolved geometry. The container resolves — the x-snap, the
 * per-sample measurements, the band — and the slots draw (RFC A2.3). Mount a
 * preset as a child of `<ChartContainer>` (the default for every row) or
 * inside a `<ChartRow>` (the per-row override: a row with its own mounts
 * ignores the container's).
 *
 * Render-only presets may stack; **one cursor owns snap and gesture per
 * scope**, resolved to the hovered row's innermost mount (RFC A2.5) — the
 * container dev-warns on two gesture owners in one scope.
 *
 * The specs themselves stay unpublished (RFC Q3): these presets are the litmus
 * the contract must pass before a user-authored cursor is supported.
 */

/** Past this fraction of the plot, an in-plot chip flips to the left of its
 *  anchor so it doesn't overflow the right edge (mirrors `Layers`). */
const LABEL_FLIP_FRACTION = 0.85;
/** Top inset (px) of the in-plot time readout / the flag stack. */
const FLAG_TOP = 2;

/** The cursor ink — the theme's cursor colour, else the axis label colour. */
function cursorInk(theme: ChartTheme): string {
  return theme.cursor ?? theme.axis.label;
}

/** One chip line's height (px) — the font size plus the chip's leading. */
function chipLineHeight(theme: ChartTheme): number {
  return theme.font.size + 5;
}

/** The shared cursorX, or `null` when it's outside the plot. */
function inBoundsX(f: ResolvedCursorFrame): number | null {
  return f.cursorX !== null && f.cursorX >= 0 && f.cursorX <= f.plotWidth
    ? f.cursorX
    : null;
}

/**
 * The in-plot cursor-time readout (`showTime`) — plain text, no chip fill,
 * once atop the **first** row (the time is shared; repeating it per row would
 * stutter). `timeX` anchors it: the cursor line for line/point/inline, the
 * flag stack's x for the flag cursor.
 */
function timeReadout(f: ResolvedCursorFrame, timeX: number | null): ReactNode {
  if (f.formattedTime === null || !f.isFirstRow || timeX === null) return null;
  const flip = timeX > f.plotWidth * LABEL_FLIP_FRACTION;
  return (
    <div
      style={{
        ...flagChipStyle(f.theme),
        background: 'transparent',
        padding: 0,
        top: `${FLAG_TOP}px`,
        left: flip ? undefined : `${timeX + 4}px`,
        right: flip ? `${f.plotWidth - timeX + 4}px` : undefined,
        color: cursorInk(f.theme),
      }}
    >
      {f.formattedTime}
    </div>
  );
}

/** A dot on each series at the cursor (haloed by the plot background). */
function sampleDots(f: ResolvedCursorFrame): ReactNode {
  const background = f.theme.background;
  return f.samples.map((s, i) => (
    <circle
      key={`dot-${i}`}
      cx={s.px}
      cy={s.py}
      r={3}
      fill={s.color}
      stroke={background}
      strokeWidth={background ? 1 : 0}
    />
  ));
}

/** The synced vertical cursor line (solid; the crosshair draws its own dashed
 *  variant). */
function cursorLine(f: ResolvedCursorFrame): ReactNode {
  const x = inBoundsX(f);
  if (x === null) return null;
  return (
    <line
      x1={Math.round(x)}
      y1={0}
      x2={Math.round(x)}
      y2={f.rowHeight}
      stroke={cursorInk(f.theme)}
      strokeWidth={1}
      shapeRendering="crispEdges"
    />
  );
}

/** What a spec builder hands `useCursorMount` — the spec plus the registration
 *  fields that ride alongside it (everything but scope). */
interface BuiltCursor {
  readonly spec: CursorEntry['spec'];
  readonly wants: CursorWants;
  readonly ownsGesture: boolean;
  readonly sequence?: Sequence | BoundedSequence | undefined;
  readonly format?: CursorFormat | undefined;
  readonly onDragRelease?: ((span: RangeSpan) => void) | undefined;
  readonly enableDrag?: boolean | undefined;
  readonly dragModifier?: 'shift' | undefined;
  readonly reportSnap?: ((f: ResolvedCursorFrame | null) => void) | undefined;
}

const NO_WANTS: CursorWants = {
  samples: false,
  flags: false,
  band: false,
  pointer: false,
  time: false,
};

/** `<LineCursor>` as a spec: the synced vertical line only (+ optional time). */
function buildLineCursor(o: {
  showTime: boolean;
  format?: CursorFormat | undefined;
}): BuiltCursor {
  return {
    spec: {
      snapX: 'none',
      renderPlot: cursorLine,
      ...(o.showTime
        ? { renderPlotHtml: (f) => timeReadout(f, inBoundsX(f)) }
        : {}),
    },
    wants: { ...NO_WANTS, time: o.showTime },
    ownsGesture: false,
    format: o.format,
  };
}

/** `<PointCursor>` as a spec: a dot on each series, no line. */
function buildPointCursor(o: {
  showTime: boolean;
  format?: CursorFormat | undefined;
}): BuiltCursor {
  return {
    spec: {
      snapX: 'none',
      renderPlot: sampleDots,
      ...(o.showTime
        ? { renderPlotHtml: (f) => timeReadout(f, inBoundsX(f)) }
        : {}),
    },
    wants: { ...NO_WANTS, samples: true, time: o.showTime },
    ownsGesture: false,
    format: o.format,
  };
}

/** `<InlineCursor>` as a spec: dots + a value chip beside each, clamped
 *  within the row and flipped left near the right edge. */
function buildInlineCursor(o: {
  showTime: boolean;
  format?: CursorFormat | undefined;
}): BuiltCursor {
  return {
    spec: {
      snapX: 'none',
      renderPlot: sampleDots,
      renderPlotHtml: (f) => {
        const chipStyle = flagChipStyle(f.theme);
        const lh = chipLineHeight(f.theme);
        return (
          <>
            {o.showTime ? timeReadout(f, inBoundsX(f)) : null}
            {f.samples.map((s, i) => {
              const flip = s.px > f.plotWidth * LABEL_FLIP_FRACTION;
              const top = Math.max(
                lh / 2,
                Math.min(f.rowHeight - lh / 2, s.py),
              );
              return (
                <div
                  key={i}
                  style={{
                    ...chipStyle,
                    top: `${top}px`,
                    transform: 'translateY(-50%)',
                    left: flip ? undefined : `${s.px + 8}px`,
                    right: flip ? `${f.plotWidth - s.px + 8}px` : undefined,
                    color: s.color,
                  }}
                >
                  {s.formatted}
                </div>
              );
            })}
          </>
        );
      },
    },
    wants: { ...NO_WANTS, samples: true, time: o.showTime },
    ownsGesture: false,
    format: o.format,
  };
}

/** `<FlagCursor>` as a spec: dots + staffed value flags stacked near the top
 *  of the row, plus the consolidated one-chip flag for `cursorFlag` layers
 *  (BoxPlot). The time readout (when shown, first row) tops the stack and the
 *  staffs start just below it. */
function buildFlagCursor(o: {
  showTime: boolean;
  format?: CursorFormat | undefined;
}): BuiltCursor {
  // The flag stack's top: below the time readout when this row shows it.
  const flagBase = (f: ResolvedCursorFrame) =>
    FLAG_TOP +
    (o.showTime && f.formattedTime !== null && f.isFirstRow
      ? chipLineHeight(f.theme)
      : 0);
  return {
    spec: {
      snapX: 'none',
      renderPlot: (f) => {
        const ink = cursorInk(f.theme);
        const base = flagBase(f);
        return (
          <>
            {f.samples.map((s, i) =>
              s.py > base ? (
                <line
                  key={`staff-${i}`}
                  x1={s.px}
                  y1={base}
                  x2={s.px}
                  y2={s.py}
                  stroke={ink}
                  strokeWidth={1}
                  opacity={0.5}
                />
              ) : null,
            )}
            {f.flags.map((fl, i) =>
              fl.topPy > base ? (
                <line
                  key={`boxstaff-${i}`}
                  x1={fl.px}
                  y1={base}
                  x2={fl.px}
                  y2={fl.topPy}
                  stroke={ink}
                  strokeWidth={1}
                  opacity={0.5}
                />
              ) : null,
            )}
            {sampleDots(f)}
          </>
        );
      },
      renderPlotHtml: (f) => {
        const chipStyle = flagChipStyle(f.theme);
        const base = flagBase(f);
        // The time chip tops the flag stack, so it anchors to the stack's x
        // (the nearest sample) rather than the cursor line.
        const timeX = f.samples.length > 0 ? f.samples[0]!.px : inBoundsX(f);
        return (
          <>
            {o.showTime ? timeReadout(f, timeX) : null}
            {f.cursorX !== null &&
              f.samples.map((s, i) => (
                <div
                  key={i}
                  style={{
                    ...chipStyle,
                    top: `${base}px`,
                    ...flagChipX(s.px, f.plotWidth),
                    color: s.color,
                  }}
                >
                  {s.formatted}
                </div>
              ))}
            {f.flags.map((fl, i) => (
              <div
                key={`boxflag-${i}`}
                style={{
                  ...chipStyle,
                  top: `${base}px`,
                  ...flagChipX(fl.px, f.plotWidth),
                  display: 'flex',
                  flexDirection: 'row',
                  gap: '6px',
                }}
              >
                {fl.lines.map((l, j) => (
                  <span key={j} style={{ color: l.color }}>
                    {l.text}
                  </span>
                ))}
              </div>
            ))}
          </>
        );
      },
    },
    wants: { ...NO_WANTS, samples: true, flags: true, time: o.showTime },
    ownsGesture: false,
    format: o.format,
  };
}

/**
 * The sample the snapping crosshair centres on in a row: the one nearest the
 * pointer y in the hovered row — or the first sample when nothing is hovered
 * (a pinned tracker shows a reticle in every row). `null` in a row that isn't
 * hovered while another is, or when there is nothing to snap to.
 */
function snappedSample(f: ResolvedCursorFrame): ResolvedCursorSample | null {
  if (inBoundsX(f) === null || f.samples.length === 0) return null;
  const cy = f.cursorY;
  if (f.hoveredRowKey === f.rowKey && cy !== null) {
    return f.samples.reduce((a, b) =>
      Math.abs(b.py - cy) < Math.abs(a.py - cy) ? b : a,
    );
  }
  return f.hoveredRowKey === null ? f.samples[0]! : null;
}

/**
 * The crosshair's single reticle centre for a row: with `snap` (default) the
 * {@link snappedSample}; free mode reads the container-resolved raw-pointer
 * measurement.
 *
 * It carries the picked sample's **axis placement** (side + gutter offset +
 * axis ink) as well as its value, because the reticle reads one series and its
 * pill has to land on *that series' axis*: with two axes on a side, the value
 * belongs to only one of the two scales, and a pill on the other one is a
 * number pinned to a ruler that never measured it.
 */
function crosshairPick(
  f: ResolvedCursorFrame,
  snap: boolean,
): {
  py: number;
  formatted: string;
  side: 'left' | 'right';
  axisOffset: number;
  axisColor: string | undefined;
  /** The snapped series' colour; `undefined` in free mode, where the reticle
   *  sits on the pointer rather than on any one series. */
  color: string | undefined;
} | null {
  if (inBoundsX(f) === null) return null;
  if (!snap) return f.pointer && { ...f.pointer, color: undefined };
  const pick = snappedSample(f);
  return pick
    ? {
        py: pick.py,
        formatted: pick.formatted,
        side: pick.side,
        axisOffset: pick.axisOffset,
        axisColor: pick.axisColor,
        color: pick.color,
      }
    : null;
}

/** The consumer-facing {@link CursorSnap} for a resolved sample. */
function toCursorSnap(s: ResolvedCursorSample): CursorSnap {
  return {
    x: s.x,
    value: s.value,
    color: s.color,
    label: s.label,
    ...(s.readout !== undefined ? { readout: s.readout } : {}),
    axisId: s.axisId,
    formatted: s.formatted,
  };
}

/** A {@link CursorSnap}'s identity for change detection — every field, so a
 *  new axis format under a still pointer (same point, new `formatted`) is a
 *  change the consumer hears about too. */
function snapKey(s: CursorSnap | null): string | null {
  return s === null
    ? null
    : [s.axisId, s.label, s.x, s.value, s.readout, s.color, s.formatted].join(
        '\u0000',
      );
}

/**
 * The crosshair's snap reporter: picks the snapped sample from a hovered row's
 * frame (`null` = nothing snapped) and calls the consumer only when the pick
 * **changes** — rows re-render on every pointer move, and a callback that fired
 * per move while the reticle sat still would make every consumer dedupe.
 *
 * Its state belongs to the mounted `<CrosshairCursor>`, not to this reporter:
 * the reporter is rebuilt whenever `snap` / `showTime` / `format` change, and
 * a fresh "last reported" would swallow the `null` that toggling to free mode
 * owes a consumer still holding a point. `live` goes false on unmount, so a
 * row still holding the old registration for one more commit can't report a
 * point after the unmount's final `null`. The callback is read through a ref
 * so an inline `onSnap` doesn't rebuild the cursor spec on every parent render.
 */
function snapReporter(
  onSnapRef: { readonly current: ((s: CursorSnap | null) => void) | undefined },
  state: { readonly current: SnapReportState },
  snap: boolean,
): (f: ResolvedCursorFrame | null) => void {
  return (f) => {
    const st = state.current;
    if (!st.live) return;
    // Free mode follows the pointer, not a series: there is nothing to report.
    const pick = f !== null && snap ? snappedSample(f) : null;
    const info = pick === null ? null : toCursorSnap(pick);
    const key = snapKey(info);
    if (key === st.last) return;
    st.last = key;
    onSnapRef.current?.(info);
  };
}

/** A `<CrosshairCursor>`'s snap-report state (see {@link snapReporter}). */
interface SnapReportState {
  /** The {@link snapKey} of what the consumer was last told. */
  last: string | null;
  /** False once the cursor has unmounted. */
  live: boolean;
}

/** `<CrosshairCursor>` as a spec: the dashed reticle (renderPlot), the axis
 *  value pill (renderYGutter), and the x-axis time pill (renderXAxis). Declares
 *  `snapX: 'sample'` — the container snaps the shared cursorX to the data grid. */
function buildCrosshairCursor(o: {
  snap: boolean;
  showTime: boolean;
  format?: CursorFormat | undefined;
  reportSnap?: ((f: ResolvedCursorFrame | null) => void) | undefined;
}): BuiltCursor {
  return {
    spec: {
      snapX: 'sample',
      renderPlot: (f) => {
        const x = inBoundsX(f);
        if (x === null) return null;
        const ink = cursorInk(f.theme);
        const background = f.theme.background;
        const reticle = crosshairPick(f, o.snap);
        return (
          <>
            <line
              x1={Math.round(x)}
              y1={0}
              x2={Math.round(x)}
              y2={f.rowHeight}
              stroke={ink}
              strokeWidth={1}
              strokeDasharray="3 3"
              shapeRendering="crispEdges"
            />
            {reticle && (
              <>
                <line
                  x1={0}
                  y1={Math.round(reticle.py)}
                  x2={f.plotWidth}
                  y2={Math.round(reticle.py)}
                  stroke={ink}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  shapeRendering="crispEdges"
                />
                {/* The centre dot takes the snapped series' colour, so the
                    reticle says which line it is reading; free mode has no
                    series under it and keeps the cursor ink. */}
                <circle
                  cx={x}
                  cy={reticle.py}
                  r={3}
                  fill={reticle.color ?? ink}
                  stroke={background}
                  strokeWidth={background ? 1 : 0}
                />
              </>
            )}
          </>
        );
      },
      // The value pill goes **on the reticle's own axis**: its side, its offset
      // out into that gutter (so a second axis on a side gets its own pill
      // position rather than the innermost axis's), and its `<YAxis color>` when
      // it has one — with several axes the pill's ink is what says which scale
      // the number is on. An uncoloured axis keeps the cursor's own ink.
      renderYGutter: (f) => {
        const reticle = crosshairPick(f, o.snap);
        if (reticle === null) return null;
        const lh = chipLineHeight(f.theme);
        const ink = reticle.axisColor ?? cursorInk(f.theme);
        // Clamped inside the row like the y-tick labels; the connector shares it
        // so the bridge always meets the pill it belongs to.
        const top = Math.max(
          lh / 2,
          Math.min(f.rowHeight - lh / 2, reticle.py),
        );
        return (
          <>
            {/* Bridge the reticle's horizontal line — which ends at the plot's
                edge — to a pill sitting further out, so the two read as one
                object (the x-axis time pill's connector, transposed). Nothing to
                bridge on the innermost axis. */}
            {reticle.axisOffset > 0 && (
              <div
                style={{
                  ...axisPillConnector(
                    reticle.side,
                    f.plotWidth,
                    reticle.axisOffset,
                    ink,
                  ),
                  top: `${top}px`,
                  transform: 'translateY(-50%)',
                }}
              />
            )}
            <div
              style={{
                ...axisPillStyle(f.theme, ink),
                top: `${top}px`,
                transform: 'translateY(-50%)',
                ...axisPillX(reticle.side, f.plotWidth, reticle.axisOffset),
              }}
            >
              {reticle.formatted}
            </div>
          </>
        );
      },
      ...(o.showTime
        ? {
            renderXAxis: (f: ResolvedCursorFrame) => {
              const x = inBoundsX(f);
              if (x === null || f.xAxis === null) return null;
              const ink = cursorInk(f.theme);
              const { onTop, pillOffset } = f.xAxis;
              return (
                <>
                  {/* Connector bridging the crosshair's vertical line (ending
                      at the plot's edge = this strip's plot-facing edge) to its
                      time pill, so the two read as one. */}
                  <div
                    style={{
                      position: 'absolute',
                      left: `${x}px`,
                      [onTop ? 'bottom' : 'top']: 0,
                      width: '1px',
                      height: `${pillOffset}px`,
                      background: ink,
                      zIndex: 3,
                    }}
                  />
                  <div
                    style={{
                      ...axisPillStyle(f.theme, ink),
                      left: `${x}px`,
                      transform: 'translateX(-50%)',
                      [onTop ? 'bottom' : 'top']: `${pillOffset}px`,
                      zIndex: 3,
                    }}
                  >
                    {f.formattedTime}
                  </div>
                </>
              );
            },
          }
        : {}),
    },
    wants: { ...NO_WANTS, samples: true, pointer: !o.snap },
    ownsGesture: true,
    format: o.format,
    reportSnap: o.reportSnap,
  };
}

/** `<RangeCursor>` as a spec: the hover-time **band** — the bucket under the
 *  pointer (sequence-snapped; freeform = a plain line until a drag shades the
 *  raw span) — plus the drag registration the brush recognizer reads
 *  (`resolveRangeDrag`). The container resolves the band; the shared
 *  `renderBrushBand` slot only draws it (one renderer for every brush-driven
 *  component, RFC A1.5 — `<MultiSelector>` plugs into the same one).
 *  `enableDrag` is resolved here (`?? !!onDragRelease`) so the registered
 *  entry carries the effective switch, not the raw prop. */
function buildRangeCursor(o: {
  sequence?: Sequence | BoundedSequence | undefined;
  onDragRelease?: ((span: RangeSpan) => void) | undefined;
  enableDrag?: boolean | undefined;
  dragModifier?: 'shift' | undefined;
}): BuiltCursor {
  return {
    spec: {
      snapX: o.sequence !== undefined ? 'sequence' : 'none',
      renderPlot: renderBrushBand,
    },
    wants: { ...NO_WANTS, band: true },
    ownsGesture: true,
    sequence: o.sequence,
    onDragRelease: o.onDragRelease,
    enableDrag: o.enableDrag ?? o.onDragRelease !== undefined,
    dragModifier: o.dragModifier,
  };
}

/**
 * Register a built cursor with the container, scoped to the enclosing
 * `<ChartRow>` when there is one (the per-row override) else the container.
 * Update-in-place on a prop change (the entry memo), unregister on unmount —
 * the `registerAxis` discipline.
 */
function useCursorMount(built: BuiltCursor | null): void {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error(
      'cursor components must be mounted inside a <ChartContainer> (as a ' +
        'direct child, or inside a <ChartRow> for a per-row override)',
    );
  }
  const row = useContext(RowContext);
  const rowKey = row?.rowKey ?? null;
  const key = useSlotKey();
  const entry = useMemo<CursorEntry | null>(
    () =>
      built === null
        ? null
        : {
            spec: built.spec,
            wants: built.wants,
            ownsGesture: built.ownsGesture,
            sequence: built.sequence,
            format: built.format,
            onDragRelease: built.onDragRelease,
            enableDrag: built.enableDrag,
            dragModifier: built.dragModifier,
            reportSnap: built.reportSnap,
            rowKey,
          },
    [built, rowKey],
  );
  const { registerCursor, unregisterCursor } = container;
  useEffect(() => {
    if (entry === null) {
      unregisterCursor(key);
      return;
    }
    registerCursor(key, entry);
  }, [registerCursor, unregisterCursor, key, entry]);
  useEffect(() => () => unregisterCursor(key), [unregisterCursor, key]);
}

export interface LineCursorProps {
  /** Show the cursor's time atop the readout (once, on the first row),
   *  formatted by the container's readout channel. Default `false`. */
  showTime?: boolean;
  /** The readout format for the time this cursor shows (and for marker
   *  indicators + annotation auto-labels) — the shared readout channel; see
   *  {@link CrosshairCursorProps.format}. */
  format?: CursorFormat;
}

/** The synced vertical cursor **line**. Pair with an off-chart readout via
 *  `onTrackerChanged`. */
export function LineCursor({ showTime = false, format }: LineCursorProps = {}) {
  useCursorMount(
    useMemo(() => buildLineCursor({ showTime, format }), [showTime, format]),
  );
  return null;
}

export interface PointCursorProps {
  /** Show the cursor's time atop the readout (first row). Default `false`. */
  showTime?: boolean;
  /** The readout format for the time this cursor shows (and for marker
   *  indicators + annotation auto-labels) — the shared readout channel; see
   *  {@link CrosshairCursorProps.format}. */
  format?: CursorFormat;
}

/** A **dot on each series** at the cursor, no line. */
export function PointCursor({
  showTime = false,
  format,
}: PointCursorProps = {}) {
  useCursorMount(
    useMemo(() => buildPointCursor({ showTime, format }), [showTime, format]),
  );
  return null;
}

export interface InlineCursorProps {
  /** Show the cursor's time atop the readout (first row). Default `false`. */
  showTime?: boolean;
  /** The readout format for the time this cursor shows (and for marker
   *  indicators + annotation auto-labels) — the shared readout channel; see
   *  {@link CrosshairCursorProps.format}. */
  format?: CursorFormat;
}

/** Dots **plus a value chip beside each**. */
export function InlineCursor({
  showTime = false,
  format,
}: InlineCursorProps = {}) {
  useCursorMount(
    useMemo(() => buildInlineCursor({ showTime, format }), [showTime, format]),
  );
  return null;
}

export interface FlagCursorProps {
  /** Show the cursor's time atop the flag stack (first row). Default `false`. */
  showTime?: boolean;
  /** The readout format for the time this cursor shows (and for marker
   *  indicators + annotation auto-labels) — the shared readout channel; see
   *  {@link CrosshairCursorProps.format}. */
  format?: CursorFormat;
}

/** Dots + **staffed value flags** stacked near the top of the row — a `cursorFlag` layer (BoxPlot)
 *  consolidates onto one flag. */
export function FlagCursor({ showTime = false, format }: FlagCursorProps = {}) {
  useCursorMount(
    useMemo(() => buildFlagCursor({ showTime, format }), [showTime, format]),
  );
  return null;
}

export interface CrosshairCursorProps {
  /**
   * Reticle **y** snapping. **Default `true`** — the reticle centres on the
   * nearest data point. `false` — the horizontal line + value follow the
   * pointer y freely. The **x** always snaps to the data grid either way
   * (declared `snapX: 'sample'`; the container resolves it).
   */
  snap?: boolean;
  /** Pin the cursor's **time to the x axis** (the trading-terminal pill).
   *  **Default `true`** — the time pill is the crosshair's readout; there is
   *  no per-row time chip to opt into. */
  showTime?: boolean;
  /**
   * The **cursor / marker readout** format — the x-axis time pill, marker
   * axis indicators, and annotation auto-labels — **independent of the tick
   * labels** on both axis kinds: it does **not** disqualify the `dateStyle`
   * ladder (time), and it never moves the tick labels (value). It beats an
   * explicit `<XAxis format>` for the **readout only** — pill precedence is
   * `format → axis format → container` — so terse ticks can pair with a
   * precise readout (`+2.0σ` labels, `+1.83σ` pill).
   *
   * **Omitted ⇒ the axis's own formatter.** On a time axis that default is
   * grain-aware: the readout formats at the axis's granularity, so a
   * day-or-coarser axis reads a **date** (never a time-of-day) and a sub-day
   * axis reads date + clock. On a value axis it is the tick formatter.
   *
   * A d3 specifier **string** formats uniformly (time specifier on a time
   * axis, number specifier on a value axis); a **function**
   * `(value, { grain, defaultText }) => string` receives the axis's resolved
   * coarse grain (`undefined` on a value axis) and the default readout text,
   * so it can branch on the zoom level and pass `defaultText` through. One
   * channel per chart: when several mounted cursors set `format`, the first
   * mounted wins. (A category axis reads names, and a `transform`ed axis's
   * pill speaks its derived unit — neither consults it.)
   */
  format?: CursorFormat;
  /**
   * Tells you what the reticle is **snapped to** — the series (`label`,
   * `color`, `axisId`) and the point (`x`, `value`, `formatted`) its centre dot
   * sits on — and `null` when it lets go (the pointer leaves the chart, or
   * moves to a row with no data under it). Fires only when the snapped point
   * **changes**, not on every pointer move.
   *
   * Reports the pointer's snap only: with `snap={false}` the reticle follows
   * the pointer rather than a series, so this stays `null`; and a reticle
   * shown by a controlled `trackerPosition` with no pointer on the chart
   * reports `null` too. For every series' value at the cursor time, use the
   * container's `onTrackerChanged`.
   */
  onSnap?: (snap: CursorSnap | null) => void;
}

/** The inspection **reticle**: dashed cross lines, a
 *  centre dot in the snapped series' colour, the value pinned to its y axis,
 *  the time pinned to the x axis. */
export function CrosshairCursor({
  snap = true,
  showTime = true,
  format,
  onSnap,
}: CrosshairCursorProps = {}) {
  // Latest callback in a ref, so an inline `onSnap` doesn't re-register the
  // cursor on every parent render; the spec is rebuilt only when a callback
  // appears or goes away. Written in a *layout* effect: the rows report from
  // passive effects, and every layout effect in a commit runs before any
  // passive one — so a row always calls this commit's callback, wherever the
  // cursor sits in the tree relative to the rows.
  const onSnapRef = useRef(onSnap);
  useLayoutEffect(() => {
    onSnapRef.current = onSnap;
  });
  // What the consumer was last told, shared across reporter rebuilds (see
  // `snapReporter`).
  const reportState = useRef<SnapReportState>({ last: null, live: true });
  const listening = onSnap !== undefined;
  // A consumer who stops listening is owed nothing more; a fresh listener
  // starts from "nothing reported yet".
  if (!listening) reportState.current.last = null;
  // Unmounting while snapped lets go of the point, the same as the pointer
  // leaving would. (`live` is re-set on mount for StrictMode's
  // unmount-remount.)
  useEffect(() => {
    const st = reportState.current;
    st.live = true;
    return () => {
      st.live = false;
      if (st.last === null) return;
      st.last = null;
      onSnapRef.current?.(null);
    };
  }, []);
  useCursorMount(
    useMemo(
      () =>
        buildCrosshairCursor({
          snap,
          showTime,
          format,
          reportSnap: listening
            ? snapReporter(onSnapRef, reportState, snap)
            : undefined,
        }),
      [snap, showTime, format, listening],
    ),
  );
  return null;
}

export interface RangeCursorProps {
  /**
   * The bucketing for the hover band **and the drag's snap** — a pond
   * `Sequence` (realized over the view) or `BoundedSequence` (used as-is; a
   * trading calendar's sessions). A drag extends **bucket by bucket** over
   * these. **Omit ⇒ freeform**: the cursor renders as a plain line and a drag
   * spans the raw `[lo, hi]` (a bar/histogram layer's bins still snap both
   * when present). Time axis only; on a category axis the band always
   * snaps to the slot under the pointer. Pass a stable
   * reference (the buckets memoize on it).
   */
  sequence?: Sequence | BoundedSequence;
  /**
   * Makes the cursor **draggable**: drag across the plot and the band extends
   * (bucket by bucket with a {@link sequence}, freeform without); on release
   * this fires **once** with the selected {@link RangeSpan}, and the cursor
   * **reverts** to the single-bucket highlight — it does not keep the range.
   *
   * The payload is `{ x: [lo, hi], y? }` in axis units — epoch ms on a time
   * axis, the axis value on a value axis. `y` is absent on today's 1-D
   * layers; the 2-D drag (scatter / heat map) will populate it additively
   * (RFC A3.3). `span.x` feeds `ChartContainer.range` directly — the
   * name-level coherence: a **Range**Cursor emits what `range` accepts —
   * so drag-to-zoom is `onDragRelease={(s) => setRange(s.x)}`.
   *
   * The drag **preempts pan** unless {@link dragModifier} shares the gesture.
   * Continuous x only: on a **category** axis the hover band still shades the
   * slot under the pointer, but the drag never starts — a numeric span means
   * nothing there, and dragging across bars is `<MultiSelector>`'s gesture
   * (it reports the bars). The container dev-warns when this is wired on a
   * category axis.
   */
  onDragRelease?: (span: RangeSpan) => void;
  /**
   * **The OFF switch, not the on switch** (RFC §6, resolved). The drag is
   * already enabled by wiring {@link onDragRelease} — this defaults to
   * `!!onDragRelease`, so you never need to set it to turn the drag on. Set
   * it to `false` to **freeze the gesture without unwiring the callback**
   * (otherwise a `useCallback` dance): the band stays hover-only and the
   * plot's drag goes back to pan (or nothing). Without `onDragRelease` there
   * is nothing to fire, so `enableDrag` alone never starts a gesture.
   */
  enableDrag?: boolean;
  /**
   * Which modifier the drag needs — set `'shift'` when pan is also enabled
   * and you want **plain drag to pan, shift-drag to select**. **Only
   * enforced while pan is enabled** (with pan off there is no gesture
   * conflict, so either drag selects). Omitted ⇒ the drag preempts pan.
   */
  dragModifier?: 'shift';
}

/**
 * The **range** cursor (RFC A4.1 names
 * it for what it emits: a live extent — and, dragged, exactly what
 * `ChartContainer.range` accepts — against the annotation `<Region>`'s fixed
 * mark). Hover shades the bucket under the pointer (on a category axis, the
 * slot); wiring
 * {@link RangeCursorProps.onDragRelease} adds the drag, which fires once on
 * release and reverts (RFC §6: a region is deliberately a cursor **and** a
 * drag that fires and resets). The gesture rides the shared brush recognizer
 * (`brush.tsx`) — one engine arbitrating every drag claim on the plot.
 */
export function RangeCursor({
  sequence,
  onDragRelease,
  enableDrag,
  dragModifier,
}: RangeCursorProps = {}) {
  useCursorMount(
    useMemo(
      () =>
        buildRangeCursor({ sequence, onDragRelease, enableDrag, dragModifier }),
      [sequence, onDragRelease, enableDrag, dragModifier],
    ),
  );
  return null;
}

/**
 * The cursors in effect for a row: the row's own mounts when it has any (the
 * per-row override — nearest mount wins), else the container-scoped mounts.
 * A row that wants no cursor while its siblings have one mounts the cursors
 * per row rather than at the container.
 */
export function effectiveCursorEntries(
  all: readonly CursorEntry[],
  rowKey: symbol,
): readonly CursorEntry[] {
  const rowEntries = all.filter((e) => e.rowKey === rowKey);
  if (rowEntries.length > 0) return rowEntries;
  return all.filter((e) => e.rowKey === null);
}

/** The scope's single snap/gesture owner (RFC A2.5) — first mount wins; the
 *  container dev-warns when a scope has two. */
export function gestureOwner(
  entries: readonly CursorEntry[],
): CursorEntry | undefined {
  return entries.find((e) => e.ownsGesture);
}

/**
 * The cursors whose x-axis slot `<XAxis>` should render: the **hovered row's**
 * effective set while hovering (so a per-row override reaches the axis — the
 * seam the string gate never let it through), else — a controlled
 * `trackerPosition` with no live pointer — every scope's effective set, so a
 * pinned crosshair keeps its pill wherever it is mounted.
 */
export function xAxisCursorEntries(
  all: readonly CursorEntry[],
  hoveredRowKey: symbol | null,
): readonly CursorEntry[] {
  if (hoveredRowKey !== null) return effectiveCursorEntries(all, hoveredRowKey);
  const out: CursorEntry[] = [];
  const seenRows = new Set<symbol>();
  out.push(...all.filter((e) => e.rowKey === null));
  for (const e of all) {
    if (e.rowKey === null || seenRows.has(e.rowKey)) continue;
    seenRows.add(e.rowKey);
    out.push(...effectiveCursorEntries(all, e.rowKey));
  }
  return out;
}

/**
 * Dev-warn (once per container) when any scope mounts two gesture-owning
 * cursors — RFC A2.5: stack render-only presets freely, but snap and gesture
 * have one owner per scope, and a silent first-wins would hide the loser.
 */
export function warnOnDuplicateGestureOwners(
  all: readonly CursorEntry[],
  warned: { current: boolean },
): void {
  if (!isDev || warned.current) return;
  const scopes = new Set<symbol | null>(all.map((e) => e.rowKey));
  for (const scope of scopes) {
    const entries = all.filter((e) => e.rowKey === scope);
    if (entries.filter((e) => e.ownsGesture).length > 1) {
      warned.current = true;
      console.warn(
        '[pond-charts] two gesture-owning cursors (<CrosshairCursor> / ' +
          '<RangeCursor>) are mounted in the same scope — one cursor owns ' +
          'snap and gesture per scope (the first mounted wins). Render-only ' +
          'presets (<LineCursor>, <PointCursor>, <InlineCursor>, ' +
          '<FlagCursor>) may stack; pick one gesture owner.',
      );
      return;
    }
  }
}
