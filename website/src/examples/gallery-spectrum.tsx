import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  XAxis,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  WAVE_FRAME_COUNT,
  WAVE_FREQUENCY_RANGE,
  WAVE_PEAK_DENSITY,
  WAVE_PEAK_FRAME,
  waveSpectrum,
} from './lib/science-fixtures';

/** An ocean wave energy spectrum — the canonical **non-time** series: 47
 *  (frequency, energy density) pairs from a NOAA buoy, keyed by frequency,
 *  with no time column anywhere. `ValueSeries.fromColumns` builds it directly
 *  and every draw layer reads it exactly as it reads a `TimeSeries`.
 *
 *  A second `<XAxis transform>` relabels the same shared scale as **period**
 *  (1/f), which is the unit oceanographers actually talk in — one pixel
 *  mapping, two tick layouts, and a nonlinear one at that, so the top strip's
 *  ticks bunch where the bottom's are even.
 *
 *  With a `phase` (the Gallery card's autoplay clock) the sweep steps through
 *  the storm's 48 hourly frames, so the spectral peak visibly migrates from
 *  the local wind sea to the 17-second swell. Without one it holds the frame
 *  with the most energy in it. */
export default function GallerySpectrum({
  width = 720,
  phase,
  height = 190,
}: {
  width?: number;
  phase?: number;
  height?: number;
}) {
  const theme = useSiteChartTheme();
  const frame =
    phase === undefined
      ? WAVE_PEAK_FRAME
      : Math.min(WAVE_FRAME_COUNT - 1, Math.floor(phase * WAVE_FRAME_COUNT));
  const spectrum = waveSpectrum(frame);

  return (
    <ChartContainer
      showAxis={false}
      range={WAVE_FREQUENCY_RANGE}
      width={width}
      theme={theme}
    >
      <XAxis
        side="top"
        transform={{ to: (f) => 1 / f, from: (p) => 1 / p }}
        format=",.0f"
        label="period (s)"
      />
      <ChartRow height={height}>
        {/* A fixed domain, so the autoplay sweep doesn't rescale the axis
            under itself — the peak growing is the thing you want to see. */}
        <YAxis
          id="e"
          label="energy density (m²/Hz)"
          format=",.0f"
          min={0}
          max={WAVE_PEAK_DENSITY}
          width={62}
        />
        <Layers>
          <AreaChart series={spectrum} column="density" axis="e" />
          <LineChart series={spectrum} column="density" axis="e" />
        </Layers>
      </ChartRow>
      <XAxis format=".2f" label="frequency (Hz)" />
    </ChartContainer>
  );
}
