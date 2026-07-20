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
  type LabelPlacement,
} from './context.js';
import type { ChartTheme } from './theme.js';
import { flagChipStyle, flagChipX, axisPillX, axisPillStyle } from './chip.js';
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
 * **flag** (the cursor value flag's shape). **Brightness encodes depth** — a mark
 * draws at one of three {@link ChartTheme.annotation | depth} levels (forward =
 * brightest); `selectable={false}` pins it at the back as inert context.
 *
 * **Three interaction modes** (all controlled — the consumer holds the ids):
 * - **Inspect-select** (any mode): a single click selects a mark
 *   ({@link ContainerFrame.onSelectAnnotation}); `hovered`/`onHoverAnnotation` sync
 *   hover both ways (e.g. with a legend); both come **forward** (selected = level 1,
 *   hover = level 2).
 * - **Single-annotation edit** (any mode): a double-click requests edit of just that
 *   mark ({@link ContainerFrame.onEditAnnotation}); the consumer sets its `editing`
 *   prop → it gains always-on handles and becomes draggable while the rest stay
 *   static. An empty plot click exits (fires `onSelectAnnotation(null)`).
 * - **Global edit** ({@link ContainerFrame.editAnnotations}): the data cursor steps
 *   aside and *every* mark with an `onChange` is editable, handles on hover; armed
 *   {@link ContainerFrame.creating | create tools} draw new marks.
 *
 * Editing is controlled: a `<Region>` body drags to **move**, its edges **resize**;
 * a `<Marker>`/`<Baseline>` drags whole — each reports via `onChange`. An edit hit
 * area **claims the gesture** (pointer capture + `stopPropagation`) so a drag never
 * starts a pan. Marks register with the container
 * ({@link ContainerFrame.annotations}), which draws each mark's **guide** across the
 * other rows and lets a drag **snap** to other marks' x-positions.
 */

/** Fallback when a theme defines no `annotation` token — a neutral turquoise. */
const DEFAULT_ANNOTATION: NonNullable<ChartTheme['annotation']> = {
  color: '#14b8a6',
  fillOpacity: 0.1,
  depth: [1, 0.7, 0.4],
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

/** Depth level (1 = forward/brightest … 3 = back/dimmest) → an index into the
 *  theme's `depth` ramp. Brighter reads as more forward, i.e. more attention.
 *
 *  A mark's LINES (marker/baseline line, region edges) and a region's BODY fill
 *  can sit at different levels: in edit mode the lines come fully forward (level
 *  1) while a region body stays one step back (level 2), so the edges read as the
 *  grabbable thing. A non-`selectable` mark is inert background context — always
 *  level 3, ignoring hover + selection. */
function lineLevel(
  selectable: boolean,
  editing: boolean,
  hovering: boolean,
  selected: boolean,
): 1 | 2 | 3 {
  if (!selectable) return 3;
  if (selected) return 1;
  if (editing) return 1; // edit mode brings the structural lines forward
  if (hovering) return 2;
  return 3;
}

/** Region body-fill level — like {@link lineLevel} but one step back in edit mode. */
function bodyLevel(
  selectable: boolean,
  editing: boolean,
  hovering: boolean,
  selected: boolean,
): 1 | 2 | 3 {
  if (!selectable) return 3;
  if (selected) return 1;
  if (editing || hovering) return 2;
  return 3;
}

/** Region body-fill opacity multiplier by depth level (the fill is subtle so the
 *  data reads through; it lifts as the region comes forward). */
const FILL_MULT = [1.6, 1.3, 1] as const;

/** Pick the value for a depth level (1–3) from a three-stop ramp. Indexes by a
 *  literal so the lookup is total (no out-of-range `undefined`). */
function rampAt(
  ramp: readonly [number, number, number],
  level: 1 | 2 | 3,
): number {
  return level === 1 ? ramp[0] : level === 2 ? ramp[1] : ramp[2];
}

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
  id: string | undefined,
  rowKey: symbol,
  kind: AnnotationSpec['kind'],
  xs: readonly number[],
  selected: boolean,
  selectable: boolean,
  editing: boolean,
  label: string,
  indicator: boolean,
) {
  const { registerAnnotation, unregisterAnnotation } = container;
  useEffect(() => () => unregisterAnnotation(key), [unregisterAnnotation, key]);
  useEffect(() => {
    registerAnnotation(key, {
      key,
      id,
      kind,
      rowKey,
      xs,
      selected,
      selectable,
      editing,
      label,
      indicator,
    });
  }, [
    registerAnnotation,
    key,
    id,
    kind,
    rowKey,
    xs,
    selected,
    selectable,
    editing,
    label,
    indicator,
  ]);
}

/** Vertical px between stacked label lanes. */
const LANE_H = 22;
/** Rough chip-width model for overlap detection (monospace-ish: chars × width +
 *  padding) and the min px gap kept between two labels sharing a lane. */
const LABEL_CHAR_W = 7;
const LABEL_PAD = 16;
const LANE_GAP = 6;

/** Rough chip width (px) for the overlap model. */
const labelWidth = (text: string) => text.length * LABEL_CHAR_W + LABEL_PAD;

/**
 * Lane placement for the **top-flag** labels (markers + regions). Returns, per
 * slot key, its {@link LabelPlacement}. Baselines (label anchored at their own y)
 * don't participate.
 *
 * Three behaviours:
 * - **Per row** — labels only contend within their own row's top space (a
 *   bottom-row label at the same x as a top-row one isn't "in the way").
 * - **Coincident markers merge** — labelled markers at the *same x* (e.g. dragged
 *   together, snapped onto one line) fold into a **single** chip (`"z1, z2, max"`)
 *   on one lane, rather than stacking three deep. The first is the representative
 *   (its `label` is the joined text); the rest map to `label: null`.
 * - **Greedy stacking** — non-coincident labels that would still overlap drop to
 *   the next free lane. The `draggingKey` is excluded (pinned to lane 0, its own
 *   label) so the static labels hold their lanes as it crosses them.
 */
export function computeLabelLanes(
  annotations: readonly AnnotationSpec[],
  toPixel: (axisX: number) => number,
  draggingKey?: symbol | null,
  plotWidth?: number,
): Map<symbol, LabelPlacement> {
  const out = new Map<symbol, LabelPlacement>();
  const byRow = new Map<symbol, AnnotationSpec[]>();
  for (const a of annotations) {
    if (
      (a.kind !== 'marker' && a.kind !== 'region') ||
      a.label.length === 0 ||
      a.xs.length === 0
    )
      continue;
    const arr = byRow.get(a.rowKey);
    if (arr) arr.push(a);
    else byRow.set(a.rowKey, [a]);
  }
  for (const specs of byRow.values()) {
    // A flag is one chip to place: a region, the dragged marker (both stand
    // alone), or a group of coincident markers merged into one.
    type Flag = {
      rep: symbol;
      members: symbol[];
      left: number;
      width: number;
      label: string;
    };
    const flags: Flag[] = [];
    const markerGroups = new Map<number, AnnotationSpec[]>();
    for (const a of specs) {
      if (a.kind === 'marker' && a.key !== draggingKey) {
        const g = markerGroups.get(a.xs[0]!);
        if (g) g.push(a);
        else markerGroups.set(a.xs[0]!, [a]);
      } else {
        // Lane-pack at the position the chip will *render*: a region panned
        // half off-plot renders clamped to the plot's left edge, and a fully
        // off-plot region's chip is culled — so it must not hold a lane.
        const ax =
          a.kind === 'region' ? Math.min(a.xs[0]!, a.xs[1]!) : a.xs[0]!;
        const bx =
          a.kind === 'region' ? Math.max(a.xs[0]!, a.xs[1]!) : a.xs[0]!;
        const rawLeft = toPixel(ax);
        if (plotWidth !== undefined && (rawLeft > plotWidth || toPixel(bx) < 0))
          continue;
        flags.push({
          rep: a.key,
          members: [a.key],
          left: plotWidth === undefined ? rawLeft : Math.max(rawLeft, 0),
          width: labelWidth(a.label),
          label: a.label,
        });
      }
    }
    for (const [x, group] of markerGroups) {
      // A culled off-plot marker chip must not hold a lane either.
      const px = toPixel(x);
      if (plotWidth !== undefined && (px < 0 || px > plotWidth)) continue;
      const label = group.map((g) => g.label).join(', ');
      flags.push({
        rep: group[0]!.key,
        members: group.map((g) => g.key),
        left: px,
        width: labelWidth(label),
        label,
      });
    }
    const assign = (f: Flag, lane: number) => {
      out.set(f.rep, { lane, label: f.label });
      for (const m of f.members)
        if (m !== f.rep) out.set(m, { lane, label: null });
    };
    // Greedy-pack the static flags; the dragged one is pinned to lane 0.
    const dragged = flags.filter(
      (f) => f.members.length === 1 && f.members[0] === draggingKey,
    );
    flags
      .filter((f) => !dragged.includes(f))
      .sort((p, q) => p.left - q.left)
      .reduce((laneEnds: number[], f) => {
        let lane = 0;
        while (lane < laneEnds.length && laneEnds[lane]! + LANE_GAP > f.left)
          lane += 1;
        laneEnds[lane] = f.left + f.width;
        assign(f, lane);
        return laneEnds;
      }, []);
    for (const f of dragged) assign(f, 0);
  }
  return out;
}

/** A mark's hover state, synced both ways with the consumer. The effective hover
 *  is the local pointer hover **OR** the controlled `hovered` prop (so a legend row
 *  can light the mark remotely); `reportHover` mirrors local pointer enter/leave out
 *  to {@link ContainerFrame.onHoverAnnotation} by `id` (so the mark can light the
 *  legend). A mark with no `id` keeps its hover purely local. */
function useAnnotationHover(
  container: ContainerFrame,
  id: string | undefined,
  hovered: boolean | undefined,
) {
  const [selfHover, setSelfHover] = useState(false);
  const hovering = selfHover || hovered === true;
  const reportHover = (h: boolean) => {
    setSelfHover(h);
    if (id !== undefined) container.onHoverAnnotation?.(h ? id : null);
  };
  return { hovering, reportHover };
}

/** Pixel radius within which a drag snaps to a guideline (another mark's x). */
const SNAP_PX = 6;

/**
 * Snap a dragged plot-pixel `px` to the nearest **guideline** within
 * {@link SNAP_PX} — another annotation's x, **or** a trading-axis **disjoint
 * boundary** (a session collapse point). Returns the **axis** value to snap to,
 * or `null` if none is near (the caller keeps the raw position). Excludes the
 * dragging mark's own `key`, and reads the same registry the guides draw from,
 * so a drag visibly clicks onto the lines you can see.
 *
 * At a disjoint boundary the close and the next open share a pixel, so the value
 * depends on which side of it the pointer is on (see below). Nearest-pixel wins
 * across both kinds of target, so an annotation sitting *exactly* on a boundary
 * open ties and — processed first — takes it (its own guideline), which is the
 * same instant the right-side heuristic would pick anyway.
 */
export function snapToGuides(
  container: ContainerFrame,
  selfKey: symbol,
  px: number,
): number | null {
  // The container's snap toggle gates guideline snapping — off ⇒ the drag keeps
  // its raw position (no clicking onto neighbours).
  if (!container.snap) return null;
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
  // Disjoint boundaries: on a trading-time axis a session close and the next
  // open collapse to the **same pixel**, so a boundary is one snap target with
  // two possible instants. Snap to the one on the side of the boundary the
  // pointer is on — left of it → the pre-gap edge (the previous session's
  // *close*, `clampDown` out of the gap); at/right of it → the post-gap *open*.
  const disc = container.discontinuities;
  if (disc?.boundaries) {
    const [d0, d1] = container.timeRange;
    for (const open of disc.boundaries(d0, d1)) {
      const bpx = container.xScale(open);
      const d = Math.abs(bpx - px);
      if (d < bestDist) {
        bestDist = d;
        best = px < bpx ? disc.clampDown(open - 1) : open;
      }
    }
  }
  return best;
}

/**
 * Order two region bounds so `from ≤ to`. A region **edge resize** pivots around
 * the *opposite* (fixed) edge: the dragged value `v` and the pivot are ordered
 * here, so dragging an edge past the pivot never emits an inverted span — instead
 * the edges meet (zero width) and a continued drag **re-opens the region the other
 * way** (the grabbed handle becomes the far edge). The pivot is captured at
 * drag-start (a ref) so it stays fixed even as the emitted bounds swap on cross.
 */
export function orderRegion(
  v: number,
  pivot: number,
): { from: number; to: number } {
  return v <= pivot ? { from: v, to: pivot } : { from: pivot, to: v };
}

/** The slice of a scale a rigid pixel-move needs: value → pixel and back.
 *  `invert` may return a `Date` (a d3 `scaleTime`) — the move coerces with `+`. */
interface InvertibleScale {
  (value: number): number;
  invert(pixel: number): number | Date;
}

/**
 * Translate a region's `[from, to]` by `dpx` **plot-pixels** through `scale`, so
 * the box moves rigidly in *pixel* space — each edge's pixel position shifts by
 * the same `dpx`, then inverts back to an axis value.
 *
 * This is the move that stays correct on a **discontinuous** (trading-time) axis:
 * a shared *value* delta (`from + Δt`) would move the two edges by unequal pixels
 * when they sit in different gap-contexts, distorting the box as it crosses a
 * collapsed gap. On a continuous (affine) scale it is identical to the value-delta
 * move, so this is a no-op there.
 */
export function moveRegionByPixels(
  scale: InvertibleScale,
  from: number,
  to: number,
  dpx: number,
): { from: number; to: number } {
  return {
    from: +scale.invert(scale(from) + dpx),
    to: +scale.invert(scale(to) + dpx),
  };
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
 * A transparent hit rect over a selectable mark. It **always** reports hover
 * (`onHover`, → level 2 even with edit off), and a **single click that didn't drag
 * selects** the mark (`onSelect`) in *any* mode — the inspect-select — while a
 * **double-click edits** it (`onEdit` — the consumer flips it into single-annotation
 * edit). Both clicks `stopPropagation` so they never reach the plot's data-select /
 * deselect. Only when `editable` does it claim the drag gesture (`stopPropagation` +
 * guarded pointer capture, so a drag never starts a pan) and report the pointer's
 * **plot-pixel** position on press (`onDragStart`) / move (`onDrag`). With editing
 * off, press / move bubble so a pan reads straight through.
 */
function DragArea({
  x,
  y,
  w,
  h,
  cursor,
  editable,
  onHover,
  onSelect,
  onEdit,
  onDragStart,
  onDrag,
  onDragActive,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  cursor: string;
  /** Whether this rect is an active **edit** surface (claims the drag gesture).
   *  Select (click) + edit (double-click) fire regardless; this gates dragging. */
  editable: boolean;
  onHover: (hovering: boolean) => void;
  /** A click (press + release without a real drag) selects the mark — any mode. */
  onSelect?: (() => void) | undefined;
  /** A double-click requests single-annotation edit of this mark — any mode. */
  onEdit?: (() => void) | undefined;
  onDragStart?: (px: number, py: number) => void;
  onDrag: (px: number, py: number) => void;
  /** Called `true` when a drag begins (press on an editable surface), `false` on
   *  release/cancel — so the container can exclude this mark from lane packing. */
  onDragActive?: (active: boolean) => void;
}) {
  const dragging = useRef(false);
  // Tracks whether this press became a drag (moved past a few px) — a click that
  // didn't drag selects instead of edits. Tracked in *both* modes so a pan-drag
  // started on the mark (edit off) doesn't fire a spurious select on release.
  const moved = useRef(false);
  const downAt = useRef<[number, number] | null>(null);
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
        const p = at(e);
        moved.current = false;
        downAt.current = p; // tracked in both modes for the click/drag guard
        if (!editable) return; // edit off: let it bubble (pan reads through)
        e.stopPropagation(); // claim the gesture — don't let the plot start a pan
        dragging.current = true;
        onDragActive?.(true);
        onDragStart?.(p[0], p[1]);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore (synthetic / already-released pointer) */
        }
      }}
      onPointerMove={(e) => {
        const [px, py] = at(e);
        const d = downAt.current;
        if (d !== null && Math.hypot(px - d[0], py - d[1]) > 3) {
          moved.current = true;
        }
        if (!editable || !dragging.current) return;
        e.stopPropagation();
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
        onDragActive?.(false);
        onHover(false);
      }}
      // A system gesture takeover fires pointercancel, not pointerup — clear the
      // same drag/hover state so the mark doesn't stay stuck "grabbed".
      onPointerCancel={(e) => {
        if (!dragging.current) return;
        onDragActive?.(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        dragging.current = false;
        onHover(false);
      }}
      // Click (no drag) selects; double-click edits. Stop both so a mark click
      // never reaches the plot's data-select / deselect.
      onClick={(e) => {
        e.stopPropagation();
        if (!moved.current) onSelect?.();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onEdit?.();
      }}
    />
  );
}

