#!/usr/bin/env node
/**
 * Generator for `src/examples/lib/nino34-samples.ts` — the Gallery's Niño 3.4
 * day-of-year overlay (gallery plan §4, Track F).
 *
 * Run by hand, never by the build:
 *
 *     node website/scripts/fixtures/nino34.mjs \
 *       > website/src/examples/lib/nino34-samples.ts
 *     npx prettier --write website/src/examples/lib/nino34-samples.ts
 *
 * ## The data
 *
 * NOAA's **OISST v2.1** daily 0.25° sea-surface temperature analysis, averaged
 * over the **Niño 3.4** box — 5°S–5°N, 170°W–120°W — one number per day since
 * 1982. A US government work, so public domain. Note that ocean longitudes here
 * are **degrees east**: 170°W–120°W is `190`–`240`, and reading it as a
 * negative pair silently returns the wrong ocean.
 *
 * ## Two servers, and why this one
 *
 * NOAA publishes the same analysis through more than one door, and they are
 * not equally complete:
 *
 * - **NOAA CoastWatch's ERDDAP** (`ncdcOisst21Agg`) is the obvious one — a
 *   clean CSV API, no key, and the box subsets in one request. It is also
 *   **missing 1,196 days**, including *roughly every other day from October
 *   1992 to July 1998*: 1994 has 138 of 365, 1997 has 176. Six years of the
 *   overlay would have been combs, and 1997 is one of the years the chart
 *   names.
 * - **NOAA PSL's OPeNDAP** (`noaa.oisst.v2.highres`) serves the same product as
 *   one netCDF per year, **complete** — 365/366 days in every year.
 *
 * So the fixture is pulled from PSL, and ERDDAP is kept as the **cross-check**:
 * every {@link CROSS_CHECK} date is fetched from both servers, over the same
 * box, and asserted equal. They agree to every digit either one prints, which
 * is what licenses the swap.
 *
 * ## Every cell, not a sample of them
 *
 * The box is 41 × 201 = **8,241 cells** a day and this averages all of them.
 * Striding the grid was the obvious economy — every 4th cell is 561 of them and
 * costs 0.014 °C on 2015-12-01 — but it turns out to buy nothing here: PSL's
 * cost is dominated by *reading* the year file, so a full-resolution slab and a
 * strided one come back in the same ~0.3 s per day. The only thing striding
 * saves is bandwidth, and the only thing it costs is a caveat on the page. So:
 * no caveat.
 *
 * ## What comes out
 *
 * One daily box-mean SST per day, **29 February dropped**, delta-coded in
 * hundredths of a degree. Nothing is pre-computed: the day-of-year climatology
 * and the anomaly against it are the chart's own work, done in pond on the
 * page.
 *
 * ## Re-running
 *
 * ~180 requests, ~1.1 GB, ~15 minutes at {@link CONCURRENCY}-way concurrency
 * (PSL's proxy gives up on any single request that runs past 60 s, which is
 * what {@link CHUNK} is sized against). Set `NINO34_CACHE` to a scratch
 * directory to keep the **derived daily means** — not the raw payloads —
 * between runs, so re-emitting after an edit to the output format costs
 * nothing:
 *
 *     NINO34_CACHE=/tmp/nino34 node website/scripts/fixtures/nino34.mjs > …
 *
 * The cache holds exactly what the fetch derived, so a cached re-run and a cold
 * one emit the same bytes.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/** First complete calendar year of the record (OISST starts 1981-09-01). */
const FIRST_YEAR = 1982;

/** When the servers were asked — fixed, not `new Date()`, so re-running this
 *  script against an unchanged record reproduces the committed file byte for
 *  byte. Bump it by hand when the record is re-pulled. */
const RETRIEVED = '2026-08-05';

/** Cells in the box at the native 0.25° resolution — 41 latitudes × 201
 *  longitudes, asserted per day rather than assumed. **Every one is averaged**:
 *  this is the box mean, not a sample of it. */
const CELLS = 41 * 201;

/** Days per request. PSL's proxy gives up at 60 s and a day costs it ~0.3 s, so
 *  90 lands around 30 s with headroom. */
const CHUNK = 90;

/** Requests in flight. Four scaled linearly when measured (four 90-day slabs
 *  came back in the time one did); six is the compromise between that and
 *  hammering a public server. */
const CONCURRENCY = 6;

