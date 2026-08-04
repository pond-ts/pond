import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  SEA_ANNUAL_MM,
  SEA_BOUNDS,
  SEA_DAILY_CEILING_MM,
  seattleRainfall,
} from './lib/weather-fixtures';
import styles from './gallery-rainfall.module.css';

const DAY_MS = 86_400_000;

/** Width from the container rather than a fixed pixel count — `width` is an
 *  explicit number, so responsiveness is one `ResizeObserver` away. The same
 *  hook the charts hero uses; see the responsive-width recipe. */
function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Rainfall and running total: daily precipitation as bars against a
 *  millimetres-per-day axis on the left, the year's cumulative total as a line
 *  against a second axis on the right. Two quantities in different units, one
 *  row — the dual-axis case, and the one chart where a rainy season is obvious
 *  at a glance (the curve goes flat all summer).
 *
 *  Both axes are pinned rather than auto-fitted, which is what keeps the
 *  cumulative line's height meaning "how much of the year's rain has fallen"
 *  no matter how far you've zoomed in.
 *
 *  **Two modes, and they can't be one.** Given a `phase` (the Gallery card's
 *  autoplay clock) the range is driven by the sweep, so the chart is a
 *  self-playing preview with a crosshair and no gestures — a drag would be
 *  overwritten on the next frame. Without a `phase` it's the interactive
 *  version: a controlled range, wheel to zoom, and a **region drag that zooms
 *  to the span you dragged**. */
export default function GalleryRainfall({
  width: fixedWidth,
  phase,
}: {
  /** Explicit width (the Gallery card measures its own). Omitted ⇒ measured. */
  width?: number;
  phase?: number;
}) {
  const theme = useSiteChartTheme();
  const series = seattleRainfall();
  const [boxRef, measured] = useMeasuredWidth<HTMLDivElement>();
  const width = fixedWidth ?? measured;

  // Interaction and autoplay are mutually exclusive: the sweep owns the range
  // in autoplay, so gestures would be reverted on the next animation frame.
  const interactive = phase === undefined;

  // Controlled range. `panZoom` alone could run uncontrolled (the container
  // holds the view), but zoom-to-selection has to *set* the range from
  // outside, and an uncontrolled container ignores later `range` props by
  // design so they can't fight a user's pan.
  const [range, setRange] = useState<readonly [number, number]>(SEA_BOUNDS);
  // Escape hatch for a stale zoom left behind by a hot reload in development.
  useEffect(() => {
    if (!interactive) setRange(SEA_BOUNDS);
  }, [interactive]);

  const view = interactive
    ? range
    : scanWindow(SEA_BOUNDS[0], SEA_BOUNDS[1], 140 * DAY_MS, phase!);

  const zoomed = range[0] !== SEA_BOUNDS[0] || range[1] !== SEA_BOUNDS[1];

  return (
    <div ref={boxRef} style={{ width: fixedWidth ?? '100%' }}>
      {interactive && (
        <div className={styles.bar}>
          <span className={styles.hint}>
            Drag across the plot to zoom into a span; wheel to zoom in and out.
          </span>
          <button
            type="button"
            className={styles.reset}
            onClick={() => setRange(SEA_BOUNDS)}
            disabled={!zoomed}
          >
            Reset to 2024
          </button>
        </div>
      )}
      {width > 0 && (
        <ChartContainer
          range={view}
          width={width}
          theme={theme}
          // `region` shades the bucket under the pointer and makes a drag a
          // span selection. With no `cursorSequence` the buckets come from the
          // first bar layer's own bins, so both the highlight and the
          // selection land day-aligned on the bars for free.
          cursor={interactive ? 'region' : 'crosshair'}
          // Wheel-zoom. Drag would pan, but an unmodified region-drag
          // **preempts** pan — which is the trade this chart wants, since
          // drag-to-zoom is the more useful gesture on a year of daily bars.
          // `regionSelectModifier="shift"` reverses the priority.
          panZoom={interactive ? 'panZoom' : false}
          // The view can't leave 2024 however hard you scroll.
          bounds={SEA_BOUNDS}
          onTimeRangeChange={interactive ? setRange : undefined}
          onRegionSelect={interactive ? setRange : undefined}
        >
          <ChartRow height={220}>
            <YAxis
              id="mm"
              side="left"
              label="mm/day"
              format=",.0f"
              width={46}
              min={0}
              max={SEA_DAILY_CEILING_MM}
            />
            <Layers>
              <BarChart series={series} column="precip" axis="mm" gap={1} />
              {/* `secondary` (the palette's blue) rather than the default teal —
                  two quantities on two axes need two hues, and blue next to the
                  accent reads as a companion rather than a competitor. */}
              <LineChart
                series={series}
                column="cumulative"
                axis="total"
                as="secondary"
              />
            </Layers>
            <YAxis
              id="total"
              side="right"
              label="mm this year"
              format=",.0f"
              width={62}
              min={0}
              max={SEA_ANNUAL_MM}
            />
          </ChartRow>
        </ChartContainer>
      )}
    </div>
  );
}
