#!/usr/bin/env node
/**
 * Generator for `src/examples/lib/science-samples.ts` — the Gallery's
 * science & measurement track (gallery plan §4, Track F).
 *
 * Run by hand, never by the build:
 *
 *     node website/scripts/fixtures/science.mjs \
 *       > website/src/examples/lib/science-samples.ts
 *     npx prettier --write website/src/examples/lib/science-samples.ts
 *
 * Four public sources, all fetched live here and **committed** as the output
 * module so the docs site fetches nothing:
 *
 * 1. **NDBC** (NOAA National Data Buoy Center) — non-directional wave energy
 *    density spectra (`swden`) from buoy 46042, Monterey Bay CA, for the
 *    January 2023 atmospheric-river storm. 47 frequency bins per hourly frame.
 * 2. **IRIS/EarthScope FDSN `timeseries`** — the vertical (BHZ) ground-motion
 *    trace at IU.ANMO (USGS Albuquerque Seismological Laboratory, the GSN
 *    reference station) for the 2019-07-06 M7.1 Ridgecrest, California
 *    earthquake, at the station's native 40 Hz.
 * 3. **NOAA CO-OPS** — 6-minute verified water level, the harmonic prediction
 *    for the same interval, and the predicted high/low extremes, at Seattle
 *    (station 9447130), across the record high water of 2022-12-27.
 * 4. **EPA AQS pre-generated files** (`aqs.epa.gov/aqsweb/airdata`) — hourly
 *    PM2.5 (parameter 88101) at a New York City monitor across the June 2023
 *    Canadian-wildfire smoke episode.
 *
 * All four are US-government works and therefore public domain. The output
 * module's header carries the provenance the fixture README (§"The header")
 * asks for; keep the two in step if you change what's pulled here.
 *
 * Source (4) is a **77 MB zip** — the annual national hourly file, which is
 * the only keyless door onto AQS hourly data (the AQS REST API needs a
 * registered key). It's cached in `--cache-dir` (default `/tmp`) so a re-run
 * doesn't re-download.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CACHE = process.env.SCIENCE_FIXTURE_CACHE ?? path.join(tmpdir(), 'pond-science-fixtures');

const HEADERS = { 'user-agent': 'pond-ts-docs-fixture-generator/1.0' };

/** Progress to stderr — stdout is the module, so it can't be chatted on. Two
 *  of these fetches are multi-megabyte and the AQS step scans a 2.6 GB file,
 *  so a silent five minutes would look like a hang. */
function log(msg) {
  process.stderr.write(`${msg}\n`);
}

async function get(url) {
  log(`  GET ${url.slice(0, 96)}…`);
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res;
}

const getJson = async (url) => (await get(url)).json();
const getText = async (url) => (await get(url)).text();

/** Fetch `url` into `CACHE/name` once; return the local path. */
async function cached(url, name) {
  await mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, name);
  try {
    const s = await stat(file);
    if (s.size > 0) return file;
  } catch {
    /* not cached yet */
  }
  const res = await get(url);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

/** A dense numeric array literal, hand-wrapped at ~76 columns (fixture README
 *  §"Numeric arrays: keep them dense" — prettier would explode it one value
 *  per line and roughly triple the file). */
function denseArray(values, indent = '  ') {
  const cells = values.map((v) => (v === null || v === undefined ? 'null' : String(v)));
  const lines = [];
  let line = indent;
  for (const cell of cells) {
    const next = line === indent ? line + cell + ',' : `${line} ${cell},`;
    if (next.length > 76 && line !== indent) {
      lines.push(line);
      line = `${indent}${cell},`;
    } else {
      line = next;
    }
  }
  if (line !== indent) lines.push(line);
  return lines.join('\n');
}

/** Round to `d` decimals, dropping a trailing `.0` — the size lever the
 *  fixture README asks for ("Round. Four significant figures is plenty"). */
function round(v, d) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// 1. NDBC wave energy density spectra — the F1 spectrum card
// ---------------------------------------------------------------------------

