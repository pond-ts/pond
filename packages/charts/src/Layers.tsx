import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useContext,
  useMemo,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Canvas } from './Canvas.js';
import { drawGrid } from './grid.js';
import { drawCrosshair, drawTrackerDot } from './tracker.js';
import {
  ContainerContext,
  LayersContext,
  RowContext,
  type LayerRegistry,
} from './context.js';

/** Gridline tick count — matches the axes (`YAxis`/`TimeAxis`) so they align. */
const GRID_TICKS = 5;

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
  const { cursorX, setHoverX, readout } = container;
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

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setHoverX(Math.max(0, Math.min(plotWidth, e.clientX - rect.left)));
    },
    [plotWidth, setHoverX],
  );
  const handlePointerLeave = useCallback(() => setHoverX(null), [setHoverX]);

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
        style={{
          position: 'relative',
          width: `${plotWidth}px`,
          height: `${row.height}px`,
          cursor: 'crosshair',
        }}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
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
