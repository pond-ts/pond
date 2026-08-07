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
  NINO34_ANOMALY_DOMAIN,
  NINO34_NAMED,
  NINO34_YEARS,
  NINO34_YEAR_RANGE,
  ninoWideAnomalyByYear,
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

/** Which quantity the colour carries. */
type Measure = 'sst' | 'anomaly';

/** Which ramp the colour comes out of. */
type Palette = 'site' | 'heat' | 'diverging';

const GRAINS: ReadonlyArray<{ id: Grain; label: string }> = [
  { id: 'day', label: 'Day' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];

const CELLS: Record<Grain, string> = {
  day: '365 cells',
  month: '12 cells',
  year: '1 cell',
};

const MEASURES: ReadonlyArray<{ id: Measure; label: string }> = [
  { id: 'sst', label: 'SST' },
  { id: 'anomaly', label: 'Anomaly' },
];

const PALETTES: ReadonlyArray<{ id: Palette; label: string }> = [
  { id: 'site', label: 'Site' },
  { id: 'heat', label: 'Heat' },
  { id: 'diverging', label: 'Diverging' },
];

/**
 * **Inferno** — the perceptually-uniform version of a black-body ramp, which is
 * the traditional "heat" gradient: dark through red and orange to near-white.
 * Worth preferring over a hand-rolled black→red→yellow→white because that one
 * has a bright band in the middle that reads as a contour line in data that has
 * none; inferno's lightness climbs monotonically, so equal steps in value look
 * like equal steps in colour.
 *
 * Hard-coded rather than themed, and it does not flip with the light/dark
 * toggle. That is the honest tradeoff: a heat ramp **is** a specific set of
 * colours, and re-tinting it per theme would change what the reader reads.
 * Starting at inferno's near-black rather than pure black keeps the dark end
 * from disappearing into a dark page.
 */
const HEAT: readonly string[] = [
  '#1b0c41',
  '#4a0c6b',
  '#781c6d',
  '#a52c60',
  '#cf4446',
  '#ed6925',
  '#fb9b06',
  '#f7d13d',
];

/**
 * **ColorBrewer RdBu, reversed** — cold blue through neutral to warm red. Nine
 * steps, deliberately **odd**, so that with a domain pinned symmetrically about
 * zero the middle band straddles zero and "no anomaly" reads as neutral.
 *
 * The right choice for a quantity that straddles a meaningful zero, which an
 * anomaly does and an absolute temperature does not.
 */
const DIVERGING: readonly string[] = [
  '#2166ac',
  '#4393c3',
  '#92c5de',
  '#d1e5f0',
  '#f7f7f7',
  '#fddbc7',
  '#f4a582',
  '#d6604d',
  '#b2182b',
];

/** Every year column, as heat-map rows. Oldest at the bottom, so the record
 *  reads upward the way a stripes chart reads rightward. */
const ROWS = NINO34_YEARS.map(yearColumn);

/** Average each year column over the bucket. The reducer map is built at
 *  runtime because the columns are — one per year in the record. */
const MEAN_BY_YEAR = Object.fromEntries(
  ROWS.map((c) => [c, 'avg' as const]),
) as Record<string, 'avg'>;

/**
 * The rows worth naming — the same years the day-of-year chart above picks out.
 * Explicit `{ at, label }` ticks override the layer's `binCategories`, which
 * would otherwise label all 45 rows into an unreadable stack. `at` is the row's
 * centre because the y scale runs over unit slots, one per column.
 */
const NAMED_TICKS = NINO34_NAMED.flatMap((n) => {
  const row = ROWS.indexOf(yearColumn(n.year));
  return row < 0 ? [] : [{ at: row + 0.5, label: n.label }];
});

/**
 * The anomaly colour domain, **pinned and symmetric about zero**.
 *
 * Two reasons it is pinned rather than left to the layer's own extent. A
 * diverging ramp only means anything if its neutral band sits on zero, which
 * needs `[-m, +m]`. And a colour scale has no tick labels, so a domain that
 * re-means itself as the binning changes moves every colour with no visible
 * announcement — the exact failure `domain` exists to prevent.
 */
const ANOMALY_DOMAIN: readonly [number, number] = (() => {
  const m = Math.max(
    Math.abs(NINO34_ANOMALY_DOMAIN[0]),
    Math.abs(NINO34_ANOMALY_DOMAIN[1]),
  );
  return [-m, m];
})();

/** What the hovered cell's x bin covers, in the grain that produced it. */
function periodLabel(grain: Grain, key: number): string {
  if (grain === 'year') return 'whole year';
  if (grain === 'month')
    return new Date(key).toLocaleDateString('en-GB', { month: 'long' });
  return dayLabel(timeToDayOfYear(key));
}

/**
 * **Niño 3.4 sea-surface temperature as a heat map** — granularity, measure and
 * palette all switchable, and none of them a change to the layer.
 *
 * 16,275 daily values (NOAA OISST, 1982 →) already live in this site as a
 * **wide** series: one column per year, one row per day-of-year. That shape was
 * built for the day-of-year overlay's climatology — a row-wise `collapse`
 * across year columns — and it happens to be exactly a heat map's shape too,
 * with the years as rows.
 *
 * **Granularity** re-bins the *x* axis with pond's ordinary `aggregate`; the
 * chart redraws whatever comes out. Day is the series as it stands (365 cells
 * per row); month is `Sequence.calendar('month')` (12); year is one cell per
 * row — climate stripes stood on end. (`Sequence.calendar` has no `'year'`
 * unit, so that one is a fixed `'370d'` step anchored at 1 January, sized past
 * the record's end so exactly one bucket covers it.) The rows are identical in
 * all three: the y dimension is columns, so it is fixed by the data, and
 * everything about resolution belongs to x where pond already owns it.
 *
 * **Measure** swaps which series is handed over. Absolute SST is dominated by
 * the seasonal cycle, so it bands **vertically** and ENSO is buried; the
 * anomaly grid subtracts each year's own climatology and bands
 * **horizontally**, where an El Niño year is a warm row. Same layer, same
 * props, different series.
 *
 * **Palette** is just the `colors` array. Note which ramp suits which measure:
 * a diverging ramp needs a meaningful zero, which the anomaly has and the
 * absolute temperature does not.
 */
export default function GalleryNino34Heatmap({
  width,
  height = 420,
}: {
  width: number;
  height?: number;
}) {
  const theme = useSiteChartTheme();
  const siteRamp = useSequentialRamp();
  const [grain, setGrain] = useState<Grain>('month');
  const [measure, setMeasure] = useState<Measure>('sst');
  const [palette, setPalette] = useState<Palette>('heat');
  const [hit, setHit] = useState<SelectInfo | null>(null);

  const series = useMemo<TimeSeries<SeriesSchema>>(() => {
    const source = measure === 'sst' ? ninoWideByYear : ninoWideAnomalyByYear();
    if (grain === 'day') return source;
    const seq =
      grain === 'month'
        ? Sequence.calendar('month')
        : Sequence.every('370d', { anchor: NINO34_YEAR_RANGE[0] });
    return source.aggregate(seq, MEAN_BY_YEAR);
  }, [grain, measure]);

  const colors =
    palette === 'site' ? siteRamp : palette === 'heat' ? HEAT : DIVERGING;

  const button = (
    active: boolean,
    label: string,
    onClick: () => void,
    key: string,
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        font: 'inherit',
        padding: '2px 10px',
        borderRadius: 4,
        cursor: 'pointer',
        border: `1px solid ${theme.axis.grid}`,
        background: active ? theme.axis.label : 'transparent',
        color: active ? theme.background : theme.axis.label,
      }}
    >
      {label}
    </button>
  );

  const group = (name: string, children: React.ReactNode) => (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
      <span style={{ color: theme.axis.label, opacity: 0.6 }}>{name}</span>
      {children}
    </span>
  );

  return (
    <div style={{ width }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px 18px',
          alignItems: 'baseline',
          marginBottom: 8,
          fontFamily: theme.font.family,
          fontSize: 12,
        }}
      >
        {group(
          'bin',
          <>
            {GRAINS.map((g) =>
              button(grain === g.id, g.label, () => setGrain(g.id), g.id),
            )}
            <span style={{ color: theme.axis.label, opacity: 0.7 }}>
              {CELLS[grain]}
            </span>
          </>,
        )}
        {group(
          'show',
          MEASURES.map((m) =>
            button(measure === m.id, m.label, () => setMeasure(m.id), m.id),
          ),
        )}
        {group(
          'ramp',
          PALETTES.map((p) =>
            button(palette === p.id, p.label, () => setPalette(p.id), p.id),
          ),
        )}
      </div>

      <div className={readout.readout}>
        {hit === null ? (
          <span className={readout.idle}>
            Point at a cell to read its year, period and value
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
              <span className={readout.name}>
                {measure === 'sst' ? 'SST' : 'anomaly'}
              </span>
              {measure === 'sst'
                ? `${hit.value.toFixed(2)} °C`
                : // An anomaly is signed and the sign is the whole reading —
                  // "+1.28" and "1.28" are different claims.
                  `${hit.value >= 0 ? '+' : ''}${hit.value.toFixed(2)} °C`}
            </span>
          </>
        )}
      </div>

      <ChartContainer
        range={NINO34_YEAR_RANGE}
        width={width}
        theme={theme}
        // The reference year is a carrier, not information: the axis is a
        // day-of-year axis, so `%b` prints month abbreviations instead of
        // leaking the synthetic year the fixture happens to be built on. Same
        // reason, same prop, as the day-of-year chart above.
        timeFormat="%b"
        // `onHover` reports the **cell under the pointer** — a real 2-D hit,
        // which is what a grid needs and what `onTrackerChanged` cannot give:
        // the tracker samples every row at the cursor's x and knows nothing
        // about y, so any single number picked out of it is a guess at which
        // row was meant. `hitTest` already resolves both axes, so use it.
        onHover={setHit}
      >
        <ChartRow height={height}>
          {/* `label=""` because the title otherwise defaults to the axis id —
              "yr" is plumbing, not a label. */}
          <YAxis id="yr" ticks={NAMED_TICKS} label="" />
          <Layers>
            <HeatMap
              series={series}
              columns={ROWS}
              colors={colors}
              // Pinned for the anomaly so the diverging ramp's neutral band
              // sits on zero; left to the layer for absolute SST, which has no
              // meaningful centre to pin to.
              {...(measure === 'anomaly' ? { domain: ANOMALY_DOMAIN } : {})}
              axis="yr"
              id="sst"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
