import { useMemo } from 'react';
import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  fullWindow,
  marketBars,
  sessionReveal,
} from './lib/financial-fixtures';

/** **Drawdown** — how far below its own running peak the price is, at every
 *  session. It is zero at each new high and negative everywhere else, so the
 *  chart is an area hanging *under* a fixed `baseline={0}` rather than standing
 *  on the axis floor. The shape traders actually look at: not "what did it do"
 *  but "how much of the pain would I have sat through".
 *
 *  Prices are **modelled**, not measured — see `lib/financial-fixtures.ts`.
 *
 *  With a `phase` (the Gallery card's autoplay clock) the range's **end**
 *  sweeps out and back, so the curve draws itself in. Drawdown is
 *  path-dependent — every point depends on all the ones before it — so
 *  revealing it left-to-right is honest in a way that scanning a window past
 *  it would not be. */
export default function GalleryDrawdown({
  width = 680,
  height = 220,
  phase,
}: {
  width?: number;
  height?: number;
  phase?: number;
}) {
  const theme = useSiteChartTheme();
  const set = marketBars();
  // The reveal window always starts at the first session, so the cropped bars
  // still carry their whole history — which is what makes a running-peak
  // derivation on them correct rather than merely plausible.
  const { range, bars } =
    phase === undefined ? fullWindow(set) : sessionReveal(set, 30, phase);

  // Peak-to-date drawdown as a signed fraction: one pass, carrying the running
  // maximum. `withColumn` appends it, so the result is still just a series.
  const series = useMemo(() => {
    const close = bars.column('close').toFloat64Array();
    const drawdown = new Float64Array(close.length);
    let peak = -Infinity;
    for (let i = 0; i < close.length; i += 1) {
      if (close[i]! > peak) peak = close[i]!;
      drawdown[i] = close[i]! / peak - 1;
    }
    return bars.withColumn('drawdown', drawdown);
  }, [bars]);

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      calendar={set.calendar}
      cursor="crosshair"
    >
      <ChartRow height={height}>
        <YAxis id="dd" side="right" format=".0%" width={62} />
        <Layers>
          <AreaChart
            series={series}
            column="drawdown"
            axis="dd"
            as="out"
            baseline={0}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
