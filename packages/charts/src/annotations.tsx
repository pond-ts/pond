import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  ContainerContext,
  RowContext,
  type AnnotationSpec,
  type ContainerFrame,
} from './context.js';
import type { ChartTheme } from './theme.js';
import { flagChipStyle, flagChipX } from './chip.js';
import { useSlotKey } from './use-slot-key.js';

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
 * mark sits at `rest`, lifts to `hover`, and shows `selected`.
 *
 * **Editing.** Give a mark an `onChange` *and* put the container in
 * {@link ContainerFrame.editAnnotations | edit mode} (`<ChartContainer
 * editAnnotations>`): the data cursor steps aside, hovering the mark highlights it
 * + reveals its handles, and dragging edits it (controlled — wire `onChange` back
 * to the position prop). A `<Region>` body drags to **move** (hand cursor); its
 * edges **resize** (`ew-resize`). Each interactive area **claims the gesture**
 * (pointer capture + `stopPropagation`), so grabbing a mark never starts a pan.
 * Outside edit mode the overlay is pointer-inert and `selected` shows static
 * handles. Marks register with the container ({@link ContainerFrame.annotations}),
 * which draws each mark's **guide** across the other rows and lets a drag
 * **snap** to other marks' x-positions. (Cross-region z-order on select is the
 * remaining edit-mode piece.)
 */

/** Fallback when a theme defines no `annotation` token — a neutral turquoise. */
const DEFAULT_ANNOTATION: NonNullable<ChartTheme['annotation']> = {
  color: '#14b8a6',
  fillOpacity: 0.1,
  rest: 0.6,
  hover: 0.82,
  selected: 1,
};

/** Handle-pill geometry (px) — long axis vs short axis. */
const HANDLE_LONG = 18;
const HANDLE_SHORT = 6;
/** How wide a line's invisible grab area is, each side (px). */
const HIT_PAD = 5;
/** How wide a region edge's resize grab area is (px) — sits over the body. */
const EDGE_GRAB = 8;
/** Flag-chip top offset (px from the row top) — shared so labels align. */
const FLAG_TOP = 2;

type AnnotationState = 'rest' | 'hover' | 'selected';

/** The full-plot overlay each annotation paints into — above the data canvas,
 *  below the cursor. Inert to the pointer by default; an edit-mode hit area opts
 *  back in to `pointerEvents: auto` for itself only. */
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

/** Register this annotation with the container (so it can draw the mark's guide on
 *  other rows, order regions, and serve snap targets), keyed by the caller's stable
 *  per-instance slot key; unregister on unmount. `xs` should be memoised by the
 *  caller so the effect only re-runs when the position actually moves. */
function useRegisterAnnotation(
  container: ContainerFrame,
  key: symbol,
  rowKey: symbol,
  kind: AnnotationSpec['kind'],
  xs: readonly number[],
  selected: boolean,
) {
  const { registerAnnotation, unregisterAnnotation } = container;
  useEffect(() => () => unregisterAnnotation(key), [unregisterAnnotation, key]);
  useEffect(() => {
    registerAnnotation(key, { key, kind, rowKey, xs, selected });
  }, [registerAnnotation, key, kind, rowKey, xs, selected]);
}

/** Pixel radius within which a drag snaps to a guideline (another mark's x). */
const SNAP_PX = 6;

/**
 * Snap a dragged plot-pixel `px` to the nearest **guideline** — another
 * annotation's x — within {@link SNAP_PX}. Returns that guideline's **axis** value
 * to snap to, or `null` if none is near (the caller keeps the raw position).
 * Excludes the dragging mark's own `key`, and reads the same registry the guides
 * draw from, so a drag visibly clicks onto the lines you can see.
 */
function snapToGuides(
  container: ContainerFrame,
  selfKey: symbol,
  px: number,
): number | null {
  let best: number | null = null;
  let bestDist = SNAP_PX;
  for (const a of container.annotations) {
    if (a.key === selfKey) continue;
    for (const tx of a.xs) {
      const d = Math.abs(container.xScale(tx) - px);
      if (d < bestDist) {
        bestDist = d;
        best = tx;
      }
    }
  }
  return best;
}

/** A label chip — the cursor value flag's shape (shared {@link flagChipStyle}:
 *  filled, no outline) with text in the annotation register. */
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

