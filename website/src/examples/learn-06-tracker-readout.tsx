import { useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  type TrackerInfo,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

export default function LearnTrackerReadout() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();
  const [info, setInfo] = useState<TrackerInfo | null>(null);

  return (
    <div>
      <div
        style={{
          marginBottom: 10,
          fontSize: 13,
          fontFamily: 'ui-monospace, monospace',
          minHeight: 20,
        }}
      >
        {info === null
          ? 'hover the chart →'
          : info.values.map((v) => (
              <span key={v.label} style={{ color: v.color, marginRight: 16 }}>
                {v.label}: {(v.value * 100).toFixed(1)}%
              </span>
            ))}
      </div>
      <ChartContainer
        range={series.timeRange()}
        width={560}
        theme={theme}
        cursor="line"
        onTrackerChanged={setInfo}
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
