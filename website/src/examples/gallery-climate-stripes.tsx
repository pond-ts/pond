import { useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  HeatMap,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import {
  useSiteChartTheme,
  useSequentialRamp,
} from '@site/src/theme/useSiteChartTheme';
import { STRIPES_BOUNDS, climateStripes } from './lib/weather-fixtures';
import readout from './lib/tracker-readout.module.css';

const YEAR_MS = 365.2425 * 86_400_000;

/** Climate stripes: 146 years of global temperature anomaly, one bar per year,
 *  every cell the same height. The **colour is the value**, which is what a
 *  `<HeatMap>` is for: one cell per year, `anomaly` encoded as colour and
 *  reported as the value. This card used to be a `<BarChart>` with a constant
 *  `stripe` column (so every bar was full height) plus a caller-computed
 *  `binColors` array; both are gone, and so is the out-of-band lookup the
 *  readout needed.
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
  // The cell reports its own value now, so the readout holds both together
  // rather than looking the number up by year.
  const [hit, setHit] = useState<{ year: number; anomaly: number } | null>(
    null,
  );

  const [first, last] = STRIPES_BOUNDS;
  // Out-and-back rather than wrapping: a window that jumped back to the start
  // once a loop would read as a glitch (see `scanWindow`'s own note).
  const grow =
    phase === undefined ? 1 : phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const span = 60 * YEAR_MS + grow * (last - first - 60 * YEAR_MS);

  return (
    // A single block, not a fragment: `<ChartExample>`'s stage is a flex row,
    // so two siblings would land side by side rather than stacked.
    <div style={{ width }}>
      {/* The readout IS this chart's legend, and it now reads the chart. The
          bar version could not: a crosshair would have read the drawn column,
          the constant `stripe` — "1.0" on every bar — so the anomaly had to be
          fetched from the fixture by year. A heat-map cell carries its value,
          so `onTrackerChanged` hands over the real number. */}
      {showReadout && (
        <div className={readout.readout}>
          {hit === null ? (
            <span className={readout.idle}>
              Point at a stripe to read its year and anomaly
            </span>
          ) : (
            <>
              <span className={readout.date}>{hit.year}</span>
              <span className={readout.field}>
                <span className={readout.name}>anomaly</span>
                {`${hit.anomaly > 0 ? '+' : ''}${hit.anomaly.toFixed(2)} °C`}
              </span>
            </>
          )}
        </div>
      )}
      <ChartContainer
        range={[first, first + span]}
        width={width}
        theme={theme}
        onTrackerChanged={(info) => {
          const sample = info?.values[0];
          setHit(
            info === null || sample === undefined
              ? null
              : {
                  year: new Date(info.time).getUTCFullYear(),
                  // `value` is where the cursor would draw (the row
                  // centre); `readout` is the cell's number. See the page.
                  anomaly: sample.readout ?? sample.value,
                },
          );
        }}
      >
        <ChartRow height={200}>
          {/* One row, so the layer's own `[0, 1]` extent is the whole plot.
              `hide` takes the axis off the canvas entirely ([PND-AXISHIDE]):
              a single unnamed row has no scale worth drawing. */}
          <YAxis id="stripe" hide />
          <Layers>
            <HeatMap
              series={series}
              columns={['anomaly']}
              colors={ramp}
              axis="stripe"
              gap={0}
              id="stripes"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
