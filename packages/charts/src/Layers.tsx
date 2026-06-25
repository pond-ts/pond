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
import { cursorParts } from './tracker.js';
import { resolveSelection } from './select.js';
import { panRange, zoomRange } from './viewport.js';
import { flagChipStyle } from './chip.js';
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
  const { layers, yScales, formats, defaultAxisId } = row;
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

  // Interaction overlay: the cursor marks live on a DOM/SVG overlay above the
  // data, so hovering never repaints the data canvas (whose `draw` doesn't depend
  // on the cursor). Reading the container's cursorX — set by whichever row the
  // pointer is over — syncs the cursor across every row for free. cursorX is a
  // *pixel*, so it stays put while a live window slides; the time + values under
  // it derive from the current xScale.
  const { cursorX, cursorTime: showCursorTime, formatTime } = container;
  // Cursor mode: the row's override, else the container default. One mode per
  // row (the synced vertical line is shared across rows); each layer renders the
  // mode in its own way. `parts` decomposes it into {line, dots, chip}.
  const parts = cursorParts(row.cursor ?? container.cursor);
  const cursorColor = container.theme.cursor ?? container.theme.axis.label;
  // Only read a time when the cursor is within the plot. An out-of-bounds
  // controlled trackerPosition hides the cursor, so the dots + chips hide too —
  // gating cursorTime makes trackerSamples empty, which drives both the SVG marks
  // and the DOM chip branches.
  const cursorTime =
    cursorX !== null && cursorX >= 0 && cursorX <= plotWidth
      ? +xScale.invert(cursorX)
      : null;

  // Per-layer readout samples at the cursor time (nearest data point) — pixel
  // position + value + colour. Drives the overlay dots and the DOM value labels;
  // recomputes as the cursor moves or the window slides under it. Empty when not
  // hovering, so the data canvas is never touched.
  const trackerSamples = useMemo(() => {
    // Only needed for the in-chart dots / chips; skip the per-layer walk when the
    // mode shows neither (the off-chart readout fans in separately on the container).
    if (cursorTime === null || (!parts.dots && parts.chip === 'none'))
      return [];
    const out: {
      px: number;
      py: number;
      value: number;
      color: string;
      format: (v: number) => string;
    }[] = [];
    for (const entry of layers) {
      // A layer with a consolidated flag (BoxPlot) renders that, not per-sample
      // dots/chips — skip it here (its values still fan to the off-chart readout
      // via sampleAt on the container).
      if (entry.layer.cursorFlag) continue;
      const axisId = entry.axisId ?? defaultAxisId;
      const yScale = yScales.get(axisId);
      if (yScale === undefined) continue;
      // The chip uses this layer's axis formatter, so a readout value reads
      // exactly as the axis labels it.
      const fmt = formats.get(axisId) ?? String;
      for (const s of entry.layer.sampleAt(cursorTime)) {
        out.push({
          px: xScale(s.x),
          py: yScale(s.value),
          value: s.value,
          color: s.color,
          format: fmt,
        });
      }
    }
    return out;
  }, [
    cursorTime,
    layers,
    yScales,
    formats,
    xScale,
    defaultAxisId,
    parts.dots,
    parts.chip,
  ]);

  // Consolidated multi-value flags (BoxPlot) — one flag per such layer, only in
  // `flag` mode: all the box's values on one chip, anchored at its top-centre
  // (`px`, `topPy`). Rendered as one staff + one multi-line chip (vs the
  // per-sample dots/chips above), the values each coloured to their box piece.
  const trackerFlags = useMemo(() => {
    if (cursorTime === null || parts.chip !== 'flag') return [];
    const out: {
      px: number;
      topPy: number;
      lines: { text: string; color: string }[];
    }[] = [];
    for (const entry of layers) {
      const flagOf = entry.layer.cursorFlag;
      if (flagOf === undefined) continue;
      const axisId = entry.axisId ?? defaultAxisId;
      const yScale = yScales.get(axisId);
      if (yScale === undefined) continue;
      const fmt = formats.get(axisId) ?? String;
      // `cursorFlag` is an arrow (captures bx/style, no `this`), so a detached
      // call is safe — and avoids re-reading the optional method.
      const f = flagOf(cursorTime);
      if (f === null) continue;
      out.push({
        px: xScale(f.x),
        topPy: yScale(f.topValue),
        lines: f.lines.map((l) => ({ text: fmt(l.value), color: l.color })),
      });
    }
    return out;
  }, [cursorTime, layers, yScales, formats, xScale, defaultAxisId, parts.chip]);

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
      c.setHovered(null); // and drop any hover-highlight
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
      const px = Math.max(0, Math.min(c.plotWidth, e.clientX - rect.left));
      c.setHoverX(px);
      // Hover-highlight: hit-test the row's selectable layers (Bar) under the
      // pointer and set the hovered mark. Deduped in the container, so the data
      // canvas repaints only on a mark transition — not every move (the move just
      // slides the SVG cursor). A row with no selectable layer (line/area/band)
      // resolves to null → a no-op.
      const r = rowRef.current;
      const hit = resolveSelection(
        r.layers,
        px,
        e.clientY - rect.top,
        c.xScale,
        (axisId) => r.yScales.get(axisId ?? r.defaultAxisId),
      );
      c.setHovered(hit);
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
  const handlePointerLeave = useCallback(() => {
    const c = containerRef.current;
    c.setHoverX(null);
    c.setHovered(null);
  }, []);
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

  // Cursor presentation is a DOM/SVG overlay (no cursor canvas): an SVG holds the
  // line / dots / flag staffs; these value chips (DOM, crisp text) sit beside each
  // dot ('inline', clamped within the row) or stack at the top of the flag staff
  // ('flag'). line / point / none draw no chips — surface values off-chart.
  const flagLineHeight = container.theme.font.size + 5;
  // Cursor chips share the annotation label look (filled, no outline) — one
  // source of truth so a flag and a placed label read as the same object.
  const chipStyle = flagChipStyle(container.theme);
  // Show the cursor's time atop the readout (opt-in via `cursorTime`), whenever
  // the cursor is active (any mode that draws marks). A single chip at the cursor
  // x, top of the row; for `flag` it sits above the value chips (which shift down).
  // The time is shared across rows (one cursor, one time), so it shows **once**,
  // atop the first row — not repeated per row. (Gating it here also drops the
  // top-of-stack space reservation on the other rows, see `flagBase`.)
  const showTime =
    showCursorTime &&
    cursorTime !== null &&
    (parts.line || parts.dots) &&
    row.isFirstRow;
  // Flag geometry: each value flies as a flag from the top of its own staff — the
  // chip's top sits at `flagBase` (just below the time chip when shown) and the
  // staff drops from there to the dot. (Chips share that top and spread by x, so
  // near-coincident flags can overlap — a de-overlap heuristic is a follow-up.)
  const flagTop = 2;
  const flagBase = flagTop + (showTime ? flagLineHeight : 0);
  // The cursor-time chip caps the readout. In `flag` mode it tops the flag stack,
  // so anchor it to the stack's x (the nearest sample's point) so time + flag +
  // staff + dot read as one column; otherwise it labels the cursor line at cursorX.
  const timeX =
    parts.chip === 'flag' && trackerSamples.length > 0
      ? trackerSamples[0]!.px
      : cursorX;

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
        {/* Annotation overlays — <Region>/<Baseline>/<Marker> — paint here, above
            the data canvas and below the cursor. Draw layers (LineChart, …)
            co-located here render null (they paint via the canvas `draw`); both
            register through LayersContext. Inside the plot div so annotations
            share its 0..plotWidth × 0..height coordinate space. */}
        {indexedChildren}
        {/* Cursor overlay (SVG, above the data canvas): the synced line, the
            per-series dots, and the flag staffs — all crisp + positioned in plot
            space, no second canvas. Value chips are DOM divs below. */}
        <svg
          width={plotWidth}
          height={row.height}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'none',
          }}
        >
          {parts.line &&
            cursorX !== null &&
            cursorX >= 0 &&
            cursorX <= plotWidth && (
              <line
                x1={Math.round(cursorX)}
                y1={0}
                x2={Math.round(cursorX)}
                y2={row.height}
                stroke={cursorColor}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
            )}
          {/* Flag staffs: a faint pole from the flag's top (`flagBase`) down to
              each dot (skipped when the dot is above that top). */}
          {parts.chip === 'flag' &&
            trackerSamples.map((s, i) =>
              s.py > flagBase ? (
                <line
                  key={`staff-${i}`}
                  x1={s.px}
                  y1={flagBase}
                  x2={s.px}
                  y2={s.py}
                  stroke={cursorColor}
                  strokeWidth={1}
                  opacity={0.5}
                />
              ) : null,
            )}
          {/* Box flags: one staff per consolidated-flag layer, from the flag's
              top (`flagBase`) down to the mark's top-centre (skipped when the
              mark top is above the flag). */}
          {parts.chip === 'flag' &&
            trackerFlags.map((f, i) =>
              f.topPy > flagBase ? (
                <line
                  key={`boxstaff-${i}`}
                  x1={f.px}
                  y1={flagBase}
                  x2={f.px}
                  y2={f.topPy}
                  stroke={cursorColor}
                  strokeWidth={1}
                  opacity={0.5}
                />
              ) : null,
            )}
          {parts.dots &&
            trackerSamples.map((s, i) => (
              <circle
                key={`dot-${i}`}
                cx={s.px}
                cy={s.py}
                r={3}
                fill={s.color}
                stroke={background}
                strokeWidth={background ? 1 : 0}
              />
            ))}
        </svg>
        {/* Cursor-time chip atop the readout (opt-in); the `!== null` checks gate
            to an in-bounds, active cursor and narrow the types. */}
        {showTime && timeX !== null && cursorTime !== null && (
          <div
            style={{
              ...chipStyle,
              top: `${flagTop}px`,
              left:
                timeX > plotWidth * LABEL_FLIP_FRACTION
                  ? undefined
                  : `${timeX + 4}px`,
              right:
                timeX > plotWidth * LABEL_FLIP_FRACTION
                  ? `${plotWidth - timeX + 4}px`
                  : undefined,
              color: cursorColor,
            }}
          >
            {formatTime(cursorTime)}
          </div>
        )}
        {parts.chip === 'inline' &&
          trackerSamples.map((s, i) => {
            // Flip the chip left of its dot near the right edge so it stays in-plot.
            const flip = s.px > plotWidth * LABEL_FLIP_FRACTION;
            // Clamp within the row so a chip near the top/bottom isn't clipped by
            // (or spilling into) the neighbouring row. Chip-vs-chip de-overlap is
            // a later refinement; this keeps each chip inside its own row.
            const top = Math.max(
              flagLineHeight / 2,
              Math.min(row.height - flagLineHeight / 2, s.py),
            );
            return (
              <div
                key={i}
                style={{
                  ...chipStyle,
                  top: `${top}px`,
                  transform: 'translateY(-50%)',
                  left: flip ? undefined : `${s.px + 8}px`,
                  right: flip ? `${plotWidth - s.px + 8}px` : undefined,
                  color: s.color,
                }}
              >
                {s.format(s.value)}
              </div>
            );
          })}
        {parts.chip === 'flag' &&
          cursorX !== null &&
          trackerSamples.map((s, i) => {
            // The flag flies from the top of its staff — chip top aligned to the
            // staff top (`flagBase`), attached to the pole at the point's x
            // (`s.px`). Flip left near the right edge so it stays in-plot.
            const flip = s.px > plotWidth * LABEL_FLIP_FRACTION;
            return (
              <div
                key={i}
                style={{
                  ...chipStyle,
                  top: `${flagBase}px`,
                  left: flip ? undefined : `${s.px}px`,
                  right: flip ? `${plotWidth - s.px}px` : undefined,
                  color: s.color,
                }}
              >
                {s.format(s.value)}
              </div>
            );
          })}
        {/* Box flag: one chip listing all the box's values, each coloured to its
            piece, anchored at the box's centre x (atop its staff). */}
        {parts.chip === 'flag' &&
          trackerFlags.map((f, i) => {
            const flip = f.px > plotWidth * LABEL_FLIP_FRACTION;
            return (
              <div
                key={`boxflag-${i}`}
                style={{
                  ...chipStyle,
                  top: `${flagBase}px`,
                  left: flip ? undefined : `${f.px}px`,
                  right: flip ? `${plotWidth - f.px}px` : undefined,
                  display: 'flex',
                  flexDirection: 'row',
                  gap: '6px',
                }}
              >
                {f.lines.map((l, j) => (
                  <span key={j} style={{ color: l.color }}>
                    {l.text}
                  </span>
                ))}
              </div>
            );
          })}
      </div>
    </LayersContext.Provider>
  );
}