export interface MarkerProps {
  /** x position in axis units — epoch ms on a time axis, the value on a value
   *  axis. (The generalisation of the mockup's "time line": a mark at an x, time
   *  or value.) */
  at: number;
  /** Chip label. Omit to auto-label with the shared x formatter (the axis's);
   *  pass `false` (or `''`) to render **no label chip** — for an inert background
   *  mark you don't want labelled (where the auto-label would just show a raw
   *  axis value). */
  label?: string | false;
  /** Stable consumer id — a click reports it via the container's
   *  `onSelectAnnotation`, so the consumer can track which mark is selected. */
  id?: string;
  /** Controlled selection — brightens to the front (level 1). Handles are an
   *  edit-mode hover affordance, not a selection cue. Ignored if not `selectable`. */
  selected?: boolean;
  /** Whether the mark responds to hover + selection (default `true`). When
   *  `false` it's inert background context — drawn at the back (level 3) always,
   *  no hover, no select, no edit. */
  selectable?: boolean;
  /** Controlled hover (OR'd with pointer hover) — lets a legend row light the mark
   *  remotely. Pair with the container's `onHoverAnnotation` to sync both ways. */
  hovered?: boolean;
  /** When `true`, this mark is in **single-annotation edit** (the double-click
   *  target): handles stay out, it's draggable, and it reads as level 1 — while
   *  other marks stay static. Independent of the container's global
   *  `editAnnotations`. Pair with `onEditAnnotation` (the consumer holds an
   *  `editingId` and sets `editing={editingId === id}`). */
  editing?: boolean;
  /** Make the marker **editable** (in edit mode): dragging its line reports the
   *  new `at` (controlled — wire it back to `at`). The whole line moves. */
  onChange?: (at: number) => void;
  /** Also pin this marker's **time** to the **x-axis** as an on-axis pill (drawn
   *  by `<XAxis>` at `at`, in the annotation colour) — the axis-edge counterpart
   *  of the near-line chip. Default `false`. The pill always shows the formatted
   *  `at` (the axis coordinate), never the custom `label` (which stays the
   *  near-line chip) — an indicator reads like a tick. A connector links the
   *  marker line to its pill. */
  indicator?: boolean;
}

