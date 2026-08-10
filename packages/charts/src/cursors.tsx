import { useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { Sequence, BoundedSequence } from 'pond-ts';
import {
  ContainerContext,
  RowContext,
  type CursorEntry,
  type CursorMode,
  type CursorWants,
  type RangeSpan,
  type ResolvedCursorFrame,
} from './context.js';
import { renderBrushBand } from './brush.js';
import type { ChartTheme } from './theme.js';
import type { CursorFormat } from './format.js';
import { flagChipStyle, flagChipX, axisPillStyle, axisPillX } from './chip.js';
import { useSlotKey } from './use-slot-key.js';
import { isDev } from './dev.js';

/**
 * Cursor **presets** — the mounted-component successors of the `cursor` string
 * modes (interaction RFC §4 / A4.1): `<LineCursor>`, `<PointCursor>`,
 * `<InlineCursor>`, `<FlagCursor>`, `<CrosshairCursor>`, `<RangeCursor>`.
 *
 * Each preset registers a `CursorSpec` with the container (the
 * `registerAxis` / `registerLayer` idiom): **declared** snap plus render slots
 * taking resolved geometry. The container resolves — the x-snap, the
 * per-sample measurements, the band — and the slots draw (RFC A2.3). Mount a
 * preset as a child of `<ChartContainer>` (the default for every row) or
 * inside a `<ChartRow>` (the per-row override, replacing `<ChartRow cursor>`).
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
 *  fields that ride alongside it (everything but scope + legacy). */
interface BuiltCursor {
  readonly spec: CursorEntry['spec'];
  readonly wants: CursorWants;
  readonly ownsGesture: boolean;
  readonly sequence?: Sequence | BoundedSequence | undefined;
  readonly format?: CursorFormat | undefined;
  readonly onDragRelease?: ((span: RangeSpan) => void) | undefined;
  readonly enableDrag?: boolean | undefined;
  readonly dragModifier?: 'shift' | undefined;
}

const NO_WANTS: CursorWants = {
  samples: false,
  flags: false,
  band: false,
  pointer: false,
  time: false,
};

/** `cursor="line"` as a spec: the synced vertical line only (+ optional time). */
function buildLineCursor(o: { showTime: boolean }): BuiltCursor {
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
  };
}

/** `cursor="point"` as a spec: a dot on each series, no line. */
function buildPointCursor(o: { showTime: boolean }): BuiltCursor {
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
  };
}

/** `cursor="inline"` as a spec: dots + a value chip beside each, clamped
 *  within the row and flipped left near the right edge. */
function buildInlineCursor(o: { showTime: boolean }): BuiltCursor {
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
  };
}

/** `cursor="flag"` as a spec: dots + staffed value flags stacked near the top
 *  of the row, plus the consolidated one-chip flag for `cursorFlag` layers
 *  (BoxPlot). The time readout (when shown, first row) tops the stack and the
 *  staffs start just below it. */
function buildFlagCursor(o: { showTime: boolean }): BuiltCursor {
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
  };
}

/**
 * The crosshair's single reticle centre for a row: with `snap` (default) the
 * sample nearest the pointer y in the hovered row — or the first sample when
 * nothing is hovered (a pinned tracker shows a reticle in every row); free
 * mode reads the container-resolved raw-pointer measurement.
 */
function crosshairPick(
  f: ResolvedCursorFrame,
  snap: boolean,
): { py: number; formatted: string; side: 'left' | 'right' } | null {
  if (inBoundsX(f) === null) return null;
  if (!snap) return f.pointer;
  if (f.samples.length === 0) return null;
  const hoveredRow = f.hoveredRowKey === f.rowKey;
  const cy = f.cursorY;
  const pick =
    hoveredRow && cy !== null
      ? f.samples.reduce((a, b) =>
          Math.abs(b.py - cy) < Math.abs(a.py - cy) ? b : a,
        )
      : f.hoveredRowKey === null
        ? f.samples[0]!
        : null;
  return pick
    ? { py: pick.py, formatted: pick.formatted, side: pick.side }
    : null;
}

/** `cursor="crosshair"` as a spec: the dashed reticle (renderPlot), the axis
 *  value pill (renderYGutter), and the x-axis time pill (renderXAxis). Declares
 *  `snapX: 'sample'` — the container snaps the shared cursorX to the data grid. */
