import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BandChart,
  Baseline,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { riverGauge } from './lib/river-gauge';

/** Width from the container rather than a fixed pixel count — `width` is an
 *  explicit number, so responsiveness is one `ResizeObserver` away. See the
 *  responsive-width recipe; every Gallery card runs on this. */
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

const ROW_HEIGHT = 260;

/** A full day. Short enough to follow a storm, long enough that the envelope
 *  is the day's actual min–max range and the trend visibly *lags* a rising
 *  limb rather than tracing it — which is the whole reason to draw both. */
const WINDOW = '24h';

/** Three weeks of 15-minute stream discharge, drawn three ways from **one**
 *  column.
 *
 *  The point of the composition is that `cfs` is the only data. The envelope
 *  and the trend aren't a second dataset prepared elsewhere — they're a single
 *  `rolling()` call, emitting three columns off the same source column via the
 *  `{ from, using }` spec, feeding two more draw layers. That's the pond
 *  pipeline running right up to the plot.
 *
 *  Layer order matters: the envelope fills first, the raw gauge trace draws
 *  over it as a grey hairline, and the trend sits on top. Painting the band
 *  last would bury the texture it's summarising.
 *
 *  Discharge is **modelled**, not measured — see `lib/river-gauge.ts`. */
export default function ChartsHero() {
  const theme = useSiteChartTheme();
  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();

  const gauge = useMemo(() => riverGauge(), []);

  // One pass over the gauge column produces all three derived series. `{ from,
  // using }` is what lets three outputs share one source column — the bare
  // `{ cfs: 'avg' }` form can only name the column once.
  const rolled = useMemo(
    () =>
      gauge.rolling(
        WINDOW,
        {
          mean: { from: 'cfs', using: 'avg' },
          lo: { from: 'cfs', using: 'min' },
          hi: { from: 'cfs', using: 'max' },
        },
        { alignment: 'centered' },
      ),
    [gauge],
  );

  // Median flow for the baseline — the level the channel sits at between
  // storms, which is the honest reference for "is this event big".
  const median = useMemo(() => {
    const sorted = Array.from(gauge.column('cfs').toFloat64Array()).sort(
      (a, b) => a - b,
    );
    return sorted[sorted.length >> 1]!;
  }, [gauge]);

  // `bounds` is the outer pan/zoom extent — the view can't leave the record,
  // so a drag stops at the first and last sample instead of running into blank
  // canvas.
  const extent = useMemo(() => {
    const range = gauge.timeRange();
    // `undefined` only for an empty series, which this fixture never is.
    return range ? ([range.begin(), range.end()] as [number, number]) : null;
  }, [gauge]);

  return (
    <div ref={boxRef} style={{ width: '100%' }}>
      {width > 0 && extent ? (
        <ChartContainer
          range={extent}
          bounds={extent}
          width={width}
          theme={theme}
          cursor="crosshair"
          panZoom="panZoom"
          // Gridlines are `--pond-muted` at 0.28 and the raw gauge trace is the
          // same colour at 0.55 — close enough that the grid reads as data.
          // The envelope already gives the eye a reference, so drop it.
          grid={false}
        >
          <ChartRow height={ROW_HEIGHT}>
            <YAxis
              id="cfs"
              side="left"
              label="discharge (cfs)"
              format=",.0f"
              width={62}
            />
            <Layers>
              <BandChart
                series={rolled}
                lower="lo"
                upper="hi"
                axis="cfs"
                as="outer"
              />
              <LineChart series={gauge} column="cfs" axis="cfs" as="muted" />
              <LineChart series={rolled} column="mean" axis="cfs" />
              <Baseline
                value={median}
                axis="cfs"
                label={`median ${median.toFixed(0)}`}
                indicator
              />
            </Layers>
          </ChartRow>
        </ChartContainer>
      ) : null}
    </div>
  );
}
