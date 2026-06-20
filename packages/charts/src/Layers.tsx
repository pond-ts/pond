import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Canvas } from './Canvas.js';
import { drawGrid } from './grid.js';
import { drawCrosshair, drawTrackerDot } from './tracker.js';
import { resolveSelection } from './select.js';
import { panRange, zoomRange } from './viewport.js';
import {
  ContainerContext,
  LayersContext,
  RowContext,
  type LayerRegistry,
} from './context.js';

/** Gridline tick count — matches the axes (`YAxis`/`TimeAxis`) so they align. */
const GRID_TICKS = 5;

/** Wheel-zoom sensitivity: `factor = exp(deltaY * k)` (one ~100px notch ≈ ±15%). */
const ZOOM_SENSITIVITY = 0.0015;

/** Pointer slop (px): a drag must exceed this before it pans, and a click within
 *  it still selects. One threshold for both so a click never also nudges the pan
 *  (and never hit-tests against a shifted scale). */
const DRAG_SLOP = 4;

/** Past this fraction of the plot, a readout label flips left of its dot so it
 *  doesn't overflow the right edge. */
const LABEL_FLIP_FRACTION = 0.85;

/** Compact value formatting for the scrub readout — ≤2 decimals, no trailing
 *  zeros. (Per-axis formatting is a separate axis-backlog item.) */
function formatValue(v: number): string {
  return String(Math.round(v * 100) / 100);
}

export interface LayersProps {
  children?: ReactNode;
}

/**
 * The plot area of a {@link ChartRow}: a single `<canvas>` plus the draw-layer
 * registry. It is the boundary where the row's horizontal layout flips to
 * z-stacking — child layers ({@link LineChart}, …) register here and paint into
 * the one canvas, each with its own axis's y-scale (looked up by the layer's
 * `axis` id, defaulting to the row's default axis).
 *
 * **Z-order — declaration order, last child on top** (SVG / DOM / RTC). A row is
 * authored back-to-front: `<BandChart/>` then `<LineChart/>` puts the line over
 * its band. Order comes from each child's **injected JSX index** (so the stack
 * follows the markup regardless of mount timing — a layer toggled in between two
 * others slots into place, not onto the top), and each layer keeps a stable,
 * id-keyed slot so a series/style update holds its position (no jump to the
 * front — the trap that bites live charts). Draw layers must be **direct
 * children** of `<Layers>` for the index to reach them.
 */
