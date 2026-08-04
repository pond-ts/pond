import { TimeSeries } from 'pond-ts';
import type { CategoryDatum } from '@pond-ts/charts';
import {
  GISTEMP_ANOMALY_C,
  GISTEMP_YEAR0,
  SEA_DAY0_MS,
  SEA_PRCP_MM,
  SEA_TMAX_C,
  SEA_TMIN_C,
  SEA_WIND_CALM_HOURS,
  SEA_WIND_HOURS,
  SEA_WIND_VARIABLE_HOURS,
  WIND_SECTORS,
} from './weather-samples';

/**
 * Real weather and climate data as pond series — the Gallery's whole Weather &
 * climate section. See `weather-samples.ts` for provenance: NOAA GHCN-Daily and
 * NOAA LCD for Seattle-Tacoma 2024, NASA GISTEMP for the global record, all
 * public domain, gaps left intact.
 *
 * Everything derived here is memoized. These are pure functions of a frozen
 * fixture and four cards plus four pages ask for the same answers, several of
 * them on every animation frame.
 */

const DAY_MS = 86_400_000;

/** Seattle-Tacoma's daily record: the two temperature extremes and the rain. */
export const SEA_SCHEMA = [
  { name: 'time', kind: 'time' },
  // Optional, all three: the station's own reporting gaps ride as gaps rather
  // than as zeros, which for a rain gauge would be an outright lie.
  { name: 'low', kind: 'number', required: false },
  { name: 'high', kind: 'number', required: false },
  { name: 'precip', kind: 'number', required: false },
] as const;

/**
 * One row per calendar day of 2024 at Seattle-Tacoma — `low` / `high` in °C
 * (GHCN's TMIN / TMAX) and `precip` in mm (PRCP, which counts melted snow as
 * well as rain).
 *
 * Keyed at **midnight UTC** of each local date. A GHCN "day" is a local
 * observing day, so the key is the day's name rather than an instant; at the
 * month-and-season zoom these charts live at, that distinction never reaches
 * a pixel.
 */
export function seattleDaily(): TimeSeries<typeof SEA_SCHEMA> {
  return TimeSeries.fromColumns({
    name: 'sea-2024',
    schema: SEA_SCHEMA,
    columns: {
      time: SEA_TMAX_C.map((_, i) => SEA_DAY0_MS + i * DAY_MS),
      low: SEA_TMIN_C,
      high: SEA_TMAX_C,
      precip: SEA_PRCP_MM,
    },
  });
}

/** Calendar 2024 in ms — the outer limit for panning either SEA chart. */
export const SEA_BOUNDS: readonly [number, number] = [
  SEA_DAY0_MS,
  SEA_DAY0_MS + SEA_TMAX_C.length * DAY_MS,
];

function buildTemperature() {
  const daily = seattleDaily();
  // The midpoint of the day's two extremes — the classic definition of a
  // "daily mean temperature", and what the US climate record has always used
  // where hourly readings don't exist. Missing either extreme leaves it
  // missing, rather than quietly halving one number.
  const mid = SEA_TMAX_C.map((high, i) => {
    const low = SEA_TMIN_C[i];
    return high === null || low === undefined || low === null
      ? undefined
      : (high + low) / 2;
  });
  return (
    daily
      .withColumn('mid', mid)
      // A fortnight, centred: long enough that a warm week doesn't bend it,
      // short enough to keep the shoulders of spring and autumn. The default
      // `missing: 'bridge'` is what we want here — the one-day hole in `mid`
      // is smaller than the window, and a trend line that stutters at it
      // would say something about the recorder, not about the weather.
      .smooth('mid', 'movingAverage', {
        window: '15d',
        alignment: 'centered',
        output: 'trend',
      })
  );
}

let temperatureCache: ReturnType<typeof buildTemperature> | undefined;

/**
 * The daily record plus two derived columns: `mid` (the day's midpoint
 * temperature) and `trend` (a 15-day centred moving average of it).
 */
export function seattleTemperature(): ReturnType<typeof buildTemperature> {
  temperatureCache ??= buildTemperature();
  return temperatureCache;
}

function buildRainfall() {
  // A running total down the year. `scan` holds its accumulator across a
  // missing cell rather than resetting or dropping the row, so the two days
  // the gauge didn't report read as a two-day plateau — which is exactly what
  // "we don't know" should look like on a cumulative curve.
  return seattleDaily().scan(
    'precip',
    (total: number, mm: number) => [total + mm, total + mm] as const,
    0,
    { output: 'cumulative' },
  );
}

let rainfallCache: ReturnType<typeof buildRainfall> | undefined;

/** The daily record plus `cumulative` — millimetres so far this year. */
export function seattleRainfall(): ReturnType<typeof buildRainfall> {
  rainfallCache ??= buildRainfall();
  return rainfallCache;
}

/**
 * The year's coldest low and warmest high, °C — a **fixed** `<YAxis>` domain
 * for the scanning card. Auto-fit would rescale on every frame as the window
 * slid, which reads as the chart jittering rather than as the year passing.
 */
export const SEA_TEMP_EXTENT: readonly [number, number] = [
  Math.min(...SEA_TMIN_C.filter((v): v is number => v !== null)),
  Math.max(...SEA_TMAX_C.filter((v): v is number => v !== null)),
];

/** Total precipitation for 2024, mm — the top of the cumulative curve. */
export const SEA_ANNUAL_MM = SEA_PRCP_MM.reduce<number>(
  (total, mm) => total + (mm ?? 0),
  0,
);

/** The wettest single day's total, mm — the tallest bar. */
export const SEA_WETTEST_MM = SEA_PRCP_MM.reduce<number>(
  (max, mm) => Math.max(max, mm ?? 0),
  0,
);

