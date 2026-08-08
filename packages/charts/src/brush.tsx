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
 * 2. **The range drag** ({@link resolveRangeDrag}) — a drag-enabled
 *    `<RangeCursor>` in the hovered row's effective cursor set, else the
 *    legacy `cursor="region"` + `onRegionSelect` container props. Preempts
 *    pan — unless a `dragModifier` is declared **and pan is enabled**, in
 *    which case a plain drag falls through to pan and only a modifier-held
 *    drag brushes. (With pan off there is no gesture to share, so the
 *    modifier is not enforced.)
 * 3. **Pan** — armed behind `DRAG_SLOP`, so a click never nudges the view.
 * 4. **Nothing** — the press is a potential click; hover/select handle it.
 *
 * The recognizer resolves the claim **at pointer-down**; the per-claim
 * sessions (create preview, range anchor, pan anchor) stay in `Layers`, keyed
 * off the refs the claim seeds. `<RangeCursor>` and the future
 * `<MultiSelector>` both drive the same range-drag session — only what fires
 * on release differs (a span vs. marks), which is A1.5's "one brush engine,
 * two components".
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
  | { readonly kind: 'range'; readonly drag: RangeDrag }
  | { readonly kind: 'pan' }
  | { readonly kind: 'none' };

/**
 * The claim decision at pointer-down — pure, so the precedence order is
 * testable without a DOM. Inputs are the already-resolved facts:
 *
 * - `creating` — an annotation tool is armed (claim 1).
 * - `drag` — {@link resolveRangeDrag}'s answer (claim 2), whose `modifier`
 *   gates it behind the key **only while pan is enabled**.
 * - `canPan` — this surface has a pan to arm (claim 3): x-pan on a
 *   continuous axis, or any y-pan.
 */
export function resolveBrushClaim(opts: {
  readonly creating: boolean;
  readonly drag: RangeDrag | null;
  readonly shiftKey: boolean;
  readonly panEnabled: boolean;
  readonly canPan: boolean;
}): BrushClaim {
  if (opts.creating) return { kind: 'create' };
  if (opts.drag !== null) {
    const needsShift = opts.drag.modifier === 'shift' && opts.panEnabled;
    if (!needsShift || opts.shiftKey) return { kind: 'range', drag: opts.drag };
    // Modifier required but not held → the press falls through to pan.
  }
  if (opts.canPan) return { kind: 'pan' };
  return { kind: 'none' };
}

/**
 * The **shared band renderer** — the brush's one visual, so the components
 * driving the engine cannot drift apart (RFC A1.5): `<RangeCursor>` renders
 * it today; `<MultiSelector>`'s sweep plugs in here when it lands
 * ([PND-INTERACT2D] / RFC step 5) by using this as (part of) its
 * `renderPlot` slot. The container resolves `f.band` / `f.bandLine`; this
 * only draws them.
 */
export function renderBrushBand(f: ResolvedCursorFrame): ReactNode {
  // The cursor ink — the theme's cursor colour, else the axis label colour
  // (same resolution as the cursor presets' `cursorInk`).
  const ink = f.theme.cursor ?? f.theme.axis.label;
  return (
    <>
      {f.band !== null && (
        <rect
          x={f.band.x0}
          y={0}
          width={f.band.x1 - f.band.x0}
          height={f.rowHeight}
          fill={ink}
          opacity={0.12}
        />
      )}
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
