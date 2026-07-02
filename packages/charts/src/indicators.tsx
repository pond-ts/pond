import { useContext, useSyncExternalStore, type CSSProperties } from 'react';
import { ContainerContext, RowContext } from './context.js';
import { axisPillStyle, axisPillX, pointerStyle } from './chip.js';
import { resolveAxisFormat, type AxisFormat } from './format.js';

/**
 * A **live scalar** an axis indicator subscribes to, pushed imperatively from
 * outside React — a WebSocket `onmessage`, a `requestAnimationFrame` loop, a
 * tick handler. Backed by `useSyncExternalStore` on the consuming indicator:
 * calling {@link LiveValue.set} re-renders **only the indicators subscribed to
 * this value** — never the chart tree, never a canvas repaint. This is the path
 * for a value that ticks many times a second (a live last-price tag), set
 * independently of the series' own last point.
 *
 * Create one with {@link createLiveValue} and pass it to
 * `<YAxisIndicator source={…}>`.
 */
export interface LiveValue {
  /** Push a new value. Re-renders subscribed indicators only; a no-op if the
   *  value is unchanged. Safe to call from outside React at any frequency. */
  set(value: number): void;
  /** @internal Store subscribe, for `useSyncExternalStore`. */
  subscribe(onStoreChange: () => void): () => void;
  /** @internal Current value snapshot, for `useSyncExternalStore`. */
  getSnapshot(): number;
}

/**
 * Create a {@link LiveValue} seeded at `initial`. Hold the returned object,
 * call `.set(v)` from your data source, and hand it to
 * `<YAxisIndicator source={…}>` — the pill repositions and relabels on each
 * `set` without re-rendering the chart.
 *
 * ```ts
 * const price = createLiveValue(0);
 * ws.onmessage = (e) => price.set(JSON.parse(e.data).last); // outside React
 * // <YAxisIndicator source={price} color="#4af" format=",.2f" />
 * ```
 */
export function createLiveValue(initial: number): LiveValue {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    set(v) {
      // Skip a redundant notify — a repeated identical tick shouldn't wake the
      // subscriber (getSnapshot must be stable between real changes anyway).
      if (v === value) return;
      value = v;
      for (const listener of listeners) listener();
    },
    subscribe(onStoreChange) {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
      };
    },
    getSnapshot() {
      return value;
    },
  };
}

const noopSubscribe = () => () => {};

/** The full-plot overlay the guide line paints into — above the data canvas,
 *  inert to the pointer (matches the annotations' `overlayStyle`). */
const overlayStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  pointerEvents: 'none',
};

const TICK_COUNT = 5;

export interface YAxisIndicatorProps {
  /**
   * A static value to pin the pill at. Pass this **or** {@link source}. Updating
   * `value` re-renders with its parent — fine for an occasional change; for a
   * high-frequency tick use `source` so only the pill repaints.
   */
  value?: number;
  /**
   * A {@link LiveValue} to subscribe to — the high-frequency path. `.set(v)`
   * moves and relabels the pill **without re-rendering the chart**. Takes
   * precedence over {@link value} if both are given.
   */
  source?: LiveValue;
  /** Which `<YAxis>` (by id) to position against; omit for the row's default axis. */
  axis?: string;
  /**
   * Which edge the pill hugs. Default `right` — the conventional side for a live
   * value tag. (Independent of the linked axis's side; set it to match.)
   */
  side?: 'left' | 'right';
  /**
   * Pill hue — the colour of the series / value it tracks. Defaults to the axis
   * label colour (`theme.axis.label`).
   */
  color?: string;
  /**
   * Value formatting: a d3 format specifier (e.g. `',.2f'`, `'.1%'`) or a
   * `(value) => string`. Omit to use the linked axis's own formatter, so the pill
   * reads exactly like a tick. Pass a specifier for finer precision than the
   * tick-calibrated default (a live price usually wants `',.2f'`, not the
   * coarser tick rounding). See {@link AxisFormat}.
   *
   * An indicator **always shows the axis value** — there is no label override. A
   * name/annotation belongs on a `<Baseline label>`'s near-line chip, not on the
   * axis pill (an axis pill reads like a tick).
   */
  format?: AxisFormat;
  /**
   * Draw a thin dashed guide line from the pill across the plot (the ChartIQ
   * "price line"). Default `false`.
   */
  line?: boolean;
  /**
   * Add a small triangle on the pill's plot-facing edge, pointing **into** the
   * plot at the value (a callout tab). Default `false`.
   */
  pointer?: boolean;
}