/** A vertical line at an x position (a time, a distance, a lap boundary). */
export function Marker({
  at,
  label,
  id,
  selected = false,
  selectable = true,
  hovered,
  editing = false,
  onChange,
  indicator = false,
}: MarkerProps) {
  const { container, row, ann } = useAnnotationFrame('Marker');
  const selfKey = useSlotKey();
  const { hovering, reportHover } = useAnnotationHover(container, id, hovered);
  // Draggable right now: global edit mode OR this mark's single-edit flag, and no
  // tool armed, and it has an onChange to report to.
  const editable =
    (container.editAnnotations || editing) &&
    container.creating === null &&
    onChange !== undefined;
  const xs = useMemo(() => [at], [at]);
  // `label === false` (or '') ⇒ no chip; omitted ⇒ auto-label off the readout
  // channel (else the x label formatter).
  const text =
    label === false
      ? ''
      : (label ?? (container.formatReadout ?? container.formatTime)(at));
  useRegisterAnnotation(
    container,
    selfKey,
    id,
    row.rowKey,
    'marker',
    xs,
    selected,
    selectable,
    editing,
    text,
    indicator,
  );
  // No select/edit while a create tool is armed — the chart is in draw mode then.
  const select =
    id !== undefined && container.creating === null
      ? () => container.onSelectAnnotation?.(id)
      : undefined;
  const edit =
    id !== undefined && container.creating === null
      ? () => container.onEditAnnotation?.(id)
      : undefined;
  const x = container.xScale(at);
  const h = row.height;
  const opacity = rampAt(
    ann.depth,
    lineLevel(selectable, editable, hovering, selected),
  );
  const showHandle = editable && (editing || hovering);
  // Placement decides the lane + the chip text: `chipLabel` is this marker's own
  // label, the merged `"a, b"` when coincident markers fold together, or `null`
  // for a folded-in member (its chip is subsumed by the representative's).
  const placement = container.labelLanes.get(selfKey);
  const lane = placement?.lane ?? 0;
  const chipLabel = placement?.label ?? null;
  // The staff (vertical line) hangs from the top of its flag — so a flag stacked
  // into a lower lane doesn't leave line poking above it. No label ⇒ full height.
  const staffTop = text ? FLAG_TOP + lane * LANE_H : 0;
  return (
    <>
      <svg width={container.plotWidth} height={h} style={overlayStyle}>
        <line
          x1={x}
          y1={staffTop}
          x2={x}
          y2={h}
          stroke={ann.color}
          strokeWidth={1}
          opacity={opacity}
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
        {selectable && (
          <DragArea
            x={x - HIT_PAD}
            y={0}
            w={2 * HIT_PAD}
            h={h}
            cursor={editing ? 'ew-resize' : 'inherit'}
            editable={editable}
            onHover={reportHover}
            onSelect={select}
            onEdit={edit}
            onDragActive={(a) => container.setDragging(a ? selfKey : null)}
            onDrag={(px) =>
              onChange?.(
                snapToGuides(container, selfKey, px) ??
                  +container.xScale.invert(px),
              )
            }
          />
        )}
      </svg>
      {/* The staff is SVG (clipped by the plot's viewport), but the chip is
          DOM — cull it when the pole pans off-plot, or it floats orphaned in
          the axis gutter. */}
      {chipLabel && x >= 0 && x <= container.plotWidth && (
        <Chip
          theme={container.theme}
          color={ann.color}
          style={{
            top: `${FLAG_TOP + lane * LANE_H}px`,
            ...flagChipX(x, container.plotWidth),
          }}
        >
          {chipLabel}
        </Chip>
      )}
    </>
  );
}

