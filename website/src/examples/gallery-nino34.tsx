import { useLayoutEffect, useRef, useState } from 'react';
import {
  Baseline,
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  LineChart,
  Marker,
  YAxis,
  type TrackerInfo,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  NINO34_ANOMALY_DOMAIN,
  NINO34_BACKDROP,
  NINO34_CURRENT_DAYS,
  NINO34_CURRENT_YEAR,
  NINO34_NAMED,
  NINO34_THRESHOLDS,
  NINO34_YEAR_RANGE,
  NINO34_YEARS,
  anomalySeries,
  dayLabel,
  dayOfYearTime,
  timeToDayOfYear,
} from './lib/nino34';
import styles from './lib/tracker-readout.module.css';

/**
 * Every year since 1982 of Niño 3.4 sea-surface temperature anomaly, drawn on
 * one shared Jan–Dec axis: 42 muted years behind, 1997 and 2015 named as the
 * two comparable El Niños, and the current year prominent and **stopping
 * partway across**, because that is where the record stops.
 *
 * Three things make it work:
 *
 * - **The x axis is a day of the year, not a date.** Every year is mapped onto
 *   one common non-leap reference year, so an ordinary time axis gives month
 *   ticks for free and each year is just another series on it.
 * - **The values are anomalies**, each year against its own centred 30-year
 *   day-of-year climatology (`lib/nino34.ts`). Raw SST would put the last
 *   decade above the first and the comparison would be about the warming
 *   trend rather than about El Niño.
 * - **`line.ensemble` + `line.highlight1…3` are a register, not a palette.**
 *   42 background years take a very faint neutral hairline and read as one
 *   texture; the three named years take data hues *and extra weight*, with the
 *   current year heaviest because it is the subject. That hierarchy is the
 *   difference between a backdrop and 45 competing series.
 *
 * Drag to pan and wheel to zoom, bounded to the reference year — May to July is
 * where the current year separates from the pack, and it is worth a closer
 * look.
 */
export default function GalleryNino34({
  width: fixedWidth,
  height = 420,
  compact = false,
  showReadout = false,
}: {
  /**
   * Explicit pixel width. **Omit on a page**, where the chart measures its own
   * container instead — 45 lines want every pixel of it, and a hardcoded
   * number is only ever right at one viewport. The Gallery card passes one,
   * because a card stage has already measured a width and handed it down.
   */
  width?: number;
  /** Plot height. Generous by default: 45 overlapping lines need vertical room
   *  or the pack compresses into a band and the highlights have nothing to
   *  separate from. */
  height?: number;
  /** Card-sized: fewer labelled thresholds, no legend, no end marker. Five
   *  labelled reference lines and a legend card are right at full size and a
   *  thicket at 190px. */
  compact?: boolean;
  /** Mount the off-chart readout strip (the full-size embed does). */
  showReadout?: boolean;
}) {
  const theme = useSiteChartTheme();
  const [tracker, setTracker] = useState<TrackerInfo | null>(null);

  // `<ChartContainer>` takes an explicit pixel width, so responsiveness is one
  // `ResizeObserver` away — the responsive-width recipe, the same hook the
  // charts landing hero and the volume-history panel run. The ref sits on the
  // wrapper so the readout strip resolves to the same width as the plot.
  const [boxRef, measured] = useMeasuredWidth<HTMLDivElement>();
  const width = fixedWidth ?? measured;

  // At card size only two of the four stay labelled. Four labelled reference
  // lines are right on a full-size chart and a thicket at 196px, so the card
  // keeps the two that bracket where the named years get to — the same trade
  // the air-quality card makes.
  const thresholds = compact
    ? NINO34_THRESHOLDS.filter((t) => t.value === 1 || t.value === 2)
    : NINO34_THRESHOLDS;

  return (
    // A single block, not a fragment: `<ChartExample>`'s stage is a flex row,
    // so the readout and the chart would land side by side rather than stacked.
    // `width: 100%` when unmeasured is what gives the ResizeObserver something
    // to measure; a fixed width pins it to what the caller asked for.
    <div ref={boxRef} style={{ width: fixedWidth ?? '100%' }}>
      {showReadout ? <Readout tracker={tracker} /> : null}
      {width <= 0 ? (
        // Nothing until the box has been measured: a `<ChartContainer>` at
        // width 0 registers 45 layers against a degenerate scale and rebuilds
        // every one of them a frame later. The reserved height keeps the page
        // from jumping when the real chart arrives.
        <div style={{ height: height + AXIS_STRIP_PX }} aria-hidden="true" />
      ) : (
        <ChartContainer
          range={NINO34_YEAR_RANGE}
          width={width}
          theme={theme}
          // The reference year is a carrier, not information: `%b` prints month
          // abbreviations — thinned by the tick ladder to `Jan / Apr / Jul / Oct`
          // at this width — and nothing on the chart names the year the axis
          // belongs to. (No `cursorFormat`: `cursor="line"` draws no pill.)
          timeFormat="%b"
          // `line` and not `crosshair`: a crosshair pins one value pill per row,
          // and with 45 lines under the pointer a single pill cannot say which
          // year it read. The vertical line marks the day; the numbers come out
          // off-chart, named.
          cursor="line"
          // Drag pans, wheel zooms, and `bounds` stops both at the edges of the
          // reference year — without it a drag runs off into empty canvas, which
          // on a day-of-year axis is not even a coherent place to be. Zooming
          // into May–July is the natural thing to want: that is where the
          // current year leaves the pack.
          panZoom="panZoom"
          bounds={NINO34_YEAR_RANGE}
          onTrackerChanged={setTracker}
        >
          <ChartRow height={height}>
            <YAxis
              id="anom"
              label="SST anomaly (°C)"
              format="+.1f"
              min={NINO34_ANOMALY_DOMAIN[0]}
              max={NINO34_ANOMALY_DOMAIN[1]}
              width={compact ? 46 : 62}
            />
            <Layers>
              {/* The pack, first so everything else draws over it. `ensemble`
                is much fainter than `muted` — see the theme's note: 42
                strokes of a backdrop weight tuned for one stack into a mass
                that competes with the years drawn over them. */}
              {NINO34_BACKDROP.map((year) => (
                <LineChart
                  key={year}
                  series={anomalySeries(year)}
                  column="anomaly"
                  axis="anom"
                  as="ensemble"
                  legend={false}
                />
              ))}
              {/* The three named years — a data hue *and* extra weight, with
                the current year heaviest because it is the subject. Hue alone
                does not lift a mid-saturation line off a busy texture. */}
              {NINO34_NAMED.map(({ year, role, label }) => (
                <LineChart
                  key={year}
                  series={anomalySeries(year)}
                  column="anomaly"
                  axis="anom"
                  as={role}
                  legend={label}
                />
              ))}
              {/* El Niño strength thresholds — reference marks in the annotation
                register, so they read as annotation rather than as four more
                series. `selectable={false}` keeps them inert background.
                They are lines and not bands because `<Region>` spans x, not y:
                there is no y-span annotation to reach for. */}
              {thresholds.map((t) => (
                <Baseline
                  key={t.label}
                  value={t.value}
                  axis="anom"
                  label={t.label}
                  labelSide="right"
                  labelPosition="above"
                  selectable={false}
                />
              ))}
              {/* Where the record stops, said once rather than left to be
                inferred from a line that just ends. */}
              {compact ? null : (
                <Marker
                  at={dayOfYearTime(NINO34_CURRENT_DAYS - 1)}
                  label={`${NINO34_CURRENT_YEAR} to here`}
                  selectable={false}
                />
              )}
            </Layers>
          </ChartRow>
          {compact ? null : <Legend placement="bottom-left" />}
        </ChartContainer>
      )}
    </div>
  );
}

