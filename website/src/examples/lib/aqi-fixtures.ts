import { TimeSeries } from 'pond-ts';
import type { SeriesSchema } from 'pond-ts';
import type { ChartTheme } from '@pond-ts/charts';
import { AQI_CSV } from './aqi-csv';

/**
 * The air-quality guide's data: {@link AQI_CSV} parsed into a pond
 * `TimeSeries`, plus the US EPA AQI category table the chart's `<Zone>` bands
 * are built from.
 *
 * This module is the guide's code, not an illustration of it — the MDX quotes
 * these functions and the docs-site chart imports them, so the two can't drift.
 */

/**
 * Two sensors, a shared 10-minute clock. Both are `required: false` even though
 * this particular export has no holes: an outdoor sensor that never drops a
 * reading is a property of three days in July, not of the schema.
 */
export const AQI_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'a', kind: 'number', required: false },
  { name: 'b', kind: 'number', required: false },
] as const satisfies SeriesSchema;

/** One CSV line → its cells, unquoted. The export quotes every text cell and
 *  leaves numbers bare, and no cell contains a comma — so a split on `,` is
 *  honest here. (A CSV with commas *inside* quotes needs a real parser; that's
 *  the "Ingesting messy data" guide's territory.) */
function cells(line: string): string[] {
  return line.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
}

/**
 * `"2026-07-22 08:50:00"` → epoch ms, read as **UTC**.
 *
 * `new Date('2026-07-22 08:50:00')` would read the same text in the *parsing
 * machine's* zone, so the identical CSV would land on a different instant for a
 * reader in Madrid than for CI in UTC — the series would silently shift by
 * hours depending on who built it. Pinning the zone at the boundary makes the
 * epoch a property of the file. (Which zone is right is the *export's* business
 * to tell you; UTC is the honest default when it doesn't.)
 */
function parseUtc(stamp: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (m === null) throw new Error(`unparseable timestamp: ${stamp}`);
  const [, y, mo, d, h, mi, s] = m as unknown as string[];
  return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
}

/** A numeric cell, with the empty string meaning **absent** — not zero. On an
 *  AQI chart 0 is a real (excellent) reading, so coercing blanks to 0 would
 *  invent clean air. */
function num(cell: string): number | undefined {
  return cell === '' ? undefined : Number(cell);
}

/**
 * Parse the export into a `TimeSeries`.
 *
 * The CSV's four columns become three: `DateTime` → the temporal key, the two
 * sensors → `a`/`b`, and **`Average` is dropped**. That column isn't a series —
 * it's 52.7 on the first and last row and blank on the other 430, which is how
 * a spreadsheet-shaped export smuggles in a flat reference line. Carrying it as
 * data would mean a column that is 99.5% missing and a chart layer with two
 * points; the value it encodes belongs on the chart as an annotation, and pond
 * can recompute it from the sensors anyway (see {@link aqiAverage}).
 */
export function aqiSeries(): TimeSeries<typeof AQI_SCHEMA> {
  const lines = AQI_CSV.trim()
    // Strip the UTF-8 BOM: without this the first header reads "﻿DateTime"
    // and every by-name column lookup misses.
    .replace(/^﻿/, '')
    .split('\n');
  const header = cells(lines[0]!);
  // Look the sensors up by their real (accented) names rather than trusting
  // column order — an export that gains a column shouldn't silently re-map.
  const ia = header.indexOf('Argüelles A');
  const ib = header.indexOf('Argüelles B');
  if (ia < 0 || ib < 0) throw new Error(`unexpected columns: ${header}`);
  const rows = lines.slice(1).map((line) => {
    const c = cells(line);
    return [parseUtc(c[0]!), num(c[ia]!), num(c[ib]!)] as [
      number,
      number | undefined,
      number | undefined,
    ];
  });
  return new TimeSeries({ name: 'pm25-aqi', schema: AQI_SCHEMA, rows });
}

