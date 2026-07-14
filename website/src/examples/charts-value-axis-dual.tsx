import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  ScatterChart,
  XAxis,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { SPOT, smileChain } from './lib/value-axis-fixtures';

export default function ChartsValueAxisDual() {
  const theme = useSiteChartTheme();
  const chain = smileChain();

  return (
    <ChartContainer showAxis={false} width={560} theme={theme}>
      {/* A second <XAxis> relabels the SAME shared scale into a derived
          unit via `transform` — one pixel mapping, two tick layouts. Here
          strike (below) and moneyness = strike / spot (above) are linearly
          related, so the top strip's ticks land evenly too. */}
      <XAxis
        side="top"
        transform={{ to: (k) => k / SPOT, from: (m) => m * SPOT }}
        format=".2f"
        label="Moneyness"
      />
      <ChartRow height={220}>
        <YAxis id="iv" label="implied vol" format=".1%" />
        <Layers>
          <LineChart series={chain} column="fair" curve="natural" />
          <ScatterChart series={chain} column="fair" id="fair" />
        </Layers>
      </ChartRow>
      <XAxis label="Strike" format=",.0f" />
    </ChartContainer>
  );
}
