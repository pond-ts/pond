import { Fragment, useContext } from 'react';
import type { ScaleLinear, ScaleTime } from 'd3-scale';
import { ContainerContext } from './context.js';
import {
  resolveAxisFormat,
  resolveTimeFormat,
  type AxisFormat,
} from './format.js';

/** Tick strip height (mark + value label) in CSS px. */
const TICK_STRIP = 22;
/** Extra height reserved for an axis `label` line. */
const LABEL_STRIP = 16;
const TICK_COUNT = 5;

/** One placed tick — its plot-pixel x and the text to draw. */
interface PlacedTick {
  readonly x: number;
  readonly label: string;
}

export interface XAxisProps {
  /**
   * Tick / cursor value formatting — a d3 format/time specifier string or a
   * `(value) => string`. **Omitted ⇒ the container's shared formatter** (so the
   * axis and the cursor readout agree), which is the d3 multi-scale time format
   * for a time axis or the number default for a value axis. The specifier is
   * resolved against the axis's kind (time vs value).
   */
  format?: AxisFormat;
  /** A label drawn centred below (or above) the ticks — e.g. `Distance (m)`. */
  label?: string;
  /** Which edge the axis sits on. **Default `'bottom'`.** Declaration order in
   *  the `<ChartContainer>` places it; `side` orients the ticks + label. */
  side?: 'top' | 'bottom';
  /** Strip height in px. Defaults to fit the ticks (+ the label line if any). */
  height?: number;
  /**
   * Explicit ticks — `{ at, label }` in axis-value units — instead of the
   * scale's automatic ticks. The value-axis lever for e.g. lap markers placed at
   * their cumulative-distance positions (`{ at: lap.endMeters, label: 'Lap 3' }`).
   */
  ticks?: ReadonlyArray<{ readonly at: number; readonly label: string }>;
}

/**
 * The shared **x axis**, a sibling of {@link YAxis} for the horizontal axis. A
 * child of {@link ChartContainer}, rendered as DOM chrome (crisp text,
 * themeable) under (or over) the rows, aligned to the plot. It reads the
 * container's resolved `xScale` + `xKind` — so a **time** container ticks on
 * wall-clock boundaries and a **value** container (a `ValueSeries` row) ticks as
 * numbers, with no axis-type prop here; the kind follows the data.
 *
 * `<TimeAxis>` is the time-flavoured preset (`<XAxis />`).
 */
export function XAxis({
  format,
  label,
  side = 'bottom',
  height,
  ticks: customTicks,
}: XAxisProps = {}) {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<XAxis> must be rendered inside a <ChartContainer>');
  }
  const { xScale, plotWidth, leftGutter, theme, formatTime, xKind } = container;

  // Tick formatter: an explicit `format` is resolved against the axis kind
  // (a time specifier through the time scale, a number specifier through the
  // value scale); otherwise the container's shared formatter — the one the
  // cursor readout uses, so a tick and the cursor read identically.
  const fmt: (value: number) => string =
    format === undefined
      ? formatTime
      : xKind === 'time'
        ? resolveTimeFormat(
            xScale as ScaleTime<number, number>,
            TICK_COUNT,
            format,
          )
        : resolveAxisFormat(
            xScale as ScaleLinear<number, number>,
            TICK_COUNT,
            format,
          );

  const placed: PlacedTick[] = customTicks
    ? customTicks.map((t) => ({ x: xScale(t.at), label: t.label }))
    : (xScale.ticks(TICK_COUNT) as ReadonlyArray<number | Date>).map((d) => ({
        x: xScale(d as number),
        label: fmt(+d),
      }));

  const stripHeight = height ?? TICK_STRIP + (label ? LABEL_STRIP : 0);
  const onTop = side === 'top';

  return (
    <div
      style={{
        position: 'relative',
        marginLeft: `${leftGutter}px`,
        width: `${plotWidth}px`,
        height: `${stripHeight}px`,
        // The plot-facing edge carries the rule; a top axis rules its bottom.
        [onTop ? 'borderBottom' : 'borderTop']: `1px solid ${theme.axis.grid}`,
        fontFamily: theme.font.family,
        fontSize: `${theme.font.size}px`,
        color: theme.axis.label,
      }}
    >
      {placed.map((t, i) => {
        // End-align the edge labels so they stay within [0, plotWidth].
        const labelTransform =
          i === 0
            ? 'none'
            : i === placed.length - 1
              ? 'translateX(-100%)'
              : 'translateX(-50%)';
        return (
          <Fragment key={`${t.x}-${i}`}>
            <div
              style={{
                position: 'absolute',
                left: `${t.x}px`,
                [onTop ? 'bottom' : 'top']: 0,
                width: '1px',
                height: '4px',
                background: theme.axis.grid,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: `${t.x}px`,
                [onTop ? 'bottom' : 'top']: '6px',
                transform: labelTransform,
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </div>
          </Fragment>
        );
      })}
      {label !== undefined && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            width: '100%',
            textAlign: 'center',
            [onTop ? 'top' : 'bottom']: 0,
            opacity: 0.7,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