const BUOY = '46042';
const SWDEN_YEAR = 2023;
/** Inclusive UTC window, hourly frames: the wind-sea peak of 4 Jan giving way
 *  to the 17 s forerunner swell that peaked on 5 Jan. */
const SWDEN_FROM = Date.UTC(2023, 0, 4, 12, 0);
const SWDEN_TO = Date.UTC(2023, 0, 6, 12, 59);

async function waveSpectra() {
  const text = await getText(
    `https://www.ndbc.noaa.gov/view_text_file.php?filename=${BUOY}w${SWDEN_YEAR}.txt.gz` +
      `&dir=data/historical/swden/`,
  );
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const freqs = lines[0].trim().split(/\s+/).slice(5).map(Number);
  const frames = [];
  for (const line of lines.slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 6) continue;
    const [Y, M, D, h, m] = p.slice(0, 5).map(Number);
    const t = Date.UTC(Y, M - 1, D, h, m);
    if (t < SWDEN_FROM || t > SWDEN_TO) continue;
    // NDBC fills a failed bin with 999.00; carry it through as a gap rather
    // than dropping the frame — a spectrum with a hole is a real spectrum.
    const density = p.slice(5).map((x) => (Number(x) >= 99 ? null : round(Number(x), 2)));
    frames.push({ t, density });
  }
  frames.sort((a, b) => a.t - b.t);
  return { freqs: freqs.map((f) => round(f, 4)), frames };
}

// ---------------------------------------------------------------------------
// 2. IRIS seismic waveform — the F2 seismograph card
// ---------------------------------------------------------------------------

const SEIS_NET = 'IU';
const SEIS_STA = 'ANMO';
const SEIS_LOC = '00';
const SEIS_CHA = 'BHZ';
/** 2019-07-06 03:19:53 UTC M7.1 Ridgecrest, CA. The window opens ~87 s after
 *  origin — inside the pre-arrival noise — and closes in the surface-wave
 *  coda, so the P, the S, and the Rayleigh train are all inside it. */
const SEIS_FROM = '2019-07-06T03:21:20';
const SEIS_TO = '2019-07-06T03:26:40';

async function seismicTrace() {
  const url =
    `https://service.iris.edu/irisws/timeseries/1/query?net=${SEIS_NET}&sta=${SEIS_STA}` +
    `&loc=${SEIS_LOC}&cha=${SEIS_CHA}&starttime=${SEIS_FROM}&endtime=${SEIS_TO}` +
    // `demean` drops the digitiser's DC offset; `scale=AUTO` divides by the
    // channel's stage-zero sensitivity, so the output is m/s of ground
    // velocity rather than raw counts. No response deconvolution, no filter —
    // nothing that would invent structure the seismometer didn't record.
    `&output=ascii&format=ascii&demean=true&scale=AUTO`;
  const text = await getText(url);
  const lines = text.split('\n');
  const header = lines[0];
  const hz = Number(/,\s*([\d.]+)\s*sps/.exec(header)?.[1]);
  const startIso = /,\s*(\d{4}-\d\d-\d\dT[\d:.]+),/.exec(header)?.[1];
  if (!hz || !startIso) throw new Error(`unparsed IRIS header: ${header}`);
  const samples = [];
  for (const line of lines.slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length !== 2) continue;
    // m/s → µm/s, 2 dp. The pre-arrival noise floor is ~0.3 µm/s RMS, so two
    // decimals is what keeps the noise band from quantising into steps when
    // you zoom into it.
    samples.push(round(Number(p[1]) * 1e6, 2));
  }
  return { hz, startMs: Math.round(Date.parse(`${startIso}Z`)), samples, header: header.trim() };
}

// ---------------------------------------------------------------------------
// 3. NOAA CO-OPS tides — the F3 tides card
// ---------------------------------------------------------------------------

const TIDE_STATION = '9447130'; // Seattle, WA
const TIDE_FROM = '20221224';
const TIDE_TO = '20221230';

