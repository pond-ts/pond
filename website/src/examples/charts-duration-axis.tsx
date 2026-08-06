import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  XAxis,
  YAxis,
} from '@pond-ts/charts';
import { TimeSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';

/** A ride that started at 10:33:17 — a deliberately un-round instant, so the
 *  duration labels and the wall-clock labels can't be confused. */
const START = Date.UTC(2026, 0, 15, 10, 33, 17);

function ride() {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < 73; i += 1) {
    rows.push([START + i * 10_000, 138 + 22 * Math.sin(i / 8) + (i % 3)]);
  }
  return new TimeSeries({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'hr', kind: 'number' },
    ] as const,
    rows,
  });
}

export default function ChartsDurationAxis() {
  const theme = useSiteChartTheme();

  return (
    <ChartContainer showAxis={false} width={560} theme={theme} origin="data">
      <ChartRow height={200}>
        <YAxis id="hr" label="bpm" width={44} />
        <Layers>
          <LineChart series={ride()} column="hr" axis="hr" />
        </Layers>
      </ChartRow>
      {/* The primary strip reads durations from the ride's first sample. */}
      <XAxis label="Elapsed" />
      {/* A second strip on the SAME origin-anchored ticks: a d3 time specifier
          can only describe an instant, so it labels the wall clock underneath. */}
      <XAxis format="%H:%M" />
    </ChartContainer>
  );
}
