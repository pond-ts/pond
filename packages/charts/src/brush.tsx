import type { ReactNode } from 'react';
import type {
  ContainerFrame,
  CursorEntry,
  ResolvedCursorFrame,
} from './context.js';

/**
 * The **brush recognizer** — the one engine that arbitrates every drag claim
 * on the plot surface (interaction RFC A1.5 / A2.7).
 *
 * A drag on the plot has several would-be owners, and before this module the
 * ordering that resolved them lived implicitly in `Layers.handlePointerDown`'s
 * statement order. Turning claimants into mounted components
 * (`<RangeCursor>`, later `<MultiSelector>`) makes that ordering **public
 * API**, so it is written down once, here, and `Layers` routes on the answer.
 *
 * ## Precedence — highest claim wins
 *
 * 0. **Mark-edit** (`DragArea` in `annotations.tsx`). DOM-level: an editable
 *    annotation's handles sit *above* the plot surface and stop propagation,
 *    so the engine never sees the press. Listed so the full order is in one
 *    place; it is not a case this resolver returns.
 * 1. **Annotation-create capture** — an armed `creating` tool owns the whole
 *    surface (the press starts a draw, never a pan or a range drag).
 * 2. **The sweep** — a mounted `<MultiSelector>` in scope (RFC §8), when the
 *    row has a sweep-capable layer. A *selection* gesture is the most
 *    specific intent a drag can carry (the selector was deliberately
 *    mounted), so it preempts both the range drag and pan; a drag-enabled
 *    `<RangeCursor>` competing in the same scope is shadowed, and
 *    {@link warnSweepShadowsRangeDrag} says so (A1.5 asked for the
 *    arbitration to be written down, not implied). The sweep arms behind
 *    `DRAG_SLOP` — a plain click stays a click and selects one mark (§8.1:
 *    the two are separated by movement, not modifier).
 * 3. **The range drag** ({@link resolveRangeDrag}) — a drag-enabled
 *    `<RangeCursor>` in the hovered row's effective cursor set, else the
 *    legacy `cursor="region"` + `onRegionSelect` container props. Preempts
 *    pan — unless a `dragModifier` is declared **and pan is enabled**, in
 *    which case a plain drag falls through to pan and only a modifier-held
 *    drag brushes. (With pan off there is no gesture to share, so the
 *    modifier is not enforced.)
 * 4. **Pan** — armed behind `DRAG_SLOP`, so a click never nudges the view.
 * 5. **Nothing** — the press is a potential click; hover/select handle it.
 *
 * The recognizer resolves the claim **at pointer-down**; the per-claim
 * sessions (create preview, range anchor, sweep session, pan anchor) stay in
 * `Layers`, keyed off the refs the claim seeds. `<RangeCursor>` and
 * `<MultiSelector>` both drive the same range-drag session — anchor, bucket
 * snap, the shared band — only what fires on release differs (a span vs.
 * marks), which is A1.5's "one brush engine, two components".
 */

/** What a completed range drag calls with the released `[start, end]`
 *  (axis units, `start ≤ end`). Resolved once at pointer-down — the component
 *  path wraps `onDragRelease` (the `{ x }` payload), the legacy path wraps
 *  `onRegionSelect` (the bare pair). */
export interface RangeDrag {
  readonly release: (start: number, end: number) => void;
  /** The modifier the drag needs — only enforced while pan is enabled. */
  readonly modifier: 'shift' | undefined;
}

/**
 * Resolve whether a press could start a **range drag**, and who gets the
 * released span. Two sources, component first:
 *
 * 1. **A mounted `<RangeCursor>`** — the hovered row's effective
 *    gesture-owning cursor (`owner`), when it carries `onDragRelease` and is
 *    not frozen (`enableDrag={false}` — the OFF switch, which also suppresses
 *    the legacy fallback: the consumer wired the new API and asked for no
 *    gesture). A `<RangeCursor>` without `onDragRelease` has nothing to fire,
 *    so it does not claim — the legacy props keep working underneath it
 *    during the deprecation window (exactly the step-2 behaviour).
 * 2. **The legacy container props** — `cursor="region"` + `onRegionSelect`
 *    (+ `regionSelectModifier`), byte-for-byte today's semantics, including
 *    the bare-pair payload.
 *
 * Continuous x only (time or value): a category axis has no span to drag
 * (an ordinal-slot select is a different gesture), so both paths gate on it.
 */
