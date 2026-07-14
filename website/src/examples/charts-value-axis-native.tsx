import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { smileChain } from './lib/value-axis-fixtures';

/** An options chain natively keyed by strike (`ValueSeries.fromColumns`,
 *  never time-keyed) — `LineChart` and `ScatterChart` read it exactly like
 *  a `TimeSeries`, no special-casing. */
export default function ChartsValueAxisNative() {
  const theme = useSiteChartTheme();
  const chain = smileChain();

  return (
    <ChartContainer timeFormat=",.0f" width={560} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="iv" label="implied vol" format=".1%" width={60} />
        <Layers>
          <LineChart series={chain} column="fair" curve="natural" />
          <ScatterChart series={chain} column="fair" id="fair" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
