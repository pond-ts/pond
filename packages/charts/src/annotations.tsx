import { useContext, type CSSProperties, type ReactNode } from 'react';
import { ContainerContext, RowContext } from './context.js';
import type { ChartTheme } from './theme.js';
import { flagChipStyle } from './chip.js';

/**
 * User-authored **annotations** — marks you place *on* a chart, in a register
 * deliberately distinct from the data: `<Region>` (a shaded x-span), `<Baseline>`
 * (a horizontal value line), and `<Marker>` (a vertical x line). All three render
 * in the theme's turquoise {@link ChartTheme.annotation} register so a placed mark
 * never reads as data ("the data stays foam; the marks you place are turquoise").
 *
 * They are children of `<Layers>` (so they share the plot's coordinate space) and
 * paint a pointer-inert SVG overlay above the data canvas + below the cursor —
 * pan/zoom keeps the surface. Each label is a **flag**: the chip attaches to the
 * side of the mark's vertical line, its top aligned to the line's top (the same
 * shape as the cursor's value flag).
 *
 * **Luminosity encodes attention:** a mark sits at `rest`, lifting to `selected`
 * (with drag handles) when its `selected` prop is set. Hover + live select +
 * drag-to-edit are a later phase — an explicit edit *mode*, where hovering a mark
 * changes the cursor; they're one interaction, deferred together. For now
 * `selected` is a controlled input.
 */

/** Fallback when a theme defines no `annotation` token — a neutral turquoise. */
const DEFAULT_ANNOTATION: NonNullable<ChartTheme['annotation']> = {
  color: '#14b8a6',
  fillOpacity: 0.1,
  rest: 0.6,
  hover: 0.82,
  selected: 1,
};

/** Selection-handle pill geometry (px). */
const HANDLE_W = 6;
const HANDLE_H = 18;
/** Flag-chip top offset (px from the row top) — a few px down so it clears the
 *  edge. Region + Marker share it so their labels align across a chart. */
const FLAG_TOP = 2;
/** Past this fraction of the plot a flag chip flips left of its line to stay in. */
const FLAG_FLIP = 0.85;
/** Gap (px) between a flag chip and its line, so the chip floats beside the pole
 *  instead of covering (dimming) the prominent vertical line. */
const FLAG_GAP = 4;

/** Phase 1 drives only rest + selected; `hover` (the theme's third level) lands
 *  with the edit mode. */
type AnnotationState = 'rest' | 'selected';

/** The full-plot overlay each annotation paints into — above the data canvas,
 *  below the cursor, inert to the pointer (pan/zoom owns the surface). */
const overlayStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  pointerEvents: 'none',
};

/** Read the container + row frames an annotation needs, or throw if misplaced. */
function useAnnotationFrame(name: string) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error(`<${name}> must be rendered inside a <ChartContainer>`);
  }
  const row = useContext(RowContext);
  if (row === null) {
    throw new Error(`<${name}> must be rendered inside a <ChartRow>`);
  }
  const ann = container.theme.annotation ?? DEFAULT_ANNOTATION;
  return { container, row, ann };
}

/** Position a flag chip attached to a vertical line at plot-x `x`: to the right
 *  of the line, flipping to the left near the right edge so it stays in-plot. */
function flagX(x: number, plotWidth: number): CSSProperties {
  return x > plotWidth * FLAG_FLIP
    ? { right: `${plotWidth - x + FLAG_GAP}px` }
    : { left: `${x + FLAG_GAP}px` };
}

/** A label chip — the cursor value flag's shape (shared {@link flagChipStyle}:
 *  filled, no outline) with text in the annotation register. Positioned by the
 *  caller's `style` (top/left/right/transform). */
function Chip({
  theme,
  color,
  style,
  children,
}: {
  theme: ChartTheme;
  color: string;
  style: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div style={{ ...flagChipStyle(theme), color, ...style }}>{children}</div>
  );
}

export interface MarkerProps {
  /** x position in axis units — epoch ms on a time axis, the value on a value
   *  axis. (The generalisation of the mockup's "time line": a mark at an x, time
   *  or value.) */
  at: number;
  /** Chip label; omit to auto-label with the shared x formatter (the axis's). */
  label?: string;
  /** Controlled selection — brightens + shows a single centre handle (the line
   *  moves as a whole). Live select/edit is a later phase; this is the input now. */
  selected?: boolean;
}

