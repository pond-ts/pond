import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { ValueSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';

// An options chain: rows are naturally keyed by strike, never by time. There
// is no time column to project from — ValueSeries.fromColumns builds the
// value-keyed series directly, the value-axis counterpart of
// TimeSeries.fromColumns.
function smileChain() {
  const spot = 100;
  const strikes: number[] = [];
  const fair: number[] = [];
  for (let k = 80; k <= 120; k += 2.5) {
    const m = k - spot;
    strikes.push(k);
    fair.push(0.24 + 0.00042 * m * m - 0.0016 * m);
  }
  return ValueSeries.fromColumns({
    name: 'smile',
    schema: [
      { name: 'strike', kind: 'value' },
      { name: 'fair', kind: 'number' },
    ] as const,
    columns: { strike: strikes, fair },
  });
}

export default function ChartsValueAxisNative() {
  const theme = useSiteChartTheme();
  const chain = smileChain();

  return (
    <ChartContainer timeFormat=",.0f" width={560} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="iv" label="implied vol" format=".1%" />
        <Layers>
          <LineChart series={chain} column="fair" curve="natural" />
          <ScatterChart series={chain} column="fair" id="fair" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
