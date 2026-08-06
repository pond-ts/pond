import { TimeSeries } from 'pond-ts';
import {
  NINO34_FIRST_YEAR,
  NINO34_SST_DELTA_CENTI,
  NINO34_YEAR_DAYS,
  NINO34_YEAR_LENGTHS,
} from './nino34-samples';

/**
 * The Gallery's **Niño 3.4 day-of-year overlay** (plan §4, Track F) — every
 * year of the record drawn on one shared Jan–Dec axis.
 *
 * Provenance and licence live in the header of `nino34-samples.ts`, which this
 * module only shapes: numbers there, pond types here. Short version: **real
 * measured data**, NOAA OISST v2.1, public domain, daily since 1982.
 *
 * What this module does is the interesting part, and it is deliberately *not*
 * baked into the fixture:
 *
 * 1. **Stack the years.** Every year's days are mapped onto one common
 *    non-leap reference year, so "5 August" is the same x for all of them.
 * 2. **Build each year's own climatology** — the mean SST for that day of the
 *    year across the 30 years centred on it (ONI's convention), clamped at the
 *    ends of the record.
 * 3. **Subtract.** The anomaly is what is left, and it is the only quantity
 *    that can be compared across 44 years: raw SST carries the warming trend,
 *    and on a raw axis the last decade simply sits above the first.
 *
 * Steps 2 and 3 are two `collapse`s over a wide series. See
 * {@link anomalySeries}.
 */

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/** Every year in the record, in order. */
export const NINO34_YEARS: readonly number[] = NINO34_YEAR_LENGTHS.map(
  (_, i) => NINO34_FIRST_YEAR + i,
);

/** The partial year at the end of the record — the one the chart is about. */
export const NINO34_CURRENT_YEAR = NINO34_YEARS[NINO34_YEARS.length - 1]!;

/** Complete years only. The current year's 215 days would otherwise contribute
 *  to the first half of every climatology and not the second, which is a
 *  seam in a quantity whose whole job is to be seamless across the year. */
const NINO34_COMPLETE_YEARS: readonly number[] = NINO34_YEARS.slice(0, -1);

/** Days of the current year the record actually carries. */
export const NINO34_CURRENT_DAYS =
  NINO34_YEAR_LENGTHS[NINO34_YEAR_LENGTHS.length - 1]!;

/**
 * Raw daily SST in °C, `[year][dayOfYear]`, `dayOfYear` 0-based with 29
 * February already dropped. The fixture stores hundredths of a degree as
 * deltas; undoing that is the running sum below.
 */
const SST: readonly Float64Array[] = (() => {
  const out: Float64Array[] = [];
  let acc = 0;
  let at = 0;
  for (const days of NINO34_YEAR_LENGTHS) {
    const year = new Float64Array(days);
    for (let d = 0; d < days; d++) {
      acc += NINO34_SST_DELTA_CENTI[at++]!;
      year[d] = acc / 100;
    }
    out.push(year);
  }
  return out;
})();

// ---------------------------------------------------------------------------
// One axis for every year
// ---------------------------------------------------------------------------

/**
 * The common year every year's days are stacked onto. **Non-leap on purpose**:
 * 29 February is dropped from the fixture, so a reference year that had one
 * would leave a permanent hole in the middle of every series. 2001 is
 * otherwise arbitrary — it never reaches the reader, because the axis is
 * formatted `%b` (`Jan`, `Apr`, …) and the off-chart readout formats the day
 * itself via {@link dayLabel}.
 */
const REFERENCE_YEAR = 2001;

/**
 * The 365 slot times, **local midnights** of the reference year.
 *
 * Local and not UTC on purpose. `<TimeAxis>`'s tick ladder places month ticks
 * on *local* month boundaries, so a UTC-midnight axis is offset from them by
 * the reader's own UTC offset — sub-pixel across a year, but enough that a
 * reader far enough east loses the `Jan` tick entirely, because local 1 January
 * falls before the range starts. Local midnights put every tick exactly on a
 * slot. The observations are still UTC days; this is the carrier, not the data.
 *
 * Built as a table rather than `t0 + d × 86 400 000` because two of these days
 * are 23 or 25 hours long in most timezones, and a DST hour is enough to make
 * an index round the wrong way.
 */
const DAY_TIMES: readonly number[] = Array.from(
  { length: NINO34_YEAR_DAYS },
  (_, d) => new Date(REFERENCE_YEAR, 0, 1 + d).getTime(),
);

/** Epoch ms of day-of-year `d` (0-based) on the shared axis. */
export function dayOfYearTime(d: number): number {
  return DAY_TIMES[Math.min(Math.max(d, 0), NINO34_YEAR_DAYS - 1)]!;
}

/** Which day-of-year slot a time on the shared axis falls in — the estimate a
 *  uniform grid would give, then nudged onto the real slot. */
