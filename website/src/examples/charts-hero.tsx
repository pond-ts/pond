import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BandChart,
  Baseline,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  ScatterChart,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { householdPower } from './lib/household-power';

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

/** One hour. Long enough to swallow a kettle and read as the household's
 *  underlying demand, short enough to still separate breakfast from dinner. */
const WINDOW = '1h';

/** Two days of one-minute household demand: every raw minute as a point, with
 *  an hourly envelope and trend rolled through it.
 *
 *  `kw` is the only data. The envelope and the trend aren't a second dataset
 *  prepared elsewhere — they're a single `rolling()` call emitting three
 *  columns off the same source column via the `{ from, using }` spec, feeding
 *  two more draw layers. That's the pond pipeline running right up to the plot.
 *
 *  **The raw minutes get two layers, not one.** Points alone say where the
 *  samples are but not how they connect; a line alone, at a sample per minute,
 *  is mostly vertical strokes. Drawn together the strokes become the reading:
 *  those verticals are appliances switching, and the flats between them are
 *  the rectangles they draw. The line is `muted` — a hairline at 55% — so it
 *  stays connective tissue under the cloud rather than competing with it.
 *
 *  Layer order matters. The envelope fills first, the raw line and its cloud
 *  draw over it, and the trend sits on top; painting the band last would bury
 *  the texture it's summarising.
 *
 *  The gap on the first afternoon is a recorder outage carried as `undefined`,
 *  not zero. `LineChart` is gap-aware, so the raw line **breaks** there rather
 *  than ruling a straight edge across ninety minutes it has no samples for —
 *  which is the one thing a connecting line could otherwise quietly invent.
 *
 *  Demand is **modelled**, not measured — see `lib/household-power.ts`. */
export default function ChartsHero() {
  const theme = useSiteChartTheme();
  const [boxRef, width] = useMeasuredWidth<HTMLDivElement>();

  const demand = useMemo(() => householdPower(), []);

  // One pass over the `kw` column produces all three derived columns. `{ from,
  // using }` is what lets three outputs share one source column — the bare
  // `{ kw: 'avg' }` form can only name the column once.
  const rolled = useMemo(
    () =>
      demand.rolling(
        WINDOW,
        {
          mean: { from: 'kw', using: 'avg' },
          lo: { from: 'kw', using: 'min' },
          hi: { from: 'kw', using: 'max' },
        },
        { alignment: 'centered' },
      ),
    [demand],
  );

  // The level demand stays under nine minutes in ten. A mean would sit down in
  // the standby floor and say nothing about the events, which are the whole
  // shape here — and peak demand is what sizes a supply and what a time-of-use
  // tariff prices, so p90 is the reference a meter reading is actually judged
  // against. `reduce` collapses the whole series to one scalar, skipping the
  // outage's `undefined`s rather than counting them as zero.
  const p90 = useMemo(() => {
    const value = demand.reduce('kw', 'p90');
    return typeof value === 'number' ? value : 0;
  }, [demand]);

  // `bounds` is the outer pan/zoom extent — the view can't leave the record,
  // so a drag stops at the first and last sample instead of running into blank
  // canvas.
  const extent = useMemo(() => {
    const range = demand.timeRange();
    // `undefined` only for an empty series, which this fixture never is.
    return range ? ([range.begin(), range.end()] as [number, number]) : null;
  }, [demand]);

  return (
    <div ref={boxRef} style={{ width: '100%' }}>
      {width > 0 && extent ? (
        <ChartContainer
          range={extent}
          bounds={extent}
          width={width}
          theme={theme}
          cursor="flag"
          panZoom="panZoom"
          // Gridlines are `--pond-muted` at 0.28; the raw cloud is the brand
          // hue at 0.3. Close enough in weight that the grid reads as another
          // scatter of points. The envelope already gives the eye a reference.
          grid={false}
        >
          <ChartRow height={ROW_HEIGHT}>
            <YAxis
              id="kw"
              side="left"
              label="active power (kW)"
              format=",.1f"
              width={62}
            />
            <Layers>
              <BandChart
                series={rolled}
                lower="lo"
                upper="hi"
                axis="kw"
                as="outer"
              />
              <LineChart series={demand} column="kw" axis="kw" as="muted" />
              <ScatterChart series={demand} column="kw" axis="kw" as="raw" />
              <LineChart series={rolled} column="mean" axis="kw" />
              {/* No `indicator`: the axis pill rounds to the tick format
                  (2.0) while the label carries the real figure (1.98), and
                  side by side they read as two different numbers. */}
              <Baseline
                value={p90}
                axis="kw"
                label={`p90 ${p90.toFixed(2)} kW`}
              />
            </Layers>
          </ChartRow>
        </ChartContainer>
      ) : null}
    </div>
  );
}