export interface BaselineProps {
  /** y value in the linked axis's units. */
  value: number;
  /** Which `<YAxis>` (by id) to measure against; omit for the row's default axis. */
  axis?: string;
  /** Chip label. Omit to format `value` with that axis's formatter; pass `false`
   *  (or `''`) to render **no label chip**. */
  label?: string | false;
  /** Which side of the chart the near-line label chip sits. **Default `left`.** */
  labelSide?: 'left' | 'right';
  /** Where the label chip sits relative to the line: **`center`** (default) rides
   *  on the line, vertically centred; `above` sits just on top of it. */
  labelPosition?: 'center' | 'above';
  /** Stable consumer id — a click reports it via `onSelectAnnotation`. */
  id?: string;
  /** Controlled selection — brightens to the front (level 1). Handles are an
   *  edit-mode hover affordance, not a selection cue. Ignored if not `selectable`. */
  selected?: boolean;
  /** Whether the baseline responds to hover + selection (default `true`). When
   *  `false` it's inert background context — drawn at the back (level 3) always. */
  selectable?: boolean;
  /** Controlled hover (OR'd with pointer hover) — lets a legend row light the mark
   *  remotely. Pair with the container's `onHoverAnnotation` to sync both ways. */
  hovered?: boolean;
  /** When `true`, this mark is in **single-annotation edit** (the double-click
   *  target): handles stay out, it's draggable, and it reads as level 1 — while
   *  other marks stay static. Independent of the container's global
   *  `editAnnotations`. Pair with `onEditAnnotation` (the consumer holds an
   *  `editingId` and sets `editing={editingId === id}`). */
  editing?: boolean;
  /** Make the baseline **editable** (in edit mode): dragging it vertically reports
   *  the new `value` (controlled — wire it back to `value`). */
  onChange?: (value: number) => void;
  /** Also pin this baseline's **value** to its **y-axis** as an on-axis pill (in
   *  the annotation colour) — the axis-edge counterpart of the near-line chip.
   *  Default `false`. The pill always shows the formatted `value` (the axis
   *  coordinate), never the custom `label` (which stays the near-line chip) — an
   *  indicator reads like a tick. */
  indicator?: boolean;
}

