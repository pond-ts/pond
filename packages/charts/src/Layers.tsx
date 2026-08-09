import {
  Children,
  cloneElement,
  Fragment,
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
import { drawGrid, drawDividers, dividerAlphas, thinPixels } from './grid.js';
import { bandRect, regionSpan } from './tracker.js';
import { effectiveCursorEntries, gestureOwner } from './cursors.js';
import {
  renderBrushBand,
  resolveBrushClaim,
  resolveRangeDrag,
  warnSweepShadowsRangeDrag,
} from './brush.js';
import { resolveSelection } from './select.js';
import { isDev } from './dev.js';
import {
  panRange,
  zoomRange,
  panRangeTrading,
  zoomRangeTrading,
} from './viewport.js';
import { yTickValues } from './yticks.js';
import {
  ContainerContext,
  CursorContext,
  LayersContext,
  RowContext,
  type ContainerFrame,
  type LayerRegistry,
  type LayerDrawInfo,
  type ResolvedCursorFlag,
  type ResolvedCursorFrame,
  type ResolvedCursorSample,
  type RowFrame,
  type SelectInfo,
  type SelectModifiers,
  type SweepGesture,
  type SweepSession,
} from './context.js';

/** Fallback **y**-gridline tick count, used only before the row publishes its
 *  resolved `tickCounts` (pre-registration). Normally the gridlines read the
 *  default axis's resolved count from `row.tickCounts` — the same value the
 *  `<YAxis>` labels use — so they line up by construction (was three hardcoded
 *  `5`s agreeing by convention). The **x** side reads the container's shared
 *  `xTickCount`, width-derived on a trading-time axis. */
const GRID_TICKS = 5;
/** Minimum px between `'labeled'` session dividers — thins dense collapse
 *  points (e.g. a daily chart where every candle is a new session) so the axis
 *  never crowds. (`'all'` mode fades instead of thinning — see below.) */
const MIN_DIVIDER_PX = 40;
/** Calendar gridlines (one per day / month / aligned hour — the full grain
 *  populations, `TradingTimeScale.gridLevels`) are full-strength while their
 *  **nominal** spacing (`level.spacing` — calendar density, gap-free; NOT the
 *  measured on-screen gaps, so hiding weekends doesn't brighten the grid) is
 *  at least this — a day grain reaches full at a ~1.5-month window on a
 *  default-width plot, in either mode. Dashed faint lines tolerate more
 *  density than the solid session dividers, hence the tighter pair. */
const GRID_LINE_FULL_PX = 15;
/** …and fully faded once nominal spacing falls to this (the same quadratic
 *  wash-aware ramp as the session lines — alpha `t²`, so total ink → 0).
 *  Also the enumeration floor: a grain denser than this is skipped
 *  outright. */
const GRID_LINE_GONE_PX = 5;
/** `'all'`-mode session lines are full-strength while spaced at least this
 *  far apart (the ~1M-view session width on a default-width plot). */
const SESSION_LINE_FULL_PX = 28;
/** …and fully invisible once spacing falls to this — a smooth quadratic
 *  falloff between the two, so nothing pops in/out as you pan/zoom (a hard
 *  drop keyed to pixel clusters shifts phase with the window) and the plot
 *  zooms out to *clean*, not to a gray wash (see `dividerAlphas`). */
const SESSION_LINE_GONE_PX = 6;

/** Wheel-zoom sensitivity: `factor = exp(deltaY * k)` (one ~100px notch ≈ ±15%). */
const ZOOM_SENSITIVITY = 0.0015;

/** Pointer slop (px): a drag must exceed this before it pans, and a click within
 *  it still selects. One threshold for both so a click never also nudges the pan
 *  (and never hit-tests against a shifted scale). */
const DRAG_SLOP = 4;

/**
 * The topmost sweep-capable layer's fresh {@link SweepSession} (RFC §8's
 * z-order rule — the same rule a click follows), or `null` when the row has
 * none. **The one resolution** behind both the pointer-down sweep claim and
 * the resting block preview, so what hover previews and what a drag captures
 * cannot come from different layers.
 */
function beginTopmostSweep(
  c: Pick<ContainerFrame, 'xScale'>,
  r: Pick<RowFrame, 'layers' | 'yScales' | 'defaultAxisId'>,
): SweepSession | null {
  for (let i = r.layers.length - 1; i >= 0; i -= 1) {
    const entry = r.layers[i]!;
    const ys = r.yScales.get(entry.axisId ?? r.defaultAxisId);
    if (ys === undefined) continue;
    const s =
      entry.layer.beginSweep?.(
        (v) => c.xScale(v),
        (v) => ys(v),
      ) ?? null;
    if (s !== null) return s;
  }
  return null;
}

/** Same marks, by full identity — so a recomputed resting block can keep the
 *  CACHED array's reference when nothing actually changed. The layer registry
 *  re-identifies on every hover commit (the entries close over the hovered
 *  set), so an identity-keyed cache alone would re-mint the block each move
 *  and defeat the container's identity-based block dedup. O(block). */
function sameHits(a: readonly SelectInfo[], b: readonly SelectInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.key !== y.key ||
      x.label !== y.label ||
      x.mark !== y.mark
    )
      return false;
  }
  return true;
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
  // Per-move cursor state (own context, so this overlay re-renders on hover
  // without re-identifying the container frame — [PND-HOVCTX]).
  const cursor = useContext(CursorContext);
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
  const {
    layers,
    yScales,
    formats,
    defaultAxisId,
    tickValues,
    tickCounts,
    axisSides,
  } = row;
  // x geometry is shared and lives on the container (uniform across rows), and
  // so is the x tick count — vertical gridlines must sit under the `<XAxis>`
  // labels, which pass the same `xTickCount` to the same scale.
  const { xScale, plotWidth, xTickCount } = container;
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
      // A category axis draws no vertical gridlines — a line through each bar
      // centre reads as noise; the bars are the structure.
      const xTickVals =
        container.xKind === 'category' ? [] : xScale.ticks(xTickCount);
      // The same rule on the other axis: a **horizontal** categorical chart
      // ([PND-HCAT]) puts its categories on y, where the `<YAxis>` labels slot
      // *centres* while d3's auto ticks fall on slot *boundaries* — so drawing
      // them would both mismatch the labels and stripe each bar. Suppressed,
      // exactly as the categorical x axis already is.
      const yIsCategory = layers.some(
        (e) =>
          (e.axisId ?? defaultAxisId) === defaultAxisId &&
          (e.layer.binCategories?.() ?? null) !== null,
      );
      // The reference grid — behind the data, opt-out via `grid={false}` for
      // a clean backdrop (session dividers below stay independent of it).
      if (container.grid) {
        // Auto gridlines use the default axis's RESOLVED tick count (the row's
        // single source, height-derived or an explicit `<YAxis tickCount>`), so
        // a gridline sits under every `<YAxis>` label and no more.
        const yCount = tickCounts.get(defaultAxisId) ?? GRID_TICKS;
        const yTicks =
          gridY && !(yIsCategory && explicitY === undefined)
            ? (explicitY ?? yTickValues(gridY, yCount)).map((t) => gridY(t))
            : [];
        // On a calendar axis the verticals are the FULL grain populations —
        // every day in the month, every month in the year, every aligned
        // clock instant — not just the thinned instants the labels chose:
        // the labels decorate the grid, they don't define it. Each grain
        // fades AS A UNIT by its **nominal** (gap-free, calendar-density)
        // spacing — `level.spacing`, the same wash-aware quadratic ramp as
        // the session lines — so zooming out dissolves the fine grain into
        // the coarser one instead of popping when the label algorithm
        // switches rung, and collapsing weekends draws *fewer* day lines at
        // the *same* strength (not wider-spaced lines that jump to full —
        // the owner's same-zoom, different-weight complaint). Levels nest,
        // so walk coarsest→finest and let the first (widest-spaced,
        // strongest) claim shared anchors — a month start draws once, at
        // month strength, never dimmed by the day crowd around it.
        const levels =
          container.xKind === 'time' && 'gridLevels' in xScale
            ? xScale.gridLevels(GRID_LINE_GONE_PX)
            : [];
        if (levels.length > 0) {
          const xs: number[] = [];
          const alphas: number[] = [];
          const claimed = new Set<number>();
          for (let i = levels.length - 1; i >= 0; i--) {
            const { values, spacing } = levels[i]!;
            const t = Math.max(
              0,
              Math.min(
                1,
                (spacing - GRID_LINE_GONE_PX) /
                  (GRID_LINE_FULL_PX - GRID_LINE_GONE_PX),
              ),
            );
            const alpha = t * t;
            if (alpha <= 0.02) continue;
            for (const v of values) {
              if (claimed.has(v)) continue;
              claimed.add(v);
              xs.push(xScale(v));
              alphas.push(alpha);
            }
          }
          drawGrid(ctx, xs, yTicks, w, h, gridColor, gridDash, alphas);
        } else {
          // Value axis / no-calendar provider: verticals at the labelled
          // ticks, the pre-hierarchical behavior.
          const xTicks = xTickVals.map((d) => xScale(+d));
          drawGrid(ctx, xTicks, yTicks, w, h, gridColor, gridDash);
        }
      }
      // Session dividers: solid verticals at the trading calendar's collapse
      // SEAMS — where closed time was actually removed from the axis. Opt-in
      // emphasis over the grid (default 'none' — the grid's grain populations
      // already mark the calendar): `'all'` draws one at every seam in view
      // (the TradingView separator look, crowding lines fading out);
      // `'labeled'` only at the axis ticks that are seams.
      const disc = container.discontinuities;
      if (disc?.boundaries && container.sessionDividers !== 'none') {
        const [d0, d1] = container.timeRange;
        // Call as a method (not a detached reference) so a class-based provider
        // whose `boundaries` reads `this` keeps its receiver.
        //
        // `boundaries` is the provider's session ROSTER — the tick ladder and
        // the grid consume every session open as a date anchor. A divider,
        // though, marks removed time, and a roster entry that no gap precedes
        // (a demo calendar's contiguous 24h weekday "sessions", a seamless
        // session roll) is roster structure, not a seam — the owner's "why
        // session lines on every day when only weekends are removed?"
        // (2026-07-16). Keep exactly the true seams: `b` is one iff the
        // instant just before it has zero live width. For a real exchange
        // calendar every open follows an overnight gap, so this keeps all.
        //
        // Test `<= 0`, not a positive tolerance: a collapsed gap makes
        // `distance(b-1, b)` **exactly** 0 (both instants map to the same live
        // position), so no epsilon is needed — and a positive tolerance is
        // **unit-dependent**. Under `spacing: 'uniform'` distance is measured
        // in session-units, where a contiguous (non-seam) boundary reads a
        // tiny fraction (`1 / sessionMs`) that a `< 0.5` test would misread as
        // a seam. Exact zero matches the semantic contract in either spacing,
        // and agrees with the same probe in `buildTicks` (Codex review, #479).
        const seams = disc
          .boundaries(d0, d1)
          .filter((b) => disc.distance(b - 1, b) <= 0);
        const marks =
          container.sessionDividers === 'all'
            ? seams
            : ((): number[] => {
                const collapse = new Set(seams);
                return xTickVals.map((v) => +v).filter((t) => collapse.has(t));
              })();
        const bx = marks.map((t) => xScale(t));
        const dividerColor = container.theme.axis.sessionDivider ?? gridColor;
        if (container.sessionDividers === 'all') {
          // Draw every boundary — no thinning (dropping a phase-dependent
          // subset makes lines jump as the window slides). Crowding lines fade
          // instead, so density falls off smoothly toward a clean plot.
          drawDividers(
            ctx,
            bx,
            h,
            dividerColor,
            dividerAlphas(bx, SESSION_LINE_GONE_PX, SESSION_LINE_FULL_PX),
          );
        } else {
          drawDividers(ctx, thinPixels(bx, MIN_DIVIDER_PX), h, dividerColor);
        }
      }
      // Draw the layers. When a draw-stats consumer is subscribed
      // (`reportDrawStats` defined), time each layer and collect its reported
      // {@link LayerDrawStats}; otherwise the plain loop with zero timing
      // overhead. Fires one {@link DrawStatsFrame} per repaint of THIS row.
      const report = container.reportDrawStats;
      if (report === undefined) {
        for (const entry of layers) {
          const yScale = yScales.get(entry.axisId ?? defaultAxisId);
          if (yScale === undefined) continue;
          entry.layer.draw(ctx, xScale, yScale);
        }
      } else {
        const infos: LayerDrawInfo[] = [];
        let totalDrawMs = 0;
        for (const entry of layers) {
          const yScale = yScales.get(entry.axisId ?? defaultAxisId);
          if (yScale === undefined) continue;
          const t0 = performance.now();
          const stats = entry.layer.draw(ctx, xScale, yScale);
          const drawMs = performance.now() - t0;
          totalDrawMs += drawMs;
          infos.push({
            as: entry.layer.as,
            index: entry.index,
            drawMs,
            sourceCount: stats?.sourceCount,
            drawnCount: stats?.drawnCount,
            decimated: stats?.decimated,
          });
        }
        report({ rowKey: row.rowKey, layers: infos, totalDrawMs });
      }
    },
    [
      layers,
      yScales,
      xScale,
      xTickCount,
      defaultAxisId,
      tickValues,
      tickCounts,
      background,
      gridColor,
      gridDash,
      container.discontinuities,
      // Identity-stable across cursor moves (memoized tuple in ChartContainer;
      // e2e `hover sweep never repaints the data canvas` pins this). A fresh
      // array per frame rebuild here would re-fire the Canvas draw effect —
      // a full replot per mousemove.
      container.timeRange,
      container.reportDrawStats,
      // Read inside `draw`, so they have to invalidate it. Omitting `grid` meant
      // toggling `<ChartContainer grid>` changed nothing until some *other*
      // dep moved — pan the plot a pixel and the gridlines you switched off
      // finally vanished. All primitives, so no per-frame identity churn.
      container.grid,
      container.sessionDividers,
      container.xKind,
      // `container.theme` is read too. It is deliberately NOT listed: it is the
      // caller's prop and an inline object literal would rebuild `draw` every
      // render (a full replot per frame). The values `draw` actually takes from
      // it — `background`, `gridColor`, `gridDash` — are extracted above and
      // listed individually, so a theme swap still invalidates.
      row.rowKey,
    ],
  );

  // Interaction overlay: the cursor marks live on a DOM/SVG overlay above the
  // data, so hovering never repaints the data canvas (whose `draw` doesn't depend
  // on the cursor). Reading the container's cursorX — set by whichever row the
  // pointer is over — syncs the cursor across every row for free. cursorX is a
  // *pixel*, so it stays put while a live window slides; the time + values under
  // it derive from the current xScale.
  const { formatTime } = container;
  const { cursorX } = cursor;
  // The cursors in effect for THIS row: its own mounts (the per-row override —
  // a component mounted in the row, or the `<ChartRow cursor>` shim), else the
  // container's. Each registered a spec whose slots this overlay renders; what
  // the container must resolve per move is the union of their declared needs.
  // Editing suppresses the data cursor — the marks get the surface (hover/drag),
  // and a crosshair would just be noise. True in global edit mode *and* while a
  // single annotation is being edited (the double-click target).
  const editingActive =
    container.editAnnotations || container.annotations.some((a) => a.editing);
  // Paint-only mirror of "a <MultiSelector> sweep is live in THIS row"
  // (declared here, ahead of the gesture machinery below, because the cursor
  // resolution needs it). A live sweep suppresses the row's cursor slots the
  // same way editing does: the gesture owns the surface, and the default
  // line preset otherwise keeps painting its solid vertical rule at the raw
  // pointer OVER the brush band — which reads as "a line", not as the region
  // being swept (the §8.1 identical-pixels promise, broken by an overlay).
  // The shared band still renders while suppressed — `sweeping && !wantsBand`
  // below — from the same resolved frame, so the sweep looks exactly like a
  // <RangeCursor> drag.
  const [sweeping, setSweeping] = useState(false);
  // The **resting block preview**: a `<MultiSelector>` in scope over a
  // sweep-capable row changes the RESTING state, not just the drag — the grey
  // band and the block-scoped hover are a preview of exactly what a drag
  // begun here would select. Two halves, resolved here:
  //
  // - `blockPreview` — the fact ("this row previews blocks"). It also scopes
  //   the resting hover to the snap block (handlePointerMove).
  // - `restingBand` — the brush band is this row's resting CURSOR, replacing
  //   the shim's un-asked-for `'line'` default. Any *explicitly chosen*
  //   cursor still wins: a mounted component, or a legacy `cursor` string the
  //   consumer actually set — both register non-`implicit` entries and keep
  //   their own slots (a mounted `<RangeCursor>` already draws this same
  //   band; a `<CrosshairCursor>` keeps its crosshair).
  const blockPreview =
    container.hasMultiSelector(row.rowKey) &&
    layers.some((e) => e.layer.beginSweep !== undefined);
  const restingBand =
    blockPreview &&
    !editingActive &&
    effectiveCursorEntries(container.cursors, row.rowKey).every(
      (e) => e.implicit === true,
    );
  const cursorEntries = useMemo(
    () =>
      editingActive || sweeping || restingBand
        ? []
        : effectiveCursorEntries(container.cursors, row.rowKey),
    [editingActive, sweeping, restingBand, container.cursors, row.rowKey],
  );
  const wantsSamples = cursorEntries.some((e) => e.wants.samples);
  const wantsFlags = cursorEntries.some((e) => e.wants.flags);
  const wantsBand = cursorEntries.some((e) => e.wants.band);
  const wantsPointer = cursorEntries.some((e) => e.wants.pointer);
  const wantsTime = cursorEntries.some((e) => e.wants.time);
  // Only read a time when the cursor is within the plot. An out-of-bounds
  // controlled trackerPosition hides the cursor, so the dots + chips hide too —
  // gating cursorTime makes trackerSamples empty, which drives both the SVG marks
  // and the DOM chip branches.
  const cursorTime =
    cursorX !== null && cursorX >= 0 && cursorX <= plotWidth
      ? +xScale.invert(cursorX)
      : null;

  // Per-layer readout samples at the cursor time (nearest data point) —
  // **finished measurements** (RFC A2.3): pixel position, axis id + side, and
  // the value already formatted by that axis's formatter. Drives the cursor
  // slots' dots and value labels; recomputes as the cursor moves or the window
  // slides under it. Empty when not hovering — or when no effective cursor
  // declared a need — so the data canvas is never touched and a line-only
  // cursor never pays the per-layer walk.
  const trackerSamples = useMemo<readonly ResolvedCursorSample[]>(() => {
    if (cursorTime === null || !wantsSamples) return [];
    const out: ResolvedCursorSample[] = [];
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
          axisId,
          side,
          formatted: fmt(s.value),
          color: s.color,
          label: s.label,
        });
      }
    }
    return out;
  }, [
    cursorTime,
    wantsSamples,
    layers,
    yScales,
    formats,
    axisSides,
    xScale,
    defaultAxisId,
  ]);

  // Consolidated multi-value flags (BoxPlot) — one flag per such layer, wanted
  // by the flag cursor only: all the box's values on one chip, anchored at its
  // top-centre (`px`, `topPy`), each line formatted + coloured to its piece.
  const trackerFlags = useMemo<readonly ResolvedCursorFlag[]>(() => {
    if (cursorTime === null || !wantsFlags) return [];
    const out: ResolvedCursorFlag[] = [];
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
  }, [cursorTime, wantsFlags, layers, yScales, formats, xScale, defaultAxisId]);

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
  /**
   * Clamp a 2-D pan offset so the zoomed content still covers the plot.
   *
   * The y counterpart of `bounds` on x. With `k ≥ 1` the transformed band
   * `[k·0 + ty, k·height + ty]` is at least as tall as the plot, so it can cover
   * it — but nothing stopped `ty` sliding until the data left the viewport, which
   * showed up as an axis reading past the end of the record with blank canvas
   * under it. Requiring both edges to stay outside the plot pins it.
   */
  function clampPanY(k: number, ty: number, height: number): number {
    const lo = height * (1 - k); // bottom edge at or below the plot bottom
    const hi = 0; // top edge at or above the plot top
    return Math.min(hi, Math.max(lo, ty));
  }

  const dragRef = useRef<{
    startX: number;
    /** Pointer y at press, and the y transform's offset then — 2-D pan moves
     *  `ty` by the pointer's y delta, so both must be anchored. */
    startY: number;
    startTy: number;
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
  // The live range-drag session — the anchor (axis units) plus the release
  // sink the brush claim resolved at press — mirrored for the gesture
  // handlers (the same ref+state discipline as `drawFromRef`): the
  // container's `regionAnchor` STATE is only how the rows paint the band; the
  // gesture logic must never read it back, because a batched pointer stream
  // (automation, jsdom, a very fast flick under load) delivers down→up before
  // the down's setState commits — the up would see `regionAnchor === null`,
  // silently drop the select, and the late-committing anchor would then stick
  // (#508 item 7). Trusted human-paced input hides this (React flushes
  // trusted discrete events synchronously); the ref is correct under both.
  // The release sink rides the ref too, so what fires is what the press
  // resolved — a `<RangeCursor onDragRelease>` or the legacy `onRegionSelect`.
  const rangeDragRef = useRef<{
    anchor: number;
    release: (start: number, end: number) => void;
  } | null>(null);
  // The live sweep session (a mounted <MultiSelector> — RFC §8 / A7.7): the
  // anchor + the topmost capable layer's per-drag session + the container's
  // preview/commit sinks, resolved at press. Same ref-not-state discipline as
  // `rangeDragRef` (the gesture must never read a state mirror that may not
  // have committed — #508 item 7). `committed` arms past DRAG_SLOP, mirroring
  // pan's deferred capture, so a click stays a click and selects one mark
  // (§8.1: movement separates the two, not a modifier). The live preview is
  // **coalesced to animation frames** (RFC A1.4): pointermove only records
  // `pendingT` and schedules `raf`; the frame re-cuts the session and, only
  // when the covered set changed, lights the hits through plural `hovered`.
  const sweepRef = useRef<{
    anchor: number;
    session: SweepSession;
    gesture: SweepGesture;
    committed: boolean;
    raf: number;
    pendingT: number | null;
  } | null>(null);
  // (`sweeping` — the paint-only mirror of "a sweep is live" — is declared up
  // with the cursor resolution, which it suppresses. It also renders the
  // shared brush band from this row: §8.1 — one renderer either way, so the
  // two visuals cannot drift.)
  // The resting block preview's per-block cache: the materialised hits of the
  // snap block the pointer is in, keyed on the block extent AND the row's
  // layer registry identity (a data / selection change re-registers layers,
  // which must invalidate the cached marks). One small session per block
  // TRANSITION, nothing per move — and the stable `hits` array is what makes
  // the container's identity-based block dedup work.
  const restingBlockRef = useRef<{
    layers: readonly unknown[];
    start: number;
    end: number;
    hits: readonly SelectInfo[];
  } | null>(null);
  // A1.5's arbitration, surfaced: warn once when a press found both claimants.
  const warnedSweepShadowRef = useRef(false);

  /** Re-cut the sweep to the latest pointer (bucket-snapped through the shared
   *  `cursorBuckets`, freeform without) and light the changed preview. */
  const flushSweep = useCallback(() => {
    const sw = sweepRef.current;
    if (sw === null || !sw.committed || sw.pendingT === null) return;
    const c = containerRef.current;
    const span = regionSpan(c.cursorBuckets ?? [], sw.anchor, sw.pendingT);
    if (span === null) return;
    if (sw.session.update(span.start, span.end))
      sw.gesture.preview(sw.session.hits());
  }, []);
  const scheduleSweepFrame = useCallback(() => {
    const sw = sweepRef.current;
    if (sw === null || sw.raf !== 0) return;
    sw.raf = requestAnimationFrame(() => {
      sw.raf = 0;
      flushSweep();
    });
  }, [flushSweep]);
  /** Drop a live sweep without committing (leave / lost buttons / unmount). */
  const cancelSweep = useCallback(() => {
    const sw = sweepRef.current;
    if (sw === null) return;
    sweepRef.current = null;
    if (sw.raf !== 0) cancelAnimationFrame(sw.raf);
    if (sw.committed) {
      setSweeping(false);
      containerRef.current.setRegionAnchor(null);
      sw.gesture.preview([]); // un-light the preview; nothing commits
    }
  }, []);
  // A sweep interrupted by unmount must not leave the preview lit.
  useEffect(() => cancelSweep, [cancelSweep]);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      clickStartRef.current = { x: e.clientX, y: e.clientY };
      const c = containerRef.current;
      const r = rowRef.current;
      // The sweep's two resolved facts (RFC §8): a <MultiSelector> in scope
      // (the container arbitrates, registry stays private), and a
      // sweep-capable layer in THIS row — topmost wins, the z-order rule a
      // click already follows. Both must hold for the sweep to claim; a
      // selector over a row of untagged/lines-only layers deliberately claims
      // nothing (Q8's identity-gates-interactivity, range form).
      const sweepGesture = c.resolveSweep(r.rowKey);
      const sweepSession: SweepSession | null =
        sweepGesture !== null ? beginTopmostSweep(c, r) : null;
      const drag = resolveRangeDrag(
        c,
        gestureOwner(effectiveCursorEntries(c.cursors, r.rowKey)),
      );
      // ONE brush recognizer arbitrates every drag claim — annotation-create,
      // the sweep, the range drag (component or legacy), pan — in a
      // documented order (RFC A1.5 / A2.7; see brush.tsx). This handler only
      // routes.
      const claim = resolveBrushClaim({
        creating: c.creating !== null,
        sweep: sweepSession !== null,
        drag,
        shiftKey: e.shiftKey,
        panEnabled: c.panEnabled,
        // As with the wheel: a category x has nothing to pan, but a y-panning
        // mode still has work to do.
        canPan: (c.panX && c.xKind !== 'category') || c.panY,
      });
      // Sweep (a mounted <MultiSelector> over a sweepable row): record the
      // press, but arm NOTHING yet — no capture, no anchor, no preview. The
      // gesture commits on the first move past DRAG_SLOP (handlePointerMove);
      // a press that stays put remains a click and selects one mark (§8.1).
      if (claim.kind === 'sweep') {
        if (isDev && drag !== null)
          warnSweepShadowsRangeDrag(warnedSweepShadowRef);
        const px = Math.max(
          0,
          Math.min(
            c.plotWidth,
            e.clientX - e.currentTarget.getBoundingClientRect().left,
          ),
        );
        sweepRef.current = {
          anchor: +c.xScale.invert(px),
          session: sweepSession!,
          gesture: sweepGesture!,
          committed: false,
          raf: 0,
          pendingT: null,
        };
        return;
      }
      if (claim.kind === 'create') {
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
      // Range drag (a drag-enabled <RangeCursor>, or the legacy
      // `cursor="region"` + `onRegionSelect`): anchor the selection at the
      // press; the band then extends as the pointer moves (bucket by bucket
      // with a sequence, freeform without), and release commits the span to
      // whichever sink the claim resolved. Continuous x only, and gated
      // behind the drag modifier while pan is on — all decided in the claim.
      if (claim.kind === 'range') {
        const px = Math.max(
          0,
          Math.min(
            c.plotWidth,
            e.clientX - e.currentTarget.getBoundingClientRect().left,
          ),
        );
        const anchor = +c.xScale.invert(px);
        rangeDragRef.current = { anchor, release: claim.drag.release };
        c.setRegionAnchor(anchor); // paint-only mirror
        c.setHoverX(px);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        return;
      }
      if (claim.kind === 'none') return;
      const tr = c.timeRange;
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
        startY: e.clientY,
        startRange: [tr[0], tr[1]],
        startTy: c.yTransform.ty,
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
      // Range drag in progress: just track the pointer x (the band spans from the
      // anchor bucket to here); no pan, no hover hit-test. Gesture truth is the
      // ref — the state mirror may not have committed yet (see rangeDragRef).
      if (rangeDragRef.current !== null) {
        const rect = e.currentTarget.getBoundingClientRect();
        c.setHoverX(Math.max(0, Math.min(c.plotWidth, e.clientX - rect.left)));
        return;
      }
      // A pressed <MultiSelector> sweep. Below the slop it is still a
      // potential click (same deferral as pan — see the dragRef branch); past
      // it the sweep commits: capture, anchor the band, and from then on each
      // move records the pointer and schedules one animation frame — the
      // session re-cut + preview run there, not per event (RFC A1.4).
      const sw = sweepRef.current;
      if (sw !== null) {
        // Lost buttons ⇒ the press ended off-plot without a pointerup here
        // (the sub-slop path never captured) — drop it, as dragRef does.
        if (e.buttons === 0) {
          cancelSweep();
        } else {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = Math.max(0, Math.min(c.plotWidth, e.clientX - rect.left));
          let justCommitted = false;
          if (!sw.committed) {
            const start = clickStartRef.current;
            // The sweep is an x-gesture: slop on |dx|, so a vertical wobble
            // under a still x stays a click.
            if (start === null || Math.abs(e.clientX - start.x) <= DRAG_SLOP)
              return;
            sw.committed = true;
            justCommitted = true;
            setSweeping(true);
            c.setRegionAnchor(sw.anchor); // paint-only mirror (the band)
            c.setHovered(null, rowRef.current.rowKey); // plural preview owns hover now
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* ignore */
            }
          }
          c.setHoverX(px);
          sw.pendingT = +c.xScale.invert(px);
          // The move that COMMITS the sweep cuts synchronously: the band and
          // the covered marks appear in the same event turn, so a
          // bucket-snapped sweep lights its whole first bucket from the
          // moment the drag starts — not an animation frame later, with the
          // single-mark hover already cleared and nothing lit in between.
          // Every later move stays frame-coalesced (RFC A1.4).
          if (justCommitted) flushSweep();
          else scheduleSweepFrame();
          return;
        }
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
        const dy = e.clientY - drag.startY;
        // Don't pan until past the slop, so a click's 1–4px jitter neither moves
        // the view nor shifts the scale the click then hit-tests against. In 2-D
        // the slop is on the *distance*, so a purely vertical drag arms it too.
        // With y in play the slop is on the DISTANCE, so a purely vertical drag
        // arms it; x-only keeps the horizontal-only test it always had.
        const moved = c.panY ? Math.hypot(dx, dy) : Math.abs(dx);
        if (moved <= DRAG_SLOP) return;
        // First move past the slop ⇒ this is a real pan, not a click. Commit it
        // now (deferred from press, see handlePointerDown): hide the tracker and
        // claim the pointer so the pan keeps tracking outside the plot. Capturing
        // here — after the click/select decision is already moot — is what keeps a
        // tap-select on a non-editable mark working while a drag still pans.
        if (!drag.captured) {
          drag.captured = true;
          c.setHoverX(null); // hide the tracker while panning
          c.setHoverY(null, null);
          c.setHovered(null, rowRef.current.rowKey); // drop any hover-highlight
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* ignore (synthetic / already-released pointer) */
          }
        }
        // 2-D pan is a straight pixel shift of the y transform — no domain
        // maths, because the transform is already in pixel space.
        if (c.panY)
          c.applyYTransform({
            k: c.yTransform.k,
            ty: clampPanY(
              c.yTransform.k,
              drag.startTy + dy,
              rowRef.current.height,
            ),
          });
        // A category x has no continuous domain to pan; the y half above is the
        // whole gesture for a horizontal heat map. (Recomputed rather than
        // carried on the drag: this is a different closure from the press.)
        if (!c.panX || c.xKind === 'category') return;
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
      // The declared x-snap, resolved BY the container (RFC A2.3): the hovered
      // row's gesture-owning cursor (its innermost mount — A2.5) declares
      // `snapX`, and `'sample'` snaps the shared vertical line to the nearest
      // sample's x so the reticle centres on a real data point (and stays
      // aligned across rows on a shared grid). The crosshair declares it
      // unconditionally — x always rides the data grid for a clean time
      // readout; its `snap` prop only governs the *y* (ChartIQ's model). A
      // cursor component could never do this itself: it has neither the
      // layers nor the right to write the shared cursorX.
      let px = rawX;
      const owner = gestureOwner(effectiveCursorEntries(c.cursors, r.rowKey));
      if (owner?.spec.snapX === 'sample') {
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
      // The resting BLOCK preview (a mounted <MultiSelector>): hover lights
      // every mark in the snap block under the pointer — exactly the set a
      // drag begun and released here would select, from exactly the sweep's
      // own machinery (the shared snap buckets through `regionSpan`, the
      // topmost layer's session), so the preview and a drag cannot disagree.
      // Cached per block (and per layer registry), so within-block moves
      // re-materialise nothing and hand the container the SAME array back —
      // its identity is the block-level hover dedup.
      let block: readonly SelectInfo[] | undefined;
      if (c.hasMultiSelector(r.rowKey)) {
        const span = regionSpan(c.cursorBuckets ?? [], +c.xScale.invert(rawX));
        if (span !== null) {
          const cached = restingBlockRef.current;
          if (
            cached !== null &&
            cached.layers === r.layers &&
            cached.start === span.start &&
            cached.end === span.end
          ) {
            block = cached.hits;
          } else {
            const session = beginTopmostSweep(c, r);
            if (session !== null) {
              session.update(span.start, span.end);
              let hits = session.hits();
              // Same block, same marks after a registry re-identification
              // (every hover commit re-registers the layers): keep the CACHED
              // array's reference, or the identity-based block dedup would
              // re-fire on every within-block move.
              if (
                cached !== null &&
                cached.start === span.start &&
                cached.end === span.end &&
                sameHits(cached.hits, hits)
              )
                hits = cached.hits;
              restingBlockRef.current = {
                layers: r.layers,
                start: span.start,
                end: span.end,
                hits,
              };
              block = hits;
            }
          }
          // An all-gap block owns no membership (A7.6's "holes own no
          // membership") — fall back to the plain single-mark hover.
          if (block !== undefined && block.length === 0) block = undefined;
        }
      }
      // The row key scopes which `<Selector>`s hear it (a row's own mounts, else
      // the container's) — the hover *highlight* is unscoped container state.
      c.setHovered(hit, r.rowKey, block);
    },
    [],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const c = containerRef.current;
      // End a sweep: one final synchronous re-cut at the release pointer (the
      // last move's animation frame may not have run), then commit
      // `(hits, modifiers, span)` to the <MultiSelector>s the press resolved
      // (RFC A5.2). The hits ARE the materialised preview — `session.hits()`
      // reads the same cached array the last preview lit, never a fresh range
      // query (A7.7) — and the span is the covered marks' snapped-outward
      // extent (A7.6's edge rule), `null` when the sweep covered nothing (the
      // swept-empty analog of a deselect click). A sub-slop press never
      // committed: it stays a click, and the click handler selects one mark.
      const sw = sweepRef.current;
      if (sw !== null) {
        sweepRef.current = null;
        if (sw.raf !== 0) cancelAnimationFrame(sw.raf);
        if (!sw.committed) return; // a click — handleClick owns it
        const px = Math.max(
          0,
          Math.min(
            c.plotWidth,
            e.clientX - e.currentTarget.getBoundingClientRect().left,
          ),
        );
        const span = regionSpan(
          c.cursorBuckets ?? [],
          sw.anchor,
          +c.xScale.invert(px),
        );
        if (span !== null) sw.session.update(span.start, span.end);
        setSweeping(false);
        c.setRegionAnchor(null); // the band reverts, as the range drag's does
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        const extent = sw.session.extent();
        const modifiers: SelectModifiers = {
          additive: e.metaKey || e.ctrlKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
        };
        sw.gesture.commit(
          sw.session.hits(),
          modifiers,
          extent === null
            ? null
            : { kind: 'span', id: sw.session.id, x: extent },
        );
        return;
      }
      // End a range drag: commit the anchor→pointer span as a one-shot range —
      // to the sink the press resolved (`<RangeCursor onDragRelease>`'s
      // `{ x: [lo, hi] }`, or the legacy `onRegionSelect` bare pair) — then
      // clear the anchor: the cursor **reverts** to the single-bucket
      // highlight (it does not keep the range). The anchor is read from the
      // ref, never the state mirror — under a batched pointer stream the
      // state hasn't committed yet and the select would be silently dropped
      // (and the anchor stuck). See rangeDragRef.
      if (rangeDragRef.current !== null) {
        const { anchor, release } = rangeDragRef.current;
        rangeDragRef.current = null;
        const px = Math.max(
          0,
          Math.min(
            c.plotWidth,
            e.clientX - e.currentTarget.getBoundingClientRect().left,
          ),
        );
        const span = regionSpan(
          c.cursorBuckets ?? [],
          anchor,
          +c.xScale.invert(px),
        );
        c.setRegionAnchor(null);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        if (span) release(span.start, span.end);
        return;
      }
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
    // Cancel a range-drag on leave (no commit) — a safety net for the rare case
    // where the pointer capture didn't take, so the anchor can't get stuck.
    rangeDragRef.current = null;
    // Same net for a sweep: no commit, preview un-lit, band cleared.
    cancelSweep();
    if (c.regionAnchor !== null) c.setRegionAnchor(null);
    c.setHoverX(null);
    c.setHoverY(null, null);
    c.setHovered(null, rowRef.current.rowKey);
  }, [cancelSweep]);
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
    // 'select', not 'hover': a click must be able to resolve to NO mark —
    // that null is the deselect signal (the empty commit) — so layers whose
    // hover target is generous (a bar's full-height slot) narrow it here.
    const hit = resolveSelection(
      r.layers,
      e.clientX - rect.left,
      e.clientY - rect.top,
      c.xScale,
      (axisId) => r.yScales.get(axisId ?? r.defaultAxisId),
      'select',
    );
    const modifiers: SelectModifiers = {
      additive: e.metaKey || e.ctrlKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    };

    // **A click commits the block it previewed.** Under a mounted
    // `<MultiSelector>` the resting preview lights the whole snap block a
    // gesture begun here would select (the band + every covered mark); a click
    // that then selected only the mark under the pointer would make that
    // preview a lie for the gesture most people try first. So the click
    // commits the same block, through the same session the drag uses — one
    // code path, so rest, click and sweep cannot disagree.
    //
    // **Only when a `sequence` was declared** (`gesture.snapped`). With none,
    // the block is the single bin under the pointer and this falls through to
    // the one-mark `select` below unchanged — which is what keeps a click
    // distinguishable from a sweep by its `null` span (RFC §8: a click is a
    // click). A `sequence` is an explicit declaration that selection happens
    // in bucket units, and *that* is what earns the wider commit.
    //
    // The test has to be the declaration rather than "the block covers more
    // than one mark", which is what it was first written as. A **stack**'s bin
    // holds one mark per group, so the mark-count test fired on an ordinary
    // unsnapped click and swallowed the whole bin instead of the clicked
    // segment — found walking `MultiSelector/Stacked/ClickStillSelectsOne`.
    if (hit !== null && c.hasMultiSelector(r.rowKey)) {
      const px = e.clientX - rect.left;
      const span = regionSpan(c.cursorBuckets ?? [], +c.xScale.invert(px));
      const gesture = span === null ? null : c.resolveSweep(r.rowKey);
      if (span !== null && gesture !== null && gesture.snapped) {
        const session = beginTopmostSweep(c, r);
        if (session !== null) {
          session.update(span.start, span.end);
          const hits = session.hits();
          const extent = session.extent();
          if (hits.length > 0 && extent !== null) {
            gesture.commit(hits, modifiers, {
              kind: 'span',
              id: session.id,
              x: extent,
            });
            return;
          }
        }
      }
    }

    // Report the modifiers the click carried ([PND-MULTISEL]). The library
    // applies no policy to them; a consumer implements ⌘/Ctrl-adds itself,
    // which it could not do at all while the click arrived as a bare hit.
    //
    // Passing the row key marks this as a **plot gesture**, which the container
    // gates on a mounted `<Selector>` (interaction RFC §7.1): with none in
    // scope this whole click is inert, deliberately.
    c.select(hit, modifiers, r.rowKey);
  }, []);

  // Wheel-zoom — a native non-passive listener so `preventDefault` works (React's
  // onWheel is passive). Attached once; no-ops (and lets the page scroll) when
  // panZoom is off.
  useEffect(() => {
    const el = plotRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      const c = containerRef.current;
      if (!c.zoomEnabled) return;
      // A category x axis has no continuous domain to zoom. That rules out the x
      // half, but not the y half — which is why `panZoomY` is what a horizontal
      // heat map (categories on x, bins on y) wants, and why `panZoomXY` would
      // be a lie there.
      const doX = c.zoomX && c.xKind !== 'category';
      if (!doX && !c.zoomY) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const localX = Math.max(0, Math.min(c.plotWidth, e.clientX - rect.left));
      const pivot = +c.xScale.invert(localX);
      let factor = Math.exp(e.deltaY * ZOOM_SENSITIVITY);

      const nextRange = (f: number) =>
        c.discontinuities
          ? // minDuration is the zoom-in floor; on a trading-time axis it caps
            // the minimum visible *trading* time (ms of open-market time)
            // rather than wall-clock ms — the sensible meaning for this axis.
            zoomRangeTrading(
              c.timeRange,
              pivot,
              f,
              c.discontinuities,
              c.minDuration,
            )
          : zoomRange(c.timeRange, pivot, f, c.minDuration);

      // ── The aspect lock has to be NEGOTIATED, not asserted ────────────────
      // Both axes zooming by "the same factor" only holds the ratio while both
      // can actually take that factor. Each has its own limit — y cannot zoom
      // out past its natural fit (`k >= 1`), x cannot zoom in past
      // `minDuration` — and if either clamps on its own, the other carries on
      // and the picture shears. That is visible as soon as you zoom out to an
      // edge: y stops at `k = 1` and x keeps widening.
      //
      // So agree one factor first: cap it at what y can take, then ask x what
      // it would actually do with that and adopt the answer.
      const both = doX && c.zoomY;
      let range: readonly [number, number] | null = null;
      if (doX) {
        if (both) factor = Math.min(factor, c.yTransform.k);
        range = nextRange(factor);
        const span = c.timeRange[1] - c.timeRange[0];
        if (both && span > 0) factor = (range[1] - range[0]) / span;
      }

      if (c.zoomY) {
        // `factor` scales the DOMAIN span, so factor > 1 is zoom *out*; the
        // pixel-space zoom is its reciprocal. One factor for both axes is what
        // fixes the aspect ratio.
        const z = 1 / factor;
        const localY = e.clientY - rect.top;
        const { k, ty } = c.yTransform;
        // Zoom about the cursor: p' = localY + (p − localY)·z, expanded through
        // the existing transform p = ty + k·base.
        const nk = Math.max(1, k * z);
        c.applyYTransform({
          k: nk,
          ty: clampPanY(nk, localY * (1 - z) + ty * z, rowRef.current.height),
        });
      }
      if (range !== null) c.applyRange(range);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── The resolved cursor frame (RFC A2.3) — finished measurements for the
  // effective cursors' render slots. Everything below is *resolution*: the
  // slots (in cursors.tsx, or eventually user-authored) only draw.

  // The raw pointer's y resolved against the row's default axis — the free
  // (non-snapping) crosshair's centre. Only in the hovered row, and only when
  // an effective cursor declared the need; a slot has no `yScale.invert` of
  // its own, which is exactly why this is resolved here.
  const pointer = useMemo<ResolvedCursorFrame['pointer']>(() => {
    if (!wantsPointer) return null;
    if (cursor.cursorRowKey !== row.rowKey || cursor.cursorY === null)
      return null;
    const ys = yScales.get(defaultAxisId);
    if (ys === undefined) return null;
    const fmt = formats.get(defaultAxisId) ?? String;
    return {
      py: cursor.cursorY,
      formatted: fmt(ys.invert(cursor.cursorY)),
      side: axisSides.get(defaultAxisId) ?? 'left',
    };
  }, [
    wantsPointer,
    cursor.cursorRowKey,
    cursor.cursorY,
    row.rowKey,
    yScales,
    formats,
    axisSides,
    defaultAxisId,
  ]);

  // The in-plot cursor time, readout-formatted — the `showTime` presets' chip
  // text. The time is shared across rows (one cursor, one time), so the chip
  // itself shows once, atop the first row; formatting is skipped entirely when
  // no effective cursor wants it.
  const formattedTime =
    wantsTime && cursorTime !== null
      ? (container.formatReadout ?? formatTime)(cursorTime)
      : null;

  // The range cursor's band (continuous x axis — time or value): shade the
  // span under the pointer. With snap buckets (a sequence / a histogram's
  // bins) the band snaps to the bucket (and extends bucket by bucket under a
  // legacy drag); with none it's the **freeform** case — a bare hover draws a
  // plain line (`bandLine`), a drag shades the raw `[anchor, pointer]`. Edges
  // map through `xScale`, so on a trading-time axis the band crops to live time.
  // A live <MultiSelector> sweep shades the same band — and so does its
  // RESTING state (`restingBand`): the band over the snap block under the
  // pointer is the row's resting cursor, previewing the block a drag would
  // select. Neither is gated to a continuous axis: the marks currency is what
  // folds the category axis into the gesture (RFC §8 / A4.2 — nobody sees a
  // numeric range), and the band maps slot units through the shared band
  // scale like any other span.
  const bandActive =
    (wantsBand &&
      (container.xKind === 'time' || container.xKind === 'value')) ||
    sweeping ||
    restingBand;
  const band: { x0: number; x1: number } | null =
    bandActive && cursorTime !== null
      ? bandRect(
          container.cursorBuckets ?? [],
          cursorTime,
          (v) => xScale(v),
          plotWidth,
          container.regionAnchor ?? undefined,
        )
      : null;
  // Degenerate range cursor (no buckets, not mid-drag): a plain vertical
  // line. Deliberately NOT extended to `restingBand` — the resting preview is
  // "a region-like cursor, not a line", so with no snap block under the
  // pointer it shows nothing rather than degenerating to the rule it exists
  // to replace.
  // A drag owns the band's extent exactly while an anchor is set — the range
  // drag sets it on pointerdown, the sweep when it crosses `DRAG_SLOP` (so a
  // click never flashes the edges on its way to committing a block).
  const bandDragging = container.regionAnchor !== null;
  const bandLine =
    wantsBand &&
    (container.xKind === 'time' || container.xKind === 'value') &&
    !sweeping &&
    container.cursorBuckets === undefined &&
    container.regionAnchor === null &&
    cursorX !== null &&
    cursorX >= 0 &&
    cursorX <= plotWidth;

  const cursorRenderFrame: ResolvedCursorFrame = {
    cursorX,
    cursorY: cursor.cursorY,
    rowKey: row.rowKey,
    hoveredRowKey: cursor.cursorRowKey,
    samples: trackerSamples,
    flags: trackerFlags,
    pointer,
    band,
    bandLine,
    bandDragging,
    formattedTime,
    plotWidth,
    rowHeight: row.height,
    isFirstRow: row.isFirstRow,
    theme: container.theme,
    xAxis: null,
  };

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
          touchAction:
            container.panEnabled || container.zoomEnabled ? 'none' : 'auto',
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
        {/* Cursor overlay (SVG, above the data canvas): each effective
            cursor's `renderPlot` slot draws here — the synced line, the
            per-series dots, the flag staffs, the reticle — all crisp +
            positioned in plot space, no second canvas. Stacked render-only
            presets render in mount order (RFC A2.5). */}
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
          {cursorEntries.map((e, i) =>
            e.spec.renderPlot ? (
              <Fragment key={`cursor-plot-${i}`}>
                {e.spec.renderPlot(cursorRenderFrame)}
              </Fragment>
            ) : null,
          )}
          {/* A live <MultiSelector> sweep — or its RESTING block preview —
              with no band-wanting cursor mounted: draw the SAME shared band
              renderer <RangeCursor> uses (§8.1 — one function, so the brush
              visuals cannot drift). When a band cursor IS mounted, its own
              slot above already painted the identical band from the same
              resolved frame. */}
          {(sweeping || restingBand) &&
            !wantsBand &&
            renderBrushBand(cursorRenderFrame)}
        </svg>
        {/* The cursors' DOM slots, above the SVG: the in-plot chips
            (`renderPlotHtml` — value chips, the time readout) and the
            axis-edge value pills (`renderYGutter` — positioned to overflow
            into the axis gutter, zIndex over the sibling axis column). */}
        {cursorEntries.map((e, i) =>
          e.spec.renderPlotHtml ? (
            <Fragment key={`cursor-html-${i}`}>
              {e.spec.renderPlotHtml(cursorRenderFrame)}
            </Fragment>
          ) : null,
        )}
        {cursorEntries.map((e, i) =>
          e.spec.renderYGutter ? (
            <Fragment key={`cursor-gutter-${i}`}>
              {e.spec.renderYGutter(cursorRenderFrame)}
            </Fragment>
          ) : null,
        )}
      </div>
    </LayersContext.Provider>
  );
}
