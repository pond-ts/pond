import {
  BandChart,
  Candlestick,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  CrosshairCursor,
} from '@pond-ts/charts';
import '@pond-ts/financial/fluent';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { marketBars, sessionWindow } from './lib/financial-fixtures';

/** Studies **append** columns to a bar `TimeSeries` and return the widened
 *  series — so they chain, and you draw their output as ordinary chart
 *  layers. Importing `@pond-ts/financial/fluent` mounts them as methods:
 *  `.bollinger()` adds `bbUpper`/`bbMiddle`/`bbLower`, `.ema()` adds `ema`,
 *  and the band and line just read those columns over the same candles.
 *
 *  Prices are **modelled**, not measured — see `lib/financial-fixtures.ts`.
 *  The window is the last 120 sessions of that year, cropped *before* the
 *  studies run so the warm-up rows are the window's own. */
export default function ChartsFinancialStudies({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const set = marketBars();
  const { range, bars } = sessionWindow(set, 120);
  const study = bars.bollinger({ period: 20 }).ema({ period: 10 });

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      calendar={set.calendar}
    >
      <CrosshairCursor />
      <ChartRow height={240}>
        <YAxis id="price" side="right" format={set.priceFormat} width={62} />
        <Layers>
          <BandChart
            series={study}
            lower="bbLower"
            upper="bbUpper"
            axis="price"
            as="inner"
          />
          <LineChart series={study} column="ema" axis="price" as="secondary" />
          <Candlestick series={bars} as={set.symbol} showOHLC gap={1} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
