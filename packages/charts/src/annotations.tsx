import {
  useContext,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { ContainerContext, RowContext } from './context.js';
import type { ChartTheme } from './theme.js';
import { flagChipStyle, flagChipX } from './chip.js';

/**
 * User-authored **annotations** — marks you place *on* a chart, in a register
 * deliberately distinct from the data: `<Region>` (a shaded x-span), `<Baseline>`
 * (a horizontal value line), and `<Marker>` (a vertical x line). All three render
 * in the theme's turquoise {@link ChartTheme.annotation} register so a placed mark
 * never reads as data ("the data stays foam; the marks you place are turquoise").
 *
 * They are children of `<Layers>` (so they share the plot's coordinate space) and
 * paint an SVG overlay above the data canvas + below the cursor. Each label is a
 * **flag** (the cursor value flag's shape). **Luminosity encodes attention:** a
 * mark sits at `rest`, lifts to `hover` while you grab its handle, and shows
 * `selected`.
 *
 * **Editing.** Pass `onChange` to make a mark **editable**: a drag handle appears,
 * dragging it reports the new position (controlled — wire it back to the position
 * prop), and hovering it lifts the mark + shows the resize cursor. The handle
 * **claims the gesture** (pointer capture + `stopPropagation`), so grabbing it
 * never starts a pan while a drag elsewhere on the plot still pans. (Click-to-
 * select with the rest dimmed, and a global exclusive edit mode, remain deferred.)
 */

/** Fallback when a theme defines no `annotation` token — a neutral turquoise. */
const DEFAULT_ANNOTATION: NonNullable<ChartTheme['annotation']> = {
  color: '#14b8a6',
  fillOpacity: 0.1,
  rest: 0.6,
  hover: 0.82,
  selected: 1,
};

/** Selection-handle pill geometry (px) — long axis vs short axis. */
const HANDLE_LONG = 18;
const HANDLE_SHORT = 6;
/** Flag-chip top offset (px from the row top) — a few px down so it clears the
 *  edge. Region + Marker share it so their labels align across a chart. */
const FLAG_TOP = 2;

type AnnotationState = 'rest' | 'hover' | 'selected';

/** The full-plot overlay each annotation paints into — above the data canvas,
 *  below the cursor. Inert to the pointer by default (pan/zoom owns the surface);
 *  an editable handle opts back in to `pointerEvents: auto` for itself only. */
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

/**
 * An interactive selection handle: a filled pill that reports the pointer's
 * **plot-pixel** position via `onDrag` while dragged (the annotation inverts it to
 * an axis value and fires its `onChange`). It **claims the gesture** —
 * `stopPropagation` + pointer capture on pointerdown — so grabbing a handle never
 * starts a pan, while a drag anywhere else on the plot still pans. Hovering it
 * lifts the annotation (`onHover`) and shows the resize `cursor`. Rendered inside
 * the otherwise-inert overlay SVG; only this rect opts back in to pointer events.
 */
function DragHandle({
  cx,
  cy,
  w,
  h,
  color,
  cursor,
  onHover,
  onDrag,
}: {
  cx: number;
  cy: number;
  w: number;
  h: number;
  color: string;
  cursor: string;
  onHover: (hovering: boolean) => void;
  onDrag: (px: number, py: number) => void;
}) {
  const dragging = useRef(false);
  const fire = (e: ReactPointerEvent) => {
    const svg = (e.currentTarget as SVGElement).ownerSVGElement;
    if (svg === null) return;
    const r = svg.getBoundingClientRect();
    onDrag(e.clientX - r.left, e.clientY - r.top);
  };
  return (
    <rect
      x={cx - w / 2}
      y={cy - h / 2}
      width={w}
      height={h}
      rx={3}
      fill={color}
      style={{ pointerEvents: 'auto', cursor }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => {
        if (!dragging.current) onHover(false);
      }}
      onPointerDown={(e) => {
        e.stopPropagation(); // claim the gesture — don't let the plot start a pan
        dragging.current = true;
        // Capture so the drag continues outside the handle; guard for synthetic /
        // already-released pointers (same as the pan surface).
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        e.stopPropagation();
        fire(e);
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        e.stopPropagation();
        e.currentTarget.releasePointerCapture(e.pointerId);
        dragging.current = false;
        onHover(false);
      }}
    />
  );
}

export interface MarkerProps {
  /** x position in axis units — epoch ms on a time axis, the value on a value
   *  axis. (The generalisation of the mockup's "time line": a mark at an x, time
   *  or value.) */
  at: number;
  /** Chip label; omit to auto-label with the shared x formatter (the axis's). */
  label?: string;
  /** Controlled selection — brightens + shows the centre handle. */
  selected?: boolean;
  /** Make the marker **editable**: a centre handle appears and dragging it reports
   *  the new `at` (controlled — wire it back to `at`). The whole line moves. */
  onChange?: (at: number) => void;
}

/** A vertical line at an x position (a time, a distance, a lap boundary). */
export function Marker({ at, label, selected = false, onChange }: MarkerProps) {
  const { container, row, ann } = useAnnotationFrame('Marker');
  const [hovering, setHovering] = useState(false);
  const editable = onChange !== undefined;
  const x = container.xScale(at);
  const h = row.height;
  const state: AnnotationState = hovering
    ? 'hover'
    : selected
      ? 'selected'
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
        {/* One handle, centred — a marker moves as a whole (two ends would read
            as independently draggable, and collide with the top label). */}
        {editable ? (
          <DragHandle
            cx={x}
            cy={h / 2}
            w={HANDLE_SHORT}
            h={HANDLE_LONG}
            color={ann.color}
            cursor="ew-resize"
            onHover={setHovering}
            onDrag={(px) => onChange?.(+container.xScale.invert(px))}
          />
        ) : selected ? (
          <rect
            x={x - HANDLE_SHORT / 2}
            y={h / 2 - HANDLE_LONG / 2}
            width={HANDLE_SHORT}
            height={HANDLE_LONG}
            rx={3}
            fill={ann.color}
          />
        ) : null}
      </svg>
      <Chip
        theme={container.theme}
        color={ann.color}
        style={{
          top: `${FLAG_TOP}px`,
          ...flagChipX(x, container.plotWidth),
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
  /** Controlled selection — brightens + shows the handle. */
  selected?: boolean;
  /** Make the baseline **editable**: a handle appears and dragging it (vertically)
   *  reports the new `value` (controlled — wire it back to `value`). */
  onChange?: (value: number) => void;
}

/** A horizontal line at a y value, scaled against one row axis (RTC's `Baseline`).
 *  Its label anchors at the left, at the line's height (a horizontal line has no
 *  vertical staff to fly a flag from). */
export function Baseline({
  value,
  axis,
  label,
  selected = false,
  onChange,
}: BaselineProps) {
  const { container, row, ann } = useAnnotationFrame('Baseline');
  const [hovering, setHovering] = useState(false);
  const editable = onChange !== undefined;
  const axisId = axis ?? row.defaultAxisId;
  const yScale = row.yScales.get(axisId);
  // The axis may not have resolved yet (a layer mounts before its <YAxis>); skip
  // until its scale exists rather than guessing a domain.
  if (yScale === undefined) return null;
  const y = yScale(value);
  const w = container.plotWidth;
  const state: AnnotationState = hovering
    ? 'hover'
    : selected
      ? 'selected'
      : 'rest';
  const fmt = row.formats.get(axisId);
  const text = label ?? (fmt ? fmt(value) : String(value));
  // Grab handle near the right end (clears the left-anchored label), horizontal
  // pill since the drag is vertical.
  const handleX = w - 14;
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
        {editable ? (
          <DragHandle
            cx={handleX}
            cy={y}
            w={HANDLE_LONG}
            h={HANDLE_SHORT}
            color={ann.color}
            cursor="ns-resize"
            onHover={setHovering}
            onDrag={(_px, py) => onChange?.(yScale.invert(py))}
          />
        ) : selected ? (
          <rect
            x={handleX - HANDLE_LONG / 2}
            y={y - HANDLE_SHORT / 2}
            width={HANDLE_LONG}
            height={HANDLE_SHORT}
            rx={3}
            fill={ann.color}
          />
        ) : null}
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
  /** Make the region **editable**: each edge gets a handle that drags
   *  independently, reporting the new `{ from, to }` (controlled). */
  onChange?: (next: { from: number; to: number }) => void;
}

/** A shaded span over an x range — a lap, a zone, a selected interval. Its label
 *  flies as a flag off the left edge. */
export function Region({
  from,
  to,
  label,
  selected = false,
  onChange,
}: RegionProps) {
  const { container, row, ann } = useAnnotationFrame('Region');
  const [hovering, setHovering] = useState(false);
  const editable = onChange !== undefined;
  const xa = container.xScale(from);
  const xb = container.xScale(to);
  const left = Math.min(xa, xb);
  const spanW = Math.abs(xb - xa);
  const h = row.height;
  const state: AnnotationState = hovering
    ? 'hover'
    : selected
      ? 'selected'
      : 'rest';
  // The fill stays subtle so the data reads through; it lifts with attention.
  const fillOpacity =
    ann.fillOpacity *
    (state === 'selected' ? 1.6 : state === 'hover' ? 1.3 : 1);
  const text =
    label ?? `${container.formatTime(from)}–${container.formatTime(to)}`;
  // Edges + handles sit at the actual from/to positions (not sorted), so the
  // from-handle always drives `from` even if the user drags it past `to`.
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
        {edge(xa)}
        {edge(xb)}
        {editable ? (
          <>
            <DragHandle
              cx={xa}
              cy={h / 2}
              w={HANDLE_SHORT}
              h={HANDLE_LONG}
              color={ann.color}
              cursor="ew-resize"
              onHover={setHovering}
              onDrag={(px) =>
                onChange?.({ from: +container.xScale.invert(px), to })
              }
            />
            <DragHandle
              cx={xb}
              cy={h / 2}
              w={HANDLE_SHORT}
              h={HANDLE_LONG}
              color={ann.color}
              cursor="ew-resize"
              onHover={setHovering}
              onDrag={(px) =>
                onChange?.({ from, to: +container.xScale.invert(px) })
              }
            />
          </>
        ) : selected ? (
          <>
            <rect
              x={xa - HANDLE_SHORT / 2}
              y={h / 2 - HANDLE_LONG / 2}
              width={HANDLE_SHORT}
              height={HANDLE_LONG}
              rx={3}
              fill={ann.color}
            />
            <rect
              x={xb - HANDLE_SHORT / 2}
              y={h / 2 - HANDLE_LONG / 2}
              width={HANDLE_SHORT}
              height={HANDLE_LONG}
              rx={3}
              fill={ann.color}
            />
          </>
        ) : null}
      </svg>
      <Chip
        theme={container.theme}
        color={ann.color}
        style={{
          top: `${FLAG_TOP}px`,
          ...flagChipX(left, container.plotWidth),
        }}
      >
        {text}
      </Chip>
    </>
  );
}
