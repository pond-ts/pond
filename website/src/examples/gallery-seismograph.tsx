import { useEffect, useRef, useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  type DrawStatsFrame,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  SEISMIC_RANGE,
  SEISMIC_SAMPLE_COUNT,
  seismogram,
} from './lib/science-fixtures';

/**
 * A live draw-cost readout, fed by `<ChartContainer onDrawStats>`.
 *
 * The callback fires **inside the draw frame**, so it must be cheap: it writes
 * to a ref and nothing else. A 4 Hz interval publishes the latest frame to
 * React, which is fast enough to read and slow enough not to re-render the
 * page 60 times a second.
 */
function useDrawStats(enabled: boolean) {
  const latest = useRef<DrawStatsFrame | null>(null);
  const [shown, setShown] = useState<DrawStatsFrame | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setShown(latest.current), 250);
    return () => clearInterval(id);
  }, [enabled]);
  const onDrawStats = enabled
    ? (frame: DrawStatsFrame) => {
        latest.current = frame;
      }
    : undefined;
  return { onDrawStats, shown };
}

/** A seismogram: {@link SEISMIC_SAMPLE_COUNT} samples of ground velocity at
 *  40 Hz, drawn as one line. Denser than the plot has pixels, which is the
 *  point — M4 decimation reduces the visible slice to a pixel-identical
 *  polyline before it strokes, so dragging and wheel-zooming stay interactive.
 *
 *  With a `phase` (the Gallery card's autoplay clock) a 40-second window
 *  sweeps the trace so the P arrival scrolls past; without one you get the
 *  whole record, pannable and zoomable, with the draw-cost readout that says
 *  what decimation actually cost this frame. */
export default function GallerySeismograph({
  width = 720,
  phase,
  height = 200,
}: {
  width?: number;
  phase?: number;
  height?: number;
}) {
  const theme = useSiteChartTheme();
  const trace = seismogram();
  const animating = phase !== undefined;
  const { onDrawStats, shown } = useDrawStats(!animating);

  const range = animating
    ? scanWindow(SEISMIC_RANGE[0], SEISMIC_RANGE[1], 40_000, phase)
    : SEISMIC_RANGE;

  const line = shown?.layers[0];

  return (
    <div>
      <ChartContainer
        range={range}
        width={width}
        theme={theme}
        // Pan and zoom are uncontrolled, which means a `range` update would be
        // ignored once the user has moved — so the animating card leaves them
        // off and drives `range` instead.
        panZoom={!animating}
        bounds={SEISMIC_RANGE}
        minDuration={2000}
        onDrawStats={onDrawStats}
        timeFormat="%H:%M:%S"
      >
        <ChartRow height={height}>
          <YAxis id="v" label="velocity (µm/s)" format=",.0f" width={62} />
          <Layers>
            <LineChart series={trace} column="velocity" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
      {line ? (
        <p
          style={{
            margin: '6px 0 0',
            fontSize: 13,
            fontFamily: 'ui-monospace, monospace',
            color: 'var(--pond-muted)',
          }}
        >
          {SEISMIC_SAMPLE_COUNT.toLocaleString('en-US')} samples ·{' '}
          {line.sourceCount?.toLocaleString('en-US') ?? '—'} in view ·{' '}
          <strong>
            {line.drawnCount?.toLocaleString('en-US') ?? '—'} stroked
          </strong>{' '}
          {line.decimated ? '(decimated)' : '(every point)'} ·{' '}
          {shown!.totalDrawMs.toFixed(2)} ms
        </p>
      ) : null}
    </div>
  );
}
