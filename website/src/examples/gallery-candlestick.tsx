import {
  Candlestick,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { useMemo, useState } from 'react';
import {
  marketBars,
  rangeWindow,
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
 *  **Interaction.** `panZoom="panZoom"` is drag-to-pan and wheel-to-zoom, and
 *  the tick ladder relabels itself as the span narrows. The range is
 *  **controlled** so the crop can follow it: the layers get a series cropped to
 *  the view (an auto-fitting `<YAxis>` fits every point of the series it's
 *  handed), and an uncontrolled pan would move the view without moving the
 *  crop — walking off the end of the data with the price axis stuck on the
 *  first window's extent.
 *
 *  With a `phase` (the Gallery card's autoplay clock) a 34-session window
 *  sweeps the year in **session** space rather than wall-clock, because a
 *  window advancing at constant ms/s stalls visibly over every weekend on a
 *  calendar axis. Interaction is off in that mode so the scan and a live
 *  gesture never fight. */
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
  const live = phase === undefined;

  const initial = useMemo(() => sessionWindow(set, 60).range, [set]);
  const [panned, setPanned] = useState<[number, number]>(initial);
  const range = live ? panned : sessionScan(set, 34, phase).range;

  // `range` is the view; `bars` is the set cropped to it, because a `<YAxis>`
  // auto-fits every point of the series it's handed rather than the ones on
  // screen. Hand it a year and show 60 sessions and the candles use a third of
  // the row — so the crop has to follow the range, not the initial window.
  const bars = useMemo(() => rangeWindow(set, range), [set, range]);

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      calendar={set.calendar}
      cursor="crosshair"
      panZoom={live ? 'panZoom' : 'none'}
      onTimeRangeChange={setPanned}
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