export function Layers({ children }: LayersProps) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<Layers> must be rendered inside a <ChartContainer>');
  }
  const row = useContext(RowContext);
  if (row === null) {
    throw new Error('<Layers> must be rendered inside a <ChartRow>');
  }

  const registry = useMemo<LayerRegistry>(
    () => ({
      registerLayer: row.registerLayer,
      unregisterLayer: row.unregisterLayer,
    }),
    [row.registerLayer, row.unregisterLayer],
  );

  const background = container.theme.background;
  const { grid: gridColor, gridDash } = container.theme.axis;
  const { layers, yScales, defaultAxisId } = row;
  // x geometry is shared and lives on the container (uniform across rows).
  const { xScale, plotWidth } = container;
  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (background !== undefined) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
      }
      // Gridlines behind the data, from the same ticks the axes label: vertical
      // from the shared time scale, horizontal from the row's default y-axis.
      const gridY = yScales.get(defaultAxisId);
      const xTicks = xScale.ticks(GRID_TICKS).map((d) => xScale(d));
      const yTicks = gridY ? gridY.ticks(GRID_TICKS).map((t) => gridY(t)) : [];
      drawGrid(ctx, xTicks, yTicks, w, h, gridColor, gridDash);
      for (const entry of layers) {
        const yScale = yScales.get(entry.axisId ?? defaultAxisId);
        if (yScale === undefined) continue;
        entry.layer.draw(ctx, xScale, yScale);
      }
    },
    [layers, yScales, xScale, defaultAxisId, background, gridColor, gridDash],
  );

  // Interaction overlay: a crosshair at the shared cursor pixel, on a second
  // canvas above the data so hovering never repaints the data layers (the data
  // canvas's `draw` doesn't depend on the cursor). Reading the container's
  // cursorX — set by whichever row the pointer is over — syncs the cursor across
  // every row for free. cursorX is a *pixel*, so it stays put while a live window
  // slides; the time + values under it derive from the current xScale.
  const { cursorX, readout } = container;
  const cursorColor = container.theme.cursor ?? container.theme.axis.label;
  // Only read a time when the cursor is within the plot. An out-of-bounds
  // controlled trackerPosition hides the crosshair (overlay guard below), so the
  // dots + chips must hide too — gating cursorTime makes trackerSamples empty,
  // which drives both the canvas dots and the DOM chip branches.
  const cursorTime =
    cursorX !== null && cursorX >= 0 && cursorX <= plotWidth
      ? +xScale.invert(cursorX)
      : null;

  // Per-layer readout samples at the cursor time (nearest data point) — pixel
  // position + value + colour. Drives the overlay dots and the DOM value labels;
  // recomputes as the cursor moves or the window slides under it. Empty when not
  // hovering, so the data canvas is never touched.
  const trackerSamples = useMemo(() => {
    if (cursorTime === null) return [];
    const out: { px: number; py: number; value: number; color: string }[] = [];
    for (const entry of layers) {
      const yScale = yScales.get(entry.axisId ?? defaultAxisId);
      if (yScale === undefined) continue;
      for (const s of entry.layer.sampleAt(cursorTime)) {
        out.push({
          px: xScale(s.x),
          py: yScale(s.value),
          value: s.value,
          color: s.color,
        });
      }
    }
    return out;
  }, [cursorTime, layers, yScales, xScale, defaultAxisId]);

  const overlayDraw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (cursorX === null || cursorX < 0 || cursorX > w) return;
      drawCrosshair(ctx, cursorX, h, cursorColor);
      for (const s of trackerSamples) {
        drawTrackerDot(ctx, s.px, s.py, s.color, background);
      }
    },
    [cursorX, cursorColor, trackerSamples, background],
  );

  // Pan/zoom + tracker share the plot's event surface. Container fields are read
  // through a ref so the handlers + the (once-attached) wheel listener always see
  // the latest frame without re-subscribing. Written after commit (not in render)
  // so a wheel/pointer event can't read a frame that was abandoned mid-render
  // under concurrent rendering.
  const containerRef = useRef(container);
  useLayoutEffect(() => {
    containerRef.current = container;
  });
  const plotRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number;
    startRange: [number, number];
  } | null>(null);
  // Row read through a ref so the click handler hit-tests the latest layers +
  // y-scales without re-subscribing (same after-commit discipline as containerRef).
  const rowRef = useRef(row);
  useLayoutEffect(() => {
    rowRef.current = row;
  });
  // Pointer-down position, to tell a click (select) from the tail of a drag/pan.
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      clickStartRef.current = { x: e.clientX, y: e.clientY };
      const c = containerRef.current;
      if (!c.panZoom) return;
      const r = c.timeRange;
      dragRef.current = { startX: e.clientX, startRange: [r[0], r[1]] };
      c.setHoverX(null); // hide the tracker while panning
      // Capture so the pan continues outside the plot; an enhancement, not
      // critical — guard the throw for synthetic / already-released pointers.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const c = containerRef.current;
      const drag = dragRef.current;
      if (drag) {
        // Pan from the start range by the total drag — right → earlier (−dt).
        const dx = e.clientX - drag.startX;
        // Don't pan until past the slop, so a click's 1–4px jitter neither moves
        // the view nor shifts the scale the click then hit-tests against.
        if (Math.abs(dx) <= DRAG_SLOP) return;
        const span = drag.startRange[1] - drag.startRange[0];
        const dt = c.plotWidth > 0 ? -dx * (span / c.plotWidth) : 0;
        c.applyRange(panRange(drag.startRange, dt));
        return; // tracker suppressed during a pan
      }
      const rect = e.currentTarget.getBoundingClientRect();
      c.setHoverX(Math.max(0, Math.min(c.plotWidth, e.clientX - rect.left)));
    },
    [],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current) {
        dragRef.current = null;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );
  const handlePointerLeave = useCallback(
    () => containerRef.current.setHoverX(null),
    [],
  );
  // Click selection: ignore the click that ends a drag/pan (moved past a few px),
  // else hit-test the row's layers top-down and select — or clear on a miss.
  const handleClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const start = clickStartRef.current;
    if (
      start &&
      Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_SLOP
    )
      return;
    const c = containerRef.current;
    const r = rowRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = resolveSelection(
      r.layers,
      e.clientX - rect.left,
      e.clientY - rect.top,
      c.xScale,
      (axisId) => r.yScales.get(axisId ?? r.defaultAxisId),
    );
    c.select(hit);
  }, []);

  // Wheel-zoom — a native non-passive listener so `preventDefault` works (React's
  // onWheel is passive). Attached once; no-ops (and lets the page scroll) when
  // panZoom is off.
  useEffect(() => {
    const el = plotRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      const c = containerRef.current;
      if (!c.panZoom) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const localX = Math.max(0, Math.min(c.plotWidth, e.clientX - rect.left));
      const pivot = +c.xScale.invert(localX);
      const factor = Math.exp(e.deltaY * ZOOM_SENSITIVITY);
      c.applyRange(zoomRange(c.timeRange, pivot, factor, c.minDuration));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Readout value chips (the crosshair + dots always show; only the value text
  // is modal). 'none' keeps values out of the plot — surface them outside via
  // onTrackerChanged. 'inline' chips sit beside each dot; 'flag' chips stack at
  // the top of the crosshair.
  const flagLineHeight = container.theme.font.size + 5;
  const chipStyle: CSSProperties = {
    position: 'absolute',
    background: container.theme.chip?.background,
    border: `1px solid ${gridColor}`,
    borderRadius: '3px',
    padding: '0 4px',
    fontFamily: container.theme.font.family,
    fontSize: `${container.theme.font.size}px`,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    lineHeight: 1.5,
  };

  // Inject each draw layer's JSX position so it registers its declaration order
  // (z-stack: lower index at the back), independent of mount timing.
  const indexedChildren = Children.map(children, (child, index) =>
    isValidElement(child)
      ? cloneElement(child as ReactElement<{ index?: number }>, { index })
      : child,
  );

  return (
    <LayersContext.Provider value={registry}>
      <div
        ref={plotRef}
        style={{
          position: 'relative',
          width: `${plotWidth}px`,
          height: `${row.height}px`,
          cursor: 'crosshair',
          // Let pan/zoom own touch gestures (no native scroll) when enabled.
          touchAction: container.panZoom ? 'none' : 'auto',
        }}
        onPointerMove={handlePointerMove}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
      >
        <Canvas width={plotWidth} height={row.height} draw={draw} />
        <Canvas
          width={plotWidth}
          height={row.height}
          draw={overlayDraw}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'none',
          }}
        />
        {readout === 'inline' &&
          trackerSamples.map((s, i) => {
            // Flip the chip left of its dot near the right edge so it stays in-plot.
            const flip = s.px > plotWidth * LABEL_FLIP_FRACTION;
            return (
              <div
                key={i}
                style={{
                  ...chipStyle,
                  top: `${s.py}px`,
                  transform: 'translateY(-50%)',
                  left: flip ? undefined : `${s.px + 8}px`,
                  right: flip ? `${plotWidth - s.px + 8}px` : undefined,
                  color: s.color,
                }}
              >
                {formatValue(s.value)}
              </div>
            );
          })}
        {readout === 'flag' &&
          cursorX !== null &&
          trackerSamples.map((s, i) => {
            // Flags stack at the top of the crosshair; flip near the right edge.
            const flip = cursorX > plotWidth * LABEL_FLIP_FRACTION;
            return (
              <div
                key={i}
                style={{
                  ...chipStyle,
                  top: `${2 + i * flagLineHeight}px`,
                  left: flip ? undefined : `${cursorX + 4}px`,
                  right: flip ? `${plotWidth - cursorX + 4}px` : undefined,
                  color: s.color,
                }}
              >
                {formatValue(s.value)}
              </div>
            );
          })}
      </div>
      {indexedChildren}
    </LayersContext.Provider>
  );
}
