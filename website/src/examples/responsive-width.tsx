import { useLayoutEffect, useRef, useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

/** Measure a box's content width via `ResizeObserver`. The first read is
 *  synchronous (`getBoundingClientRect`) so it doesn't depend on RO's
 *  initial callback firing — its timing isn't guaranteed, and relying on
 *  it can leave a chart that never mounts. RO then keeps it live. */
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

export default function ResponsiveWidth() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();
  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();

  return (
    <div
      style={{
        resize: 'horizontal',
        overflow: 'hidden',
        minWidth: 240,
        maxWidth: '100%',
        border: '1px dashed var(--site-surface-border)',
        borderRadius: 8,
        padding: 8,
      }}
    >
      {/* The measured box is a plain, unpadded child of the resize
          handle — measuring the padded box itself would hand
          ChartContainer a width wider than the space it's actually
          rendered in (padding + border), silently clipped by the
          resize box's own overflow: hidden. */}
      <div ref={boxRef}>
        {width > 0 && (
          <ChartContainer
            range={series.timeRange()}
            width={width}
            theme={theme}
          >
            <ChartRow height={200}>
              <YAxis id="pct" side="right" format=".0%" />
              <Layers>
                <LineChart series={series} column="cpu" axis="pct" />
              </Layers>
            </ChartRow>
          </ChartContainer>
        )}
      </div>
    </div>
  );
}
