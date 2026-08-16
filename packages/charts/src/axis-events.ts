import type { MouseEvent as ReactMouseEvent } from 'react';

/**
 * What an axis hands its {@link AxisMouseHandler} — the raw mouse event, plus
 * the **axis coordinate under the pointer**, which is the part a consumer
 * cannot compute for itself (the scale lives inside the container).
 */
export interface AxisMouseEvent {
  /**
   * The React mouse event, verbatim — `type` says which one fired
   * (`'click'`, `'mousemove'`, `'contextmenu'`, …), and the modifier keys,
   * `button`, `preventDefault()` and `stopPropagation()` are all the ordinary
   * ones. **A single handler receives every mouse event on the strip**, so
   * switch on `event.type` (or ignore the ones you don't want).
   */
  event: ReactMouseEvent<HTMLDivElement>;
  /** Which axis fired — so one handler can serve both. */
  axis: 'x' | 'y';
  /**
   * The axis's `id`, when it has one. A `<YAxis>` always does (it's required —
   * charts link to it); an `<XAxis>` has none, so this is `undefined` there.
   * To tell two stacked x-axes apart, close over the distinction at the call
   * site (`onMouseEvent={(e) => onAxis('delta', e)}`).
   */
  id?: string | undefined;
  /**
   * The axis value under the pointer, **in the axis's own data units** — epoch
   * ms on a time axis, the number on a value axis, the slot value on a
   * categorical one. Read {@link label} for what the axis would *print* there.
   *
   * Not clamped to a tick — it is the continuous inverse of the pixel, so it
   * lands between ticks. The one exception is a **categorical x-axis**, whose
   * scale inverts to the nearest band **centre** (`i + 0.5`); a categorical
   * *row* (horizontal bars on the y-axis) is a plain linear slot scale and does
   * not snap, so `Math.floor(value)` is its slot index.
   *
   * On a `transform`ed x-axis this is the **underlying** value, not the derived
   * unit — apply the same `transform.to` you passed the axis to get the unit
   * its ticks read in.
   */
  value: number;
  /**
   * {@link value} formatted the way this axis reads it — the category name on a
   * categorical axis, the axis's `format` (or the container's shared formatter)
   * elsewhere.
   *
   * Precisely: it is the axis's **readout** channel, the one the cursor pill
   * uses — so it always agrees with the pill at that pixel, and a container
   * `cursorFormat` shapes it exactly as it shapes the pill. That is the
   * documented precedence (`cursorFormat` → axis `format` → container), and it
   * is the one case where `label` can read differently from the tick text: a
   * chart with a precise `cursorFormat` over terse ticks gets the precise form
   * here, which is the readout it asked for.
   */
  label: string;
}

/**
 * A single handler for every mouse event on an axis strip — see
 * {@link AxisMouseEvent}. Passed as `onMouseEvent` to `<XAxis>` / `<YAxis>`.
 */
export type AxisMouseHandler = (info: AxisMouseEvent) => void;

/** The mouse props an axis strip spreads onto its root element. */
type AxisMouseProps = {
  onClick?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onDoubleClick?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseDown?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseUp?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseMove?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseEnter?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseLeave?: (e: ReactMouseEvent<HTMLDivElement>) => void;
};

/**
 * Build the mouse props for an axis strip: every mouse event routed to the one
 * `onMouseEvent` handler, each carrying the axis coordinate `at` resolves from
 * the pointer.
 *
 * With no handler this returns `{}` — **nothing is attached**, so an axis that
 * doesn't opt in keeps costing nothing (no per-move callback, no listeners).
 *
 * `at` returns `null` when the pointer maps to no value — the transient render
 * before a `<YAxis>` has a resolved scale — and the event is then dropped
 * rather than reported at a made-up coordinate.
 */
export function axisMouseProps(
  onMouseEvent: AxisMouseHandler | undefined,
  axis: 'x' | 'y',
  id: string | undefined,
  at: (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => { value: number; label: string } | null,
): AxisMouseProps {
  if (onMouseEvent === undefined) return {};
  const fire = (event: ReactMouseEvent<HTMLDivElement>) => {
    const hit = at(event);
    if (hit === null) return;
    onMouseEvent({ event, axis, id, value: hit.value, label: hit.label });
  };
  return {
    onClick: fire,
    onDoubleClick: fire,
    onContextMenu: fire,
    onMouseDown: fire,
    onMouseUp: fire,
    onMouseMove: fire,
    onMouseEnter: fire,
    onMouseLeave: fire,
  };
}

/**
 * The pointer's position along an axis strip, in **strip-local pixels** — the
 * coordinate the scale inverts. Read from the strip's own client rect
 * (`currentTarget`, so it is the strip whichever tick label was hit), which is
 * laid out flush with the plot on that dimension: the x strip carries the left
 * gutter as a margin and is exactly `plotWidth` wide, and the y gutter is
 * exactly the row's height.
 *
 * Clamped to **the scale's range, not the strip's box** — the two are not
 * always the same. A row carrying a `labelPlacement="top"` axis reserves a
 * header, so its y scales run `[height, topHeader]` while the gutter box still
 * starts at 0; clamping to the box would invert the header band to values
 * *above* the domain and report a coordinate the axis never draws. Passing the
 * range means a `mouseleave` off the edge — or a press in that header — still
 * reports a value the scale actually holds.
 */
export function axisPointerPx(
  event: ReactMouseEvent<HTMLDivElement>,
  axis: 'x' | 'y',
  range: readonly [number, number],
): number {
  const rect = event.currentTarget.getBoundingClientRect();
  const px =
    axis === 'x' ? event.clientX - rect.left : event.clientY - rect.top;
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  return Math.max(lo, Math.min(hi, px));
}