/** A horizontal line at a y value, scaled against one row axis (RTC's `Baseline`).
 *  Its label anchors at the left, at the line's height. */
export function Baseline({
  value,
  axis,
  label,
  labelSide = 'left',
  labelPosition = 'center',
  id,
  selected = false,
  selectable = true,
  hovered,
  editing = false,
  onChange,
  indicator = false,
}: BaselineProps) {
  const { container, row, ann } = useAnnotationFrame('Baseline');
  const selfKey = useSlotKey();
  const { hovering, reportHover } = useAnnotationHover(container, id, hovered);
  // Draggable right now: global edit mode OR this mark's single-edit flag, and no
  // tool armed, and it has an onChange to report to.
  const editable =
    (container.editAnnotations || editing) &&
    container.creating === null &&
    onChange !== undefined;
  // A horizontal line casts no vertical guide — register with no xs (still
  // tracked for ordering / future use). No snap target either (the guidelines are
  // vertical; a baseline drags vertically).
  const xs = useMemo<number[]>(() => [], []);
  useRegisterAnnotation(
    container,
    selfKey,
    id,
    row.rowKey,
    'baseline',
    xs,
    selected,
    selectable,
    editing,
    // Baselines don't lane-pack (the label anchors at their y, not the top), so
    // this registered string is unused by `computeLabelLanes` — `|| ''` just
    // keeps it a string for `false`/'' (which mean "no label").
    label || '',
    indicator,
  );
  // No select/edit while a create tool is armed — the chart is in draw mode then.
  const select =
    id !== undefined && container.creating === null
      ? () => container.onSelectAnnotation?.(id)
      : undefined;
  const edit =
    id !== undefined && container.creating === null
      ? () => container.onEditAnnotation?.(id)
      : undefined;
  const axisId = axis ?? row.defaultAxisId;
  const yScale = row.yScales.get(axisId);
  // The axis may not have resolved yet (a layer mounts before its <YAxis>); skip
  // until its scale exists rather than guessing a domain.
  if (yScale === undefined) return null;
  const y = yScale(value);
  const w = container.plotWidth;
  const opacity = rampAt(
    ann.depth,
    lineLevel(selectable, editable, hovering, selected),
  );
  const showHandle = editable && (editing || hovering);
  const fmt = row.formats.get(axisId);
  // `label === false` (or '') ⇒ no chip; omitted ⇒ format `value` off the axis.
  const text =
    label === false ? '' : (label ?? (fmt ? fmt(value) : String(value)));
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
          opacity={opacity}
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
        {selectable && (
          <DragArea
            x={0}
            y={y - HIT_PAD}
            w={w}
            h={2 * HIT_PAD}
            cursor={editing ? 'ns-resize' : 'inherit'}
            editable={editable}
            onHover={reportHover}
            onSelect={select}
            onEdit={edit}
            onDragActive={(a) => container.setDragging(a ? selfKey : null)}
            onDrag={(_px, py) => onChange?.(yScale.invert(py))}
          />
        )}
      </svg>
      {text && (
        <Chip
          theme={container.theme}
          color={ann.color}
          style={{
            top: `${y}px`,
            [labelSide === 'right' ? 'right' : 'left']: '2px',
            // `center` rides on the line; `above` sits its bottom edge on the line.
            transform:
              labelPosition === 'above'
                ? 'translateY(-100%)'
                : 'translateY(-50%)',
          }}
        >
          {text}
        </Chip>
      )}
      {/* The axis-edge value pill (opt-in): the baseline's **value** pinned to
          its y-axis (on the gutter, over the tick), independent of the near-line
          chip. An indicator always shows the axis coordinate (the formatted
          value), never the custom `label` (that stays the near-line chip).
          Clamped inside the row like the y-tick labels (F-charts-6). */}
      {indicator &&
        (() => {
          const half = container.theme.font.size / 2 + 1;
          return (
            <div
              style={{
                ...axisPillStyle(container.theme, ann.color),
                top: `${Math.max(half, Math.min(row.height - half, y))}px`,
                transform: 'translateY(-50%)',
                ...axisPillX(row.axisSides.get(axisId) ?? 'left', w),
              }}
            >
              {fmt ? fmt(value) : String(value)}
            </div>
          );
        })()}
    </>
  );
}

