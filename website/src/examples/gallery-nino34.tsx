import { useState } from 'react';
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
 * - **`line.muted` is a register, not a colour.** 42 background years take a
 *   neutral, part-transparent hairline; the three named years take data hues.
 *   That is the difference between a backdrop and 45 competing series.
 */
export default function GalleryNino34({
  width = 720,
  height = 300,
  compact = false,
  showReadout = false,
}: {
  width?: number;
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

  // At card size only the two thresholds the named years actually cross stay
  // labelled — the same trade the air-quality card makes.
  const thresholds = compact
    ? NINO34_THRESHOLDS.filter((t) => t.value === 1 || t.value === 2)
    : NINO34_THRESHOLDS;

  return (
    // A single block, not a fragment: `<ChartExample>`'s stage is a flex row,
    // so the readout and the chart would land side by side rather than stacked.
    <div style={{ width }}>
      {showReadout ? <Readout tracker={tracker} /> : null}
      <ChartContainer
        range={NINO34_YEAR_RANGE}
        width={width}
        theme={theme}
        // The reference year is a carrier, not information: `%b` prints `Jan` …
        // `Dec` and nothing on the chart says which year the axis belongs to.
        // (No `cursorFormat` — `cursor="line"` draws no pill for it to shape.)
        timeFormat="%b"
        // `line` and not `crosshair`: a crosshair pins one value pill per row,
        // and with 45 lines under the pointer a single pill cannot say which
        // year it read. The vertical line marks the day; the numbers come out
        // off-chart, named.
        cursor="line"
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
            {/* The pack, first so everything else draws over it. */}
            {NINO34_BACKDROP.map((year) => (
              <LineChart
                key={year}
                series={anomalySeries(year)}
                column="anomaly"
                axis="anom"
                as="muted"
                legend={false}
              />
            ))}
            {/* The three named years, in data hues. */}
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
                register, so they read as annotation rather than as five more
                series. `selectable={false}` keeps them inert background. */}
            {thresholds.map((t) => (
              <Baseline
                key={t.label}
                value={t.value}
                axis="anom"
                label={t.label}
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
    </div>
  );
}

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
