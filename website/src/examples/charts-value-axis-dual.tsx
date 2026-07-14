import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  ScatterChart,
  XAxis,
  YAxis,
} from '@pond-ts/charts';
import { ValueSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';

const SPOT = 100;

function smileChain() {
  const strikes: number[] = [];
  const fair: number[] = [];
  for (let k = 80; k <= 120; k += 2.5) {
    const m = k - SPOT;
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
