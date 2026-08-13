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
  eclipseSolar,
  eclipseSolarRange,
} from './lib/energy-fixtures';

const HOUR = 3_600_000;

/** Spain's solar generation on eclipse day (12 August 2026) over the
 *  previous day's curve at the same clock time — the generation half of the
 *  eclipse story, sharing its annotation marks with the demand card. The
 *  Moon takes a second, faster sunset out of the middle of the real one:
 *  4.47 GW below the ordinary evening at 20:15 CEST.
 *
 *  The muted curve is **11 August plotted 24 h forward** — a same-clock-time
 *  overlay (the nino34 card's device, two days instead of 45 years). The
 *  default range is the full civil day; with a `phase` (the card's autoplay
 *  clock) a 7-hour window sweeps it, and the static frame parks on the
 *  evening. */
export default function GalleryEclipseSolar({
  width,
  phase,
  height = 220,
  legend = false,
}: {
  width: number;
  phase?: number;
  height?: number;
  legend?: boolean;
}) {
  const theme = useSiteChartTheme();
  const series = eclipseSolar();
  const [begin, end] = eclipseSolarRange();

  const range: [number, number] =
    phase === undefined
      ? [begin, end]
      : scanWindow(begin, end, 7 * HOUR, phase);

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      cursor="crosshair"
    >
      <ChartRow height={height}>
        <YAxis id="gw" label="GW" format=".1f" min={0} width={48} />
        <Layers>
          {/* The ordinary evening goes first so eclipse day draws over it —
              `muted` because the reference curve is context, not data of
              equal standing. */}
          <LineChart
            series={series}
            column="dayBefore"
            axis="gw"
            as="muted"
            legend="Day before"
          />
          <LineChart
            series={series}
            column="eclipseDay"
            axis="gw"
            legend="Eclipse day"
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