/**
 * Width from the container rather than a fixed pixel count. Same hook as the
 * charts landing hero and the volume-history panel; see the responsive-width
 * recipe.
 */
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

/** `<ChartContainer showAxis>` defaults on, adding a time-axis strip below the
 *  rows — budgeted into the pre-measurement placeholder. */
const AXIS_STRIP_PX = 22;

/**
 * The off-chart readout — and the honest answer to "what can hover do here".
 *
 * It cannot tell you which of the 42 grey lines you are on: they overlap, they
 * are the same colour, and a value pill that picked one would be picking at
 * random. So it doesn't try. It reports the **day** the cursor is on, the three
 * years the chart names, and where the current year ranks among all 45 on that
 * date — which is the question the pack exists to answer.
 *
 * `onTrackerChanged` hands over `{ time, values }`; only `time` is used, and
 * the numbers are looked up from the same fixture the chart drew. That is the
 * same door the climate-stripes card goes through, for the same reason: when
 * the in-chart pill can't say the thing, take the readout off the chart.
 */
function Readout({ tracker }: { tracker: TrackerInfo | null }) {
  if (tracker === null) {
    return (
      <div className={styles.readout}>
        <span className={styles.idle}>
          Point at the chart for that day of the year.
        </span>
      </div>
    );
  }

  const day = timeToDayOfYear(tracker.time);
  const named = NINO34_NAMED.map(({ year, label }) => ({
    label,
    value: anomalySeries(year).column('anomaly').toFloat64Array()[day],
  }));
  const current = named[named.length - 1]!.value;
  const rank =
    current === undefined || Number.isNaN(current)
      ? null
      : NINO34_YEARS.filter((year) => {
          const value = anomalySeries(year).column('anomaly').toFloat64Array()[
            day
          ];
          return value !== undefined && value > current;
        }).length + 1;

  return (
    <div className={styles.readout}>
      <span className={styles.date}>{dayLabel(day)}</span>
      {named.map(({ label, value }) => (
        <span className={styles.field} key={label}>
          <span className={styles.name}>{label}</span>
          {value === undefined || Number.isNaN(value)
            ? '—'
            : `${value >= 0 ? '+' : ''}${value.toFixed(2)} °C`}
        </span>
      ))}
      {rank === null ? null : (
        <span className={styles.field}>
          <span className={styles.name}>{NINO34_CURRENT_YEAR} ranks</span>
          {rank} of {NINO34_YEARS.length}
        </span>
      )}
    </div>
  );
}