function buildCrosshairCursor(o: {
  snap: boolean;
  showTime: boolean;
  format?: CursorFormat | undefined;
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
                <circle
                  cx={x}
                  cy={reticle.py}
                  r={3}
                  fill={ink}
                  stroke={background}
                  strokeWidth={background ? 1 : 0}
                />
              </>
            )}
          </>
        );
      },
      renderYGutter: (f) => {
        const reticle = crosshairPick(f, o.snap);
        if (reticle === null) return null;
        const lh = chipLineHeight(f.theme);
        return (
          <div
            style={{
              ...axisPillStyle(f.theme, cursorInk(f.theme)),
              top: `${Math.max(
                lh / 2,
                Math.min(f.rowHeight - lh / 2, reticle.py),
              )}px`,
              transform: 'translateY(-50%)',
              ...axisPillX(reticle.side, f.plotWidth),
            }}
          >
            {reticle.formatted}
          </div>
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
  };
}

/** `cursor="region"` as a spec: the hover-time **band** — the bucket under the
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
function useCursorMount(
  built: BuiltCursor | null,
  legacy: boolean,
  /** The container shim's un-asked-for `'line'` default (see
   *  {@link CursorEntry.implicit}) — never set by component mounts. */
  implicit = false,
): void {
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
            rowKey,
            legacy,
            ...(implicit ? { implicit } : {}),
          },
    [built, rowKey, legacy, implicit],
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
}

/** The synced vertical cursor **line** — `cursor="line"` as a component (the
 *  container default during the deprecation window). Pair with an off-chart
 *  readout via `onTrackerChanged`. */
export function LineCursor({ showTime = false }: LineCursorProps = {}) {
  useCursorMount(
    useMemo(() => buildLineCursor({ showTime }), [showTime]),
    false,
  );
  return null;
}

export interface PointCursorProps {
  /** Show the cursor's time atop the readout (first row). Default `false`. */
  showTime?: boolean;
}

/** A **dot on each series** at the cursor, no line — `cursor="point"`. */
export function PointCursor({ showTime = false }: PointCursorProps = {}) {
  useCursorMount(
    useMemo(() => buildPointCursor({ showTime }), [showTime]),
    false,
  );
  return null;
}

export interface InlineCursorProps {
  /** Show the cursor's time atop the readout (first row). Default `false`. */
  showTime?: boolean;
}

/** Dots **plus a value chip beside each** — `cursor="inline"`. */
export function InlineCursor({ showTime = false }: InlineCursorProps = {}) {
  useCursorMount(
    useMemo(() => buildInlineCursor({ showTime }), [showTime]),
    false,
  );
  return null;
}

export interface FlagCursorProps {
  /** Show the cursor's time atop the flag stack (first row). Default `false`. */
  showTime?: boolean;
}

/** Dots + **staffed value flags** stacked near the top of the row —
 *  `cursor="flag"`. A `cursorFlag` layer (BoxPlot) consolidates onto one flag. */