export interface RegionProps {
  /** Start x in axis units (time or value). */
  from: number;
  /** End x in axis units. */
  to: number;
  /** Chip label. Omit to auto-label `from–to` with the shared x formatter; pass
   *  `false` (or `''`) to render **no label chip** — e.g. an inert
   *  `selectable={false}` highlight band, where the auto-label would just show
   *  raw axis values. */
  label?: string | false;
  /** Stable consumer id — a click (or double-click outside edit) reports it via
   *  `onSelectAnnotation`. */
  id?: string;
  /** Controlled selection — brightens to the front (level 1; the body too). Edge
   *  handles are an edit-mode hover affordance, not a selection cue. Ignored if not
   *  `selectable`. */
  selected?: boolean;
  /** Whether the region responds to hover + selection (default `true`). When
   *  `false` it's inert background context — drawn at the back (level 3) always,
   *  and the double-click hit-test skips it. */
  selectable?: boolean;
  /** Controlled hover (OR'd with pointer hover) — lets a legend row light the mark
   *  remotely. Pair with the container's `onHoverAnnotation` to sync both ways. */
  hovered?: boolean;
  /** When `true`, this mark is in **single-annotation edit** (the double-click
   *  target): handles stay out, it's draggable, and it reads as level 1 — while
   *  other marks stay static. Independent of the container's global
   *  `editAnnotations`. Pair with `onEditAnnotation` (the consumer holds an
   *  `editingId` and sets `editing={editingId === id}`). */
  editing?: boolean;
  /** Make the region **editable** (in edit mode): drag the body to move it (both
   *  edges shift), drag an edge to resize. Reports the new `{ from, to }`. */
  onChange?: (next: { from: number; to: number }) => void;
  /** Draw the vertical **side outlines** at `from`/`to`. **Default `true`.**
   *  `false` shades the span with no edge lines (fill only) — a soft highlight
   *  band. Edit-mode resizing still works (the grab areas are invisible). */
  edges?: boolean;
}