/**
 * The mean across **both** sensors over the whole window — the number the
 * export's `Average` column carries as its flat line.
 *
 * Computed rather than read, and it agrees: 52.666…, which is the export's 52.7
 * at the precision the export chose. A derived value the data can regenerate
 * shouldn't be ingested as data.
 *
 * Each `reduce` mapping reads **one** source column, so pooling two sensors is
 * sums and counts added by hand rather than `from: ['a', 'b']`. Averaging the
 * two column means would only agree here because both sensors have the same
 * row count; totals are the answer that stays right when one drops readings.
 *
 * The results are `| undefined` because the columns are optional — reducing a
 * column with nothing in it has no answer. Coalescing the sums to 0 is safe
 * (an absent sum contributes nothing); coalescing the *counts* and dividing
 * would hand back `NaN`, so a series with no readings at all is refused
 * outright rather than turned into a number-shaped non-answer.
 */
export function aqiAverage(series: TimeSeries<typeof AQI_SCHEMA>): number {
  const s = series.reduce({
    sumA: { from: 'a', using: 'sum' },
    sumB: { from: 'b', using: 'sum' },
    nA: { from: 'a', using: 'count' },
    nB: { from: 'b', using: 'count' },
  });
  const n = (s.nA ?? 0) + (s.nB ?? 0);
  if (n === 0) throw new Error('no readings to average');
  return ((s.sumA ?? 0) + (s.sumB ?? 0)) / n;
}

/**
 * The **US EPA AQI categories** — the breakpoints the colour bands encode.
 *
 * `to: Infinity` on the last one is the real definition: "Hazardous" is
 * open-ended, and `<Zone>` clamps an infinite bound to the plot edge rather
 * than needing an invented ceiling.
 *
 * Source: US EPA, *Technical Assistance Document for the Reporting of Daily Air
 * Quality — the Air Quality Index (AQI)*, EPA-454/B-24-002 (2024), Table 4.
 */
export const AQI_CATEGORIES = [
  { role: 'good', label: 'Good', from: 0, to: 50 },
  { role: 'moderate', label: 'Moderate', from: 50, to: 100 },
  {
    role: 'sensitive',
    label: 'Unhealthy for sensitive groups',
    from: 100,
    to: 150,
  },
  { role: 'unhealthy', label: 'Unhealthy', from: 150, to: 200 },
  { role: 'veryUnhealthy', label: 'Very unhealthy', from: 200, to: 300 },
  { role: 'hazardous', label: 'Hazardous', from: 300, to: Infinity },
] as const;

/**
 * The other half of {@link AQI_CATEGORIES}: the EPA's category **colours**, as
 * a theme layered onto whatever base the page is using.
 *
 * This is the whole styling story for a zone set — `<Zone role="good">` says
 * *which category*, and the theme says what a category looks like. It lives
 * here, beside the breakpoints, because the two are halves of one scale: a
 * category without a colour draws nothing legible, a colour without a
 * breakpoint has nothing to shade. Both the guide's chart and the gallery card
 * read this, so the two can't drift apart.
 *
 * The official hues are saturated (they're designed for filled status badges),
 * so they ride at a low `fillOpacity` — a wash the traces read through, not a
 * block of colour competing with them. The per-role values aren't uniform
 * because the hues aren't equally strong: pure yellow needs more alpha than red
 * to register at all.
 *
 * Source: US EPA, *Technical Assistance Document for the Reporting of Daily Air
 * Quality — the Air Quality Index (AQI)*, EPA-454/B-24-002 (2024), Table 4.
 */
export function aqiTheme(base: ChartTheme): ChartTheme {
  return {
    ...base,
    annotation: {
      ...base.annotation!,
      roles: {
        good: { color: '#00e400', fillOpacity: 0.16 },
        moderate: { color: '#ffff00', fillOpacity: 0.22 },
        sensitive: { color: '#ff7e00', fillOpacity: 0.14 },
        unhealthy: { color: '#ff0000', fillOpacity: 0.12 },
        veryUnhealthy: { color: '#8f3f97', fillOpacity: 0.12 },
        hazardous: { color: '#7e0023', fillOpacity: 0.12 },
        // The window average — a neutral grey, dashed, so a derived reference
        // line can't be mistaken for one of the two sensors.
        average: { color: '#8a8f98', dash: [6, 4] },
      },
    },
  };
}

/** The AQI scale as y-axis ticks: the category boundaries themselves, so every
 *  gridline is a threshold that means something rather than a round number.
 *  Explicit `ticks` drive the row's gridlines as well as its labels, so the
 *  lines land exactly on the band edges. */
export const AQI_TICKS = [0, 50, 100, 150, 200].map((at) => ({
  at,
  label: String(at),
}));
