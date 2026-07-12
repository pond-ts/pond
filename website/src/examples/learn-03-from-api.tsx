import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { TimeSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';

// The shape an API handler hands you: an array of plain objects. Fixed
// timestamps (not Date.now()) so this renders identically on every visit.
const apiResponse = [
  { time: 1_700_000_000_000, cpu: 0.31 },
  { time: 1_700_000_060_000, cpu: 0.34 },
  { time: 1_700_000_120_000, cpu: 0.42 },
  { time: 1_700_000_180_000, cpu: 0.47 },
  { time: 1_700_000_240_000, cpu: 0.39 },
  { time: 1_700_000_300_000, cpu: 0.44 },
  { time: 1_700_000_360_000, cpu: 0.52 },
  { time: 1_700_000_420_000, cpu: 0.49 },
];

export default function FromApi() {
  const theme = useSiteChartTheme();
  const series = TimeSeries.fromJSON({
    name: 'cpu',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
    ] as const,
    rows: apiResponse,
  });

  return (
    <ChartContainer range={series.timeRange()} width={560} theme={theme}>
      <ChartRow height={200}>
        <YAxis id="pct" side="right" format=".0%" />
        <Layers>
          <LineChart series={series} column="cpu" axis="pct" as="primary" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