/** The one value this whole pipeline is checked against, supplied independently
 *  of it — a full-grid box mean measured by hand off the same analysis. If the
 *  pipeline stops agreeing, the pipeline is wrong. */
const CHECK = { date: '2015-12-01', sst: 29.4282 };

/** Dates fetched from **both** servers and asserted equal — the evidence that
 *  swapping ERDDAP for PSL swapped the door and not the data. Spread across the
 *  record, including the recent tail. */
const CROSS_CHECK = [
  '1982-06-15',
  '1990-06-15',
  '2011-03-04',
  '2015-12-01',
  '2024-01-15',
];

/** PSL, one netCDF per year, subset server-side over OPeNDAP. */
const PSL = 'https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.oisst.v2.highres';

/** CoastWatch ERDDAP — the cross-check only. */
const ERDDAP = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/ncdcOisst21Agg';

/**
 * Index windows into PSL's grid, which is `lat` ascending from −89.875 and
 * `lon` ascending from 0.125, both at 0.25°:
 *
 *     lat[i] = -89.875 + 0.25 i  ⇒  −4.875 at i=340, +5.125 at i=380
 *     lon[j] =   0.125 + 0.25 j  ⇒  190.125 at j=760, 240.125 at j=960
 *
 * which is cell-for-cell the box ERDDAP returns for
 * `[(-5.0):1:(5.0)][(190.0):1:(240.0)]`. The cross-check is what proves the two
 * windows line up rather than merely looking as if they do.
 */
const LAT_SLICE = '340:1:380';
const LON_SLICE = '760:1:960';

/** PSL 403s a bare `fetch` (no UA); ERDDAP doesn't care. */
const HEADERS = { 'user-agent': 'pond-ts-docs-fixture-generator/1.0' };

/** Plausible SST bounds in °C — anything outside is a fill value, not a
 *  temperature. There is no land in the Niño 3.4 box, so this should never
 *  fire; it exists so that if it ever does, it fires loudly. */
const SST_MIN = -3;
const SST_MAX = 40;

const CACHE = process.env.NINO34_CACHE;
if (CACHE) mkdirSync(CACHE, { recursive: true });

const log = (msg) => process.stderr.write(`${msg}\n`);

function assert(ok, message) {
  if (!ok) throw new Error(`fixture check failed: ${message}`);
}

async function getText(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } catch (err) {
    if (attempt >= 5) throw new Error(`${err.message} — ${url}`);
    log(`  retry ${attempt} after ${err.message}`);
    await new Promise((r) => setTimeout(r, 3000 * attempt));
    return getText(url, attempt + 1);
  }
}

/**
 * Sum + cell count per time index in one OPeNDAP ASCII grid response.
 *
 * The payload prints one line per `[time][lat]` row, all 201 longitudes to a
 * line:
 *
 *     [0][0], 30.32, 30.42, …
 *
 * so this is a group-by on the first bracket. The count comes back with the sum
 * rather than being assumed, because a short row is how a silently wrong mean
 * would get in.
 */
function sumsByTimeIndex(text) {
  const sums = new Map();
  const counts = new Map();
  for (const line of text.split('\n')) {
    const head = line.match(/^\[(\d+)\]\[\d+\],\s*(.*)$/);
    if (head === null) continue;
    const t = Number(head[1]);
    let sum = sums.get(t) ?? 0;
    let count = counts.get(t) ?? 0;
    for (const token of head[2].split(',')) {
      const value = Number(token);
      if (Number.isFinite(value) && value > SST_MIN && value < SST_MAX) {
        sum += value;
        count++;
      }
    }
    sums.set(t, sum);
    counts.set(t, count);
  }
  return [sums, counts];
}

/** Days in `year` according to PSL's own file — asked, not computed, so the
 *  short current-year file is detected rather than requested past its end. */