export function timeToDayOfYear(ms: number): number {
  const guess = Math.round((ms - DAY_TIMES[0]!) / 86_400_000);
  let best = Math.min(Math.max(guess, 0), NINO34_YEAR_DAYS - 1);
  for (const d of [best - 1, best + 1]) {
    if (d < 0 || d >= NINO34_YEAR_DAYS) continue;
    if (Math.abs(DAY_TIMES[d]! - ms) < Math.abs(DAY_TIMES[best]! - ms))
      best = d;
  }
  return best;
}

/** The shared x range: 1 January to 31 December of the reference year. */
export const NINO34_YEAR_RANGE: readonly [number, number] = [
  dayOfYearTime(0),
  dayOfYearTime(NINO34_YEAR_DAYS - 1),
];

/** `1 March`-style label for a day-of-year slot, for prose and readouts. */
export function dayLabel(d: number): string {
  return new Date(dayOfYearTime(d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
  });
}

// ---------------------------------------------------------------------------
// The wide series — one column per year, one row per day of the year
// ---------------------------------------------------------------------------

const YEAR_COLUMN = (year: number) => `y${year}`;

/**
 * The wide series' schema, **declared rather than inferred**.
 *
 * pond's column-name types are literal-driven — `column('anomaly')` returns a
 * `Float64Column` because the schema says a column is *named* `anomaly`. This
 * series has one column per year and the years are a runtime list, so there are
 * no literals to infer from. Declaring the value columns as
 * `{ name: string; kind: 'number' }` widens the names to `string` and keeps
 * everything else: `collapse` accepts a computed key list, and the result still
 * knows its columns are numeric. (`TimeSeries<SeriesSchema>` does not work here
 * — its data-column names resolve to `never`, and every call fails.)
 */
type NinoSchema = readonly [
  { readonly name: 'time'; readonly kind: 'time' },
  ...{ readonly name: string; readonly kind: 'number' }[],
];

/**
 * Every year as its own column on one 365-row day-of-year axis.
 *
 * This is the shape that makes the climatology a one-liner: a day-of-year
 * climatology is a **row-wise** mean across a window of year columns, and
 * `collapse` reduces named columns to one per row. The alternative — 45
 * separate series and a hand-rolled index walk — is the same arithmetic with
 * the loop written out.
 *
 * The current year's column is `null` past the end of the record. Those rows
 * are genuinely unknown, not zero, and they are what makes its line stop.
 */
const wide: TimeSeries<NinoSchema> = (() => {
  const schema: NinoSchema = [
    { name: 'time', kind: 'time' },
    ...NINO34_YEARS.map((year) => ({
      name: YEAR_COLUMN(year),
      kind: 'number' as const,
    })),
  ];
  const columns: Record<string, (number | null)[]> = {
    time: Array.from({ length: NINO34_YEAR_DAYS }, (_, d) => dayOfYearTime(d)),
  };
  NINO34_YEARS.forEach((year, i) => {
    const values = SST[i]!;
    columns[YEAR_COLUMN(year)] = Array.from(
      { length: NINO34_YEAR_DAYS },
      (_, d) => (d < values.length ? values[d]! : null),
    );
  });
  return TimeSeries.fromColumns<NinoSchema>({
    name: 'nino34-sst',
    schema,
    columns,
  });
})();

// ---------------------------------------------------------------------------
// Climatology and anomaly
// ---------------------------------------------------------------------------

/** Years in a climatology base period. */
const NINO34_BASE_LENGTH = 30;

/**
 * The 30 complete years a given year is measured against: **centred** on it —
 * `[y − 14, y + 15]`, which is the window CPC's ONI uses (1950 is measured
 * against 1936–1965) — and **clamped** at the ends of the record, because
 * neither 1981 nor 2027 exists to be averaged.
 *
 * Only 1996–2010 get a genuinely centred window here; everything earlier is
 * clamped to 1982–2011 and everything later to 1996–2025. That is a real
 * property of a 44-year record and not a shortcut — CPC hits the same wall and
 * handles it the same way, holding the base period fixed at the recent end.
 *
 * The one deliberate difference: CPC moves its base period in **5-year
 * steps**; this moves it every year, which makes each year's line answer
 * exactly one question — how did this year compare with the climate of its own
 * time?
 */
function climatologyWindow(year: number): readonly number[] {
  const first = NINO34_COMPLETE_YEARS[0]!;
  const last = NINO34_COMPLETE_YEARS[NINO34_COMPLETE_YEARS.length - 1]!;
  let start = year - 14;
  if (start < first) start = first;
  if (start + NINO34_BASE_LENGTH - 1 > last) {
    start = last - NINO34_BASE_LENGTH + 1;
  }
  return Array.from({ length: NINO34_BASE_LENGTH }, (_, i) => start + i);
}