export function FlagCursor({ showTime = false }: FlagCursorProps = {}) {
  useCursorMount(
    useMemo(() => buildFlagCursor({ showTime }), [showTime]),
    false,
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
  /** Readout format for the x-axis time pill — the `cursorFormat` successor,
   *  resolved by the container into the shared readout channel (it also
   *  shapes marker indicators + annotation auto-labels, as `cursorFormat`
   *  did). */
  format?: CursorFormat;
}

/** The inspection **reticle** — `cursor="crosshair"`: dashed cross lines, a
 *  centre dot, the value pinned to its y axis, the time pinned to the x axis. */
export function CrosshairCursor({
  snap = true,
  showTime = true,
  format,
}: CrosshairCursorProps = {}) {
  useCursorMount(
    useMemo(
      () => buildCrosshairCursor({ snap, showTime, format }),
      [snap, showTime, format],
    ),
    false,
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
   * when present). Time axis only, like `cursorSequence`. Pass a stable
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
   * Continuous x only (a category axis is excluded, as for the legacy
   * `onRegionSelect`).
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
   * The `regionSelectModifier` successor.
   */
  dragModifier?: 'shift';
}

/**
 * The **range** cursor — `cursor="region"` as a component (RFC A4.1 renames
 * it for what it emits: a live extent — and, dragged, exactly what
 * `ChartContainer.range` accepts — against the annotation `<Region>`'s fixed
 * mark). Hover shades the bucket under the pointer; wiring
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
    false,
  );
  return null;
}

/**
 * The deprecation shim (internal): synthesizes the preset equivalent of a
 * legacy `cursor` string — the container's `cursor` prop (or its `'line'`
 * default), and `<ChartRow cursor>` inside a row. Registers as `legacy`, so a
 * component-mounted cursor in the same scope overrides it.
 */
export function LegacyCursor({
  mode,
  showTime,
  snap,
  sequence,
  implicit = false,
}: {
  mode: CursorMode;
  /** The container's `cursorTime` (the in-plot time readout opt-in). */
  showTime: boolean;
  /** The container's `crosshairSnap` (the reticle y-snap). */
  snap: boolean;
  sequence?: Sequence | BoundedSequence | undefined;
  /** This shim carries the container's un-asked-for `'line'` DEFAULT (no
   *  `cursor` prop set) — the only cursor a mounted `<MultiSelector>`'s
   *  resting block preview replaces (see {@link CursorEntry.implicit}). */
  implicit?: boolean;
}) {
  const built = useMemo<BuiltCursor | null>(() => {
    switch (mode) {
      case 'line':
        return buildLineCursor({ showTime });
      case 'point':
        return buildPointCursor({ showTime });
      case 'inline':
        return buildInlineCursor({ showTime });
      case 'flag':
        return buildFlagCursor({ showTime });
      case 'crosshair':
        // The legacy crosshair always pins the time to the x axis; its y-snap
        // is the container's `crosshairSnap`. (`cursorTime` is deliberately
        // NOT forwarded — crosshair has no per-row time chip.)
        return buildCrosshairCursor({ snap, showTime: true });
      case 'region':
        return buildRangeCursor({ sequence });
      case 'none':
        return null;
    }
  }, [mode, showTime, snap, sequence]);
  useCursorMount(built, true, implicit);
  return null;
}

/** Drop a scope's legacy (shim-synthesized) entries when the scope also has a
 *  component-mounted cursor — mounting a component overrides the string prop. */
function dropShadowedLegacy(
  entries: readonly CursorEntry[],
): readonly CursorEntry[] {
  return entries.some((e) => !e.legacy)
    ? entries.filter((e) => !e.legacy)
    : entries;
}

/**
 * The cursors in effect for a row: the row's own mounts when it has any (the
 * per-row override — nearest mount wins, exactly `row.cursor ?? container
 * .cursor`'s semantics), else the container-scoped mounts. Within a scope,
 * component mounts shadow the legacy shim.
 */
export function effectiveCursorEntries(
  all: readonly CursorEntry[],
  rowKey: symbol,
): readonly CursorEntry[] {
  const rowEntries = all.filter((e) => e.rowKey === rowKey);
  if (rowEntries.length > 0) return dropShadowedLegacy(rowEntries);
  return dropShadowedLegacy(all.filter((e) => e.rowKey === null));
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
  out.push(...dropShadowedLegacy(all.filter((e) => e.rowKey === null)));
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
    const entries = dropShadowedLegacy(all.filter((e) => e.rowKey === scope));
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

/** @internal The dev deprecation notice for a legacy cursor prop — one line
 *  naming the replacement, shared by the container and row shims. */
export function legacyCursorWarning(lines: readonly string[]): string {
  return (
    '[pond-charts] deprecated cursor props (they keep working this minor, ' +
    'removed next): ' +
    lines.join('; ') +
    '. Mount a cursor component instead (docs/rfcs/interaction.md §9).'
  );
}

/** @internal The preset name a legacy `cursor` mode maps to (for warnings). */
export function presetNameFor(mode: CursorMode): string {
  switch (mode) {
    case 'line':
      return '<LineCursor>';
    case 'point':
      return '<PointCursor>';
    case 'inline':
      return '<InlineCursor>';
    case 'flag':
      return '<FlagCursor>';
    case 'crosshair':
      return '<CrosshairCursor>';
    case 'region':
      return '<RangeCursor>';
    case 'none':
      return 'nothing (mount no cursor)';
  }
}
