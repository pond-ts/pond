import {
  ChartContainer,
  ChartRow,
  CrosshairCursor,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { Activity } from '@pond-ts/fit';
import { ValueSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { hillRide } from './lib/fit-fixtures';

const ride = Activity.from(hillRide());

// The whole curve: by default, a spread of durations from 1 s to the ride.
const curve = ride.power.curve();

// Keyed by duration, not time, so the x axis is seconds and can be log.
const bySeconds = ValueSeries.fromColumns({
  name: 'power curve',
  schema: [
    { name: 'seconds', kind: 'value' },
    { name: 'watts', kind: 'number' },
  ] as const,
  columns: {
    seconds: curve.map((e) => e.duration.seconds),
    watts: curve.map((e) => e.power.watts),
  },
});
const longest = curve.at(-1)!.duration.seconds;

export default function FitPowerCurve({ width = 680 }: { width?: number }) {
  const theme = useSiteChartTheme();
  return (
    <ChartContainer
      range={[1, longest]}
      width={width}
      theme={theme}
      xScale="log"
    >
      <CrosshairCursor />
      <ChartRow height={210}>
        <YAxis id="w" label="watts" min={0} width={52} />
        <Layers>
          <LineChart series={bySeconds} column="watts" axis="w" as="primary" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