export function resolveRangeDrag(
  c: Pick<
    ContainerFrame,
    'cursor' | 'onRegionSelect' | 'regionSelectModifier' | 'xKind'
  >,
  owner: CursorEntry | undefined,
): RangeDrag | null {
  if (c.xKind !== 'time' && c.xKind !== 'value') return null;
  if (owner !== undefined && !owner.legacy && owner.onDragRelease) {
    // Frozen: the gesture is off without unwiring the callback (§6's
    // `enableDrag`-as-disabler) — and the legacy fallback stays off too.
    if (owner.enableDrag === false) return null;
    const cb = owner.onDragRelease;
    return {
      release: (start, end) => cb({ x: [start, end] }),
      modifier: owner.dragModifier,
    };
  }
  if (c.cursor === 'region' && c.onRegionSelect !== undefined) {
    const cb = c.onRegionSelect;
    return {
      release: (start, end) => cb([start, end]),
      modifier: c.regionSelectModifier,
    };
  }
  return null;
}

/** Who owns the drag a pointer-down might start (see the module doc's
 *  precedence order). `'none'` = the press is a potential click only. */
export type BrushClaim =
  | { readonly kind: 'create' }
  | { readonly kind: 'sweep' }
  | { readonly kind: 'range'; readonly drag: RangeDrag }
  | { readonly kind: 'pan' }
  | { readonly kind: 'none' };

/**
 * The claim decision at pointer-down — pure, so the precedence order is
 * testable without a DOM. Inputs are the already-resolved facts:
 *
 * - `creating` — an annotation tool is armed (claim 1).
 * - `sweep` — a mounted `<MultiSelector>` is in scope AND the row has a
 *   sweep-capable layer (claim 2). The sweep preempts the range drag and pan
 *   unconditionally — mounting the selector is the intent, and it carries no
 *   modifier gate of its own.
 * - `drag` — {@link resolveRangeDrag}'s answer (claim 3), whose `modifier`
 *   gates it behind the key **only while pan is enabled**.
 * - `canPan` — this surface has a pan to arm (claim 4): x-pan on a
 *   continuous axis, or any y-pan.
 */
export function resolveBrushClaim(opts: {
  readonly creating: boolean;
  readonly sweep?: boolean;
  readonly drag: RangeDrag | null;
  readonly shiftKey: boolean;
  readonly panEnabled: boolean;
  readonly canPan: boolean;
}): BrushClaim {
  if (opts.creating) return { kind: 'create' };
  if (opts.sweep === true) return { kind: 'sweep' };
  if (opts.drag !== null) {
    const needsShift = opts.drag.modifier === 'shift' && opts.panEnabled;
    if (!needsShift || opts.shiftKey) return { kind: 'range', drag: opts.drag };
    // Modifier required but not held → the press falls through to pan.
  }
  if (opts.canPan) return { kind: 'pan' };
  return { kind: 'none' };
}

/**
 * Dev-warn (once per plot surface) when a press found BOTH a mounted
 * `<MultiSelector>` and a live range drag (a drag-enabled `<RangeCursor>`, or
 * the legacy region props) competing for it — the sweep wins (see the module
 * doc's precedence), and a silent shadow would hide the loser exactly the way
 * A1.5 said docs alone couldn't.
 */
export function warnSweepShadowsRangeDrag(warned: { current: boolean }): void {
  if (warned.current) return;
  warned.current = true;
  console.warn(
    '[pond-charts] a <MultiSelector> and a drag-enabled <RangeCursor> (or ' +
      'the legacy onRegionSelect props) are both in scope for this plot — ' +
      'the sweep claims the drag and the range drag never fires. Mount one ' +
      'drag owner per scope, or freeze the cursor with enableDrag={false}. ' +
      'See docs/rfcs/interaction.md A1.5 / §8.1.',
  );
}

/**
 * The **shared band renderer** — the brush's one visual, so the components
 * driving the engine cannot drift apart (RFC A1.5): `<RangeCursor>` renders
 * it via its spec's `renderPlot` slot, and `<MultiSelector>`'s sweep renders
 * the *same function* from `Layers` while a sweep is live (§8.1 — identical
 * pixels is the design, so there is exactly one place that draws them). The
 * container resolves `f.band` / `f.bandLine`; this only draws them.
 */
