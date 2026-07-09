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
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Canvas } from './Canvas.js';
import { drawGrid, drawDividers, thinPixels } from './grid.js';
import { cursorParts } from './tracker.js';
import { resolveSelection } from './select.js';
import {
  panRange,
  zoomRange,
  panRangeTrading,
  zoomRangeTrading,
} from './viewport.js';
import { flagChipStyle, flagChipX, axisPillX, axisPillStyle } from './chip.js';
import {
  ContainerContext,
  LayersContext,
  RowContext,
  type LayerRegistry,
} from './context.js';

/** Gridline tick count — matches the axes (`YAxis`/`TimeAxis`) so they align. */
const GRID_TICKS = 5;
/** Minimum px between session dividers — thins dense collapse points (e.g. a
 *  daily chart where every candle is a new session) so the axis never crowds. */
const MIN_DIVIDER_PX = 40;

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
  const { layers, yScales, formats, defaultAxisId, tickValues, axisSides } =
    row;
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
      // Explicit `<YAxis ticks>` drive the gridlines too, so they align with the
      // axis labels; otherwise d3 auto-picks (the default).
      const explicitY = tickValues.get(defaultAxisId);
      const xTicks = xScale.ticks(GRID_TICKS).map((d) => xScale(+d));
      const yTicks = gridY
        ? (explicitY ?? gridY.ticks(GRID_TICKS)).map((t) => gridY(t))
        : [];
      drawGrid(ctx, xTicks, yTicks, w, h, gridColor, gridDash);
      // Session dividers: solid verticals at the trading calendar's collapse
      // points (session/day opens), where closed time was removed from the axis.
      const boundaries = container.discontinuities?.boundaries;
      if (boundaries) {
        const [d0, d1] = container.timeRange;
        const bx = boundaries(d0, d1).map((t) => xScale(t));
        const dividerColor = container.theme.axis.sessionDivider ?? gridColor;
        drawDividers(ctx, thinPixels(bx, MIN_DIVIDER_PX), h, dividerColor);
      }
      for (const entry of layers) {
        const yScale = yScales.get(entry.axisId ?? defaultAxisId);
        if (yScale === undefined) continue;
        entry.layer.draw(ctx, xScale, yScale);
      }
    },
    [
      layers,
      yScales,
      xScale,
      defaultAxisId,
      tickValues,
      background,
      gridColor,
      gridDash,
      container.discontinuities,
      container.timeRange,
    ],
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
  // Editing suppresses the data cursor — the marks get the surface (hover/drag),
  // and a crosshair would just be noise. True in global edit mode *and* while a
  // single annotation is being edited (the double-click target).
  const editingActive =
    container.editAnnotations || container.annotations.some((a) => a.editing);
  const parts = editingActive
    ? cursorParts('none')
    : cursorParts(row.cursor ?? container.cursor);
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
      side: 'left' | 'right';
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
      // Which gutter the crosshair value pill hugs (the axis's own side).
      const side = axisSides.get(axisId) ?? 'left';
      for (const s of entry.layer.sampleAt(cursorTime)) {
        out.push({
          px: xScale(s.x),
          py: yScale(s.value),
          value: s.value,
          color: s.color,
          format: fmt,
          side,
        });
      }
    }
    return out;
  }, [
    cursorTime,
    layers,
    yScales,
    formats,
    axisSides,
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
    // Whether the pan has committed (moved past the slop) and so claimed the
    // pointer. Deferred from press → first real move so a click doesn't capture;
    // see handlePointerDown / handlePointerMove.
    captured: boolean;
  } | null>(null);
  // Row read through a ref so the click handler hit-tests the latest layers +
  // y-scales without re-subscribing (same after-commit discipline as containerRef).
  const rowRef = useRef(row);
  useLayoutEffect(() => {
    rowRef.current = row;
  });
  // Pointer-down position, to tell a click (select) from the tail of a drag/pan.
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);
  // Create gesture (when a tool is armed): `createPt` is the live pointer driving
  // the preview on the hovered row; `drawFrom` is a region's fixed start edge (px)
  // once pressed. `drawFromRef` mirrors it for the stable up-handler to read.
  const [createPt, setCreatePt] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [drawFrom, setDrawFrom] = useState<number | null>(null);
  const drawFromRef = useRef<number | null>(null);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      clickStartRef.current = { x: e.clientX, y: e.clientY };
      const c = containerRef.current;
      if (c.creating !== null) {
        // Armed: a region presses to fix its start edge; a line just tracks until
        // release. Capture so the draw can continue outside the plot.
        if (c.creating === 'region') {
          const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
          drawFromRef.current = px;
          setDrawFrom(px);
        }
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        return;
      }
      if (!c.panZoom) return;
      const r = c.timeRange;
      // Arm a potential pan: record the anchor, but DON'T capture the pointer or
      // hide the tracker yet. Capturing on press retargets the eventual `click`
      // to the plot (Pointer Events spec: a captured pointer's compatibility
      // mouse events fire on the capture target) — which silently swallows a
      // click-select on a *selectable but non-editable* mark, whose press bubbles
      // up to here (its DragArea deliberately lets a non-edit press through so a
      // pan can read past it). The pan commits — capture + hide tracker — only
      // once the pointer moves past the slop (handlePointerMove); a press that
      // stays put is a click, and leaving the pointer on the mark lets its
      // onClick fire. Pan-through (drag starting on a non-editable mark) is
      // unaffected: the first move past the slop still reaches this handler and
      // captures then.
      dragRef.current = {
        startX: e.clientX,
        startRange: [r[0], r[1]],
        captured: false,
      };
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const c = containerRef.current;
      if (c.creating !== null) {
        const rect = e.currentTarget.getBoundingClientRect();
        const px = Math.max(0, Math.min(c.plotWidth, e.clientX - rect.left));
        setCreatePt({ x: px, y: e.clientY - rect.top });
        c.setHoverX(px); // share the preview x so other rows draw a guide there
        return;
      }
      // A pan is only live while a button is held. A move with no buttons means
      // the press already ended without us seeing the pointerup — which the
      // deferred-capture path allows: an uncommitted (sub-slop) potential-pan
      // released *outside* the plot never captured, so its pointerup fires
      // off-plot and never reaches handlePointerUp. Drop the stale dragRef here
      // (and fall through to hover) so it can't fire a phantom pan on re-entry.
      // A genuine pan-in-progress always has buttons !== 0, so this never cuts
      // one short — including the press-leave-then-return-still-holding case.
      if (dragRef.current && e.buttons === 0) dragRef.current = null;
      const drag = dragRef.current;
      if (drag) {
        // Pan from the start range by the total drag — right → earlier (−dt).
        const dx = e.clientX - drag.startX;
        // Don't pan until past the slop, so a click's 1–4px jitter neither moves
        // the view nor shifts the scale the click then hit-tests against.
        if (Math.abs(dx) <= DRAG_SLOP) return;
        // First move past the slop ⇒ this is a real pan, not a click. Commit it
        // now (deferred from press, see handlePointerDown): hide the tracker and
        // claim the pointer so the pan keeps tracking outside the plot. Capturing
        // here — after the click/select decision is already moot — is what keeps a
        // tap-select on a non-editable mark working while a drag still pans.
        if (!drag.captured) {
          drag.captured = true;
          c.setHoverX(null); // hide the tracker while panning
          c.setHoverY(null, null);
          c.setHovered(null); // and drop any hover-highlight
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* ignore (synthetic / already-released pointer) */
          }
        }
        if (c.discontinuities) {
          // Trading-time axis: pan by an equal amount of *trading* time so the
          // drag feels uniform across collapsed gaps (a raw-ms shift jumps).
          const fraction = c.plotWidth > 0 ? -dx / c.plotWidth : 0;
          c.applyRange(
            panRangeTrading(drag.startRange, fraction, c.discontinuities),
          );
        } else {
          const span = drag.startRange[1] - drag.startRange[0];
          const dt = c.plotWidth > 0 ? -dx * (span / c.plotWidth) : 0;
          c.applyRange(panRange(drag.startRange, dt));
        }
        return; // tracker suppressed during a pan
      }
      const rect = e.currentTarget.getBoundingClientRect();
      const r = rowRef.current;
      const rawX = Math.max(0, Math.min(c.plotWidth, e.clientX - rect.left));
      const py = Math.max(0, Math.min(r.height, e.clientY - rect.top));
      // Crosshair with `crosshairSnap` (default): snap the shared vertical line to
      // the nearest sample's x, so the reticle centres on a real data point (and
      // stays aligned across rows on a shared grid). Free mode keeps the raw x.
      // Crosshair always snaps the shared vertical line (and so the x-time pill)
      // to the nearest sample's x — the reticle rides the data grid on x, giving a
      // clean time readout (a raw pointer time formats to unreadable sub-second
      // precision). `crosshairSnap` only governs the *y* (snap to the value vs a
      // free horizontal line at the pointer). This is ChartIQ's model.
      let px = rawX;
      if ((r.cursor ?? c.cursor) === 'crosshair') {
        const t = +c.xScale.invert(rawX);
        for (const entry of r.layers) {
          if (entry.layer.cursorFlag) continue;
          const s = entry.layer.sampleAt(t)[0];
          if (s !== undefined) {
            px = c.xScale(s.x);
            break;
          }
        }
      }
      c.setHoverX(px);
      c.setHoverY(py, r.rowKey);
      // Hover-highlight: hit-test the row's selectable layers (Bar) under the
      // pointer and set the hovered mark. Deduped in the container, so the data
      // canvas repaints only on a mark transition — not every move (the move just
      // slides the SVG cursor). A row with no selectable layer (line/area/band)
      // resolves to null → a no-op. Uses the raw pointer, not the snapped x.
      const hit = resolveSelection(r.layers, rawX, py, c.xScale, (axisId) =>
        r.yScales.get(axisId ?? r.defaultAxisId),
      );
      c.setHovered(hit);
    },
    [],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const c = containerRef.current;
      if (c.creating !== null) {
        const rect = e.currentTarget.getBoundingClientRect();
        const px = Math.max(0, Math.min(c.plotWidth, e.clientX - rect.left));
        const py = e.clientY - rect.top;
        if (c.creating === 'marker') {
          c.onCreate?.({ kind: 'marker', at: +c.xScale.invert(px) });
        } else if (c.creating === 'baseline') {
          const r = rowRef.current;
          const ys = r.yScales.get(r.defaultAxisId);
          if (ys) {
            c.onCreate?.({
              kind: 'baseline',
              value: ys.invert(py),
              axis: r.defaultAxisId,
            });
          }
        } else if (c.creating === 'region') {
          const fromPx = drawFromRef.current;
          // Need a real drag — a click (no span) creates nothing.
          if (fromPx !== null && Math.abs(px - fromPx) > DRAG_SLOP) {
            const a = +c.xScale.invert(fromPx);
            const b = +c.xScale.invert(px);
            c.onCreate?.({
              kind: 'region',
              from: Math.min(a, b),
              to: Math.max(a, b),
            });
          }
        }
        drawFromRef.current = null;
        setDrawFrom(null);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        return;
      }
      const drag = dragRef.current;
      if (drag) {
        dragRef.current = null;
        // Only release if the pan actually committed + captured (a click never
        // captured, so there's nothing to release).
        if (drag.captured) {
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
        }
      }
    },
    [],
  );
  const handlePointerLeave = useCallback(() => {
    const c = containerRef.current;
    if (c.creating !== null) {
      // Leaving mid-arm cancels the preview (and an in-progress region draw).
      setCreatePt(null);
      drawFromRef.current = null;
      setDrawFrom(null);
      c.setHoverX(null);
      c.setHoverY(null, null);
      return;
    }
    c.setHoverX(null);
    c.setHoverY(null, null);
    c.setHovered(null);
  }, []);
  // Click selection: ignore the click that ends a drag/pan (moved past a few px),
  // else hit-test the row's layers top-down and select — or clear on a miss.
  const handleClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (containerRef.current.creating !== null) return; // the draw owns the click
    const start = clickStartRef.current;
    if (
      start &&
      Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_SLOP
    )
      return;
    const c = containerRef.current;
    // A click that reached the plot (no mark's DragArea claimed it) is an empty
    // click. Deselect / exit edit when the consumer is tracking annotations — in
    // global edit mode, or whenever a mark is currently active: selected, OR the
    // single-edit target (`editing`). Checking `editing` too means a consumer that
    // sets `editing` without also setting `selected` still gets the exit signal.
    // Marks stop their own clicks in DragArea, so this only fires on true empty space.
    if (
      c.editAnnotations ||
      c.annotations.some((a) => a.selected || a.editing)
    ) {
      c.onSelectAnnotation?.(null);
      return;
    }
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
      c.applyRange(
        c.discontinuities
          ? // minDuration is the zoom-in floor; on a trading-time axis it caps
            // the minimum visible *trading* time (ms of open-market time) rather
            // than wall-clock ms — the sensible meaning for this axis.
            zoomRangeTrading(
              c.timeRange,
              pivot,
              factor,
              c.discontinuities,
              c.minDuration,
            )
          : zoomRange(c.timeRange, pivot, factor, c.minDuration),
      );
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
  // Crosshair (`chip: 'axis'`) is excluded: it pins the time to the shared x-axis
  // pill (`<XAxis>`), so a per-row chip here would double it (and land wrong on a
  // stacked row).
  const showTime =
    showCursorTime &&
    cursorTime !== null &&
    (parts.line || parts.dots) &&
    parts.chip !== 'axis' &&
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

  // Crosshair reticle (`chip: 'axis'`): a single centre for THIS row — the
  // horizontal line + centre dot + value pill anchor to `center.py` (the vertical
  // line is the shared `cursorX`, drawn in every row). Snap: the sample nearest
  // the pointer y in the hovered row (or the first sample when nothing's hovered,
  // e.g. a pinned demo — so every row shows a reticle then). Free: the raw pointer
  // y in the hovered row, its value via `yScale.invert`. `null` ⇒ vertical only.
  const cursorInBounds =
    cursorX !== null && cursorX >= 0 && cursorX <= plotWidth;
  const reticle: {
    py: number;
    value: number;
    format: (v: number) => string;
    side: 'left' | 'right';
  } | null = (() => {
    if (parts.chip !== 'axis' || !cursorInBounds) return null;
    const hoveredRow = container.cursorRowKey === row.rowKey;
    const cy = container.cursorY;
    if (container.crosshairSnap) {
      if (trackerSamples.length === 0) return null;
      const pick =
        hoveredRow && cy !== null
          ? trackerSamples.reduce((a, b) =>
              Math.abs(b.py - cy) < Math.abs(a.py - cy) ? b : a,
            )
          : container.cursorRowKey === null
            ? trackerSamples[0]!
            : null;
      return pick
        ? {
            py: pick.py,
            value: pick.value,
            format: pick.format,
            side: pick.side,
          }
        : null;
    }
    // Free reticle — the raw pointer y in the hovered row.
    if (!hoveredRow || cy === null) return null;
    const ys = yScales.get(defaultAxisId);
    if (ys === undefined) return null;
    return {
      py: cy,
      value: ys.invert(cy),
      format: formats.get(defaultAxisId) ?? String,
      side: axisSides.get(defaultAxisId) ?? 'left',
    };
  })();

  // Cross-row guide lines: the x-positions of annotations on the OTHER rows
  // (markers + region edges), so a mark on one row reads against this row's data +
  // the shared x axis. A mark's own row skips itself; baselines cast no vertical
  // guide (empty `xs`). Faint + dashed so they read as reference, not data.
  const guideXs = container.annotations
    .filter((a) => a.rowKey !== row.rowKey)
    .flatMap((a) => a.xs)
    .map((xv) => xScale(xv));
  const guideColor = container.theme.annotation?.color ?? gridColor;

  // Create preview: while a tool is armed, the hovered row (the one with
  // `createPt`) shows a cursor-style line tracking the pointer — vertical for
  // marker/region, horizontal for baseline, a span once a region is being dragged.
  // The OTHER rows show the faint guide at the shared preview x (markers/regions).
  const creating = container.creating;
  let createPreview: ReactNode = null;
  if (creating !== null && createPt !== null) {
    if (creating === 'baseline') {
      createPreview = (
        <line
          x1={0}
          y1={createPt.y}
          x2={plotWidth}
          y2={createPt.y}
          stroke={guideColor}
          strokeWidth={1}
          opacity={0.85}
          shapeRendering="crispEdges"
        />
      );
    } else if (drawFrom !== null) {
      const l = Math.min(drawFrom, createPt.x);
      const w = Math.abs(createPt.x - drawFrom);
      createPreview = (
        <>
          <rect
            x={l}
            y={0}
            width={w}
            height={row.height}
            fill={guideColor}
            opacity={0.12}
          />
          <line
            x1={drawFrom}
            y1={0}
            x2={drawFrom}
            y2={row.height}
            stroke={guideColor}
            strokeWidth={1}
            opacity={0.85}
            strokeDasharray="3 2"
            shapeRendering="crispEdges"
          />
          <line
            x1={createPt.x}
            y1={0}
            x2={createPt.x}
            y2={row.height}
            stroke={guideColor}
            strokeWidth={1}
            opacity={0.85}
            shapeRendering="crispEdges"
          />
        </>
      );
    } else {
      createPreview = (
        <line
          x1={createPt.x}
          y1={0}
          x2={createPt.x}
          y2={row.height}
          stroke={guideColor}
          strokeWidth={1}
          opacity={0.85}
          shapeRendering="crispEdges"
        />
      );
    }
  } else if (creating !== null && creating !== 'baseline' && cursorX !== null) {
    // Another row — the faint preview guide at the shared pointer x.
    createPreview = (
      <line
        x1={cursorX}
        y1={0}
        x2={cursorX}
        y2={row.height}
        stroke={guideColor}
        strokeWidth={1}
        opacity={0.22}
        strokeDasharray="2 3"
        shapeRendering="crispEdges"
      />
    );
  }

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
          // Edit mode: a plain cursor on the plot (the annotations supply their
          // own grab/resize cursors); crosshair only when the data cursor is live
          // (suppressed in single-annotation edit too, not just global edit).
          cursor: editingActive ? 'default' : 'crosshair',
          // The turquoise edit border — the "you're in *global* Edit" signal (not
          // single-annotation edit). Inset shadow so it doesn't shift layout.
          boxShadow: container.editAnnotations
            ? `inset 0 0 0 1px ${guideColor}`
            : undefined,
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
        {/* Cross-row guides: faint dashed lines at the other rows' mark
            x-positions, below this row's own annotations + the cursor. */}
        {guideXs.length > 0 && (
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
            {guideXs.map((gx, i) => (
              <line
                key={i}
                x1={gx}
                y1={0}
                x2={gx}
                y2={row.height}
                stroke={guideColor}
                strokeWidth={1}
                opacity={0.22}
                strokeDasharray="2 3"
                shapeRendering="crispEdges"
              />
            ))}
          </svg>
        )}
        {/* Create preview — the armed tool's line/region tracking the pointer. */}
        {createPreview !== null && (
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
            {createPreview}
          </svg>
        )}
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
          {/* Crosshair reticle: a full-height dashed vertical line (the shared
              cursor x, in every row) + — in the row with a centre — a full-width
              dashed horizontal line and a centre dot at the value. */}
          {parts.chip === 'axis' &&
            cursorX !== null &&
            cursorX >= 0 &&
            cursorX <= plotWidth && (
              <>
                <line
                  x1={Math.round(cursorX)}
                  y1={0}
                  x2={Math.round(cursorX)}
                  y2={row.height}
                  stroke={cursorColor}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  shapeRendering="crispEdges"
                />
                {reticle && (
                  <>
                    <line
                      x1={0}
                      y1={Math.round(reticle.py)}
                      x2={plotWidth}
                      y2={Math.round(reticle.py)}
                      stroke={cursorColor}
                      strokeWidth={1}
                      strokeDasharray="3 3"
                      shapeRendering="crispEdges"
                    />
                    <circle
                      cx={cursorX}
                      cy={reticle.py}
                      r={3}
                      fill={cursorColor}
                      stroke={background}
                      strokeWidth={background ? 1 : 0}
                    />
                  </>
                )}
              </>
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
        {/* Cursor time atop the readout (opt-in); the `!== null` checks gate to
            an in-bounds, active cursor and narrow the types. The time is **plain
            text, no chip background** — only the value flags below it are filled
            panels. */}
        {showTime && timeX !== null && cursorTime !== null && (
          <div
            style={{
              ...chipStyle,
              background: 'transparent',
              padding: 0,
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
        {/* Crosshair value pill: the reticle's centre value, on the axis gutter
            (`zIndex` over the sibling axis column — the same placement as
            YAxisIndicator's default), clamped inside the row. */}
        {reticle && (
          <div
            style={{
              ...axisPillStyle(container.theme, cursorColor),
              top: `${Math.max(
                flagLineHeight / 2,
                Math.min(row.height - flagLineHeight / 2, reticle.py),
              )}px`,
              transform: 'translateY(-50%)',
              ...axisPillX(reticle.side, plotWidth),
            }}
          >
            {reticle.format(reticle.value)}
          </div>
        )}
        {parts.chip === 'flag' &&
          cursorX !== null &&
          trackerSamples.map((s, i) => (
            // The flag flies from the top of its staff — chip top at the staff top
            // (`flagBase`), beside the pole at the point's x (shared `flagChipX`).
            <div
              key={i}
              style={{
                ...chipStyle,
                top: `${flagBase}px`,
                ...flagChipX(s.px, plotWidth),
                color: s.color,
              }}
            >
              {s.format(s.value)}
            </div>
          ))}
        {/* Box flag: one chip listing all the box's values, each coloured to its
            piece, anchored at the box's centre x (atop its staff). */}
        {parts.chip === 'flag' &&
          trackerFlags.map((f, i) => (
            <div
              key={`boxflag-${i}`}
              style={{
                ...chipStyle,
                top: `${flagBase}px`,
                ...flagChipX(f.px, plotWidth),
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
          ))}
      </div>
    </LayersContext.Provider>
  );
}
