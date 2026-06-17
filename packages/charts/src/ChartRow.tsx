import { useContext, useMemo, type ReactNode } from 'react';
import { ContainerContext, RowContext, type RowFrame } from './context.js';

export interface ChartRowProps {
  /** Row height in CSS pixels. */
  height: number;
  /**
   * Explicit y-domain `[min, max]` for the plot. Omitted ⇒ `<Layers>` auto-fits
   * to its layers' finite-value extents (a flat line gets ±1 of headroom).
   */
  yDomain?: readonly [number, number];
  children?: ReactNode;
}

/**
 * A horizontal band sharing the container's time axis. `ChartRow` owns the
 * **horizontal layout** — axes positioned left/right around a `<Layers>` plot
 * area — and the row's height + y-domain, which it provides to its children via
 * context. The plot canvas and the draw-layer z-stack live in {@link Layers};
 * the y-axis is per-row (`YAxis`, M2.3).
 *
 * Children are laid out left-to-right. Until `YAxis` lands the only child is
 * `<Layers>`, which spans the full width (`plotWidth === container.width`); when
 * axes arrive they take fixed gutters and `plotWidth` shrinks to the remainder.
 */
export function ChartRow({ height, yDomain, children }: ChartRowProps) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<ChartRow> must be rendered inside a <ChartContainer>');
  }

  // plotWidth is the full row width until axes reserve gutters (M2.3).
  const frame = useMemo<RowFrame>(
    () => ({
      height,
      plotWidth: container.width,
      yDomain: yDomain,
    }),
    [height, container.width, yDomain],
  );

  return (
    <RowContext.Provider value={frame}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          width: `${container.width}px`,
          height: `${height}px`,
        }}
      >
        {children}
      </div>
    </RowContext.Provider>
  );
}
