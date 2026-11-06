import {
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineCursor,
  YAxis,
} from '@pond-ts/charts';
import { Activity, km } from '@pond-ts/fit';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { intervalRun } from './lib/fit-fixtures';

const run = Activity.from(intervalRun());

// One bar per split, from where it starts to where it ends (in km), its value
// the split's pace in minutes per km: the bins shape `<BarChart>` takes.
const bars = run.splits(km(1)).map((split) => ({
  start: split.bounds.distance.from.km,
  end: split.bounds.distance.to.km,
  pace: split.stats().pace.average!.secondsPerKm / 60,
}));

export default function FitSplits({ width = 680 }: { width?: number }) {
  const theme = useSiteChartTheme();
  return (
    <ChartContainer range={[0, bars.at(-1)!.end]} width={width} theme={theme}>
      <LineCursor />
      <ChartRow height={180}>
        <YAxis id="pace" label="min/km" min={0} width={52} />
        <Layers>
          <BarChart bins={bars} column="pace" axis="pace" gap={4} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