async function pslDayCount(year) {
  const dds = await getText(`${PSL}/sst.day.mean.${year}.nc.dds`);
  const m = dds.match(/time = (\d+)/);
  assert(m !== null, `no time dimension in ${year}'s DDS`);
  return Number(m[1]);
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** One 90-day slab of one year: `[[dayIndex, mean], …]`. */
async function fetchChunk({ year, from, to }) {
  const text = await getText(
    `${PSL}/sst.day.mean.${year}.nc.ascii?sst[${from}:1:${to}][${LAT_SLICE}][${LON_SLICE}]`,
  );
  const [sums, counts] = sumsByTimeIndex(text);
  const want = to - from + 1;
  assert(
    sums.size === want,
    `${year} [${from}..${to}]: ${sums.size} time steps, expected ${want}`,
  );
  const out = [];
  for (let i = 0; i < want; i++) {
    assert(
      counts.get(i) === CELLS,
      `${year} day ${from + i} has ${counts.get(i)} cells, expected ${CELLS}`,
    );
    out.push([from + i, sums.get(i) / CELLS]);
  }
  return { year, from, out, bytes: text.length };
}

/** The same box mean for one day from ERDDAP's CSV — the cross-check path, at
 *  the same full resolution. */
async function erddapDay(date) {
  const text = await getText(
    `${ERDDAP}.csv?sst[(${date}):1:(${date})][(0.0):1:(0.0)]` +
      `[(-5.0):1:(5.0)][(190.0):1:(240.0)]`,
  );
  let sum = 0;
  let count = 0;
  for (const line of text.trim().split('\n').slice(2)) {
    const value = Number(line.slice(line.lastIndexOf(',') + 1));
    if (Number.isFinite(value) && value > SST_MIN && value < SST_MAX) {
      sum += value;
      count++;
    }
  }
  assert(count === CELLS, `ERDDAP returned ${count} cells for ${date}`);
  return sum / count;
}

/** Run with at most `limit` in flight — polite to PSL, and several times faster
 *  than one at a time. */
async function pooled(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await run(items[i]);
      }
    }),
  );
  return results;
}

/** Hand-wrap a dense numeric array at ~76 columns — prettier would otherwise
 *  put one value per line and triple the file. */
function wrap(values) {
  const lines = [];
  let line = ' ';
  for (const value of values) {
    const token = ` ${value},`;
    if (line.length + token.length > 76) {
      lines.push(line);
      line = ' ';
    }
    line += token;
  }
  if (line.trim() !== '') lines.push(line);
  return lines.join('\n');
}

// --- fetch ------------------------------------------------------------------

const thisYear = new Date(`${RETRIEVED}T00:00:00Z`).getUTCFullYear();
const years = Array.from(
  { length: thisYear - FIRST_YEAR + 1 },
  (_, i) => FIRST_YEAR + i,
);
log(`fetching ${FIRST_YEAR}…${thisYear} from PSL, all ${CELLS} cells per day`);

const cachePath = (year) =>
  CACHE ? path.join(CACHE, `psl-${year}.json`) : null;
const cached = new Map();
const wanted = [];
for (const year of years) {
  const file = cachePath(year);
  if (file && existsSync(file)) {
    cached.set(year, JSON.parse(readFileSync(file, 'utf8')));
  } else {
    wanted.push(year);
  }
}
if (cached.size > 0) log(`cached: ${cached.size} year(s)`);

// Day counts first: the current year's file is short, and chunk boundaries have
// to be built against the file's real length rather than the calendar's.
const dayCounts = new Map(
  await pooled(wanted, CONCURRENCY, async (year) => [
    year,
    await pslDayCount(year),
  ]),
);
for (const [year, days] of dayCounts) {
  const calendar = isLeap(year) ? 366 : 365;
  assert(days <= calendar, `${year} has ${days} days, more than ${calendar}`);
  assert(
    year === thisYear || days === calendar,
    `${year} has ${days} days, expected ${calendar} — PSL is meant to be complete`,
  );
}

