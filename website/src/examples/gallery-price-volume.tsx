import { useMemo } from 'react';
import {
  AreaChart,
  BarChart,
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

/** The two-row price-and-volume layout every trading screen opens with: price
 *  filled against a dollar axis, share volume on its own axis underneath.
 *  **One** `<ChartContainer>` — so the two rows share the x range, the pan/zoom
 *  and the cursor, while each `<YAxis id>` fits its own scale.
 *
 *  Volume bars are coloured by the bar's own direction (close ≥ open) via
 *  `binColors`, reading the up/down colours **off the theme** rather than
 *  naming hues — the same pair the candles use.
 *
 *  Prices are **modelled**, not measured — see `lib/financial-fixtures.ts`. */
export default function GalleryPriceVolume({
  width = 680,
  priceHeight = 170,
  volumeHeight = 74,
  phase,
}: {
  width?: number;
  priceHeight?: number;
  volumeHeight?: number;
  phase?: number;
}) {
  const theme = useSiteChartTheme();
  const set = marketBars();
  // `range` is the view; `bars` is the set cropped to it, because a `<YAxis>`
  // auto-fits every point of the series it's handed rather than the ones on
  // screen.
  const { range, bars } =
    phase === undefined ? sessionWindow(set, 90) : sessionScan(set, 46, phase);

  // One colour per bar, in the cropped series' order — `binColors[i]` fills
  // bar `i`, so it has to be built from the same series the layer draws.
  const volumeColors = useMemo(() => {
    const open = bars.column('open').toFloat64Array();
    const close = bars.column('close').toFloat64Array();
    const { rising, falling } = theme.candle.default;
    return Array.from(close, (c, i) =>
      c >= open[i]! ? rising.body : falling.body,
    );
  }, [bars, theme]);

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      calendar={set.calendar}
      cursor="crosshair"
    >
      <ChartRow height={priceHeight}>
        <YAxis id="price" side="right" format={set.priceFormat} width={62} />
        <Layers>
          <AreaChart series={bars} column="close" axis="price" />
        </Layers>
      </ChartRow>
      <ChartRow height={volumeHeight}>
        <YAxis id="volume" side="right" format={set.volumeFormat} width={62} />
        <Layers>
          <BarChart
            series={bars}
            column="volume"
            axis="volume"
            binColors={volumeColors}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
