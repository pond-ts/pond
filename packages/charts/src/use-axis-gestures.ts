import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
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
/**
 * Most a **single** event may scale the view. A captured drag can deliver one
 * enormous move (a fast flick, or a coalesced move after the pointer left the
 * strip), and `exp` of it is a factor in the hundreds — enough to overflow a log
 * domain to `[0, Infinity]` in one step. Clamping per event keeps every gesture
 * reachable by repetition while bounding what one event can do.
 */
const MAX_STEP_FACTOR = 4;
/** How long the directional cursor lingers after the last wheel notch. */
const WHEEL_CURSOR_MS = 400;

/** What a strip needs to know to turn pointer input into view changes. */
export interface AxisGestureSpec {
  /** Which pointer delta drives the gesture, and which cursor to show. */
  axis: 'x' | 'y';
  /**
   * What a **drag** on the strip does, or `'none'` when it captures no drag:
   *
   * - `'pan'` — slides the view, **exactly as a drag on the plot does**. Reports
   *   the total delta from the press (anchored, not incremental) because that is
   *   what the plot's own pan needs: it re-derives the view from the range it
   *   snapshotted at press, so a pan can't accumulate rounding across a drag.
   * - `'zoom'` — scales the axis about the grabbed pixel, reporting incremental
   *   span multipliers.
   *
   * The x strip pans (the canvas gesture, one mental model for both surfaces);
   * a y gutter zooms, which is the gesture the plot cannot offer per axis.
   */
  drag: 'none' | 'pan' | 'zoom';
  /** Whether the **wheel** zooms this axis — again as it does over the plot. */
  wheel: boolean;
  /** Called on press, before any movement: the caller snapshots its view here so
   *  a `'pan'` drag can anchor on it. */
  onDragStart?: () => void;
  /** Total drag delta from the press, in px (`'pan'` mode only). */
  onPan?: (totalDeltaPx: number) => void;
  /**
   * Zoom by `factor` about `pivotPx` (strip-local pixels). `factor` is a
   * **domain-span multiplier** — `< 1` zooms in, `> 1` out — matching
   * {@link zoomRange}'s convention. From the wheel it is one notch; from a
   * `'zoom'` drag it arrives **incrementally**, each move reporting the step
   * since the last, so the caller composes onto the current view.
   */
  onZoom?: (factor: number, pivotPx: number) => void;
  /** Double-click — return this axis to its declared view. */
  onReset?: () => void;
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
 * Drag, wheel and double-click gestures for an axis strip.
 *
 * **The x strip behaves exactly as the canvas does** — drag pans, wheel zooms
 * about the pointer — so a chart has one gesture vocabulary rather than one per
 * surface, and the strip is simply a second place to reach the same view.
 *
 * **A y gutter zooms on drag**, because that is the gesture the plot cannot
 * offer: the plot's vertical drag scales every axis in the row by one factor
 * (the aspect lock), while grabbing a gutter names a single axis. Up expands it,
 * down compresses it, about the grabbed pixel.
 *
 * The two shapes are why the drag reports differently per mode: a pan is
 * **anchored** (total delta from the press, re-derived from a snapshot — how the
 * plot's own pan avoids accumulating rounding), a zoom is **incremental** (a
 * span multiplier per step, composed onto the current view).
 */
export function useAxisGestures(spec: AxisGestureSpec): AxisGestures {
  // The live spec, read by the handlers — so a listener attached once still sees
  // current props (the pattern `Layers` uses for the plot's gestures).
  //
  // Published from a layout effect, **not** during render: a render React
  // abandons under concurrent rendering would otherwise leave the ref pointing at
  // callbacks that close over a frame that was never committed. `ChartContainer`
  // writes `onRangeRef` the same way, for the same reason. It still lands before
  // paint, so the first event after mount reads a current spec.
  const specRef = useRef(spec);
  useLayoutEffect(() => {
    specRef.current = spec;
  });

  const elRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    /** Pointer position at the press — a pan anchors on this. */
    start: number;
    /** Pointer position at the last reported step (a zoom is incremental). */
    last: number;
    /** Strip-local pixel the gesture grabbed — the pivot, fixed for the drag. */
    pivot: number;
    /** Past the slop, so this sequence is a gesture and its click is not real. */
    committed: boolean;
  } | null>(null);
  /** Set on release when the sequence had committed; consumed by the axis. */
  const draggedRef = useRef(false);
  /**
   * Whether a gesture is happening *right now* — the cursor's only input.
   *
   * At rest a strip shows the ordinary arrow: it is chrome you also click, hover
   * and read, and a permanent resize cursor over it would claim the whole strip
   * is a handle. The directional cursor appears while a drag is live (and for a
   * moment after a wheel notch, which has no press to hang it on) — the same way
   * a scrollbar tells you what it is doing rather than what it could do.
   */
  const [gesturing, setGesturing] = useState(false);
  /** Clears the post-wheel cursor; also cancelled on unmount. */
  const wheelIdle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const local = (e: { clientX: number; clientY: number }): number => {
    const el = elRef.current;
    if (el === null) return 0;
    const r = el.getBoundingClientRect();
    const px =
      specRef.current.axis === 'x' ? e.clientX - r.left : e.clientY - r.top;
    // Clamped to the strip, as `Layers` clamps the plot's own wheel pivot: a
    // pivot off the end would zoom about a value the axis does not draw.
    const extent = specRef.current.axis === 'x' ? r.width : r.height;
    return extent > 0 ? Math.max(0, Math.min(extent, px)) : px;
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
    const clamped = Math.max(
      1 / MAX_STEP_FACTOR,
      Math.min(MAX_STEP_FACTOR, factor),
    );
    specRef.current.onZoom?.(clamped, pivotPx);
  };

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const s = specRef.current;
    if (s.drag === 'none' || e.button !== 0) return;
    const at = s.axis === 'x' ? e.clientX : e.clientY;
    drag.current = { start: at, last: at, pivot: local(e), committed: false };
    s.onDragStart?.();
    // Capture so a drag that leaves the strip (very likely — the strip is
    // ~20px tall) keeps steering the gesture until release. Feature-detected: a
    // test DOM may not implement it, and the gesture works without it as long
    // as the pointer stays over the strip.
    if (typeof e.currentTarget.setPointerCapture === 'function') {
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const s = specRef.current;
    if (d === null || s.drag === 'none') return;
    const at = s.axis === 'x' ? e.clientX : e.clientY;
    const total = at - d.start;
    // Below the slop the sequence is still a click: report nothing, so a click's
    // jitter neither moves the view nor shifts the scale the click hit-tests
    // against. The plot's own drag holds the same line, at the same 3px.
    if (!d.committed && Math.abs(total) <= DRAG_SLOP) return;
    if (!d.committed) setGesturing(true);
    d.committed = true;
    if (s.drag === 'pan') {
      // Anchored on the press: the caller re-derives from the range it
      // snapshotted in `onDragStart`, which is how the plot's pan avoids
      // accumulating rounding over a long drag.
      if (Number.isFinite(total)) s.onPan?.(total);
    } else {
      const step = at - d.last;
      if (step !== 0) zoom(factorFor(step, DRAG_SENSITIVITY), d.pivot);
    }
    d.last = at;
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setGesturing(false);
    if (d === null) return;
    if (d.committed) draggedRef.current = true;
    if (
      typeof e.currentTarget.hasPointerCapture === 'function' &&
      e.currentTarget.hasPointerCapture(e.pointerId)
    ) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  // Disabling gestures mid-drag (a prop flip, or a category axis appearing) has
  // the same problem as the element vanishing: no release will arrive.
  useLayoutEffect(() => {
    if (spec.drag === 'none' && drag.current !== null) {
      drag.current = null;
      draggedRef.current = false;
      setGesturing(false);
    }
  }, [spec.drag]);

  const onDoubleClick = useCallback(() => {
    const s = specRef.current;
    if (s.drag !== 'none' || s.wheel) s.onReset?.();
  }, []);

  // Wheel must be a native non-passive listener to `preventDefault()` the page
  // scroll — React's `onWheel` is passive. Bound in the **ref callback** rather
  // than an effect: the strip element comes and goes (a `<YAxis hide>` toggle
  // unmounts the gutter), and an effect with `[]` deps would stay attached to the
  // first element and go silent on the replacement.
  const onWheelRef = useRef<((e: WheelEvent) => void) | null>(null);
  const setRef = useCallback((el: HTMLDivElement | null) => {
    const prev = elRef.current;
    if (prev !== null && onWheelRef.current !== null) {
      prev.removeEventListener('wheel', onWheelRef.current);
      onWheelRef.current = null;
    }
    elRef.current = el;
    if (el === null) {
      // The strip went away mid-gesture — a `<YAxis hide>` toggle, or the axis
      // unmounting under the pointer. Nothing will deliver its `pointerup`, so
      // drop the drag here: otherwise re-showing the strip resumed a gesture
      // nobody was making, and the directional cursor stayed on.
      drag.current = null;
      draggedRef.current = false;
      setGesturing(false);
      if (wheelIdle.current !== null) {
        clearTimeout(wheelIdle.current);
        wheelIdle.current = null;
      }
      return;
    }
    const onWheel = (e: WheelEvent) => {
      const s = specRef.current;
      if (!s.wheel) return;
      e.preventDefault();
      // The wheel's own axis is irrelevant here: the strip *is* the axis, so a
      // notch means "zoom me" whichever way the device reports it. `deltaY` is
      // what a mouse wheel and a two-finger scroll both produce.
      zoom(Math.exp(e.deltaY * WHEEL_SENSITIVITY), local(e));
      // A wheel notch has no press to bracket, so the cursor is shown for a beat
      // and re-armed by each further notch — a continuous scroll reads as one
      // gesture rather than flickering per notch.
      setGesturing(true);
      if (wheelIdle.current !== null) clearTimeout(wheelIdle.current);
      wheelIdle.current = setTimeout(
        () => setGesturing(false),
        WHEEL_CURSOR_MS,
      );
    };
    onWheelRef.current = onWheel;
    el.addEventListener('wheel', onWheel, { passive: false });
  }, []);

  // Nothing to detach on unmount beyond the pending cursor timer: React calls the
  // ref callback with `null` first, which releases the listener above.
  useLayoutEffect(
    () => () => {
      if (wheelIdle.current !== null) clearTimeout(wheelIdle.current);
    },
    [],
  );

  const consumeDrag = useCallback(() => {
    const was = draggedRef.current;
    draggedRef.current = false;
    return was;
  }, []);

  if (spec.drag === 'none' && !spec.wheel) {
    return { ref: setRef, props: {}, style: {}, consumeDrag };
  }
  return {
    ref: setRef,
    props: {
      ...(spec.drag === 'none'
        ? {}
        : {
            onPointerDown,
            onPointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
          }),
      onDoubleClick,
    },
    style: {
      // Arrow at rest (see `gesturing`); while moving, name the direction the
      // gesture works in — up/down over a y gutter, left/right over the x strip.
      ...(gesturing
        ? { cursor: spec.axis === 'x' ? 'ew-resize' : 'ns-resize' }
        : {}),
      // A drag must not start a text selection of the tick labels.
      userSelect: 'none' as const,
      // The strip owns the wheel where it takes it, so a two-finger scroll
      // zooms rather than scrolling the page.
      ...(spec.wheel ? { touchAction: 'none' as const } : {}),
    },
    consumeDrag,
  };
}
