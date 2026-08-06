import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  Marker,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  TIDE_RANGE,
  TIDE_RECORD_HIGH,
  tideExtremes,
  tideRecord,
} from './lib/science-fixtures';

/** A week of tide at Seattle: what the water actually did (the solid line)
 *  against what the harmonic prediction said it would (the muted one), with
 *  the predicted high and low waters dotted onto it.
 *
 *  The two lines separate on 27 December — that separation is the **storm
 *  surge**, and it is the whole reason to plot a measurement and its model on
 *  one pair of axes. A `<Marker>` pins the record high.
 *
 *  With a `phase` (the Gallery card's autoplay clock) a 34-hour window sweeps
 *  the record, which is a bit more than one full tidal day — so the card
 *  always shows a complete rise and fall, and the surge scrolls through. */
export default function GalleryTides({
  width = 720,
  phase,
  height = 200,
}: {
  width?: number;
  phase?: number;
  height?: number;
}) {
  const theme = useSiteChartTheme();
  const tide = tideRecord();

  const range =
    phase === undefined
      ? TIDE_RANGE
      : scanWindow(TIDE_RANGE[0], TIDE_RANGE[1], 34 * 3_600_000, phase);

  return (
    <ChartContainer range={range} width={width} theme={theme}>
      <ChartRow height={height}>
        <YAxis id="m" label="metres above MLLW" format=".1f" width={62} />
        <Layers>
          {/* The prediction goes first so the observed line draws over it —
              `muted` is the theme's hairline neutral, not a data hue, which is
              what a reference curve should read as. */}
          <LineChart
            series={tide}
            column="predicted"
            axis="m"
            as="muted"
            curve="monotone"
          />
          <LineChart
            series={tide}
            column="observed"
            axis="m"
            curve="monotone"
          />
          <ScatterChart
            series={tideExtremes('H')}
            column="level"
            axis="m"
            as="secondary"
            radius={3}
          />
          <ScatterChart
            series={tideExtremes('L')}
            column="level"
            axis="m"
            as="secondary"
            radius={3}
          />
          <Marker at={TIDE_RECORD_HIGH.at} label="record high" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
