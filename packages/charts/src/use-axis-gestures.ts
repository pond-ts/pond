import { useCallback, useEffect, useRef, type CSSProperties } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Pixels of drag per e-fold of zoom, and the wheel's per-notch equivalent. The
 * drag figure is deliberately slower than a plot pan feels: an axis drag scales
 * the view rather than sliding it, so the same pixel budget covers a much bigger
 * change in what's on screen.
 */
const DRAG_SENSITIVITY = 0.006;
const WHEEL_SENSITIVITY = 0.0015; // matches the plot's `ZOOM_SENSITIVITY`
/**
 * Slop before a press becomes a zoom. Below it the sequence is still a click —
 * which is what keeps `onMouseEvent` consumers (and a double-click reset) working
 * on a strip that also zooms.
 */
const DRAG_SLOP = 3;

/** What a strip needs to know to turn pointer deltas into zoom. */
export interface AxisGestureSpec {
  /**
   * Whether the strip captures gestures at all. Wired from the container's
   * `panZoom` (its zoom degree of freedom for this axis), so a chart that never
   * opted into pan/zoom is untouched — no listeners, no resize cursor.
   */
  enabled: boolean;
  /** Which pointer delta drives the zoom, and which resize cursor to show. */
  axis: 'x' | 'y';
  /**
   * Zoom by `factor` about `pivotPx` (strip-local pixels). `factor` is a
   * **domain-span multiplier** — `< 1` zooms in, `> 1` out — matching
   * {@link zoomRange}'s convention, and it arrives **incrementally**: each move
   * reports the step since the last one, so the caller composes it onto whatever
   * the current view is rather than tracking a gesture start.
   */
  onZoom: (factor: number, pivotPx: number) => void;
  /** Double-click — return this axis to its declared view. */
  onReset: () => void;
}

/** What a strip spreads onto its root element to become gesture-capable. */
export interface AxisGestures {
  /** Attach to the strip element — the wheel listener needs it non-passive. */
  ref: (el: HTMLDivElement | null) => void;
  props: {
    onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove?: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp?: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel?: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onDoubleClick?: () => void;
  };
  /** Cursor affordance — merged into the strip's own style. */
  style: CSSProperties;
  /**
   * Did the sequence that just ended pass the slop and zoom? The axis reports
   * mouse events too ({@link AxisMouseHandler}), and a drag on the same element
   * still emits a trailing `click` — which would read as "the user clicked the
   * axis at the value they happened to release on". Consulted (and consumed) by
   * the axis to swallow exactly that one report.
   */
  consumeDrag: () => boolean;
}

/**
 * Drag-to-zoom, wheel-to-zoom and double-click-to-reset for an axis strip.
 *
 * **Drag zooms; it does not pan** — panning stays the plot's own drag, so the
 * two gestures never compete for the same pixels. Up / right expands the axis
 * (zoom in), down / left compresses it (zoom out), and the pixel the drag
 * started on is the pivot, so the value you grabbed stays under the pointer for
 * the whole gesture.
 *
 * Zoom arrives at the caller as an incremental span multiplier, which is what
 * lets the same hook drive two very different back-ends: the x strip's
 * domain-space `zoomRange` (where `bounds` / `minDuration` / the trading
 * calendar live) and a y gutter's per-axis pixel transform.
 */
