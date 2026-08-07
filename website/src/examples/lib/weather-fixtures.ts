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
  SEA_WIND_CODES,
  SEA_WIND_HOURS,
  SEA_WIND_OFF_GRID,
  SEA_WIND_T0_MS,
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
// Climate stripes — the global record, one cell per year
// ---------------------------------------------------------------------------

export const STRIPES_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'anomaly', kind: 'number' },
  // One numeric column, and the chart colours by it: `<HeatMap>` reads
  // `anomaly` as both the colour and the value it reports. This schema used to
  // carry a constant `stripe: 1` column as well, purely so the bars drawing
  // the stripes were full height — the heat map made it unnecessary.
] as const;

function buildStripes() {
  return TimeSeries.fromColumns({
    name: 'gistemp',
    schema: STRIPES_SCHEMA,
    columns: {
      // Keyed at 1 January of each year; the cells take their width from the
      // spacing of their neighbours, so they tile with no gaps.
      time: GISTEMP_ANOMALY_C.map((_, i) => Date.UTC(GISTEMP_YEAR0 + i, 0, 1)),
      anomaly: GISTEMP_ANOMALY_C,
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

// ---------------------------------------------------------------------------
// Wind — the hourly record as a categorical series, and the rose it counts to
// ---------------------------------------------------------------------------

/**
 * Every category an observation can carry — the 16 compass sectors clockwise
 * from north, then the two with no direction. This is the **declared group
 * list** for `partitionBy('sector', { groups: WIND_CATEGORIES })`: it fixes
 * the slot order and keeps a sector that no hour in the window blew from as an
 * empty partition rather than a missing one, so the bars never shuffle as the
 * window moves.
 */
export const WIND_CATEGORIES = [
  ...WIND_SECTORS,
  'Calm',
  'Variable',
] as const satisfies readonly string[];

/** How many hours of {@link SEA_WIND_HOURS} carry no direction, whole year. */
const ANNUAL_CALM = SEA_WIND_CALM_HOURS.reduce((a, b) => a + b, 0);
const ANNUAL_VARIABLE = SEA_WIND_VARIABLE_HOURS.reduce((a, b) => a + b, 0);
const ANNUAL_HOURS =
  SEA_WIND_HOURS.reduce((a, row) => a + row.reduce((x, y) => x + y, 0), 0) +
  ANNUAL_CALM +
  ANNUAL_VARIABLE;

/** The share of a year's observed hours in each of `indices`, as a percent. */
function annualShare(indices: readonly number[]): number {
  const hours = SEA_WIND_HOURS.reduce(
    (total, row) => total + indices.reduce((a, s) => a + row[s]!, 0),
    0,
  );
  return (100 * hours) / ANNUAL_HOURS;
}

/** Sector indices either side of the compass: the three centred on north, and
 *  the three centred on south. The pair the Puget Sound trough swings between,
 *  and what the readout compares. */
const NORTHERLY = [15, 0, 1];
const SOUTHERLY = [7, 8, 9];

/**
 * The whole of 2024, from the **binned** matrix — the reference the scrubbing
 * window is read against, and the reason `SEA_WIND_HOURS` is still worth
 * shipping alongside the per-observation codes. Percentages are of all
 * observed hours, calm and variable included in the denominator.
 */
export const WIND_ANNUAL = {
  northerly: annualShare(NORTHERLY),
  southerly: annualShare(SOUTHERLY),
} as const;

const WIND_HOURLY_SCHEMA = [
  { name: 'time', kind: 'time' },
  // The category. A string column, because that's what it is — and because
  // `partitionBy` groups on it directly.
  { name: 'sector', kind: 'string' },
  // Where the observation sits on the strip's y axis. Optional: a calm or
  // variable hour was observed (it counts in the denominator) but has no
  // direction, so it rides as a gap and draws no mark.
  { name: 'row', kind: 'number', required: false },
] as const;

/**
 * Which plot row a sector index draws on — **the compass cut at east**.
 *
 * An axis has two ends and a compass has none, so the circle has to be broken
 * somewhere, and wherever it breaks, two adjacent directions land at opposite
 * edges of the plot. Cutting between ENE and E puts the break in the quietest
 * 45° at this station (5.0% of hours between them) and leaves the north-south
 * axis — 52% of the year — in the middle of the plot where it can be read.
 * North ends up above south, which is the one convention worth keeping.
 */
function windRow(sector: number): number {
  return (sector + 12) % 16;
}

/** The sixteen sectors in plot-row order — index 0 is the bottom lane (E),
 *  index 15 the top (ENE). */
const WIND_ROW_LABELS: readonly string[] = (() => {
  const out = new Array<string>(16);
  WIND_SECTORS.forEach((label, s) => {
    out[windRow(s)] = label;
  });
  return out;
})();

/** Every other row named, the rest ticked but unlabelled — sixteen gridlines
 *  so each row reads as a lane, eight labels so the names don't collide. */
export const WIND_ROW_TICKS: ReadonlyArray<{ at: number; label: string }> =
  WIND_ROW_LABELS.map((label, at) => ({
    at,
    label: at % 2 === 0 ? label : '',
  }));

/** The four cardinal lanes only — for the Gallery card, where sixteen
 *  gridlines and eight names in 76 pixels is a smear rather than an axis. */
export const WIND_ROW_TICKS_CARD: ReadonlyArray<{ at: number; label: string }> =
  WIND_ROW_TICKS.filter((tick) => tick.at % 4 === 0);

/** The strip's y domain — the sixteen rows, with half a lane of air at each
 *  end so an E or an ENE mark isn't half-clipped by the plot edge. */
export const WIND_ROW_EXTENT: readonly [number, number] = [-0.5, 15.5];

/**
 * Every observation's timestamp — the base plus 60 minutes a step, with the 28
 * recorded breaks applied. Reconstructing them here rather than shipping 8,735
 * stamps is the whole point of {@link SEA_WIND_OFF_GRID}.
 */
const WIND_TIMES: readonly number[] = (() => {
  const offGrid = new Map(SEA_WIND_OFF_GRID);
  const out: number[] = [];
  let t = SEA_WIND_T0_MS;
  for (let i = 0; i < SEA_WIND_CODES.length; i += 1) {
    if (i > 0) t += (offGrid.get(i) ?? 60) * 60_000;
    out.push(t);
  }
  return out;
})();

function buildWindHourly() {
  return TimeSeries.fromColumns({
    name: 'sea-wind-2024',
    schema: WIND_HOURLY_SCHEMA,
    columns: {
      time: WIND_TIMES,
      sector: SEA_WIND_CODES.map((code) => WIND_CATEGORIES[code]!),
      row: SEA_WIND_CODES.map((code) =>
        code < 16 ? windRow(code) : undefined,
      ),
    },
  });
}

let windHourlyCache: ReturnType<typeof buildWindHourly> | undefined;

/**
 * The 8,735 hourly METAR observations of 2024 as a categorical time series —
 * one row per report, carrying the compass sector it blew from (`sector`) and
 * that sector's lane on the strip (`row`).
 */
export function seattleWindHourly(): ReturnType<typeof buildWindHourly> {
  windHourlyCache ??= buildWindHourly();
  return windHourlyCache;
}

/** Calendar 2024 in ms — the strip's fixed range, and the travel the window
 *  slides through. */
export const SEA_WIND_BOUNDS: readonly [number, number] = [
  Date.UTC(2024, 0, 1),
  Date.UTC(2025, 0, 1),
];

/** How long the scrubbing window may be, in days. The range is narrow on
 *  purpose: {@link WIND_WINDOW_CEILING_PCT} is one pinned number across all of
 *  it, so resizing never rescales the histogram out from under a comparison. */
export const WIND_SPAN_DAYS = { min: 21, max: 45, initial: 30 } as const;

/** What one window's worth of observations counts to. */
export interface WindWindow {
  /** One `{ label, value }` per compass sector, clockwise from north, `value`
   *  the percent of the window's observed hours. Always sixteen entries. */
  bars: readonly CategoryDatum[];
  /** Observations inside the window — the denominator. */
  hours: number;
  /** Percent of the window with no direction to plot. */
  calm: number;
  variable: number;
  /** Percent from the three sectors centred on north / on south. */
  northerly: number;
  southerly: number;
}

/**
 * Count one `[from, to)` window of the hourly series into a rose.
 *
 * This is the whole demonstration, and the only thing that happens when the
 * window moves: the histogram is not a second dataset, it is the same series
 * sliced and grouped. `within` takes the
 * window (inclusive of both ends, hence the `- 1`), `partitionBy` splits it by
 * the category column with the sixteen-plus-two slots **declared** so empty
 * ones survive, and each partition collapses to a count.
 *
 * The one bump: `PartitionedTimeSeries` has no `reduce`, so collapsing every
 * partition to a scalar means `toMap()` and then a `reduce` per group rather
 * than one call on the partitioned view.
 */
export function windWindow(from: number, to: number): WindWindow {
  const inWindow = seattleWindHourly().within(from, to - 1);
  const hours = inWindow.length;
  const byCategory = inWindow
    .partitionBy('sector', { groups: WIND_CATEGORIES })
    .toMap();
  const pct = (label: (typeof WIND_CATEGORIES)[number]) => {
    const count = byCategory.get(label)?.reduce('sector', 'count') ?? 0;
    return hours === 0 ? 0 : (100 * (count as number)) / hours;
  };
  const bars = WIND_SECTORS.map((label) => ({ label, value: pct(label) }));
  const group = (indices: readonly number[]) =>
    indices.reduce((a, s) => a + bars[s]!.value, 0);
  return {
    bars,
    hours,
    calm: pct('Calm'),
    variable: pct('Variable'),
    northerly: group(NORTHERLY),
    southerly: group(SOUTHERLY),
  };
}

/**
 * The tallest single sector any window this page allows reaches in 2024 —
 * 29.6%, S, in the 28 days from 18 October — rounded up to the next whole
 * percent. Pinning the histogram's ceiling here is what makes scrubbing a
 * comparison rather than sixteen bars that always fill the plot.
 *
 * Computed rather than written down: a sliding two-pointer over every
 * day-aligned window of every allowed length, which is why the window snaps to
 * whole days (a window that started mid-day could be taller than anything this
 * scan saw).
 */
export const WIND_WINDOW_CEILING_PCT = (() => {
  const [year0, year1] = SEA_WIND_BOUNDS;
  let peak = 0;
  for (
    let span = WIND_SPAN_DAYS.min * DAY_MS;
    span <= WIND_SPAN_DAYS.max * DAY_MS;
    span += DAY_MS
  ) {
    const counts = new Array<number>(16).fill(0);
    let a = 0;
    let b = 0;
    for (let start = year0; start + span <= year1; start += DAY_MS) {
      while (b < WIND_TIMES.length && WIND_TIMES[b]! < start + span) {
        if (SEA_WIND_CODES[b]! < 16) counts[SEA_WIND_CODES[b]!] += 1;
        b += 1;
      }
      while (a < b && WIND_TIMES[a]! < start) {
        if (SEA_WIND_CODES[a]! < 16) counts[SEA_WIND_CODES[a]!] -= 1;
        a += 1;
      }
      const hours = b - a;
      if (hours === 0) continue;
      for (const c of counts) peak = Math.max(peak, (100 * c) / hours);
    }
  }
  return Math.ceil(peak);
})();