/** The wettest day rounded up to the next 5 mm — a fixed ceiling for the
 *  daily axis with just enough headroom that the tallest bar doesn't sit
 *  flush against the plot's top edge and read as clipped. */
export const SEA_DAILY_CEILING_MM = Math.ceil(SEA_WETTEST_MM / 5) * 5;

// ---------------------------------------------------------------------------
// Climate stripes — the global record, one bar per year
// ---------------------------------------------------------------------------

export const STRIPES_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'anomaly', kind: 'number' },
  // Every stripe is the same height: in this chart the *colour* is the value,
  // and a constant column is how you say "draw a full-height slot here". The
  // anomaly is still on the row, so the cursor can read it out.
  { name: 'stripe', kind: 'number' },
] as const;

function buildStripes() {
  return TimeSeries.fromColumns({
    name: 'gistemp',
    schema: STRIPES_SCHEMA,
    columns: {
      // Keyed at 1 January of each year; the bars take their width from the
      // spacing of their neighbours, so they tile with no gaps.
      time: GISTEMP_ANOMALY_C.map((_, i) => Date.UTC(GISTEMP_YEAR0 + i, 0, 1)),
      anomaly: GISTEMP_ANOMALY_C,
      stripe: GISTEMP_ANOMALY_C.map(() => 1),
    },
  });
}

let stripesCache: ReturnType<typeof buildStripes> | undefined;

/** Global annual temperature anomaly, one row per complete year. */
export function climateStripes(): ReturnType<typeof buildStripes> {
  stripesCache ??= buildStripes();
  return stripesCache;
}

/** The record's `[first, last]` bounds in ms, padded to whole years. */
export const STRIPES_BOUNDS: readonly [number, number] = [
  Date.UTC(GISTEMP_YEAR0, 0, 1),
  Date.UTC(GISTEMP_YEAR0 + GISTEMP_ANOMALY_C.length, 0, 1),
];

/** The coldest and warmest years on record, `[min, max]` in °C. */
export const STRIPES_EXTENT: readonly [number, number] = [
  Math.min(...GISTEMP_ANOMALY_C),
  Math.max(...GISTEMP_ANOMALY_C),
];

/**
 * One calendar year's anomaly in °C, or `null` for a year off the record.
 *
 * The stripes chart draws a *constant* column — the colour is the value — so
 * the number behind a stripe can't come from the cursor's own readout. It
 * comes from here, keyed by the year the tracker reports.
 */
export function anomalyAt(year: number): number | null {
  return GISTEMP_ANOMALY_C[year - GISTEMP_YEAR0] ?? null;
}

/**
 * Which ramp step an anomaly falls in — `0` (coldest) to `steps - 1`
 * (warmest), spread linearly across {@link STRIPES_EXTENT}.
 *
 * The colour *is* the data here, so this is the encoding, not decoration:
 * feed the result into a ramp and hand the ramp to `<BarChart binColors>`.
 */
export function anomalyStep(anomaly: number, steps: number): number {
  const [min, max] = STRIPES_EXTENT;
  const t = (anomaly - min) / (max - min);
  return Math.min(steps - 1, Math.max(0, Math.floor(t * steps)));
}

// ---------------------------------------------------------------------------
// Wind rose — the hourly record, binned to 16 compass sectors
// ---------------------------------------------------------------------------

/** Month names for {@link windRose}'s `month` argument (0 = January). */
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Every observed hour of 2024, by month — the denominator {@link windRose}
 *  divides by, so calm and variable hours count against the percentages
 *  rather than being quietly excluded. */
const MONTH_HOURS = SEA_WIND_HOURS.map(
  (sectors, m) =>
    sectors.reduce((a, b) => a + b, 0) +
    SEA_WIND_CALM_HOURS[m]! +
    SEA_WIND_VARIABLE_HOURS[m]!,
);

const roseCache = new Map<number, readonly CategoryDatum[]>();

/**
 * The wind rose as ordered categories — one `{ label, value }` per compass
 * sector, clockwise from north, `value` being the **percentage of observed
 * hours** the wind blew from that sector.
 *
 * `month` is 0–11; omit it for the whole year. Percentages don't sum to 100:
 * the balance is the calm and variable hours ({@link windOtherPct}), which
 * have no direction to plot.
 */
export function windRose(month?: number): readonly CategoryDatum[] {
  const key = month ?? -1;
  const cached = roseCache.get(key);
  if (cached) return cached;
  const months = month === undefined ? SEA_WIND_HOURS.map((_, m) => m) : [month];
  const hours = months.reduce((a, m) => a + MONTH_HOURS[m]!, 0);
  const rose = WIND_SECTORS.map((label, s) => ({
    label,
    value: (100 * months.reduce((a, m) => a + SEA_WIND_HOURS[m]![s]!, 0)) / hours,
  }));
  roseCache.set(key, rose);
  return rose;
}

/** Percentage of hours with no plottable direction — calm plus variable. */
export function windOtherPct(month?: number): {
  calm: number;
  variable: number;
} {
  const months = month === undefined ? SEA_WIND_HOURS.map((_, m) => m) : [month];
  const hours = months.reduce((a, m) => a + MONTH_HOURS[m]!, 0);
  const pct = (source: readonly number[]) =>
    (100 * months.reduce((a, m) => a + source[m]!, 0)) / hours;
  return { calm: pct(SEA_WIND_CALM_HOURS), variable: pct(SEA_WIND_VARIABLE_HOURS) };
}

/** The tallest sector in any single month, as a percentage — the fixed y-axis
 *  ceiling that lets a month-by-month sweep be compared frame to frame. */
export const WIND_MONTHLY_PEAK_PCT = Math.max(
  ...SEA_WIND_HOURS.map((_, m) =>
    Math.max(...windRose(m).map((sector) => sector.value)),
  ),
);