export function useAxisGestures(spec: AxisGestureSpec): AxisGestures {
  // The live spec, read by the handlers — so the wheel listener can be attached
  // once and still see current props (the pattern `Layers` uses for the plot's).
  const specRef = useRef(spec);
  specRef.current = spec;

  const elRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    /** Pointer position at the last reported step (deltas are incremental). */
    last: number;
    /** Strip-local pixel the gesture grabbed — the pivot, fixed for the drag. */
    pivot: number;
    /** Past the slop, so this sequence is a zoom and its click is not real. */
    committed: boolean;
    /** Total travel, for the slop test. */
    travel: number;
  } | null>(null);
  /** Set on release when the sequence had committed; consumed by the axis. */
  const draggedRef = useRef(false);

  const local = (e: { clientX: number; clientY: number }): number => {
    const el = elRef.current;
    if (el === null) return 0;
    const r = el.getBoundingClientRect();
    return specRef.current.axis === 'x'
      ? e.clientX - r.left
      : e.clientY - r.top;
  };

  /** Pointer delta → span multiplier. Up / right = zoom in (multiplier < 1). */
  const factorFor = (delta: number, sensitivity: number): number =>
    Math.exp(sensitivity * (specRef.current.axis === 'x' ? -delta : delta));

  /**
   * Zoom, unless the factor isn't a usable multiplier. A device (or a DOM shim)
   * that reports no `deltaY` yields `exp(NaN)`, and a `NaN` factor walks
   * straight into the view range — `[NaN, NaN]` is an unrecoverable chart, not a
   * dropped frame, so it is worth the guard at the one choke point.
   */
  const zoom = (factor: number, pivotPx: number): void => {
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (!Number.isFinite(pivotPx)) return;
    specRef.current.onZoom(factor, pivotPx);
  };

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!specRef.current.enabled || e.button !== 0) return;
    const at = specRef.current.axis === 'x' ? e.clientX : e.clientY;
    drag.current = { last: at, pivot: local(e), committed: false, travel: 0 };
    // Capture so a drag that leaves the strip (very likely — the strip is
    // ~20px tall) keeps steering the zoom until release. Feature-detected: a
    // test DOM may not implement it, and the gesture works without it as long
    // as the pointer stays over the strip.
    if (typeof e.currentTarget.setPointerCapture === 'function') {
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null || !specRef.current.enabled) return;
    const at = specRef.current.axis === 'x' ? e.clientX : e.clientY;
    const step = at - d.last;
    d.travel += Math.abs(step);
    // Below the slop the sequence is still a click: report nothing, and keep
    // accumulating from the press point so the first real step isn't swallowed.
    if (!d.committed && d.travel < DRAG_SLOP) return;
    d.committed = true;
    d.last = at;
    if (step !== 0) {
      zoom(factorFor(step, DRAG_SENSITIVITY), d.pivot);
    }
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d === null) return;
    if (d.committed) draggedRef.current = true;
    if (
      typeof e.currentTarget.hasPointerCapture === 'function' &&
      e.currentTarget.hasPointerCapture(e.pointerId)
    ) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const onDoubleClick = useCallback(() => {
    if (specRef.current.enabled) specRef.current.onReset();
  }, []);

  // Wheel must be a native non-passive listener to `preventDefault()` the page
  // scroll — React's `onWheel` is passive. Attached once; the handler reads the
  // live spec, and no-ops (leaving the page to scroll) while gestures are off.
  useEffect(() => {
    const el = elRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      const s = specRef.current;
      if (!s.enabled) return;
      e.preventDefault();
      // The wheel's own axis is irrelevant here: the strip *is* the axis, so a
      // notch means "zoom me" whichever way the device reports it. `deltaY` is
      // what a mouse wheel and a two-finger scroll both produce.
      zoom(Math.exp(e.deltaY * WHEEL_SENSITIVITY), local(e));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const setRef = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
  }, []);

  const consumeDrag = useCallback(() => {
    const was = draggedRef.current;
    draggedRef.current = false;
    return was;
  }, []);

  if (!spec.enabled) {
    return { ref: setRef, props: {}, style: {}, consumeDrag };
  }
  return {
    ref: setRef,
    props: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick,
    },
    style: {
      cursor: spec.axis === 'x' ? 'ew-resize' : 'ns-resize',
      // A zoom drag must not start a text selection of the tick labels.
      userSelect: 'none',
      // The strip owns its gestures; a two-finger scroll over it zooms rather
      // than scrolling the page.
      touchAction: 'none',
    },
    consumeDrag,
  };
}
