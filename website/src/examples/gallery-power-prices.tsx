import { useMemo } from 'react';
import {
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { dayAheadPrice, dayAheadPriceRange } from './lib/energy-fixtures';

const HOUR = 3_600_000;

/**
 * German day-ahead power prices over Easter weekend 2025 — eight of the 72
 * auction hours cleared **below zero**, bottoming at −52.42 EUR/MWh at 13:00
 * on Easter Sunday, the same hour wind and solar peaked above total demand.
 *
 * A `<BarChart>` needs no `baseline` prop for this: `barExtent` always pulls
 * `0` into the auto-fitted domain, so the zero line is on screen and bars
 * whose value is negative are drawn **downward** from it.
 *
 * `binColors` is the per-bar colour channel (the stack's `colors` is
 * per-group). The two colours are read off the live theme rather than written
 * as literals, so they flip with the site's dark mode: the brand bar fill for
 * a positive hour, and the falling-candle hue for a negative one — the
 * "conventional exception" the palette reserves for a signed quantity.
 */
export default function GalleryPowerPrices({
  width,
  phase,
  height = 220,
}: {
  width: number;
  phase?: number;
  height?: number;
}) {
  const theme = useSiteChartTheme();
  const prices = useMemo(() => dayAheadPrice(), []);
  const positive = theme.bar.default.fill;
  const negative = theme.candle.default.falling.body;
  const binColors = useMemo(() => {
    const price = prices.column('price');
    return Array.from({ length: prices.length }, (_, i) =>
      (price.at(i) ?? 0) < 0 ? negative : positive,
    );
  }, [prices, negative, positive]);
  const [begin, end] = dayAheadPriceRange();
  const range: [number, number] =
    phase === undefined
      ? [begin, end]
      : scanWindow(begin, end, 26 * HOUR, phase);

  return (
    <ChartContainer range={range} width={width} theme={theme}>
      <ChartRow height={height}>
        <YAxis id="eur" label="EUR / MWh" format=",.0f" width={58} />
        <Layers>
          <BarChart
            series={prices}
            column="price"
            axis="eur"
            binColors={binColors}
            gap={2}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
