import { useMemo } from 'react';
import { BarChart, ChartContainer, ChartRow, Layers, YAxis } from '@pond-ts/charts';
import { useSiteChartTheme, useSequentialRamp } from '@site/src/theme/useSiteChartTheme';
import {
  STRIPES_BOUNDS,
  anomalyStep,
  climateStripes,
} from './lib/weather-fixtures';

const YEAR_MS = 365.2425 * 86_400_000;

/** Hoisted so the axis doesn't re-register on every animation frame. */
const NO_TICKS: ReadonlyArray<{ at: number; label: string }> = [];

/** Climate stripes: 146 years of global temperature anomaly, one bar per year,
 *  every bar the same height. The **colour is the value** — the bars carry a
 *  constant `stripe` column purely so each year gets a full-height slot, and
 *  `binColors` does the encoding off the anomaly.
 *
 *  Ed Hawkins' original uses a diverging blue-to-red scale; this one steps
 *  through the site's own sequential ramp, dark to light, because the palette
 *  rule here is one family rather than competing hues. Swapping in your own
 *  eight colours is the same one line.
 *
 *  With a `phase` the visible range grows from the first 60 years out to the
 *  whole record and back — you watch the dark end fill in, then the light. */
export default function GalleryClimateStripes({
  width,
  phase,
}: {
  width: number;
  phase?: number;
}) {
  const theme = useSiteChartTheme();
  const ramp = useSequentialRamp();
  const series = climateStripes();

  const colors = useMemo(
    () =>
      Array.from(series.column('anomaly').toFloat64Array(), (anomaly) =>
        ramp[anomalyStep(anomaly, ramp.length)],
      ),
    [series, ramp],
  );

  const [first, last] = STRIPES_BOUNDS;
  // Out-and-back rather than wrapping: a window that jumped back to the start
  // once a loop would read as a glitch (see `scanWindow`'s own note).
  const grow = phase === undefined ? 1 : phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const span = 60 * YEAR_MS + grow * (last - first - 60 * YEAR_MS);

  return (
    <ChartContainer range={[first, first + span]} width={width} theme={theme}>
      <ChartRow height={200}>
        {/* The value axis exists only to give every stripe the same height.
            `min`/`max` pin it (a constant column has no extent of its own to
            fit to); `ticks={[]}` and zero width take it off the canvas
            entirely, because "0.0 … 1.0" would be a scale for a quantity
            this chart isn't showing. */}
        <YAxis id="stripe" min={0} max={1} width={0} ticks={NO_TICKS} />
        <Layers>
          <BarChart
            series={series}
            column="stripe"
            axis="stripe"
            binColors={colors}
            gap={0}
            id="stripes"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