/** A vertical line at an x position (a time, a distance, a lap boundary). */
export function Marker({ at, label, selected = false }: MarkerProps) {
  const { container, row, ann } = useAnnotationFrame('Marker');
  const x = container.xScale(at);
  const h = row.height;
  const state: AnnotationState = selected ? 'selected' : 'rest';
  const text = label ?? container.formatTime(at);
  return (
    <>
      <svg width={container.plotWidth} height={h} style={overlayStyle}>
        <line
          x1={x}
          y1={0}
          x2={x}
          y2={h}
          stroke={ann.color}
          strokeWidth={1}
          opacity={ann[state]}
          shapeRendering="crispEdges"
        />
        {/* One handle, centred — a marker moves as a whole (two ends would read
            as independently draggable, and collide with the top label). */}
        {selected && (
          <rect
            x={x - HANDLE_W / 2}
            y={h / 2 - HANDLE_H / 2}
            width={HANDLE_W}
            height={HANDLE_H}
            rx={3}
            fill={ann.color}
          />
        )}
      </svg>
      <Chip
        theme={container.theme}
        color={ann.color}
        style={{
          top: `${FLAG_TOP}px`,
          ...flagX(x, container.plotWidth),
        }}
      >
        {text}
      </Chip>
    </>
  );
}

export interface BaselineProps {
  /** y value in the linked axis's units. */
  value: number;
  /** Which `<YAxis>` (by id) to measure against; omit for the row's default axis. */
  axis?: string;
  /** Chip label; omit to format `value` with that axis's formatter. */
  label?: string;
  /** Controlled selection — brightens. */
  selected?: boolean;
}

/** A horizontal line at a y value, scaled against one row axis (RTC's `Baseline`).
 *  Its label anchors at the left, at the line's height (a horizontal line has no
 *  vertical staff to fly a flag from). */
export function Baseline({
  value,
  axis,
  label,
  selected = false,
}: BaselineProps) {
  const { container, row, ann } = useAnnotationFrame('Baseline');
  const axisId = axis ?? row.defaultAxisId;
  const yScale = row.yScales.get(axisId);
  // The axis may not have resolved yet (a layer mounts before its <YAxis>); skip
  // until its scale exists rather than guessing a domain.
  if (yScale === undefined) return null;
  const y = yScale(value);
  const w = container.plotWidth;
  const state: AnnotationState = selected ? 'selected' : 'rest';
  const fmt = row.formats.get(axisId);
  const text = label ?? (fmt ? fmt(value) : String(value));
  return (
    <>
      <svg width={w} height={row.height} style={overlayStyle}>
        <line
          x1={0}
          y1={y}
          x2={w}
          y2={y}
          stroke={ann.color}
          strokeWidth={1}
          opacity={ann[state]}
          shapeRendering="crispEdges"
        />
      </svg>
      <Chip
        theme={container.theme}
        color={ann.color}
        style={{ top: `${y}px`, left: '2px', transform: 'translateY(-50%)' }}
      >
        {text}
      </Chip>
    </>
  );
}

export interface RegionProps {
  /** Start x in axis units (time or value). */
  from: number;
  /** End x in axis units. */
  to: number;
  /** Chip label; omit to auto-label `from–to` with the shared x formatter. */
  label?: string;
  /** Controlled selection — brightens + shows edge handles (each edge drags
   *  independently to resize the span). */
  selected?: boolean;
}

/** A shaded span over an x range — a lap, a zone, a selected interval. Its label
 *  flies as a flag off the left edge. */
export function Region({ from, to, label, selected = false }: RegionProps) {
  const { container, row, ann } = useAnnotationFrame('Region');
  const xa = container.xScale(from);
  const xb = container.xScale(to);
  const left = Math.min(xa, xb);
  const right = Math.max(xa, xb);
  const spanW = right - left;
  const h = row.height;
  const state: AnnotationState = selected ? 'selected' : 'rest';
  // The fill stays subtle so the data reads through; it lifts a touch when selected.
  const fillOpacity = ann.fillOpacity * (selected ? 1.6 : 1);
  const text =
    label ?? `${container.formatTime(from)}–${container.formatTime(to)}`;
  const edge = (atX: number) => (
    <line
      x1={atX}
      y1={0}
      x2={atX}
      y2={h}
      stroke={ann.color}
      strokeWidth={1}
      opacity={ann[state]}
      shapeRendering="crispEdges"
    />
  );
  const handle = (atX: number) => (
    <rect
      x={atX - HANDLE_W / 2}
      y={h / 2 - HANDLE_H / 2}
      width={HANDLE_W}
      height={HANDLE_H}
      rx={3}
      fill={ann.color}
    />
  );
  return (
    <>
      <svg width={container.plotWidth} height={h} style={overlayStyle}>
        <rect
          x={left}
          y={0}
          width={spanW}
          height={h}
          fill={ann.color}
          opacity={fillOpacity}
        />
        {edge(left)}
        {edge(right)}
        {selected && (
          <>
            {handle(left)}
            {handle(right)}
          </>
        )}
      </svg>
      <Chip
        theme={container.theme}
        color={ann.color}
        style={{
          top: `${FLAG_TOP}px`,
          ...flagX(left, container.plotWidth),
        }}
      >
        {text}
      </Chip>
    </>
  );
}
