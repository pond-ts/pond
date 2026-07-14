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
  /**
   * How the axis title (`label`) is drawn:
   * - **`'rotated'` (default)** — a thin vertical strip down the outer edge
   *   (the standard y-axis convention; fits long labels in a narrow gutter).
   * - `'top'` — horizontal, at the top of the axis, aligned to its side. Reads
   *   better for short unit labels; keep it terse and pair it with a domain
   *   that has headroom (auto-fit / padded) so it doesn't crowd the top tick.
   */
  labelPlacement?: 'rotated' | 'top';
  /** Explicit domain bounds; omit to auto-fit the charts linked to this axis. */
  min?: number;
  max?: number;
  /**
   * Fractional headroom added to each side of the resolved domain — `0` (the
   * default) means none. Lifts a tight domain off the plot edges without
   * hand-computing bounds (e.g. `pad={0.05}` adds 5% of the span top & bottom).
   * Applies to an explicit `[min, max]` or an auto-fit domain.
   */
  pad?: number;
  /**
   * Value formatting for the tick labels (and the cursor readout, which matches):
   * a d3 format specifier string (e.g. `'.0%'`, `',.2f'`) or a `(value) => string`
   * function. Omit for the scale's d3 default — which is calibrated to the tick
   * step, so a between-ticks readout rounds to tick precision; pass a specifier
   * (e.g. `',.2f'`) when you want finer readout precision. See {@link AxisFormat}.
   *
   * **Live charts:** a string specifier is value-compared, so an inline
   * `format='.0%'` is safe every render. An inline `format={(v) => …}` **function**
   * is a fresh reference each render — the one axis prop a structural guard can't
   * value-compare — so on a frequently re-rendering (e.g. scrub-driven) chart,
   * hoist it or wrap it in `useCallback`, or it re-registers the axis each frame.
   */
  format?: AxisFormat;
  /**
   * Explicit ticks — `{ at, label }` in axis-value units — instead of the
   * scale's automatic ticks, driving BOTH the labels and the row's gridlines so
   * the two align. The y-axis counterpart of `<XAxis ticks>` (same shape): the
   * lever for a non-uniform axis like pace, where the caller chooses round-pace
   * positions and their own `m:ss` labels (`{ at: -300, label: '5:00' }`). `at`
   * values outside `[min, max]` extrapolate off-plot (the scale does not clamp).
   * Pass `[]` to draw none. The array is **value-compared on registration**, so an
   * inline `ticks={[…]}` (or `ticks={[]}`) with unchanged contents no longer
   * re-registers the axis — only genuinely changed tick positions do. (An inline
   * `format` *function* still needs hoisting; see `format`.)
   */
  ticks?: ReadonlyArray<{ readonly at: number; readonly label: string }>;
  /**
   * Render the tick labels at the domain extremes (the top & bottom ticks)?
   * **Default `true`.** `false` drops just those two numbers — the gridlines
   * stay — for when the min/max labels crowd a stacked row's edges and you'd
   * rather omit them than keep them. (Extreme labels are otherwise clamped to
   * stay inside the row, never overflowing the edge.)
   */
  boundaryLabels?: boolean;
  /** Gutter width in CSS pixels (default 50). */
  width?: number;
  /**
   * This axis instance's colour — tick labels and the axis title take it,
   * overriding the theme's `axis.label` / `axis.title.color`. The multi-axis
   * convention of colouring each y axis to match its series (`color`
   * matching the layer's) — busy, but standard. Omit for the theme's axis
   * colours. Presentation-only: it never re-registers the axis.
   */
  color?: string;
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
  ticks,
  pad = 0,
  boundaryLabels = true,
  width = DEFAULT_WIDTH,
  labelPlacement = 'rotated',
  color,
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
    () => ({
      id,
      side,
      width,
      min,
      max,
      pad,
      labelPlacement,
      format,
      tickValues: ticks?.map((t) => t.at),
      index,
    }),
    [id, side, width, min, max, pad, labelPlacement, format, ticks, index],
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
  // Same formatter the readout uses (resolved per axis on the row), so a tick and
  // a cursor value read identically.
  const fmt = yScale ? resolveAxisFormat(yScale, TICK_COUNT, format) : String;
  // Explicit `{ at, label }` ticks render verbatim (each label at its `at`),
  // overriding the auto-picked d3 ticks; otherwise label the scale's ticks via `fmt`.
  const tickList: readonly { value: number; label: string }[] = ticks
    ? ticks.map((t) => ({ value: t.at, label: t.label }))
    : (yScale ? yScale.ticks(TICK_COUNT) : []).map((t) => ({
        value: t,
        label: fmt(t),
      }));

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
          color: color ?? theme.axis.label,
        }}
      >
        {yScale &&
          tickList.map(({ value, label }, i) => {
            // Drop just the top & bottom labels when boundary labels are off
            // (gridlines are drawn separately, so they stay).
            if (!boundaryLabels && (i === 0 || i === tickList.length - 1))
              return null;
            // Clamp the label's centre so a domain-extreme label stays inside
            // the row instead of half-overflowing the top/bottom edge (and
            // colliding across a splitter in a stacked layout) — F-charts-6.
            const half = theme.font.size / 2 + 1;
            const top = Math.max(
              half,
              Math.min(row.height - half, yScale(value)),
            );
            return (
              <div
                key={value}
                style={{
                  position: 'absolute',
                  top: `${top}px`,
                  [side === 'left' ? 'right' : 'left']: '4px',
                  transform: 'translateY(-50%)',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </div>
            );
          })}
        {/* The axis title. Typography is themeable + a touch larger than the
            ticks (see `theme.axis.title`). `'top'` draws it horizontally at the
            top of the axis, aligned to its side (terse unit labels); `'rotated'`
            (default) is the thin vertical strip down the outer edge — the
            standard y-axis convention, fits long labels in a narrow gutter.
            Left axes read bottom→top, right axes top→bottom. */}
        {labelPlacement === 'top' ? (
          <div
            style={{
              position: 'absolute',
              top: 0,
              // Align to the axis line (the plot-facing edge), matching the tick
              // labels' alignment, rather than floating at the outer gutter edge.
              [side === 'left' ? 'right' : 'left']: '4px',
              fontSize: `${theme.axis.title?.size ?? theme.font.size + 1}px`,
              color: color ?? theme.axis.title?.color ?? theme.axis.label,
              opacity: theme.axis.title?.opacity ?? 0.85,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            {label ?? id}
          </div>
        ) : (
          <div
            style={{
              position: 'absolute',
              [side === 'left' ? 'left' : 'right']: '1px',
              top: 0,
              bottom: 0,
              width: `${(theme.axis.title?.size ?? theme.font.size + 1) + 3}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: `${theme.axis.title?.size ?? theme.font.size + 1}px`,
              color: color ?? theme.axis.title?.color ?? theme.axis.label,
              opacity: theme.axis.title?.opacity ?? 0.85,
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
        )}
      </div>
    </div>
  );
}
