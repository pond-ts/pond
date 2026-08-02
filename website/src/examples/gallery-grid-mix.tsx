import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { gridMix, gridMixRange } from './lib/energy-fixtures';

const HOUR = 3_600_000;

/**
 * **Cumulative** columns, one per band: `s2` is `other + lignite`, `s3` adds
 * hard coal, and `s8` is total generation. That is the whole trick to a
 * stacked area — pond builds the running totals with `collapse(…, { append:
 * true })`, and the chart draws each cumulative column as a plain area from
 * zero.
 *
 * `collapse` is the right operator rather than eight hand-written loops
 * because it stays columnar (no per-row `Event` materialization) and each call
 * appends one column to the same series, so the result is still one
 * `TimeSeries` the chart can read eight ways.
 */
function stacked() {
  return gridMix()
    .collapse(['other', 'lignite'], 's2', (v) => v.other + v.lignite, {
      append: true,
    })
    .collapse(['s2', 'hardCoal'], 's3', (v) => v.s2 + v.hardCoal, {
      append: true,
    })
    .collapse(['s3', 'gas'], 's4', (v) => v.s3 + v.gas, { append: true })
    .collapse(['s4', 'biomass'], 's5', (v) => v.s4 + v.biomass, {
      append: true,
    })
    .collapse(['s5', 'hydro'], 's6', (v) => v.s5 + v.hydro, { append: true })
    .collapse(['s6', 'wind'], 's7', (v) => v.s6 + v.wind, { append: true })
    .collapse(['s7', 'solar'], 's8', (v) => v.s7 + v.solar, { append: true });
}

/**
 * Bands **top-of-stack first** — which is also the paint order. Each area is
 * drawn from zero to its cumulative total, so a later (smaller) one covers the
 * lower part of the one before it and the slab left visible for band `k` is
 * exactly `[cumulative(k-1), cumulative(k)]`.
 *
 * This only reads as slabs because the `seq1…seq8` area roles set
 * `flatFill` — an area's default gradient fades to transparent at the
 * baseline, which would let all eight bands show through each other.
 */
const PAINT_ORDER = [
  { column: 's8', as: 'seq8', label: 'Solar' },
  { column: 's7', as: 'seq7', label: 'Wind' },
  { column: 's6', as: 'seq6', label: 'Hydro' },
  { column: 's5', as: 'seq5', label: 'Biomass' },
  { column: 's4', as: 'seq4', label: 'Gas' },
  { column: 's3', as: 'seq3', label: 'Hard coal' },
  { column: 's2', as: 'seq2', label: 'Lignite' },
  { column: 'other', as: 'seq1', label: 'Other' },
] as const;

/**
 * Germany's generation mix over Easter weekend 2025, eight bands stacked —
 * the chart the sequential ramp exists for (gallery plan §8.2: more than four
 * series goes tonal, not chromatic).
 *
 * With a `phase` (the Gallery card's autoplay clock) a 14-hour window sweeps
 * the three days, so the solar bulge grows and collapses as it crosses. Every
 * other embed passes no phase and gets the whole weekend.
 */
export default function GalleryGridMix({
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
  const series = stacked();
  const [begin, end] = gridMixRange();
  const range: [number, number] =
    phase === undefined
      ? [begin, end]
      : scanWindow(begin, end, 14 * HOUR, phase);

  return (
    <ChartContainer range={range} width={width} theme={theme}>
      <ChartRow height={height}>
        <YAxis id="gw" label="GW" format=",.0f" min={0} width={56} />
        <Layers>
          {PAINT_ORDER.map((band) => (
            <AreaChart
              key={band.column}
              series={series}
              column={band.column}
              as={band.as}
              axis="gw"
              baseline={0}
              legend={band.label}
            />
          ))}
        </Layers>
      </ChartRow>
      {legend ? <Legend placement="top-left" /> : null}
    </ChartContainer>
  );
}
