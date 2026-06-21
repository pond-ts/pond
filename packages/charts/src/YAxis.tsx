import { useContext, useEffect, useMemo } from 'react';
import { ContainerContext, RowContext, type AxisSpec } from './context.js';
import { resolveAxisFormat, type AxisFormat } from './format.js';
import { useSlotKey } from './use-slot-key.js';

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
  /**
   * Value formatting for the tick labels (and the cursor readout, which matches):
   * a d3 format specifier string (e.g. `'.0%'`, `',.2f'`) or a `(value) => string`
   * function. Omit for the scale's d3 default — which is calibrated to the tick
   * step, so a between-ticks readout rounds to tick precision; pass a specifier
   * (e.g. `',.2f'`) when you want finer readout precision. See {@link AxisFormat}.
   */
  format?: AxisFormat;
  /** Gutter width in CSS pixels (default 50). */
  width?: number;
  /**
   * @internal Declaration position among the row's children, injected by
   * `ChartRow` so the first-declared axis stays the default. Do not set.
   */
  index?: number;
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
  format,
  width = DEFAULT_WIDTH,
  index = 0,
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
    () => ({ id, side, width, min, max, format, index }),
    [id, side, width, min, max, format, index],
  );
  // A stable per-instance slot (see useSlotKey) keeps this axis in a fixed
  // registry position, so a min/max/side change updates in place rather than
  // re-appending (which would move the first axis behind a later one and
  // silently rebind the row's default-axis charts).
  const slot = useSlotKey();
  const { registerAxis, unregisterAxis } = row;
  // Unregister on unmount only (deps are stable, so cleanup never runs early).
  useEffect(() => () => unregisterAxis(slot), [unregisterAxis, slot]);
  // Register on mount + update in place on every spec change — no reorder.
  useEffect(() => {
    registerAxis(slot, spec);
  }, [registerAxis, slot, spec]);

  const { theme } = container;
  const yScale = row.yScales.get(id);
  const ticks = yScale ? yScale.ticks(TICK_COUNT) : [];
  // Same formatter the readout uses (resolved per axis on the row), so a tick and
  // a cursor value read identically.
  const fmt = yScale ? resolveAxisFormat(yScale, TICK_COUNT, format) : String;

  // The row reserves a slot per axis column (the widest in that column across
  // rows). Size the box to the slot and align this axis's own (narrower)
  // content toward the plot — left axes flush right, right axes flush left — so
  // axes line up column-by-column. Keyed by this instance's slot key (not `id`,
  // which may repeat across a mirror). Falls back to own width until reserved.
  const slotWidth = row.axisSlots.get(slot) ?? width;

  return (
    <div
      style={{
        flex: `0 0 ${slotWidth}px`,
        display: 'flex',
        justifyContent: side === 'left' ? 'flex-end' : 'flex-start',
        height: `${row.height}px`,
      }}
    >
      <div
        style={{
          position: 'relative',
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
              {fmt(t)}
            </div>
          ))}
        {/* The axis label, rotated to a thin vertical strip at the outer edge +
            centred down the axis (the standard y-axis convention) — so it doesn't
            collide with the tick labels (which sit flush toward the plot) in a
            narrow gutter. Left axes read bottom→top, right axes top→bottom. */}
        <div
          style={{
            position: 'absolute',
            [side === 'left' ? 'left' : 'right']: '1px',
            top: 0,
            bottom: 0,
            width: `${theme.font.size + 2}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: `${theme.font.size - 1}px`,
            opacity: 0.7,
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              whiteSpace: 'nowrap',
              transform: `rotate(${side === 'left' ? -90 : 90}deg)`,
            }}
          >
            {label ?? id}
          </span>
        </div>
      </div>
    </div>
  );
}
