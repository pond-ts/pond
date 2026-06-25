import { useContext, type CSSProperties, type ReactNode } from 'react';
import { ContainerContext, RowContext } from './context.js';
import type { ChartTheme } from './theme.js';

/**
 * User-authored **annotations** — marks you place *on* a chart, in a register
 * deliberately distinct from the data: `<Region>` (a shaded x-span), `<Baseline>`
 * (a horizontal value line), and `<Marker>` (a vertical x line). All three render
 * in the theme's turquoise {@link ChartTheme.annotation} register so a placed mark
 * never reads as data ("the data stays foam; the marks you place are turquoise").
 *
 * They are children of `<Layers>` (so they share the plot's coordinate space) and
 * paint a pointer-inert SVG overlay above the data canvas + below the cursor —
 * pan/zoom keeps the surface. **Luminosity encodes attention:** a mark sits at
 * `rest`, brightens to `hover` as the pointer nears it (Region / Marker, via the
 * shared cursor x), and to `selected` (with drag handles) when its `selected` prop
 * is set. Live select + drag-to-edit is a later phase (an explicit edit *mode*,
 * since the surface already owns pan/zoom); here `selected` is a controlled input.
 */

/** Fallback when a theme defines no `annotation` token — a neutral turquoise. */
const DEFAULT_ANNOTATION: NonNullable<ChartTheme['annotation']> = {
  color: '#14b8a6',
  fillOpacity: 0.1,
  rest: 0.6,
  hover: 0.82,
  selected: 1,
};

/** Pointer proximity (px) within which a Marker / Region brightens to `hover`. */
const HOVER_PX = 6;
/** Selection-handle pill geometry (px). */
const HANDLE_W = 6;
const HANDLE_H = 18;

type AnnotationState = 'rest' | 'hover' | 'selected';

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

/** A label chip in the annotation register — turquoise text + outline, positioned
 *  by the caller's `style` (top/left/right/transform). */
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
    <div
      style={{
        position: 'absolute',
        background: theme.chip?.background ?? theme.background,
        border: `1px solid ${color}`,
        borderRadius: '3px',
        padding: '0 4px',
        fontFamily: theme.font.family,
        fontSize: `${theme.font.size}px`,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        lineHeight: 1.5,
        color,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export interface MarkerProps {
  /** x position in axis units — epoch ms on a time axis, the value on a value
   *  axis. (The generalisation of the mockup's "time line": a mark at an x, time
   *  or value.) */
  at: number;
  /** Chip label; omit to auto-label with the shared x formatter (the axis's). */
  label?: string;
  /** Controlled selection — brightens + shows end handles. Live select/edit is a
   *  later phase; this is the input for now. */
  selected?: boolean;
}

/** A vertical line at an x position (a time, a distance, a lap boundary). */
export function Marker({ at, label, selected = false }: MarkerProps) {
  const { container, row, ann } = useAnnotationFrame('Marker');
  const x = container.xScale(at);
  const h = row.height;
  const cx = container.cursorX;
  const hovering = cx !== null && Math.abs(cx - x) <= HOVER_PX;
  const state: AnnotationState = selected
    ? 'selected'
    : hovering
      ? 'hover'
      : 'rest';
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
        {selected && (
          <>
            <rect
              x={x - HANDLE_W / 2}
              y={0}
              width={HANDLE_W}
              height={14}
              rx={3}
              fill={ann.color}
            />
            <rect
              x={x - HANDLE_W / 2}
              y={h - 14}
              width={HANDLE_W}
              height={14}
              rx={3}
              fill={ann.color}
            />
          </>
        )}
      </svg>
      <Chip
        theme={container.theme}
        color={ann.color}
        style={{ top: '2px', left: `${x + 4}px` }}
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

/** A horizontal line at a y value, scaled against one row axis (RTC's `Baseline`). */
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
  /** Controlled selection — brightens + shows edge handles. */
  selected?: boolean;
}

/** A shaded span over an x range — a lap, a zone, a selected interval. */
export function Region({ from, to, label, selected = false }: RegionProps) {
  const { container, row, ann } = useAnnotationFrame('Region');
  const xa = container.xScale(from);
  const xb = container.xScale(to);
  const left = Math.min(xa, xb);
  const right = Math.max(xa, xb);
  const w = right - left;
  const h = row.height;
  const cx = container.cursorX;
  const hovering = cx !== null && cx >= left && cx <= right;
  const state: AnnotationState = selected
    ? 'selected'
    : hovering
      ? 'hover'
      : 'rest';
  // The fill stays subtle so the data reads through; it lifts a touch with attention.
  const fillOpacity = ann.fillOpacity * (selected ? 1.6 : hovering ? 1.3 : 1);
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
          width={w}
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
          top: '2px',
          left: `${(left + right) / 2}px`,
          transform: 'translateX(-50%)',
        }}
      >
        {text}
      </Chip>
    </>
  );
}
