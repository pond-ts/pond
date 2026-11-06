import {
  ChartContainer,
  ChartRow,
  CrosshairCursor,
  Layers,
  LineChart,
  Region,
  YAxis,
} from '@pond-ts/charts';
import { Activity, haversineMeters } from '@pond-ts/fit';
import { col } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { intervalRun } from './lib/fit-fixtures';

// The run, as `readActivity` reads interval-run.fit.
const run = Activity.from(intervalRun());
const track = run.toSeries();
const start = run.startedAt.getTime();

// Speed over the last 10 s from the GPS steps: one-second GPS speed is too
// jumpy to read. The rolled series keeps only what it computes, so heart rate
// is read from `track` and speed from `speed`, on the same time axis.
const lat = track.column('lat')!.toFloat64Array();
const lng = track.column('lng')!.toFloat64Array();
const step = lat.map((_, i) =>
  i ? haversineMeters(lat[i - 1]!, lng[i - 1]!, lat[i]!, lng[i]!) : 0,
);
const speed = track
  .withColumn('step', step)
  .rolling('10s', { meters: { from: 'step', using: 'sum' } })
  .withColumn('kmh', col('meters').mul(0.36));

// FIT laps have no names; the repeats are every other lap from the second.
const repeats = run.laps.filter((lap) => lap.id % 2 === 0 && lap.id < 13);

export default function FitRunChart({ width = 680 }: { width?: number }) {
  const theme = useSiteChartTheme();
  return (
    <ChartContainer
      range={track.timeRange()}
      width={width}
      theme={theme}
      origin="data"
    >
      <CrosshairCursor />
      <ChartRow height={170}>
        <YAxis id="kmh" label="km/h" min={0} width={52} />
        <Layers>
          {repeats.map((lap, i) => (
            <Region
              key={lap.id}
              from={start + lap.fromSeconds * 1000}
              to={start + lap.toSeconds * 1000}
              label={`R${i + 1}`}
              selectable={false}
            />
          ))}
          <LineChart series={speed} column="kmh" axis="kmh" as="primary" />
        </Layers>
      </ChartRow>
      <ChartRow height={120}>
        <YAxis id="bpm" label="bpm" width={52} pad={0.05} />
        <Layers>
          <LineChart series={track} column="hr" axis="bpm" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
