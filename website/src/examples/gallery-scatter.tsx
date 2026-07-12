import {
  ChartContainer,
  ChartRow,
  Layers,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { tradeTicks, tradeTicksRange } from './lib/gallery-fixtures';

/** Trade ticks: a data-driven scatter — radius encodes size, colour encodes
 *  up/down — pond's signed-off exception to "style is never data-driven". */
export default function GalleryScatter({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const series = tradeTicks();
  // The candle up/down pair is the theme's existing source of truth for
  // this exact semantic (down, up) — reused rather than re-declaring hex.
  const down = theme.candle.default.falling.body;
  const up = theme.candle.default.rising.body;

  return (
    <ChartContainer range={tradeTicksRange()} width={width} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="price" side="right" format="$,.0f" width={50} />
        <Layers>
          <ScatterChart
            series={series}
            column="price"
            axis="price"
            radius={{ column: 'size', range: [3, 14] }}
            color={{ column: 'change', range: [down, up] }}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
