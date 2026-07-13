import { useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

export default function LearnZoom() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();
  // singleHostSeries() always returns a non-empty, fixed-length series, so
  // timeRange() is never undefined here.
  const bounds = series.timeRange()!;
  const fullRange: readonly [number, number] = [bounds.begin(), bounds.end()];
  const [range, setRange] = useState<readonly [number, number]>(fullRange);
  const zoomed = range[0] !== fullRange[0] || range[1] !== fullRange[1];

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <button
          onClick={() => setRange(fullRange)}
          disabled={!zoomed}
          style={{
            padding: '4px 12px',
            borderRadius: 6,
            border: '1px solid var(--site-surface-border)',
            background: 'transparent',
            cursor: zoomed ? 'pointer' : 'default',
            opacity: zoomed ? 1 : 0.5,
            fontSize: 13,
          }}
        >
          ← Reset zoom
        </button>
        <span style={{ marginLeft: 10, fontSize: 12, opacity: 0.7 }}>
          drag on the chart to select a range
        </span>
      </div>
      <ChartContainer
        range={range}
        width={560}
        theme={theme}
        cursor="region"
        onRegionSelect={(r) => setRange(r)}
      >
        <ChartRow height={200}>
          <YAxis id="pct" side="right" format=".0%" />
          <Layers>
            <LineChart series={series} column="cpu" axis="pct" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