/** A shaded span over an x range — a lap, a zone, a selected interval. Its label
 *  flies as a flag off the left edge. */
export function Region({
  from,
  to,
  label,
  id,
  selected = false,
  selectable = true,
  hovered,
  editing = false,
  onChange,
  edges = true,
}: RegionProps) {
  const { container, row, ann } = useAnnotationFrame('Region');
  const selfKey = useSlotKey();
  const { hovering, reportHover } = useAnnotationHover(container, id, hovered);
  // Draggable right now: global edit mode OR this mark's single-edit flag, and no
  // tool armed, and it has an onChange to report to.
  const editable =
    (container.editAnnotations || editing) &&
    container.creating === null &&
    onChange !== undefined;
  const xs = useMemo(() => [from, to], [from, to]);
  // `label === false` (or '') ⇒ no chip; omitted ⇒ auto-label the `from–to`
  // span off the readout channel (else the x label formatter).
  const fmtX = container.formatReadout ?? container.formatTime;
  const text = label === false ? '' : (label ?? `${fmtX(from)}–${fmtX(to)}`);
  useRegisterAnnotation(
    container,
    selfKey,
    id,
    row.rowKey,
    'region',
    xs,
    selected,
    selectable,
    editing,
    text,
    false, // regions have no axis-edge indicator
  );
  // No select/edit while a create tool is armed — the chart is in draw mode then.
  const select =
    id !== undefined && container.creating === null
      ? () => container.onSelectAnnotation?.(id)
      : undefined;
  const edit =
    id !== undefined && container.creating === null
      ? () => container.onEditAnnotation?.(id)
      : undefined;
  const xa = container.xScale(from);
  const xb = container.xScale(to);
  const left = Math.min(xa, xb);
  const spanW = Math.abs(xb - xa);
  const h = row.height;
  // The edges (lines) come fully forward in edit mode; the body fill sits one step
  // back (so the edges read as the grabbable thing). Both jump to level 1 selected.
  const edgeOpacity = rampAt(
    ann.depth,
    lineLevel(selectable, editable, hovering, selected),
  );
  const fillOpacity =
    ann.fillOpacity *
    rampAt(FILL_MULT, bodyLevel(selectable, editable, hovering, selected));
  const showHandles = editable && (editing || hovering);
  const lane = container.labelLanes.get(selfKey)?.lane ?? 0;
  // Body move-drag: capture the start position + pointer on press, then move by
  // the TOTAL delta from there, so the *raw* position accumulates from a fixed
  // origin. Snap is applied only to the output — never fed back into this
  // accumulator — so once you drag past SNAP_PX the region releases cleanly
  // instead of re-snapping on every small move.
  const dragRef = useRef<{ from: number; to: number; startPx: number } | null>(
    null,
  );
  // Edge resize pivots around the OPPOSITE edge, captured on press so it stays put
  // even after the dragged edge crosses it — {@link orderRegion} then re-opens the
  // region the other way instead of dead-ending at zero width.
  const edgeRef = useRef<number | null>(null);
  const edge = (atX: number) => (
    <line
      x1={atX}
      y1={0}
      x2={atX}
      y2={h}
      stroke={ann.color}
      strokeWidth={1}
      opacity={edgeOpacity}
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
        {edges && edge(xa)}
        {edges && edge(xb)}
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
        {selectable && (
          <>
            {/* Body — present for any selectable region: tracks hover (level 2)
                even with edit off; in edit mode it also move-drags (both edges
                shift) + click-selects. Rendered first, under the edge areas. */}
            <DragArea
              x={left}
              y={0}
              w={spanW}
              h={h}
              cursor={editing ? 'grab' : 'inherit'}
              editable={editable}
              onHover={reportHover}
              onSelect={select}
              onEdit={edit}
              onDragActive={(a) => container.setDragging(a ? selfKey : null)}
              onDragStart={(px) => {
                dragRef.current = { from, to, startPx: px };
              }}
              onDrag={(px) => {
                const s = dragRef.current;
                if (s === null) return;
                // Rigid move by the TOTAL pointer *pixel* delta from the press
                // origin — each edge shifts the same pixels through the scale, so
                // the box holds its shape even across a collapsed gap (a shared
                // value-delta would drift the edges apart there).
                const moved = moveRegionByPixels(
                  container.xScale,
                  s.from,
                  s.to,
                  px - s.startPx,
                );
                // Snap either edge to a guideline, shifting BOTH by the same pixel
                // correction so the box keeps its width; snap-independent, so a
                // drag past SNAP_PX releases cleanly.
                const fpx = container.xScale(moved.from);
                const tpx = container.xScale(moved.to);
                const sf = snapToGuides(container, selfKey, fpx);
                const st = snapToGuides(container, selfKey, tpx);
                const d =
                  sf !== null
                    ? container.xScale(sf) - fpx
                    : st !== null
                      ? container.xScale(st) - tpx
                      : 0;
                onChange?.({
                  from: +container.xScale.invert(fpx + d),
                  to: +container.xScale.invert(tpx + d),
                });
              }}
            />
            {editable && (
              <>
                {/* Edges (resize) — on top, so a grab near an edge resizes it.
                    Each pivots around the OTHER edge (captured on press), so a
                    drag past it re-opens the region the other way rather than
                    inverting — see {@link orderRegion}. */}
                <DragArea
                  x={xa - EDGE_GRAB / 2}
                  y={0}
                  w={EDGE_GRAB}
                  h={h}
                  cursor="ew-resize"
                  editable={editable}
                  onHover={reportHover}
                  onSelect={select}
                  onEdit={edit}
                  onDragActive={(a) =>
                    container.setDragging(a ? selfKey : null)
                  }
                  onDragStart={() => {
                    edgeRef.current = to; // the fixed pivot = the far edge
                  }}
                  onDrag={(px) =>
                    onChange?.(
                      orderRegion(
                        snapToGuides(container, selfKey, px) ??
                          +container.xScale.invert(px),
                        edgeRef.current ?? to,
                      ),
                    )
                  }
                />
                <DragArea
                  x={xb - EDGE_GRAB / 2}
                  y={0}
                  w={EDGE_GRAB}
                  h={h}
                  cursor="ew-resize"
                  editable={editable}
                  onHover={reportHover}
                  onSelect={select}
                  onEdit={edit}
                  onDragActive={(a) =>
                    container.setDragging(a ? selfKey : null)
                  }
                  onDragStart={() => {
                    edgeRef.current = from; // the fixed pivot = the near edge
                  }}
                  onDrag={(px) =>
                    onChange?.(
                      orderRegion(
                        snapToGuides(container, selfKey, px) ??
                          +container.xScale.invert(px),
                        edgeRef.current ?? from,
                      ),
                    )
                  }
                />
              </>
            )}
          </>
        )}
      </svg>
      {/* The fill/edges are SVG (clipped by the plot's viewport), but the chip
          is DOM — anchor it to the *visible* part of the region (clamped to the
          plot's left edge while any of the region shows), and cull it entirely
          once the region pans fully off-plot. */}
      {text && left <= container.plotWidth && left + spanW >= 0 && (
        <Chip
          theme={container.theme}
          color={ann.color}
          style={{
            top: `${FLAG_TOP + lane * LANE_H}px`,
            ...flagChipX(Math.max(left, 0), container.plotWidth),
          }}
        >
          {text}
        </Chip>
      )}
    </>
  );
}