// Every slab of every uncached year, flat, so the pool stays saturated across
// year boundaries instead of draining at the end of each one.
const slabs = [];
for (const year of wanted) {
  const days = dayCounts.get(year);
  for (let from = 0; from < days; from += CHUNK) {
    slabs.push({ year, from, to: Math.min(from + CHUNK, days) - 1 });
  }
}
const started = Date.now();
let done = 0;
let bytes = 0;
const fetched = await pooled(slabs, CONCURRENCY, async (slab) => {
  const chunk = await fetchChunk(slab);
  done++;
  bytes += chunk.bytes;
  log(
    `  ${slab.year} [${slab.from}..${slab.to}] — ${done}/${slabs.length}, ` +
      `${(bytes / 1e6).toFixed(0)} MB, ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
  return chunk;
});

const perYear = new Map(cached);
for (const year of wanted) {
  const days = dayCounts.get(year);
  const means = new Array(days);
  for (const chunk of fetched.filter((c) => c.year === year)) {
    for (const [i, mean] of chunk.out) means[i] = mean;
  }
  const start = Date.UTC(year, 0, 1);
  const out = means.map((mean, i) => {
    assert(mean !== undefined, `${year} day ${i} never arrived`);
    return [iso(start + i * 86_400_000), mean];
  });
  perYear.set(year, out);
  const file = cachePath(year);
  if (file) writeFileSync(file, JSON.stringify(out));
}

// --- the checks -------------------------------------------------------------

const all = new Map(years.flatMap((y) => perYear.get(y)));

const check = all.get(CHECK.date);
assert(check !== undefined, `${CHECK.date} missing from the record`);
assert(
  Math.abs(check - CHECK.sst) < 0.0005,
  `${CHECK.date} box mean is ${check.toFixed(4)}, expected ${CHECK.sst}`,
);
log(`check: ${CHECK.date} = ${check.toFixed(4)} °C (expected ${CHECK.sst})`);

// PSL vs ERDDAP, same box, same day, same full resolution.
for (const date of CROSS_CHECK) {
  const mine = all.get(date);
  assert(mine !== undefined, `cross-check date ${date} missing from PSL`);
  const theirs = await erddapDay(date);
  assert(
    Math.abs(mine - theirs) < 0.001,
    `${date}: PSL ${mine.toFixed(4)} vs ERDDAP ${theirs.toFixed(4)}`,
  );
  log(
    `cross-check ${date}: PSL ${mine.toFixed(4)} = ERDDAP ${theirs.toFixed(4)}`,
  );
}

// The record must have no holes — PSL's completeness is the whole reason it is
// the source, so it is asserted rather than assumed.
for (const year of years) {
  const days = perYear.get(year);
  const expected = year === thisYear ? days.length : isLeap(year) ? 366 : 365;
  assert(
    days.length === expected,
    `${year} has ${days.length} days, expected ${expected}`,
  );
  for (let d = 1; d < days.length; d++) {
    const step =
      Date.parse(`${days[d][0]}T00:00:00Z`) -
      Date.parse(`${days[d - 1][0]}T00:00:00Z`);
    assert(step === 86_400_000, `gap in ${year}: ${days[d - 1][0]}`);
  }
}

// --- reshape: drop 29 February, flatten -------------------------------------
//
// Every year becomes 365 slots aligned by *calendar date*, not by ordinal day.
// Dropping 29 February is what makes that identity: in a leap year 1 March is
// day 61, and after the drop it is day 60 — the slot a common year puts it in.
// Aligning on the raw ordinal instead slides every leap year's second half one
// day left of every common year's.

const values = [];
const yearLengths = [];
for (const year of years) {
  const days = perYear.get(year).filter((d) => !d[0].endsWith('-02-29'));
  const expected = year === thisYear ? days.length : 365;
  assert(
    days.length === expected,
    `${year} has ${days.length} days after dropping 29 Feb, expected ${expected}`,
  );
  assert(
    days[0][0] === `${year}-01-01`,
    `${year} starts at ${days[0][0]}, not 1 January`,
  );
  yearLengths.push(days.length);
  for (const [, mean] of days) values.push(Math.round(mean * 100));
}
assert(
  yearLengths.slice(0, -1).every((n) => n === 365),
  `a year other than ${thisYear} is short: ${yearLengths.join(',')}`,
);
const complete = yearLengths.length - 1;

// Delta-coded in hundredths of a degree: SST moves a few hundredths a day, so
// the deltas are one or two digits where the absolute values are four. Entry 0
// is absolute; the rest are differences, running across year boundaries.
const deltas = values.map((v, i) => (i === 0 ? v : v - values[i - 1]));
// Round-trip the encoding rather than trusting it — a cumulative sum that
// drifted would be invisible in the emitted file.
let acc = 0;
deltas.forEach((d, i) => {
  acc += d;
  assert(acc === values[i], `delta round-trip failed at ${i}`);
});

const min = Math.min(...values) / 100;
const max = Math.max(...values) / 100;
const step = Math.max(...deltas.slice(1).map(Math.abs)) / 100;
const lastDate = perYear.get(thisYear).at(-1)[0];
const plainChars = values.join(',').length;
const deltaChars = deltas.join(',').length;
const saved = Math.round((1 - deltaChars / plainChars) * 100);
log(
  `encoding: ${plainChars} chars plain → ${deltaChars} delta (${saved}% off)`,
);

const emitted = `/**
 * **Real measured data** — daily sea-surface temperature over the **Niño 3.4**
 * box (5°S–5°N, 170°W–120°W), ${FIRST_YEAR}-01-01 → ${lastDate}: ${values.length.toLocaleString('en-US')} daily
 * values. This is the box whose SST anomaly *is* the definition of El Niño and
 * La Niña.
 *
 * Source: NOAA **OISST v2.1**, the daily 0.25° optimum-interpolation SST
 * analysis, retrieved ${RETRIEVED} from **NOAA PSL**'s OPeNDAP server
 * (\`noaa.oisst.v2.highres\`, one netCDF per year, subset server-side). A US
 * government work — public domain.
 *
 * **Every cell, not a sample.** Each value is the mean of all ${CELLS.toLocaleString('en-US')} 0.25°
 * cells in the box (41 latitudes × 201 longitudes) for that day. No striding,
 * so no approximation to declare.
 *
 * **Why PSL and not CoastWatch's ERDDAP.** ERDDAP's \`ncdcOisst21Agg\` is the
 * friendlier API and serves the same analysis, but it is **missing 1,196
 * days** — about every other day from October 1992 to July 1998, which leaves
 * 1997 with 176 of its 365. PSL's yearly files are complete. The generator
 * fetches ${CROSS_CHECK.length} dates from **both** and asserts they agree; they match to every
 * digit either one prints.
 *
 * **29 February is dropped**, which is what makes a slot a calendar date: with
 * the leap day gone, slot 59 of every year is 1 March, and the ${complete + 1} years stack
 * on one Jan–Dec axis with no drift. The alternative — aligning on the raw
 * ordinal day — slides every leap year's second half one day left.
 *
 * **Nothing is pre-computed.** These are raw SSTs. The day-of-year climatology
 * and the anomaly against it are the chart's own work, done in pond at render
 * time (\`nino34.ts\`) — which is the point of the card.
 *
 * **The quirk that matters.** The last year is **short**: the record ends
 * ${lastDate}, so ${thisYear}'s line stops partway across the plot. That partial year
 * is the chart's subject, not an inconvenience.
 *
 * Generated once by \`website/scripts/fixtures/nino34.mjs\`, then committed.
 */

/** First calendar year in the record. */
export const NINO34_FIRST_YEAR = ${FIRST_YEAR};

/** Days in a complete year here — 29 February is dropped, so every one is 365. */
export const NINO34_YEAR_DAYS = 365;

/** Days per year in order: ${complete} complete years, then a partial ${thisYear}. */
// prettier-ignore
export const NINO34_YEAR_LENGTHS: readonly number[] = [
${wrap(yearLengths)}
];

/** Last day of the record, \`YYYY-MM-DD\` — where the ${thisYear} line stops. */
export const NINO34_LAST_DAY = '${lastDate}';

/** When the servers were asked. OISST v2.1 revises its most recent fortnight
 *  from preliminary to final, so a regenerated fixture will not be
 *  bit-identical at the tail. */
export const NINO34_RETRIEVED = '${RETRIEVED}';

/** The box, as drawn from — quoted on the page rather than paraphrased there. */
export const NINO34_BOX = {
  /** 0.25° cells averaged per day: 41 latitudes × 201 longitudes. */
  cells: ${CELLS},
  /** The day the pipeline is checked on. */
  checkDate: '${CHECK.date}',
  /** Its box mean in °C, reproduced independently of this script. */
  checkSst: ${check.toFixed(4)},
} as const;

/**
 * Daily box-mean SST in **hundredths of a degree C, delta-coded**: entry 0 is
 * absolute, every later entry is the difference from its predecessor, running
 * straight across year boundaries. Undo it with a running sum.
 *
 * Why: the absolute values sit between ${min.toFixed(2)} and ${max.toFixed(2)} °C — four digits each —
 * while a day moves at most ${step.toFixed(2)} °C, so the deltas are one or two digits.
 * That is **${saved}% off** the committed file for a decode of one line.
 */
// prettier-ignore
export const NINO34_SST_DELTA_CENTI: readonly number[] = [
${wrap(deltas)}
];
`;

process.stdout.write(emitted);