/** A non-interactive handle pill, shown on hover (edit mode) / when selected. */
function Pill({
  cx,
  cy,
  w,
  h,
  color,
}: {
  cx: number;
  cy: number;
  w: number;
  h: number;
  color: string;
}) {
  return (
    <rect
      x={cx - w / 2}
      y={cy - h / 2}
      width={w}
      height={h}
      rx={3}
      fill={color}
      style={{ pointerEvents: 'none' }}
    />
  );
}

/**
 * A transparent hit rect that drives an edit interaction: it reports the pointer's
 * **plot-pixel** position on press (`onDragStart`) and each move (`onDrag`),
 * **claims the gesture** (`stopPropagation` + guarded pointer capture) so it never
 * starts a pan, and toggles the annotation's hover (`onHover`). Rendered only in
 * edit mode; the rest of the overlay stays pointer-inert.
 */
function DragArea({
  x,
  y,
  w,
  h,
  cursor,
  onHover,
  onDragStart,
  onDrag,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  cursor: string;
  onHover: (hovering: boolean) => void;
  onDragStart?: (px: number, py: number) => void;
  onDrag: (px: number, py: number) => void;
}) {
  const dragging = useRef(false);
  const at = (e: ReactPointerEvent): [number, number] => {
    const svg = (e.currentTarget as SVGElement).ownerSVGElement;
    if (svg === null) return [0, 0];
    const r = svg.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  return (
    <rect
      x={x}
      y={y}
      width={Math.max(w, 1)}
      height={Math.max(h, 1)}
      fill="transparent"
      style={{ pointerEvents: 'auto', cursor }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => {
        if (!dragging.current) onHover(false);
      }}
      onPointerDown={(e) => {
        e.stopPropagation(); // claim the gesture — don't let the plot start a pan
        dragging.current = true;
        const [px, py] = at(e);
        onDragStart?.(px, py);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore (synthetic / already-released pointer) */
        }
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        e.stopPropagation();
        const [px, py] = at(e);
        onDrag(px, py);
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        e.stopPropagation();
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
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
  /** Controlled selection — brightens; shows the handle outside edit mode. */
  selected?: boolean;
  /** Make the marker **editable** (in edit mode): dragging its line reports the
   *  new `at` (controlled — wire it back to `at`). The whole line moves. */
  onChange?: (at: number) => void;
}

/** A vertical line at an x position (a time, a distance, a lap boundary). */
export function Marker({ at, label, selected = false, onChange }: MarkerProps) {
  const { container, row, ann } = useAnnotationFrame('Marker');
  const selfKey = useSlotKey();
  const [hovering, setHovering] = useState(false);
  const editing = container.editAnnotations && onChange !== undefined;
  const xs = useMemo(() => [at], [at]);
  useRegisterAnnotation(container, selfKey, row.rowKey, 'marker', xs, selected);
  const x = container.xScale(at);
  const h = row.height;
  const state: AnnotationState = hovering
    ? 'hover'
    : selected
      ? 'selected'
      : 'rest';
  const showHandle = editing ? hovering : selected;
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
        {showHandle && (
          <Pill
            cx={x}
            cy={h / 2}
            w={HANDLE_SHORT}
            h={HANDLE_LONG}
            color={ann.color}
          />
        )}
        {editing && (
          <DragArea
            x={x - HIT_PAD}
            y={0}
            w={2 * HIT_PAD}
            h={h}
            cursor="ew-resize"
            onHover={setHovering}
            onDrag={(px) =>
              onChange?.(
                snapToGuides(container, selfKey, px) ??
                  +container.xScale.invert(px),
              )
            }
          />
        )}
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
  /** Controlled selection — brightens; shows the handle outside edit mode. */
  selected?: boolean;
  /** Make the baseline **editable** (in edit mode): dragging it vertically reports
   *  the new `value` (controlled — wire it back to `value`). */
  onChange?: (value: number) => void;
}

/** A horizontal line at a y value, scaled against one row axis (RTC's `Baseline`).
 *  Its label anchors at the left, at the line's height. */
export function Baseline({
  value,
  axis,
  label,
  selected = false,
  onChange,
}: BaselineProps) {
  const { container, row, ann } = useAnnotationFrame('Baseline');
  const selfKey = useSlotKey();
  const [hovering, setHovering] = useState(false);
  const editing = container.editAnnotations && onChange !== undefined;
  // A horizontal line casts no vertical guide — register with no xs (still
  // tracked for ordering / future use). No snap target either (the guidelines are
  // vertical; a baseline drags vertically).
  const xs = useMemo<number[]>(() => [], []);
  useRegisterAnnotation(
    container,
    selfKey,
    row.rowKey,
    'baseline',
    xs,
    selected,
  );
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
  const showHandle = editing ? hovering : selected;
  const fmt = row.formats.get(axisId);
  const text = label ?? (fmt ? fmt(value) : String(value));
  // Handle pill near the right end (clears the left-anchored label).
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
        {showHandle && (
          <Pill
            cx={handleX}
            cy={y}
            w={HANDLE_LONG}
            h={HANDLE_SHORT}
            color={ann.color}
          />
        )}
        {editing && (
          <DragArea
            x={0}
            y={y - HIT_PAD}
            w={w}
            h={2 * HIT_PAD}
            cursor="ns-resize"
            onHover={setHovering}
            onDrag={(_px, py) => onChange?.(yScale.invert(py))}
          />
        )}
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
  /** Controlled selection — brightens; shows edge handles outside edit mode. */
  selected?: boolean;
  /** Make the region **editable** (in edit mode): drag the body to move it (both
   *  edges shift), drag an edge to resize. Reports the new `{ from, to }`. */
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
  const selfKey = useSlotKey();
  const [hovering, setHovering] = useState(false);
  const editing = container.editAnnotations && onChange !== undefined;
  const xs = useMemo(() => [from, to], [from, to]);
  useRegisterAnnotation(container, selfKey, row.rowKey, 'region', xs, selected);
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
  const showHandles = editing ? hovering : selected;
  // The fill stays subtle so the data reads through; it lifts with attention.
  const fillOpacity =
    ann.fillOpacity *
    (state === 'selected' ? 1.6 : state === 'hover' ? 1.3 : 1);
  const text =
    label ?? `${container.formatTime(from)}–${container.formatTime(to)}`;
  // Body move-drag tracks the previous pointer x to apply an incremental delta to
  // both edges (so the region follows the pointer, keeping the grab offset).
  const lastPx = useRef(0);
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
        {showHandles && (
          <>
            <Pill
              cx={xa}
              cy={h / 2}
              w={HANDLE_SHORT}
              h={HANDLE_LONG}
              color={ann.color}
            />
            <Pill
              cx={xb}
              cy={h / 2}
              w={HANDLE_SHORT}
              h={HANDLE_LONG}
              color={ann.color}
            />
          </>
        )}
        {editing && (
          <>
            {/* Body (move both edges) — rendered first, under the edge areas. */}
            <DragArea
              x={left}
              y={0}
              w={spanW}
              h={h}
              cursor="grab"
              onHover={setHovering}
              onDragStart={(px) => {
                lastPx.current = px;
              }}
              onDrag={(px) => {
                const d =
                  +container.xScale.invert(px) -
                  +container.xScale.invert(lastPx.current);
                lastPx.current = px;
                let nf = from + d;
                let nt = to + d;
                // Snap whichever edge lands near a guideline, keeping the width.
                const sf = snapToGuides(
                  container,
                  selfKey,
                  container.xScale(nf),
                );
                const st = snapToGuides(
                  container,
                  selfKey,
                  container.xScale(nt),
                );
                if (sf !== null) {
                  nt += sf - nf;
                  nf = sf;
                } else if (st !== null) {
                  nf += st - nt;
                  nt = st;
                }
                onChange?.({ from: nf, to: nt });
              }}
            />
            {/* Edges (resize) — on top, so a grab near an edge resizes it. */}
            <DragArea
              x={xa - EDGE_GRAB / 2}
              y={0}
              w={EDGE_GRAB}
              h={h}
              cursor="ew-resize"
              onHover={setHovering}
              onDrag={(px) =>
                onChange?.({
                  from:
                    snapToGuides(container, selfKey, px) ??
                    +container.xScale.invert(px),
                  to,
                })
              }
            />
            <DragArea
              x={xb - EDGE_GRAB / 2}
              y={0}
              w={EDGE_GRAB}
              h={h}
              cursor="ew-resize"
              onHover={setHovering}
              onDrag={(px) =>
                onChange?.({
                  from,
                  to:
                    snapToGuides(container, selfKey, px) ??
                    +container.xScale.invert(px),
                })
              }
            />
          </>
        )}
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
