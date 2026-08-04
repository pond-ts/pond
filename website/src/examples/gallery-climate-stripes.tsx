import { useMemo, useState } from 'react';
import { BarChart, ChartContainer, ChartRow, Layers, YAxis } from '@pond-ts/charts';
import { useSiteChartTheme, useSequentialRamp } from '@site/src/theme/useSiteChartTheme';
import {
  STRIPES_BOUNDS,
  anomalyAt,
  anomalyStep,
  climateStripes,
} from './lib/weather-fixtures';
import readout from './lib/tracker-readout.module.css';

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
 *  whole record and back — you watch the dark end fill in, then the light.
 *
 *  `showReadout` adds the off-chart strip described below. It's off for the
 *  Gallery card (which has no room for it) and on for the page. */
export default function GalleryClimateStripes({
  width,
  phase,
  showReadout = false,
}: {
  width: number;
  phase?: number;
  showReadout?: boolean;
}) {
  const theme = useSiteChartTheme();
  const ramp = useSequentialRamp();
  const series = climateStripes();
  const [year, setYear] = useState<number | null>(null);

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

  const anomaly = year === null ? null : anomalyAt(year);

  return (
    // A single block, not a fragment: `<ChartExample>`'s stage is a flex row,
    // so two siblings would land side by side rather than stacked.
    <div style={{ width }}>
      {/* The readout IS this chart's legend. When colour carries the value,
          an in-chart pill can't help: `cursor="crosshair"` would read the
          drawn column, which is the constant `stripe` — "1.0" on every bar.
          So the cursor stays at its `'line'` default and `onTrackerChanged`
          surfaces the year and its anomaly outside the plot, which is the
          division of labour `<ChartContainer cursor>` documents. */}
      {showReadout && (
        <div className={readout.readout}>
          {year === null ? (
            <span className={readout.idle}>
              Point at a stripe to read its year and anomaly
            </span>
          ) : (
            <>
              <span className={readout.date}>{year}</span>
              <span className={readout.field}>
                <span className={readout.name}>anomaly</span>
                {anomaly === null
                  ? '—'
                  : `${anomaly > 0 ? '+' : ''}${anomaly.toFixed(2)} °C`}
              </span>
            </>
          )}
        </div>
      )}
      <ChartContainer
        range={[first, first + span]}
        width={width}
        theme={theme}
        onTrackerChanged={(info) =>
          setYear(
            info === null ? null : new Date(info.time).getUTCFullYear(),
          )
        }
      >
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
    </div>
  );
}
