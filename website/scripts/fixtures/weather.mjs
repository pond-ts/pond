#!/usr/bin/env node
/**
 * Generator for `src/examples/lib/weather-samples.ts` — the Gallery's
 * weather & climate track (gallery plan §4, Track C).
 *
 * Run by hand, never by the build:
 *
 *     node website/scripts/fixtures/weather.mjs \
 *       > website/src/examples/lib/weather-samples.ts
 *     npx prettier --write website/src/examples/lib/weather-samples.ts
 *
 * Three public sources, all fetched live here and **committed** as the output
 * module so the docs site fetches nothing:
 *
 * 1. **NOAA NCEI GHCN-Daily** (`daily-summaries`) — daily TMAX / TMIN / PRCP
 *    for Seattle-Tacoma Intl (GHCN id `USW00024233`), calendar 2024, metric.
 * 2. **NOAA NCEI Local Climatological Data** — hourly METAR (`FM-15`) wind
 *    direction + speed for the same station/year (WBAN id `72793024233`).
 * 3. **NASA GISS GISTEMP v4** — global land-ocean surface temperature
 *    anomaly, annual means (the `J-D` column), 1880 → last complete year.
 *
 * All three are US-government works and therefore public domain. The output
 * module's header carries the provenance the fixture README (§"The header")
 * asks for; keep the two in step if you change what's pulled here.
 */

const SEA_GHCN = 'USW00024233';
const SEA_WBAN = '72793024233';
const YEAR = 2024;

const DAILY_URL =
  `https://www.ncei.noaa.gov/access/services/data/v1?dataset=daily-summaries` +
  `&stations=${SEA_GHCN}&startDate=${YEAR}-01-01&endDate=${YEAR}-12-31` +
  `&dataTypes=TMAX,TMIN,PRCP&units=metric&format=json`;

const LCD_URL =
  `https://www.ncei.noaa.gov/access/services/data/v1?dataset=local-climatological-data` +
  `&stations=${SEA_WBAN}&startDate=${YEAR}-01-01&endDate=${YEAR}-12-31` +
  `&dataTypes=HourlyWindDirection,HourlyWindSpeed&format=json`;

const GISTEMP_URL = 'https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv';

const SECTORS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

// data.giss.nasa.gov 403s a bare `fetch` (no UA); NCEI doesn't care.
const HEADERS = { 'user-agent': 'pond-ts-docs-fixture-generator/1.0' };

async function get(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res;
}

const getJson = async (url) => (await get(url)).json();
const getText = async (url) => (await get(url)).text();

