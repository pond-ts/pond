import { useMemo } from 'react';
import {
  BandChart,
  Candlestick,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { bollinger } from '@pond-ts/financial';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { marketBars, sessionWindow } from './lib/financial-fixtures';

/** The studies → chart seam. `bollinger()` is a pure `(series, options) =>
 *  series` that **appends** `bbLower` / `bbMiddle` / `bbUpper` columns; nothing
 *  about it knows there's a chart. A `<BandChart>` then just reads two of those
 *  columns as its edges and a `<LineChart>` reads the third.
 *
 *  Prices are **modelled**, not measured — see `lib/financial-fixtures.ts`.
 *
 *  With a `phase` (the Gallery card's autoplay clock) the **window length**
 *  sweeps 10 → 40 sessions and back, which is the parameter worth seeing move:
 *  a short window hugs the candles, a long one is slow enough to stay wide
 *  through the whole correction. */
export default function GalleryBollinger({
  width = 680,
  height = 250,
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
  // screen. Cropping *before* the study also means the warm-up rows are the
  // window's own, which is what a chart that starts here would really show.
  const { range, bars } = sessionWindow(set, 120);

  // 20 sessions is the convention; the card sweeps it out and back.
  const period =
    phase === undefined
      ? 20
      : Math.round(10 + 30 * (phase < 0.5 ? phase * 2 : (1 - phase) * 2));

  const study = useMemo(() => bollinger(bars, { period }), [bars, period]);

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
          <BandChart
            series={study}
            lower="bbLower"
            upper="bbUpper"
            axis="price"
            as="inner"
          />
          <LineChart
            series={study}
            column="bbMiddle"
            axis="price"
            as="secondary"
          />
          <Candlestick series={bars} as={set.symbol} gap={1} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
