import {
  BarChart,
  Baseline,
  ChartContainer,
  ChartRow,
  CrosshairCursor,
  Layers,
  LineChart,
  LineCursor,
  YAxis,
} from '@pond-ts/charts';
import { Activity } from '@pond-ts/fit';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { intervalRun } from './lib/fit-fixtures';

const run = Activity.from(intervalRun());
const zones = run.analyze({
  athlete: { hrZone: [{ at: '2026-01-01', maxHr: 186 }] },
}).zones.heartRate!;

// The bpm axis starts a little under the run's lowest heart rate, so zone 1
// (whose edge is 0 bpm) is drawn from there.
const FLOOR = 80;
const bars = zones.map((z) => ({
  start: Math.max(z.start, FLOOR),
  end: z.end,
  minutes: z.seconds / 60,
}));
const top = bars.at(-1)!.end;

export default function FitTimeInZones({ width = 680 }: { width?: number }) {
  const theme = useSiteChartTheme();
  const track = run.toSeries();
  return (
    <div>
      <ChartContainer
        range={track.timeRange()}
        width={width}
        theme={theme}
        origin="data"
      >
        <CrosshairCursor />
        <ChartRow height={180}>
          <YAxis id="bpm" label="bpm" min={FLOOR} max={top} width={52} />
          <Layers>
            <LineChart series={track} column="hr" axis="bpm" as="primary" />
            {zones.slice(1).map((z) => (
              <Baseline
                key={z.zone}
                value={z.start}
                axis="bpm"
                label={`Z${z.zone}`}
              />
            ))}
          </Layers>
        </ChartRow>
      </ChartContainer>
      <ChartContainer range={[FLOOR, top]} width={width} theme={theme}>
        <LineCursor />
        <ChartRow height={150}>
          <YAxis id="min" label="minutes" min={0} width={52} />
          <Layers>
            <BarChart bins={bars} column="minutes" axis="min" gap={4} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