function coopsUrl(product, extra = '') {
  return (
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=${product}` +
    `&application=pond-ts-docs&begin_date=${TIDE_FROM}&end_date=${TIDE_TO}` +
    `&datum=MLLW&station=${TIDE_STATION}&time_zone=gmt&units=metric&format=json${extra}`
  );
}

async function tides() {
  const [obs, pred, hilo] = await Promise.all([
    getJson(coopsUrl('water_level')),
    getJson(coopsUrl('predictions')),
    getJson(coopsUrl('predictions', '&interval=hilo')),
  ]);
  const parse = (t) => Date.parse(`${t.replace(' ', 'T')}:00Z`);
  const num = (v) => (v === '' || v === null || v === undefined ? null : round(Number(v), 2));

  const predByT = new Map(pred.predictions.map((p) => [parse(p.t), num(p.v)]));
  const rows = obs.data.map((o) => ({
    t: parse(o.t),
    observed: num(o.v),
    predicted: predByT.get(parse(o.t)) ?? null,
  }));
  rows.sort((a, b) => a.t - b.t);
  const extremes = hilo.predictions.map((p) => ({
    t: parse(p.t),
    v: num(p.v),
    kind: p.type,
  }));
  return { station: obs.metadata, rows, extremes };
}

// ---------------------------------------------------------------------------
// 4. EPA AQS hourly PM2.5 — the F4 air-quality card
// ---------------------------------------------------------------------------

const AQ_YEAR = 2023;
/** Site 36-005-0110 — IS 52, Bronx NY (40.816, −73.902). The closest EPA
 *  PM2.5 monitor to central New York City that also has a **real interior
 *  dropout** inside the smoke episode, which is why it was picked over the
 *  (higher-peaking, gapless) Queens College site: gap handling is one of the
 *  things this card is for, and a manufactured hole would be a lie. POC 4 is
 *  the raw Teledyne T640 channel; POC 24 is the same instrument's corrected
 *  channel, within ~2 µg/m³ throughout. */
const AQ_STATE = '36';
const AQ_COUNTY = '005';
const AQ_SITE = '0110';
const AQ_POC = '4';
const AQ_FROM = Date.UTC(2023, 5, 5);
const AQ_TO = Date.UTC(2023, 5, 12);

/** Split one AQS row. Numeric fields are unquoted and text fields are quoted,
 *  but no field in this table carries an embedded comma, so a plain split with
 *  quote-stripping is exact (and 20× faster than a real CSV parser over a
 *  2.6 GB file). */
function aqsFields(line) {
  return line.split(',').map((s) => (s.startsWith('"') ? s.slice(1, -1) : s));
}

async function airQuality() {
  const zip = await cached(
    `https://aqs.epa.gov/aqsweb/airdata/hourly_88101_${AQ_YEAR}.zip`,
    `hourly_88101_${AQ_YEAR}.zip`,
  );
  const csv = path.join(CACHE, `hourly_88101_${AQ_YEAR}.csv`);
  try {
    await stat(csv);
  } catch {
    await run('unzip', ['-o', '-q', zip, '-d', CACHE]);
  }
  // The national annual file is ~2.6 GB uncompressed — too big for one string,
  // so grep the site's rows out first and parse only those.
  const slice = path.join(CACHE, `aqs-${AQ_STATE}-${AQ_COUNTY}-${AQ_SITE}.csv`);
  try {
    await stat(slice);
  } catch {
    const { stdout } = await run(
      'grep',
      ['-E', `^"${AQ_STATE}","${AQ_COUNTY}","${AQ_SITE}"`, csv],
      { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
    );
    await writeFile(slice, stdout);
  }
  const byHour = new Map();
  for (const line of (await readFile(slice, 'utf8')).split('\n')) {
    if (line.length === 0) continue;
    const f = aqsFields(line);
    if (f[4] !== AQ_POC) continue;
    // 11 = Date GMT, 12 = Time GMT, 13 = Sample Measurement
    const t = Date.parse(`${f[11]}T${f[12]}:00Z`);
    if (!(t >= AQ_FROM && t < AQ_TO)) continue;
    const v = f[13] === '' ? null : Number(f[13]);
    byHour.set(t, v === null || !Number.isFinite(v) ? null : round(v, 1));
  }
  const rows = [];
  for (let t = AQ_FROM; t < AQ_TO; t += 3_600_000) {
    rows.push({ t, pm25: byHour.has(t) ? byHour.get(t) : null });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function iso(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

async function main() {
  // Serial, not `Promise.all`: four sources of very different weight, and when
  // one stalls you want to know which.
  log('1/4 NDBC wave spectra');
  const spec = await waveSpectra();
  log('2/4 IRIS seismogram');
  const seis = await seismicTrace();
  log('3/4 NOAA CO-OPS tides');
  const tide = await tides();
  log('4/4 EPA AQS hourly PM2.5');
  const air = await airQuality();

  const seisSeconds = seis.samples.length / seis.hz;
  const tideStep = tide.rows[1].t - tide.rows[0].t;
  const airMissing = air.filter((r) => r.pm25 === null).length;
  const specGaps = spec.frames.reduce(
    (n, f) => n + f.density.filter((d) => d === null).length,
    0,
  );
  const peakUms = Math.max(...seis.samples.map((v) => Math.abs(v)));

  const out = `/**
 * Track F's four datasets — a wave spectrum, a seismogram, a tide record and
 * an air-quality trace. **Every one of them is real, measured data from a US
 * government source, and therefore public domain**; nothing here is modelled.
 * Generated once by \`website/scripts/fixtures/science.mjs\`, then committed —
 * the docs site fetches nothing.
 *
 * ---------------------------------------------------------------------------
 * 1. WAVE ENERGY DENSITY SPECTRA — \`WAVE_*\`
 * ---------------------------------------------------------------------------
 * Non-directional wave energy density at **NDBC buoy ${BUOY}** (Monterey Bay,
 * CA, 27 nm west of Moss Landing), ${spec.frames.length} consecutive hourly frames from
 * ${iso(spec.frames[0].t)} to ${iso(spec.frames.at(-1).t)} — the January 2023
 * atmospheric-river storm that ran onto the California coast.
 *
 * Source: NOAA National Data Buoy Center historical \`swden\` archive,
 * https://www.ndbc.noaa.gov/data/historical/swden/ — a US government work,
 * public domain. Retrieved ${iso(Date.now()).slice(0, 10)}.
 *
 * Each frame is **${spec.freqs.length} energy-density values in m²/Hz, one per frequency bin**,
 * ${spec.freqs[0]}–${spec.freqs.at(-1)} Hz (periods of ${round(1 / spec.freqs.at(-1), 1)}–${round(1 / spec.freqs[0], 0)} s). The bins are
 * **unevenly spaced** — 0.005 Hz wide below 0.1 Hz where the swell lives,
 * 0.01 Hz wide above it — which is exactly why the axis has to be a real
 * value axis and not a bar index.
 *
 * Kept: the density values and their frequencies. Dropped: the directional
 * spectra (\`swdir\`/\`swr1\`/…) the buoy also publishes — this card plots
 * energy against frequency, not against direction.
 *
 * The ${specGaps} \`null\`s are the buoy's own \`999.00\` fill values — bins its
 * onboard processing rejected. They stay in as gaps rather than being
 * interpolated.
 *
 * ---------------------------------------------------------------------------
 * 2. SEISMOGRAM — \`SEISMIC_*\`
 * ---------------------------------------------------------------------------
 * ${seis.samples.length.toLocaleString('en-US')} samples of vertical ground velocity at **${seis.hz} Hz** — ${round(seisSeconds / 60, 1)} minutes,
 * recorded at **${SEIS_NET}.${SEIS_STA}.${SEIS_LOC}.${SEIS_CHA}**, the USGS Albuquerque Seismological
 * Laboratory (New Mexico), of the **M7.1 Ridgecrest, California earthquake**
 * of 2019-07-06 03:19:53 UTC, ~1,020 km away. The window opens in the
 * pre-arrival noise, so the P arrival, the S arrival and the Rayleigh
 * surface-wave train are all inside it.
 *
 * Source: IRIS/EarthScope FDSN \`timeseries\` web service,
 * https://service.iris.edu/irisws/timeseries/1/ — the Global Seismographic
 * Network is operated by the USGS and NSF; its data are public domain.
 * Retrieved ${iso(Date.now()).slice(0, 10)}. Original header:
 * \`${seis.header}\`
 *
 * Units are **µm/s**. Two transforms were applied at the source, both
 * documented in the generator: \`demean\` (removes the digitiser's DC offset)
 * and \`scale=AUTO\` (divides by the channel's stage-zero sensitivity, turning
 * counts into m/s). **No response deconvolution and no filter** — nothing
 * that could invent structure the seismometer didn't record. Values are
 * rounded to 2 dp, which is what keeps the ~0.3 µm/s noise floor from
 * quantising into steps when you zoom into it; the peak is ${round(peakUms, 0)} µm/s.
 *
 * Kept: the vertical channel only. Dropped: the two horizontals (BH1/BH2) —
 * a single trace is what a seismogram card is about, and three would triple
 * a fixture that is already the heaviest in the gallery.
 *
 * ---------------------------------------------------------------------------
 * 3. TIDES — \`TIDE_*\`
 * ---------------------------------------------------------------------------
 * ${tide.rows.length.toLocaleString('en-US')} six-minute water-level samples at **NOAA CO-OPS station ${TIDE_STATION}**
 * (${tide.station.name}, WA — ${tide.station.lat}, ${tide.station.lon}), ${iso(tide.rows[0].t).slice(0, 10)} to
 * ${iso(tide.rows.at(-1).t).slice(0, 10)}, with the harmonic **prediction** for the same instants
 * and the ${tide.extremes.length} predicted high/low **extremes**. The window straddles
 * 2022-12-27, when a storm surge on top of a king tide set the all-time
 * record high water for the station.
 *
 * Source: NOAA CO-OPS API,
 * https://api.tidesandcurrents.noaa.gov/api/prod/ — a US government work,
 * public domain. Retrieved ${iso(Date.now()).slice(0, 10)}.
 *
 * Metres above **MLLW** (mean lower low water), UTC, rounded to the
 * centimetre. \`TIDE_OBSERVED\` is the verified record; \`TIDE_PREDICTED\` is
 * what the harmonic constituents said the tide alone would do. The gap
 * between them is the surge — which is the entire point of plotting both.
 *
 * Kept: water level, prediction, and the hi/lo extremes. Dropped: the sigma /
 * flags / quality columns CO-OPS also returns, and the six-minute
 * meteorological channels (wind, pressure) published separately.
 *
 * ---------------------------------------------------------------------------
 * 4. AIR QUALITY — \`AIR_*\`
 * ---------------------------------------------------------------------------
 * ${air.length} hourly PM2.5 concentrations (µg/m³) at **EPA AQS site
 * ${AQ_STATE}-${AQ_COUNTY}-${AQ_SITE}** — IS 52, Bronx NY (40.816, −73.902) — from
 * ${iso(AQ_FROM).slice(0, 10)} to ${iso(AQ_TO).slice(0, 10)} UTC, across the June 2023 Canadian-wildfire
 * smoke episode that put New York City's air among the worst in the world for
 * two days. The peak here is ${Math.max(...air.map((r) => r.pm25 ?? 0))} µg/m³ — roughly ${Math.round(Math.max(...air.map((r) => r.pm25 ?? 0)) / 35)}× the
 * 24-hour national standard, in a single hour.
 *
 * Source: EPA Air Quality System pre-generated data files,
 * https://aqs.epa.gov/aqsweb/airdata/ (\`hourly_88101_${AQ_YEAR}.zip\`, parameter
 * 88101 = PM2.5 FRM/FEM mass) — a US government work, public domain.
 * Retrieved ${iso(Date.now()).slice(0, 10)}.
 *
 * The ${airMissing} \`null\` is an hour the monitor did not report — ${air
   .filter((r) => r.pm25 === null)
   .map((r) => iso(r.t).slice(0, 16).replace('T', ' '))
   .join(', ')} UTC, in
 * the thick of the episode. It stays in as a gap rather than being
 * interpolated, and it is the reason this site was chosen over the
 * higher-peaking but gapless Queens College monitor a few miles east.
 *
 * Kept: the sample measurement, POC ${AQ_POC} (the raw Teledyne T640 channel).
 * Dropped: POC 24 (the same instrument's corrected channel, within ~2 µg/m³
 * throughout), the site's other parameters, and the method / uncertainty /
 * qualifier columns. There is no AQI column here on purpose — the AQI
 * breakpoints are applied in \`science-fixtures.ts\` so the arithmetic is
 * visible rather than imported.
 */

// ---------------------------------------------------------------------------
// 1. Wave energy density spectra
// ---------------------------------------------------------------------------

/** The ${spec.freqs.length} NDBC frequency bin centres, Hz. Unevenly spaced by design. */
// prettier-ignore
export const WAVE_FREQUENCIES: readonly number[] = [
${denseArray(spec.freqs)}
];

/** UTC ms of the first hourly frame in {@link WAVE_SPECTRA}. */
export const WAVE_FIRST_FRAME_MS = ${spec.frames[0].t};

/** Spacing between frames — the buoy reports one spectrum an hour. */
export const WAVE_FRAME_STEP_MS = ${spec.frames[1].t - spec.frames[0].t};

/** One row per hourly frame, one value per {@link WAVE_FREQUENCIES} bin:
 *  energy density in m²/Hz, \`null\` where the buoy flagged the bin. */
// prettier-ignore
export const WAVE_SPECTRA: ReadonlyArray<ReadonlyArray<number | null>> = [
${spec.frames.map((f) => `  [\n${denseArray(f.density, '    ')}\n  ],`).join('\n')}
];

// ---------------------------------------------------------------------------
// 2. Seismogram
// ---------------------------------------------------------------------------

/** UTC ms of the first sample. */
export const SEISMIC_START_MS = ${seis.startMs};

/** Sample rate, Hz — the channel's native rate, not a resampling. */
export const SEISMIC_RATE_HZ = ${seis.hz};

/** Vertical ground velocity, µm/s, one value per 1/${seis.hz} s. */
// prettier-ignore
export const SEISMIC_VELOCITY: readonly number[] = [
${denseArray(seis.samples)}
];

// ---------------------------------------------------------------------------
// 3. Tides
// ---------------------------------------------------------------------------

/** UTC ms of the first six-minute sample. */
export const TIDE_START_MS = ${tide.rows[0].t};

/** Spacing between samples. */
export const TIDE_STEP_MS = ${tideStep};

/** Verified water level, metres above MLLW. */
// prettier-ignore
export const TIDE_OBSERVED: ReadonlyArray<number | null> = [
${denseArray(tide.rows.map((r) => r.observed))}
];

/** The harmonic prediction for the same instants, metres above MLLW. */
// prettier-ignore
export const TIDE_PREDICTED: ReadonlyArray<number | null> = [
${denseArray(tide.rows.map((r) => r.predicted))}
];

/** Predicted high/low extremes: \`[utcMs, metres, 'H' | 'L']\`. */
export const TIDE_EXTREMES: ReadonlyArray<readonly [number, number, 'H' | 'L']> = [
${tide.extremes.map((e) => `  [${e.t}, ${e.v}, '${e.kind}'],`).join('\n')}
];

// ---------------------------------------------------------------------------
// 4. Air quality
// ---------------------------------------------------------------------------

/** UTC ms of the first hourly sample. */
export const AIR_START_MS = ${AQ_FROM};

/** Spacing between samples. */
export const AIR_STEP_MS = 3600000;

/** Hourly PM2.5, µg/m³; \`null\` where the monitor didn't report. */
// prettier-ignore
export const AIR_PM25: ReadonlyArray<number | null> = [
${denseArray(air.map((r) => r.pm25))}
];
`;

  process.stdout.write(out);
  process.stderr.write(
    `spectra: ${spec.frames.length} frames × ${spec.freqs.length} bins (${specGaps} gaps)\n` +
      `seismic: ${seis.samples.length} samples @ ${seis.hz} Hz, peak ${round(peakUms, 1)} µm/s\n` +
      `tides:   ${tide.rows.length} samples, ${tide.extremes.length} extremes\n` +
      `air:     ${air.length} hours, ${airMissing} missing\n`,
  );
}

await main();
