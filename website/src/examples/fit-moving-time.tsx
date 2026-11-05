import {
  ChartContainer,
  ChartRow,
  CrosshairCursor,
  Layers,
  LineChart,
  Region,
  YAxis,
} from '@pond-ts/charts';
import { Activity, haversineMeters, MOVING_SPEED_MPS } from '@pond-ts/fit';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { intervalRun } from './lib/fit-fixtures';

const run = Activity.from(intervalRun());
const track = run.toSeries();
const times = track.keyColumn().begin;
const lat = track.column('lat')!.toFloat64Array();
const lng = track.column('lng')!.toFloat64Array();

// Speed over each gap between samples, as the moving rule judges it.
const speed = lat.map((_, i) =>
  i
    ? haversineMeters(lat[i - 1]!, lng[i - 1]!, lat[i]!, lng[i]!) /
      ((times[i]! - times[i - 1]!) / 1000)
    : NaN,
);

// The stopped stretches: runs of gaps below the threshold.
const stops: Array<[number, number]> = [];
for (let i = 1; i < speed.length; i++) {
  if (!(speed[i]! < MOVING_SPEED_MPS)) continue;
  const last = stops[stops.length - 1];
  if (last && last[1] === times[i - 1]) last[1] = times[i]!;
  else stops.push([times[i - 1]!, times[i]!]);
}

// Drawn as km/h over the last 5 s, so the line is readable; the shading is
// from the gap-by-gap speed above.
const kmh = track
  .withColumn('speed', speed)
  .smooth('speed', 'movingAverage', { window: '5s', output: 'smooth' });
const shown = kmh.withColumn(
  'kmh',
  kmh
    .column('smooth')!
    .toFloat64Array()
    .map((v) => v * 3.6),
);

export default function FitMovingTime({ width = 680 }: { width?: number }) {
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
          {stops.map(([from, to]) => (
            <Region
              key={from}
              from={from}
              to={to}
              label={false}
              selectable={false}
            />
          ))}
          <LineChart series={shown} column="kmh" axis="kmh" as="primary" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
