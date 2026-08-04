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
 *  **Why scatter and not a line.** Minute-resolution demand is a sum of
 *  rectangles — a kettle is 2.6 kW for three minutes — so a polyline spends
 *  most of its ink on vertical strokes between samples that aren't a
 *  transition through anything. Points say what's actually there: a dense
 *  floor, and events standing off it.
 *
 *  Layer order matters. The envelope fills first, the raw cloud draws over it,
 *  and the trend sits on top; painting the band last would bury the texture
 *  it's summarising.
 *
 *  The gap on the first afternoon is a recorder dropout carried as
 *  `undefined`, not zero — the band and the trend both step around it rather
 *  than diving to the floor.
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

  // Mean demand over the record — what the meter averages to, and the honest
  // reference for "is this spike big". Skips the dropout's `undefined`s, which
  // is why this reads the column rather than a Float64Array (where a missing
  // sample materializes as 0 and drags the mean down).
  const mean = useMemo(() => {
    const col = demand.column('kw');
    let sum = 0;
    let n = 0;
    for (let i = 0; i < col.length; i++) {
      const v = col.read(i);
      if (v !== undefined) {
        sum += v;
        n += 1;
      }
    }
    return n === 0 ? 0 : sum / n;
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
          cursor="crosshair"
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
              <ScatterChart series={demand} column="kw" axis="kw" as="raw" />
              <LineChart series={rolled} column="mean" axis="kw" />
              <Baseline
                value={mean}
                axis="kw"
                label={`mean ${mean.toFixed(2)} kW`}
                indicator
              />
            </Layers>
          </ChartRow>
        </ChartContainer>
      ) : null}
    </div>
  );
}
