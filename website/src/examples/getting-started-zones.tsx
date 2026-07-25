import {
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { computePower } from '@pond-ts/fit';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { ride, RIDE_ELAPSED_S, RIDE_FTP } from './lib/ride-fixtures';

const rideSeries = ride();
const startMs = rideSeries.keyColumn().begin[0]!;

const power = computePower(
  Float64Array.from(
    rideSeries.keyColumn().begin,
    (ms) => (ms - startMs) / 1000,
  ),
  rideSeries.column('watts').toFloat64Array(),
  RIDE_FTP,
  RIDE_ELAPSED_S,
);

// `power.zones` is already chart-ready: fit reports bands as { start, end, … },
// the same shape core's `byColumn` returns. The only thing added here is a
// minutes column — seconds would draw identically, just read worse.
const zones = power.zones.map((z) => ({ ...z, minutes: z.seconds / 60 }));

// Ordinal slots, so a 40 W zone and an open-ended one get equal height; the
// labels sit at each slot's centre. `openEnded` marks the band with no upper
// bound — say "300 W+", not "300–440 W".
const ticks = power.zones.map((z, i) => ({
  at: i + 0.5,
  label: `Z${z.zone} ${z.openEnded ? `${z.start}+` : `${z.start}–${z.end}`} W`,
}));

export default function GettingStartedZones() {
  const theme = useSiteChartTheme();

  return (
    <ChartContainer width={680} theme={theme}>
      <ChartRow height={210}>
        <YAxis id="zone" label="power zone" width={116} ticks={ticks} />
        <Layers>
          <BarChart
            bins={zones}
            column="minutes"
            axis="zone"
            orientation="horizontal"
            ordinal
            gap={6}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
