import {
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  LineChart,
  Marker,
  Region,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  ECLIPSE_MARKS,
  eclipseDemand,
  eclipseDemandRange,
} from './lib/energy-fixtures';

const HOUR = 3_600_000;

/** Spain's measured demand against REE's forecast on the evening of the
 *  12 August 2026 total solar eclipse — the tides pattern (a measurement over
 *  its model, `muted` for the model) plus the annotation register saying
 *  *why* they disagree: a `<Region>` spanning the partial phases and a
 *  `<Marker>` where the umbra crossed. Demand ran up to 2.13 GW under
 *  forecast, bottoming ten minutes after totality.
 *
 *  The default range is eclipse day as a civil day — 03:00 CEST on the 12th
 *  to 03:00 on the 13th, where the record ends — so the whole diurnal shape
 *  frames the ninety-minute dip. With a `phase` (the card's autoplay clock) a
 *  7-hour window sweeps the full record instead, so the tight tracking on
 *  either side scrolls past as context. `full` opens all thirty hours. */
export default function GalleryEclipseDemand({
  width,
  phase,
  height = 220,
  legend = false,
  full = false,
}: {
  width: number;
  phase?: number;
  height?: number;
  legend?: boolean;
  full?: boolean;
}) {
  const theme = useSiteChartTheme();
  const series = eclipseDemand();
  const [begin, end] = eclipseDemandRange();

  const range: [number, number] =
    phase !== undefined
      ? scanWindow(begin, end, 7 * HOUR, phase)
      : full
        ? [begin, end]
        : // The record starts 21:00 on the 11th; six hours in is 03:00 CEST
          // on the 12th, and the record's own end is 03:00 on the 13th.
          [begin + 6 * HOUR, end];

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      cursor="crosshair"
    >
      <ChartRow height={height}>
        <YAxis id="gw" label="GW" format=".1f" width={48} />
        <Layers>
          {/* The forecast goes first so the measurement draws over it —
              `muted` is the theme's hairline neutral, not a data hue, which
              is what a model curve should read as. */}
          <LineChart
            series={series}
            column="forecast"
            axis="gw"
            as="muted"
            legend="Forecast"
          />
          <LineChart
            series={series}
            column="demand"
            axis="gw"
            legend="Demand"
          />
          <Region
            from={ECLIPSE_MARKS.partialsBegin}
            to={ECLIPSE_MARKS.partialsEnd}
            label="eclipse"
          />
          <Marker at={ECLIPSE_MARKS.totality} label="totality" />
        </Layers>
      </ChartRow>
      {legend ? <Legend placement="top-left" /> : null}
    </ChartContainer>
  );
}