export function renderBrushBand(f: ResolvedCursorFrame): ReactNode {
  // The cursor ink — the theme's cursor colour, else the axis label colour
  // (same resolution as the cursor presets' `cursorInk`).
  const ink = f.theme.cursor ?? f.theme.axis.label;
  // The band's own colours come from `theme.brush` when the theme sets it.
  // With no `brush` this is the pre-token look exactly: cursor ink at 0.12,
  // no edges — so an existing hand-built theme's band does not shift.
  const brush = f.theme.brush;
  const bandFill = brush?.fill ?? ink;
  const bandOpacity = brush === undefined ? 0.12 : 1;
  const edge = brush?.edge;
  return (
    <>
      {f.band !== null && (
        <rect
          x={f.band.x0}
          y={0}
          width={f.band.x1 - f.band.x0}
          height={f.rowHeight}
          fill={bandFill}
          opacity={bandOpacity}
        />
      )}
      {/* The edges are the **gesture's** grabbed boundary, so they draw only
          while one is in flight. A resting band is a preview of the block a
          drag would select; edging it would assert a range the user has not
          made yet, and the two states would read alike. */}
      {f.band !== null &&
        f.bandDragging &&
        edge !== undefined &&
        [f.band.x0, f.band.x1].map((x, i) => (
          <line
            key={i}
            x1={Math.round(x)}
            y1={0}
            x2={Math.round(x)}
            y2={f.rowHeight}
            stroke={edge}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        ))}
      {f.bandLine && f.cursorX !== null && (
        <line
          x1={Math.round(f.cursorX)}
          y1={0}
          x2={Math.round(f.cursorX)}
          y2={f.rowHeight}
          stroke={ink}
          strokeWidth={1}
          shapeRendering="crispEdges"
        />
      )}
    </>
  );
}

/** Half-length of a brush crosshair's arms, in pixels. Small on purpose — it
 *  marks a corner, and a full-plot rule at each end of the diagonal would put
 *  four lines across a plot the rect is already dividing. */
const BRUSH_CROSS_PX = 5;

/** One brush crosshair — the same `+` at rest and at each end of a drag's
 *  diagonal, so the resting mark reads as the thing the drag then picks up. */
function brushCross(
  key: number | string,
  cx: number,
  cy: number,
  stroke: string,
): ReactNode {
  const x = Math.round(cx);
  const y = Math.round(cy);
  return (
    <g key={key} stroke={stroke} strokeWidth={1} shapeRendering="crispEdges">
      <line x1={x - BRUSH_CROSS_PX} y1={y} x2={x + BRUSH_CROSS_PX} y2={y} />
      <line x1={x} y1={y - BRUSH_CROSS_PX} x2={x} y2={y + BRUSH_CROSS_PX} />
    </g>
  );
}

/**
 * The **2-D brush renderer** — the rect a sweep paints over a `twoD` layer
 * (a scatter, a heat map), the counterpart of {@link renderBrushBand} and
 * drawn from the same `theme.brush` tokens so the two brushes read as one
 * gesture in two dimensionalities.
 *
 * A small `+` sits on each end of the drag diagonal: the corner the press
 * anchored and the corner under the pointer. That is the whole reason
 * {@link ResolvedCursorFrame.rect} arrives unsorted — sorting first would put
 * both crosses on the same diagonal regardless of which way the drag went.
 */
export function renderBrushRect(f: ResolvedCursorFrame): ReactNode {
  const ink = f.theme.cursor ?? f.theme.axis.label;
  const r = f.rect;
  if (r === null) {
    // At rest: one grey `+` at the pointer, in the hovered row only. It is
    // the same mark the drag then pins at its anchor — the gesture reads as
    // picking up what was already under the cursor, rather than swapping one
    // kind of cursor for another.
    return f.restingCross &&
      f.cursorX !== null &&
      f.cursorY !== null &&
      f.rowKey === f.hoveredRowKey
      ? brushCross('rest', f.cursorX, f.cursorY, ink)
      : null;
  }
  const brush = f.theme.brush;
  const fill = brush?.fill ?? ink;
  const opacity = brush === undefined ? 0.12 : 1;
  const edge = brush?.edge ?? ink;
  const x = Math.min(r.x0, r.x1);
  const y = Math.min(r.y0, r.y1);
  const w = Math.abs(r.x1 - r.x0);
  const h = Math.abs(r.y1 - r.y0);
  return (
    <>
      <rect x={x} y={y} width={w} height={h} fill={fill} opacity={opacity} />
      <rect
        x={Math.round(x) + 0.5}
        y={Math.round(y) + 0.5}
        width={Math.max(0, Math.round(w) - 1)}
        height={Math.max(0, Math.round(h) - 1)}
        fill="none"
        stroke={edge}
        strokeWidth={1}
      />
      {[
        [r.x0, r.y0],
        [r.x1, r.y1],
      ].map(([cx, cy], i) => brushCross(i, cx!, cy!, edge))}
    </>
  );
}
