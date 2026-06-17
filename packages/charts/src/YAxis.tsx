import { useContext, useEffect, useMemo } from 'react';
import { ContainerContext, RowContext, type AxisSpec } from './context.js';

export interface YAxisProps {
  /** Identifier a chart links to via its `axis` prop (and the first declared is
   *  the row's default). */
  id: string;
  /**
   * Which side of the plot the gutter sits on. Author left axes *before*
   * `<Layers>` in JSX and right axes *after* — the row lays children out in
   * order. Default `left`.
   */
  side?: 'left' | 'right';
  /** Display label / unit (e.g. `bpm`); defaults to `id`. */
  label?: string;
  /** Explicit domain bounds; omit to auto-fit the charts linked to this axis. */
  min?: number;
  max?: number;
  /** Gutter width in CSS pixels (default 50). */
  width?: number;
}

const DEFAULT_WIDTH = 50;
const TICK_COUNT = 5;

/**
 * A y-axis for a {@link ChartRow}, rendered as DOM chrome (not canvas) so the
 * text is crisp, themeable, and accessible. Registers its id / side / width /
 * domain with the row, which reserves the gutter (shrinking `plotWidth`) and
 * computes this axis's scale from the charts linked to it; the gutter then draws
 * tick marks + labels from that scale. Charts attach via `<LineChart axis="id">`
 * (default: the first axis).
 */
export function YAxis({
  id,
  side = 'left',
  label,
  min,
  max,
  width = DEFAULT_WIDTH,
}: YAxisProps) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<YAxis> must be rendered inside a <ChartContainer>');
  }
  const row = useContext(RowContext);
  if (row === null) {
    throw new Error('<YAxis> must be rendered inside a <ChartRow>');
  }

  const spec = useMemo<AxisSpec>(
    () => ({ id, side, width, min, max }),
    [id, side, width, min, max],
  );
  // Depend on the *stable* registerAxis (a useCallback), NOT the whole `row`
  // frame — the frame is recreated on every registration, so depending on it
  // would re-register in a loop (register → re-render → re-register).
  const { registerAxis } = row;
  useEffect(() => registerAxis(spec), [registerAxis, spec]);

  const { theme } = container;
  const yScale = row.yScales.get(id);
  const ticks = yScale ? yScale.ticks(TICK_COUNT) : [];

  return (
    <div
      style={{
        position: 'relative',
        flex: `0 0 ${width}px`,
        width: `${width}px`,
        height: `${row.height}px`,
        fontFamily: theme.font.family,
        fontSize: `${theme.font.size}px`,
        color: theme.axis.label,
      }}
    >
      {yScale &&
        ticks.map((t) => (
          <div
            key={t}
            style={{
              position: 'absolute',
              top: `${yScale(t)}px`,
              [side === 'left' ? 'right' : 'left']: '4px',
              transform: 'translateY(-50%)',
              whiteSpace: 'nowrap',
            }}
          >
            {t}
          </div>
        ))}
      <div
        style={{
          position: 'absolute',
          [side === 'left' ? 'left' : 'right']: '2px',
          top: '0',
          fontSize: `${theme.font.size - 1}px`,
          opacity: 0.7,
        }}
      >
        {label ?? id}
      </div>
    </div>
  );
}