/**
 * One year's daily SST **anomaly** against its own centred 30-year day-of-year
 * climatology, on the shared Jan–Dec axis, in a column called `anomaly`.
 *
 * Two `collapse`s, and that is the whole computation:
 *
 * - the first reduces the 30 base-period columns to `clim`, the mean SST on
 *   that day of the year across the window. `append: true` keeps the other
 *   columns, which is how the year's own one survives to the second step;
 * - the second reduces `[thisYear, clim]` to their difference, and `collapse`
 *   drops the two columns it consumed.
 *
 * `collapseOp` reads only the columns it was given, and everything it keeps it
 * keeps **by reference**, so the 44 year columns still riding along afterwards
 * are free — narrowing the series with `select` first buys nothing and costs
 * the result's type (see {@link NinoSchema}).
 *
 * **The return type is inferred on purpose.** `collapse`'s result schema
 * records that `anomaly` is a numeric column named `anomaly`, which is what
 * makes `column('anomaly').toFloat64Array()` typecheck; annotating it back to
 * the wide schema — whose names are only `string` — throws that away.
 */
function buildAnomaly(year: number) {
  const own = YEAR_COLUMN(year);
  const base = climatologyWindow(year).map(YEAR_COLUMN);
  return wide
    .collapse(
      base,
      'clim',
      (values: Record<string, unknown>) => {
        let sum = 0;
        let n = 0;
        for (const column of base) {
          const value = values[column];
          if (typeof value === 'number') {
            sum += value;
            n++;
          }
        }
        return sum / n;
      },
      { append: true },
    )
    .collapse([own, 'clim'], 'anomaly', (values: Record<string, unknown>) => {
      const sst = values[own];
      const clim = values['clim'];
      // The current year past the end of its record: `undefined − number` is
      // NaN, which is exactly how pond spells "no value here", and what makes
      // the line stop rather than run to the right edge at zero.
      return typeof sst === 'number' && typeof clim === 'number'
        ? sst - clim
        : NaN;
    });
}

/** One year's anomaly series — the shape {@link anomalySeries} hands back. */
export type AnomalySeries = ReturnType<typeof buildAnomaly>;

const anomalyCache = new Map<number, AnomalySeries>();

/** {@link buildAnomaly}, memoised: 45 lines re-render on every theme flip and
 *  every pointer move, and each year is ~11,000 reducer calls. */
export function anomalySeries(year: number): AnomalySeries {
  const hit = anomalyCache.get(year);
  if (hit) return hit;
  const series = buildAnomaly(year);
  anomalyCache.set(year, series);
  return series;
}

// ---------------------------------------------------------------------------
// Numbers the page and the card quote
// ---------------------------------------------------------------------------

/** One year's anomaly column as a plain array, `NaN` past the record's end. */
function anomalies(year: number): Float64Array {
  return anomalySeries(year).column('anomaly').toFloat64Array();
}

/** Min and max anomaly across the whole record, rounded outward to a whole
 *  half-degree — the y domain, computed rather than guessed at. */
export const NINO34_ANOMALY_DOMAIN: readonly [number, number] = (() => {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const year of NINO34_YEARS) {
    for (const value of anomalies(year)) {
      if (Number.isNaN(value)) continue;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }
  return [Math.floor(lo * 2) / 2, Math.ceil(hi * 2) / 2];
})();

/**
 * The four El Niño strength thresholds, in °C of anomaly.
 *
 * These are the conventional NOAA/CPC labels for ONI — a **monthly** index over
 * a 3-month running mean — read here against a **daily** anomaly, which is a
 * noisier quantity that crosses a line and comes back. They are drawn as
 * reference marks for that reason: the bands say where a year sits, they do
 * not classify it.
 */
export const NINO34_THRESHOLDS: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 0.5, label: 'Weak' },
  { value: 1.0, label: 'Moderate' },
  { value: 1.5, label: 'Strong' },
  { value: 2.0, label: 'Very strong' },
];

/** The three years the chart names, and the `line` role each draws in. */
export const NINO34_NAMED: ReadonlyArray<{
  year: number;
  role: string;
  label: string;
}> = [
  { year: 1997, role: 'highlight2', label: '1997' },
  { year: 2015, role: 'highlight3', label: '2015' },
  {
    // `highlight1` is the subject slot — heaviest stroke, first hue.
    year: NINO34_CURRENT_YEAR,
    role: 'highlight1',
    label: `${NINO34_CURRENT_YEAR}`,
  },
];

/** Years drawn as the muted backdrop — everything the chart doesn't name. */
export const NINO34_BACKDROP: readonly number[] = NINO34_YEARS.filter(
  (year) => !NINO34_NAMED.some((n) => n.year === year),
);