/** `[[y, m, d], …]` for every calendar day of `YEAR`, in order. */
function daysOfYear() {
  const out = [];
  for (
    let t = Date.UTC(YEAR, 0, 1);
    t < Date.UTC(YEAR + 1, 0, 1);
    t += 86_400_000
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** A dense array of one column, `null` where the station reported nothing. */
function column(byDate, days, field, round) {
  return days.map((d) => {
    const raw = byDate.get(d)?.[field];
    if (raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Number(n.toFixed(round)) : null;
  });
}

/**
 * Reflow prose into a JSDoc block at 76 columns. The header is assembled from
 * interpolated counts, so hand-wrapping it in the template literal produces a
 * ragged block that shifts every time the numbers do; wrapping here keeps the
 * committed fixture tidy without anyone reflowing it by hand. Blank lines
 * separate paragraphs and are preserved.
 */
function docComment(text) {
  const out = ['/**'];
  for (const para of text.trim().split(/\n\s*\n/)) {
    const words = para.trim().split(/\s+/);
    let line = ' *';
    for (const w of words) {
      if (line.length + w.length + 1 > 76 && line !== ' *') {
        out.push(line);
        line = ' *';
      }
      line += ` ${w}`;
    }
    out.push(line);
    out.push(' *');
  }
  out[out.length - 1] = ' */';
  return out.join('\n');
}

/** Wrap a numeric list at ~76 columns so prettier-ignore output stays dense. */
function wrap(values, indent = '  ') {
  const lines = [];
  let line = indent;
  for (const v of values) {
    const tok = `${v === null ? 'null' : v},`;
    if (line.length + tok.length > 76) {
      lines.push(line.trimEnd());
      line = indent;
    }
    line += `${tok} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join('\n');
}

async function main() {
  // ---- 1. daily temperature + precipitation ------------------------------
  const daily = await getJson(DAILY_URL);
  const byDate = new Map(daily.map((r) => [r.DATE, r]));
  const days = daysOfYear();
  const tmax = column(byDate, days, 'TMAX', 1);
  const tmin = column(byDate, days, 'TMIN', 1);
  const prcp = column(byDate, days, 'PRCP', 1);

  const gapsIn = (col) => days.filter((_, i) => col[i] === null);
  const totalMm = prcp.reduce((a, v) => a + (v ?? 0), 0);
  const dryDays = prcp.filter((v) => v === 0).length;
  const wettest = prcp.reduce(
    (best, v, i) => ((v ?? -1) > (best.mm ?? -1) ? { mm: v, day: days[i] } : best),
    { mm: null, day: null },
  );

  // ---- 2. hourly wind, binned to 16 compass sectors ----------------------
  const lcd = await getJson(LCD_URL);
  const hourly = lcd.filter((r) => r.REPORT_TYPE === 'FM-15');
  const counts = Array.from({ length: 12 }, () => new Array(16).fill(0));
  const calm = new Array(12).fill(0);
  const variable = new Array(12).fill(0);
  let observed = 0;
  for (const r of hourly) {
    const m = Number(r.DATE.slice(5, 7)) - 1;
    const dir = (r.HourlyWindDirection ?? '').trim();
    const spd = Number((r.HourlyWindSpeed ?? '').trim());
    if (dir === '' && !Number.isFinite(spd)) continue;
    observed += 1;
    if (dir === 'VRB') {
      variable[m] += 1;
      continue;
    }
    const deg = Number(dir);
    // METAR reports calm as direction 000 with speed 0; true north is 360.
    if (!Number.isFinite(deg) || deg === 0 || spd === 0) {
      calm[m] += 1;
      continue;
    }
    counts[m][Math.round(deg / 22.5) % 16] += 1;
  }

  // ---- 3. GISTEMP global annual anomaly ----------------------------------
  const csv = await getText(GISTEMP_URL);
  const rows = csv.split('\n').slice(1).map((l) => l.split(','));
  const head = rows[0];
  const jd = head.indexOf('J-D');
  const anomalies = [];
  let firstYear = null;
  for (const row of rows.slice(1)) {
    const year = Number(row[0]);
    const v = (row[jd] ?? '').trim();
    if (!Number.isFinite(year) || v === '' || v.includes('*')) continue;
    if (firstYear === null) firstYear = year;
    anomalies.push(Number(Number(v).toFixed(2)));
  }
  const lastYear = firstYear + anomalies.length - 1;

  // ---- emit ---------------------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const n = (x) => x.toLocaleString('en-US');
  const directed = sum(counts.flat());

  const header = docComment(`
**Real, measured data** — three US-government sources, all public domain. The
Gallery's weather & climate track (\`gallery-c*.tsx\`) draws all four of its
charts from this one module.

## 1. Seattle-Tacoma Intl (SEA), calendar ${YEAR} — daily

Daily maximum / minimum temperature (°C) and precipitation (mm) for GHCN
station \`${SEA_GHCN}\`, from **NOAA NCEI's GHCN-Daily** \`daily-summaries\`
service (https://www.ncei.noaa.gov/access/services/data/v1), retrieved
${today}. Public domain (a work of the US government).

One value per calendar day, so the **index is the day offset** from
\`SEA_DAY0_MS\` — no parallel time array to keep in step. Kept: TMAX, TMIN,
PRCP. Dropped: SNOW / SNWD (near-zero at sea level here) and the observation
flags, which say how a value was measured rather than what it was.

The \`null\`s are the station's own reporting gaps and stay in rather than
being interpolated: **TMIN** is missing ${gapsIn(tmin).join(', ')} and **PRCP**
${gapsIn(prcp).join(' and ')} (TMAX is complete). They are why the temperature
band has a one-day hole in it and why the cumulative-rainfall line holds flat
across two days — missing data is a thing pond represents, and a docs fixture
shouldn't pretend otherwise.

The ${dryDays} days of \`0\` in the precipitation channel are equally real:
this is a dry-summer climate, and of the ${totalMm.toFixed(1)} mm that fell in
${YEAR}, the wettest single day (${wettest.day}) took ${wettest.mm} mm of it.

## 2. The same station, ${YEAR} — hourly wind, binned

Hourly METAR (\`FM-15\`) reports from **NOAA NCEI's Local Climatological
Data** service for WBAN \`${SEA_WBAN}\` — the same airport — retrieved
${today}, also public domain. The ${n(hourly.length)} observations were
**binned offline into 16 compass sectors × 12 months** (\`SEA_WIND_HOURS\`),
because the chart is a distribution: shipping every hour to draw 16 bars would
be silly, and the binning is not the lesson.

Two categories have no direction to bin and are kept separately rather than
folded into a sector: **calm** (${n(sum(calm))} hours, reported as direction
000 with zero speed) and **variable** (${n(sum(variable))} hours of \`VRB\` — a
direction shifting faster than the observation resolves). That leaves
${n(directed)} directed hours in the sector matrix.

## 3. Global annual temperature anomaly, ${firstYear}–${lastYear}

**NASA GISS Surface Temperature Analysis (GISTEMP v4)**, land-ocean index,
annual means (the \`J-D\` column of \`GLB.Ts+dSST.csv\`), retrieved ${today}.
Public domain (NASA). Values are °C relative to the 1951–1980 mean — the
series behind the "warming stripes". Only complete years are kept, so the
current partial year is absent; GISTEMP revises history as station records are
homogenised, which is what the retrieval date is for.

Generated once by \`website/scripts/fixtures/weather.mjs\`, then committed.
`);

  process.stdout.write(`${header}

/** Midnight UTC on ${YEAR}-01-01 — the key of \`SEA_*[0]\`. */
export const SEA_DAY0_MS = Date.UTC(${YEAR}, 0, 1);

/** GHCN station id, WMO/WBAN id, and the station's own name. */
export const SEA_STATION = {
  ghcn: '${SEA_GHCN}',
  wban: '${SEA_WBAN}',
  name: 'Seattle-Tacoma International Airport, WA',
} as const;

/** Daily maximum temperature, °C. One per calendar day of ${YEAR}. */
// prettier-ignore
export const SEA_TMAX_C: ReadonlyArray<number | null> = [
${wrap(tmax)}
];

/** Daily minimum temperature, °C. */
// prettier-ignore
export const SEA_TMIN_C: ReadonlyArray<number | null> = [
${wrap(tmin)}
];

/** Daily precipitation, mm — ${totalMm.toFixed(1)} mm over the year. */
// prettier-ignore
export const SEA_PRCP_MM: ReadonlyArray<number | null> = [
${wrap(prcp)}
];

/** The 16 compass sectors, clockwise from north — \`SEA_WIND_HOURS\`' inner axis. */
export const WIND_SECTORS = [
  ${SECTORS.map((s) => `'${s}'`).join(', ')},
] as const;

/**
 * Hourly observations per **[month][sector]** — 12 rows (January first), each
 * 16 counts clockwise from north. Sums to
 * ${counts.flat().reduce((a, b) => a + b, 0).toLocaleString('en-US')} directed
 * hours; the calm and variable hours below are the rest of the
 * ${observed.toLocaleString('en-US')} observations, so
 * \`sector + calm + variable\` is the month's denominator.
 */
// prettier-ignore
export const SEA_WIND_HOURS: ReadonlyArray<ReadonlyArray<number>> = [
${counts.map((row) => `  [${row.join(', ')}],`).join('\n')}
];

/** Hours reported **calm** (direction 000, speed 0), per month. */
// prettier-ignore
export const SEA_WIND_CALM_HOURS: ReadonlyArray<number> = [${calm.join(', ')}];

/** Hours reported **variable** (\`VRB\`) — a direction too unsteady to fix. */
// prettier-ignore
export const SEA_WIND_VARIABLE_HOURS: ReadonlyArray<number> = [${variable.join(', ')}];

/** The first year of {@link GISTEMP_ANOMALY_C}. */
export const GISTEMP_YEAR0 = ${firstYear};

/**
 * Global mean surface temperature anomaly, °C vs the 1951–1980 base period —
 * one value per year, ${firstYear} → ${lastYear}.
 */
// prettier-ignore
export const GISTEMP_ANOMALY_C: ReadonlyArray<number> = [
${wrap(anomalies)}
];
`);

  process.stderr.write(
    `daily: ${daily.length} rows, ${totalMm.toFixed(1)} mm, ` +
      `${dryDays} dry days; gaps tmax=[${gapsIn(tmax)}] ` +
      `tmin=[${gapsIn(tmin)}] prcp=[${gapsIn(prcp)}]\n` +
      `wind: ${hourly.length} FM-15 reports, ${observed} usable, ` +
      `calm ${calm.reduce((a, b) => a + b, 0)}, ` +
      `variable ${variable.reduce((a, b) => a + b, 0)}\n` +
      `gistemp: ${anomalies.length} complete years ${firstYear}–${lastYear}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(1);
});
