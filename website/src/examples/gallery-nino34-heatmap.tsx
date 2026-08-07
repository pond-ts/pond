import { useMemo, useState } from 'react';
import { Sequence } from 'pond-ts';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import {
  ChartContainer,
  ChartRow,
  HeatMap,
  Layers,
  YAxis,
  type SelectInfo,
} from '@pond-ts/charts';
import {
  useSiteChartTheme,
  useSequentialRamp,
} from '@site/src/theme/useSiteChartTheme';
import {
  dayLabel,
  NINO34_YEARS,
  NINO34_YEAR_RANGE,
  ninoWideByYear,
  timeToDayOfYear,
  yearColumn,
} from './lib/nino34';
import readout from './lib/tracker-readout.module.css';

/** How finely the year is cut on the **x** axis. The rows never move — they are
 *  always the 45 years — so this is purely a re-bin of the bin axis, which is
 *  the whole point: `<HeatMap>` has no opinion about x, so pond's ordinary
 *  binning does the work. */
type Grain = 'day' | 'month' | 'year';

const GRAINS: ReadonlyArray<{ id: Grain; label: string; cells: string }> = [
  { id: 'day', label: 'Day', cells: '365 cells' },
  { id: 'month', label: 'Month', cells: '12 cells' },
  { id: 'year', label: 'Year', cells: '1 cell' },
];

/** Every year column, as heat-map rows. Oldest at the bottom, so the record
 *  reads upward the way a stripes chart reads rightward. */
const ROWS = NINO34_YEARS.map(yearColumn);

/** Average each year column over the bucket. The reducer map is built at
 *  runtime because the columns are — one per year in the record. */
const MEAN_BY_YEAR = Object.fromEntries(
  ROWS.map((c) => [c, 'avg' as const]),
) as Record<string, 'avg'>;

/** What the hovered cell's x bin covers, in the grain that produced it. */
function periodLabel(grain: Grain, key: number): string {
  if (grain === 'year') return 'whole year';
  if (grain === 'month')
    return new Date(key).toLocaleDateString('en-GB', { month: 'long' });
  return dayLabel(timeToDayOfYear(key));
}

/**
 * **Niño 3.4 sea-surface temperature as a heat map**, with a day / month / year
 * granularity control.
 *
 * 16,275 daily values (NOAA OISST, 1982 →) already live in this site as a
 * **wide** series: one column per year, one row per day-of-year. That shape was
 * built for the day-of-year overlay's climatology — a row-wise `collapse`
 * across year columns — and it happens to be exactly a heat map's shape too,
 * with the years as rows.
 *
 * So the granularity control is **not** a chart prop. It re-bins the *x* axis
 * with pond's ordinary `aggregate`, and the chart redraws whatever comes out:
 *
 * - **Day** — the series as it stands, 365 cells per row.
 * - **Month** — `Sequence.calendar('month')`, 12 cells. Calendar, not a
 *   duration: months are 28–31 days.
 * - **Year** — one cell per row: the whole record collapses to a single column,
 *   45 cells tall, which is climate stripes stood on end. `Sequence.calendar`
 *   has no `'year'` unit, so this one is a fixed `'370d'` step anchored at
 *   1 January — deliberately longer than the year so exactly one bucket covers
 *   it.
 *
 * The rows are identical in all three. That is the layer's constraint paying
 * off: the y dimension is columns, so it is fixed by the data, and everything
 * about resolution belongs to x where pond already owns it.
 */
export default function GalleryNino34Heatmap({
  width,
  height = 420,
}: {
  width: number;
  height?: number;
}) {
  const theme = useSiteChartTheme();
  const ramp = useSequentialRamp();
  const [grain, setGrain] = useState<Grain>('month');
  const [hit, setHit] = useState<SelectInfo | null>(null);

  const series = useMemo<TimeSeries<SeriesSchema>>(() => {
    if (grain === 'day') return ninoWideByYear;
    const seq =
      grain === 'month'
        ? Sequence.calendar('month')
        : // `Sequence.calendar` has no `'year'` unit — it stops at `month` — so
          // the whole-year bucket is a fixed step anchored at 1 January, sized
          // past the record's end so exactly one bucket covers it.
          Sequence.every('370d', { anchor: NINO34_YEAR_RANGE[0] });
    return ninoWideByYear.aggregate(seq, MEAN_BY_YEAR);
  }, [grain]);

  return (
    <div style={{ width }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'baseline',
          marginBottom: 8,
          fontFamily: theme.font.family,
          fontSize: 12,
        }}
      >
        {GRAINS.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setGrain(g.id)}
            aria-pressed={grain === g.id}
            style={{
              font: 'inherit',
              padding: '2px 10px',
              borderRadius: 4,
              cursor: 'pointer',
              border: `1px solid ${theme.axis.grid}`,
              background: grain === g.id ? theme.axis.label : 'transparent',
              color: grain === g.id ? theme.background : theme.axis.label,
            }}
          >
            {g.label}
          </button>
        ))}
        <span style={{ color: theme.axis.label, opacity: 0.7 }}>
          {GRAINS.find((g) => g.id === grain)!.cells} per year
        </span>
      </div>

      <div className={readout.readout}>
        {hit === null ? (
          <span className={readout.idle}>
            Point at a cell to read its year, period and temperature
          </span>
        ) : (
          <>
            <span
              aria-hidden="true"
              style={{
                width: '0.7rem',
                height: '0.7rem',
                borderRadius: 2,
                background: hit.color,
                alignSelf: 'center',
              }}
            />
            {/* `label` is the row — the year column the cell is in. */}
            <span className={readout.date}>{hit.label.slice(1)}</span>
            <span className={readout.field}>
              <span className={readout.name}>period</span>
              {periodLabel(grain, hit.key as number)}
            </span>
            <span className={readout.field}>
              <span className={readout.name}>SST</span>
              {`${hit.value.toFixed(2)} °C`}
            </span>
          </>
        )}
      </div>

      <ChartContainer
        range={NINO34_YEAR_RANGE}
        width={width}
        theme={theme}
        // `onHover` reports the **cell under the pointer** — a real 2-D hit,
        // which is what a grid needs and what `onTrackerChanged` cannot give:
        // the tracker samples every row at the cursor's x and knows nothing
        // about y, so any single number picked out of it is a guess at which
        // row was meant. `hitTest` already resolves both axes, so use it.
        onHover={setHit}
      >
        <ChartRow height={height}>
          <YAxis id="yr" hide />
          <Layers>
            <HeatMap
              series={series}
              columns={ROWS}
              colors={ramp}
              axis="yr"
              id="sst"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