/**
 * A **value pill pinned to a y-axis edge** — the ChartIQ / Yahoo-Finance live
 * price tag. Positions at `yScale(value)` on the linked axis and renders a chip
 * (the solid {@link axisPillStyle} pill) at the plot's `side` edge, optionally
 * with a dashed guide line across the plot.
 *
 * Render it as a child of `<Layers>` (alongside the chart layers), so it shares
 * the plot's coordinate space:
 *
 * ```tsx
 * <Layers>
 *   <LineChart series={price} axis="usd" />
 *   <YAxisIndicator source={liveLast} axis="usd" color="#4af" format=",.2f" line />
 * </Layers>
 * ```
 *
 * The value is **decoupled from the series' last point** — feed it whatever the
 * live feed reports. For high-frequency updates pass a {@link LiveValue}
 * ({@link source}); `.set()` repaints only the pill.
 */
export function YAxisIndicator({
  value,
  source,
  axis,
  side = 'right',
  color,
  format,
  line = false,
  pointer = false,
}: YAxisIndicatorProps) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error(
      '<YAxisIndicator> must be rendered inside a <ChartContainer>',
    );
  }
  const row = useContext(RowContext);
  if (row === null) {
    throw new Error('<YAxisIndicator> must be rendered inside a <ChartRow>');
  }

  // One unconditional hook that covers both paths: with a `source`, subscribe to
  // its store (a `set` re-renders only this component); without one, a stable
  // no-op subscribe + a snapshot that reads the static `value` prop (which
  // re-renders with the parent). Either way `v` is the current value.
  const v = useSyncExternalStore(
    source ? source.subscribe : noopSubscribe,
    source ? source.getSnapshot : () => value ?? NaN,
  );

  const { theme } = container;
  const axisId = axis ?? row.defaultAxisId;
  const yScale = row.yScales.get(axisId);
  // Axis not resolved yet (a layer mounts before its <YAxis>), or no value fed —
  // draw nothing rather than guess.
  if (yScale === undefined || !Number.isFinite(v)) return null;

  const resolvedColor = color ?? theme.axis.label;
  // A caller `format` resolves against the scale (string specifier or fn);
  // otherwise reuse the axis's own formatter so the pill reads like a tick.
  const fmt = format
    ? resolveAxisFormat(yScale, TICK_COUNT, format)
    : row.formats.get(axisId);
  // An indicator always shows the axis value (no label override — a name belongs
  // on a Baseline's near-line chip, not the axis pill).
  const text = fmt ? fmt(v) : String(v);

  const rawY = yScale(v);
  // Clamp the pill's centre so an off-scale value keeps it inside the row rather
  // than half-overflowing the edge (matches the y-tick clamp, F-charts-6).
  const half = theme.font.size / 2 + 1;
  const top = Math.max(half, Math.min(row.height - half, rawY));

  return (
    <>
      {line && (
        <svg
          width={container.plotWidth}
          height={row.height}
          style={overlayStyle}
        >
          <line
            x1={0}
            y1={rawY}
            x2={container.plotWidth}
            y2={rawY}
            stroke={resolvedColor}
            strokeWidth={1}
            opacity={0.5}
            strokeDasharray="3 3"
            shapeRendering="crispEdges"
          />
        </svg>
      )}
      {/* The pill sits over the gutter on `side`: its inner edge anchored at the
          plot boundary, overflowing outward across the reserved gutter (the plot
          div doesn't clip); `zIndex` lifts it above the sibling axis column so it
          covers the tick behind it. An indicator is always on the axis. */}
      <div
        style={{
          ...axisPillStyle(theme, resolvedColor),
          top: `${top}px`,
          ...axisPillX(side, container.plotWidth),
          transform: 'translateY(-50%)',
        }}
      >
        {pointer && <span style={pointerStyle(side, resolvedColor)} />}
        {text}
      </div>
    </>
  );
}
