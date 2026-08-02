import {
  Candlestick,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  marketBars,
  sessionScan,
  sessionWindow,
} from './lib/financial-fixtures';

/** Daily OHLC candles on a **trading-time** axis: the calendar collapses every
 *  weekend, the ten market holidays and the two half-days, so the candles are
 *  evenly spaced and the dead air between sessions never reaches the canvas.
 *  Same series on a plain time axis would show them as gaps — the data is
 *  identical, only `<ChartContainer calendar>` differs.
 *
 *  Prices are **modelled**, not measured — see `lib/financial-fixtures.ts`.
 *
 *  With a `phase` (the Gallery card's autoplay clock) a 34-session window
 *  sweeps the year in **session** space rather than wall-clock, because a
 *  window advancing at constant ms/s stalls visibly over every weekend on a
 *  calendar axis. */
export default function GalleryCandlestick({
  width = 680,
  height = 240,
  phase,
}: {
  width?: number;
  height?: number;
  phase?: number;
}) {
  const theme = useSiteChartTheme();
  const set = marketBars();
  // `range` is the view; `bars` is the set cropped to it, because a `<YAxis>`
  // auto-fits every point of the series it's handed rather than the ones on
  // screen. Hand it a year and show 60 sessions and the candles use a third of
  // the row.
  const { range, bars } =
    phase === undefined ? sessionWindow(set, 60) : sessionScan(set, 34, phase);

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      calendar={set.calendar}
      cursor="crosshair"
    >
      <ChartRow height={height}>
        <YAxis id="price" side="right" format={set.priceFormat} width={62} />
        <Layers>
          <Candlestick series={bars} as={set.symbol} showOHLC gap={2} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
