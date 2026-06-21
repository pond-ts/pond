import { Fragment, useContext } from 'react';
import { ContainerContext } from './context.js';

/** Strip height in CSS pixels (tick mark + label). */
const AXIS_HEIGHT = 22;
const TICK_COUNT = 5;

/**
 * The shared time (x) axis, rendered once at the bottom of a
 * {@link ChartContainer} as DOM chrome (crisp text, themeable, accessible). It
 * reads the container's `xScale` (a d3 `scaleTime`), so ticks land on wall-clock
 * boundaries; labels use the container's shared `formatTime` — d3's multi-scale
 * time format by default (`12 PM`, `12:10`, …), or `<ChartContainer timeFormat>` —
 * the same formatter the cursor-time readout uses, so they always agree.
 *
 * Positioned with `marginLeft: leftGutter` and `width: plotWidth` so its origin
 * sits under every row's plot area (the container reserves uniform gutters), and
 * edge labels are end-aligned (first left, last right) so they don't overflow
 * the plot on gutter-less rows.
 */
export function TimeAxis() {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error('<TimeAxis> must be rendered inside a <ChartContainer>');
  }

  const { xScale, plotWidth, leftGutter, theme, formatTime } = container;
  const ticks = xScale.ticks(TICK_COUNT);

  return (
    <div
      style={{
        position: 'relative',
        marginLeft: `${leftGutter}px`,
        width: `${plotWidth}px`,
        height: `${AXIS_HEIGHT}px`,
        borderTop: `1px solid ${theme.axis.grid}`,
        fontFamily: theme.font.family,
        fontSize: `${theme.font.size}px`,
        color: theme.axis.label,
      }}
    >
      {ticks.map((d, i) => {
        const x = xScale(d);
        // End-align the edge labels so they stay within [0, plotWidth].
        const labelTransform =
          i === 0
            ? 'none'
            : i === ticks.length - 1
              ? 'translateX(-100%)'
              : 'translateX(-50%)';
        return (
          <Fragment key={+d}>
            <div
              style={{
                position: 'absolute',
                left: `${x}px`,
                top: 0,
                width: '1px',
                height: '4px',
                background: theme.axis.grid,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: `${x}px`,
                top: '6px',
                transform: labelTransform,
                whiteSpace: 'nowrap',
              }}
            >
              {formatTime(+d)}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
