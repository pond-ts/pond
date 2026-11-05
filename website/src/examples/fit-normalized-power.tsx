import {
  Baseline,
  ChartContainer,
  ChartRow,
  CrosshairCursor,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { Activity } from '@pond-ts/fit';
import { col } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { hillRide } from './lib/fit-fixtures';

const ride = Activity.from(hillRide());
const np = ride.stats().power.normalized!.watts;

// Power with the dropouts left out, then its 30 s rolling average: the line
// normalized power is built from.
const power = ride
  .toSeries()
  .select('power')
  .filter(col('power').isMissing().not());
const rolled = power.rolling('30s', { p30: { from: 'power', using: 'avg' } });

// Coasting (0 W) blanked for drawing, so a descent is a gap, not a fence.
const watts = power.column('power')!.toFloat64Array();
const drawn = power
  .withColumn(
    'pedalling',
    watts.map((w) => (w > 0 ? w : NaN)),
  )
  .withColumn('p30', rolled.column('p30')!.toFloat64Array());

export default function FitNormalizedPower({
  width = 680,
}: {
  width?: number;
}) {
  const theme = useSiteChartTheme();
  return (
    <ChartContainer
      range={drawn.timeRange()}
      width={width}
      theme={theme}
      origin="data"
    >
      <CrosshairCursor />
      <ChartRow height={210}>
        <YAxis id="w" label="watts" min={0} width={52} />
        <Layers>
          <LineChart series={drawn} column="pedalling" axis="w" as="muted" />
          <LineChart series={drawn} column="p30" axis="w" as="primary" />
          <Baseline
            value={np}
            axis="w"
            label={`NP ${Math.round(np)} W`}
            indicator
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
