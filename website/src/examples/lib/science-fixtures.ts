import { TimeSeries, ValueSeries } from 'pond-ts';
import type { ChartTheme } from '@pond-ts/charts';
import {
  AIR_PM25,
  AIR_START_MS,
  AIR_STEP_MS,
  SEISMIC_RATE_HZ,
  SEISMIC_START_MS,
  SEISMIC_VELOCITY,
  TIDE_EXTREMES,
  TIDE_OBSERVED,
  TIDE_PREDICTED,
  TIDE_START_MS,
  TIDE_STEP_MS,
  WAVE_FIRST_FRAME_MS,
  WAVE_FRAME_STEP_MS,
  WAVE_FREQUENCIES,
  WAVE_SPECTRA,
} from './science-samples';

/**
 * The Gallery's science & measurement track (gallery plan §4, Track F), shaped
 * into pond series. The raw arrays — and the provenance for all four datasets,
 * every one of them real, measured, public-domain data — live in
 * `science-samples.ts`.
 *
 * Each dataset gets its series built **once** and memoised at module scope:
 * the cards re-render on every autoplay frame, and the seismogram in
 * particular is 12,800 rows that must not be rebuilt 24 times a second.
 */

const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// F1 — the wave spectrum: a ValueSeries keyed by frequency
// ---------------------------------------------------------------------------

const spectrumSchema = [
  { name: 'frequency', kind: 'value' },
  { name: 'density', kind: 'number' },
] as const;

/** How many hourly spectra the fixture carries. */
export const WAVE_FRAME_COUNT = WAVE_SPECTRA.length;

/** UTC ms of frame `i`. */
export function waveFrameTime(i: number): number {
  return WAVE_FIRST_FRAME_MS + i * WAVE_FRAME_STEP_MS;
}

const spectrumCache = new Map<number, ValueSeries<typeof spectrumSchema>>();

/**
 * One hourly wave-energy spectrum as a `ValueSeries` **keyed by frequency**.
 *
 * This data was never time-keyed: the buoy reports 47 (frequency, energy
 * density) pairs, and the frequency is the row's identity. So it takes the
 * direct door — `ValueSeries.fromColumns`, no `time` column laundered in and
 * no `byValue` projection.
 */
export function waveSpectrum(
  frame: number,
): ValueSeries<typeof spectrumSchema> {
  const i = Math.min(Math.max(Math.trunc(frame), 0), WAVE_FRAME_COUNT - 1);
  const hit = spectrumCache.get(i);
  if (hit) return hit;
  const series = ValueSeries.fromColumns({
    name: `spectrum-${i}`,
    schema: spectrumSchema,
    // Copied rather than passed through: `fromColumns` adopts a `Float64Array`
    // zero-copy, and these module constants are shared by every frame.
    columns: {
      frequency: [...WAVE_FREQUENCIES],
      density: [...WAVE_SPECTRA[i]!],
    },
  });
  spectrumCache.set(i, series);
  return series;
}

/** The frame with the most total energy — the storm's peak, and the frame a
 *  still card should hold. Computed, not guessed. */
export const WAVE_PEAK_FRAME = (() => {
  let best = 0;
  let bestEnergy = -1;
  WAVE_SPECTRA.forEach((frame, i) => {
    const energy = frame.reduce<number>((sum, v) => sum + (v ?? 0), 0);
    if (energy > bestEnergy) {
      bestEnergy = energy;
      best = i;
    }
  });
  return best;
})();

/** The largest energy density in any frame — the fixed y domain that keeps the
 *  axis from rescaling under the autoplay sweep. */
export const WAVE_PEAK_DENSITY = WAVE_SPECTRA.reduce(
  (max, frame) => frame.reduce<number>((m, v) => Math.max(m, v ?? 0), max),
  0,
);

/** Frequency extent of the fixture, Hz — the spectrum's x domain. */
export const WAVE_FREQUENCY_RANGE: readonly [number, number] = [
  WAVE_FREQUENCIES[0]!,
  WAVE_FREQUENCIES[WAVE_FREQUENCIES.length - 1]!,
];

// ---------------------------------------------------------------------------
// F2 — the seismogram: 12,800 samples at 40 Hz
// ---------------------------------------------------------------------------

const seismicSchema = [
  { name: 'time', kind: 'time' },
  { name: 'velocity', kind: 'number' },
] as const;

let seismicMemo: TimeSeries<typeof seismicSchema> | null = null;

/**
 * The full-rate vertical ground-velocity trace, µm/s.
 *
 * Built through `TimeSeries.fromColumns` from typed arrays rather than row
 * tuples — 12,800 rows is where the columnar door starts to matter, and the
 * time column is pure arithmetic (a fixed 40 Hz), not a stored channel.
 */
export function seismogram(): TimeSeries<typeof seismicSchema> {
  if (seismicMemo) return seismicMemo;
  const n = SEISMIC_VELOCITY.length;
  const time = new Float64Array(n);
  const step = 1000 / SEISMIC_RATE_HZ;
  for (let i = 0; i < n; i += 1) time[i] = SEISMIC_START_MS + i * step;
  seismicMemo = TimeSeries.fromColumns({
    name: 'IU.ANMO.00.BHZ',
    schema: seismicSchema,
    columns: { time, velocity: Float64Array.from(SEISMIC_VELOCITY) },
  });
  return seismicMemo;
}

/** How many samples the trace carries — quoted on the page, never estimated. */
export const SEISMIC_SAMPLE_COUNT = SEISMIC_VELOCITY.length;

/** `[begin, end]` of the trace, epoch ms. */
export const SEISMIC_RANGE: readonly [number, number] = [
  SEISMIC_START_MS,
  SEISMIC_START_MS + ((SEISMIC_VELOCITY.length - 1) * 1000) / SEISMIC_RATE_HZ,
];

/** Origin time of the M7.1 Ridgecrest earthquake, 2019-07-06 03:19:53 UTC —
 *  the reference every arrival time on the page is measured from. */
export const RIDGECREST_ORIGIN_MS = Date.UTC(2019, 6, 6, 3, 19, 53);

/**
 * Where the P and S waves arrive, found the way a seismologist would: the
 * first sample at which a short-term RMS average runs `ratio`× above the
 * long-term one (the classic STA/LTA detector). Computed from the trace so the
 * page's arrival times can't drift away from the data.
 */
export function staLtaArrival(
  from: number,
  staSeconds = 1,
  ltaSeconds = 20,
  ratio = 6,
): number | null {
  const sta = Math.round(staSeconds * SEISMIC_RATE_HZ);
  const lta = Math.round(ltaSeconds * SEISMIC_RATE_HZ);
  const v = SEISMIC_VELOCITY;
  const power = (at: number, n: number) => {
    let sum = 0;
    for (let i = at - n; i < at; i += 1) sum += v[i]! * v[i]!;
    return sum / n;
  };
  for (let i = Math.max(from, lta); i < v.length; i += 1) {
    const long = power(i, lta);
    if (long > 0 && power(i, sta) / long >= ratio * ratio) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// F3 — the tide record: observed vs predicted, plus the hi/lo extremes
// ---------------------------------------------------------------------------

const tideSchema = [
  { name: 'time', kind: 'time' },
  { name: 'observed', kind: 'number' },
  { name: 'predicted', kind: 'number' },
] as const;

let tideMemo: TimeSeries<typeof tideSchema> | null = null;

/** Six-minute water level at Seattle: what happened, and what the harmonic
 *  prediction said would happen. Metres above MLLW. */
export function tideRecord(): TimeSeries<typeof tideSchema> {
  if (tideMemo) return tideMemo;
  const n = TIDE_OBSERVED.length;
  const time = new Float64Array(n);
  for (let i = 0; i < n; i += 1) time[i] = TIDE_START_MS + i * TIDE_STEP_MS;
  tideMemo = TimeSeries.fromColumns({
    name: 'seattle-9447130',
    schema: tideSchema,
    columns: {
      time,
      observed: Float64Array.from(TIDE_OBSERVED, (v) => v ?? NaN),
      predicted: Float64Array.from(TIDE_PREDICTED, (v) => v ?? NaN),
    },
  });
  return tideMemo;
}

const extremeSchema = [
  { name: 'time', kind: 'time' },
  { name: 'level', kind: 'number' },
] as const;

let highsMemo: TimeSeries<typeof extremeSchema> | null = null;
let lowsMemo: TimeSeries<typeof extremeSchema> | null = null;

/** The predicted high (or low) waters as their own tiny series, so a
 *  `<ScatterChart>` can dot them onto the prediction curve. Highs and lows are
 *  separate series because they read as two different things. */
export function tideExtremes(
  kind: 'H' | 'L',
): TimeSeries<typeof extremeSchema> {
  const memo = kind === 'H' ? highsMemo : lowsMemo;
  if (memo) return memo;
  const rows = TIDE_EXTREMES.filter((e) => e[2] === kind).map(
    (e) => [e[0], e[1]] as [number, number],
  );
  const series = new TimeSeries({
    name: kind === 'H' ? 'high-waters' : 'low-waters',
    schema: extremeSchema,
    rows,
  });
  if (kind === 'H') highsMemo = series;
  else lowsMemo = series;
  return series;
}

/** `[begin, end]` of the tide record, epoch ms. */
export const TIDE_RANGE: readonly [number, number] = [
  TIDE_START_MS,
  TIDE_START_MS + (TIDE_OBSERVED.length - 1) * TIDE_STEP_MS,
];

/** The highest observed water level in the record, and when it happened —
 *  computed from the fixture so the prose can't drift from the data. */
export const TIDE_RECORD_HIGH = (() => {
  let value = -Infinity;
  let index = 0;
  TIDE_OBSERVED.forEach((v, i) => {
    if (v !== null && v > value) {
      value = v;
      index = i;
    }
  });
  return { value, at: TIDE_START_MS + index * TIDE_STEP_MS };
})();

/** The largest gap between observed and predicted water level — the storm
 *  surge, in metres, and when it peaked. */
export const TIDE_PEAK_SURGE = (() => {
  let value = -Infinity;
  let index = 0;
  TIDE_OBSERVED.forEach((o, i) => {
    const p = TIDE_PREDICTED[i];
    if (o === null || p === null || p === undefined) return;
    if (o - p > value) {
      value = o - p;
      index = i;
    }
  });
  return { value, at: TIDE_START_MS + index * TIDE_STEP_MS };
})();

// ---------------------------------------------------------------------------
// F4 — the air-quality trace, and the AQI category boundaries
// ---------------------------------------------------------------------------

const airSchema = [
  { name: 'time', kind: 'time' },
  { name: 'pm25', kind: 'number' },
] as const;

let airMemo: TimeSeries<typeof airSchema> | null = null;

/** Hourly PM2.5 at the Bronx monitor, µg/m³, gaps intact. */
export function airQuality(): TimeSeries<typeof airSchema> {
  if (airMemo) return airMemo;
  const n = AIR_PM25.length;
  const time = new Float64Array(n);
  for (let i = 0; i < n; i += 1) time[i] = AIR_START_MS + i * AIR_STEP_MS;
  airMemo = TimeSeries.fromColumns({
    name: 'bronx-pm25',
    schema: airSchema,
    columns: { time, pm25: Float64Array.from(AIR_PM25, (v) => v ?? NaN) },
  });
  return airMemo;
}

/**
 * The **upper bound of each US AQI category** for PM2.5, µg/m³, as revised by
 * EPA in the 2024 reconsideration of the annual standard (40 CFR 58 App. G,
 * Table 2). These are the *24-hour-average* breakpoints: AirNow reports an
 * hourly AQI from a NowCast weighted average rather than a bare hourly
 * concentration, so drawing them against hourly data reads them as **reference
 * lines, not as an AQI calculation** — which is exactly what a threshold band
 * on a chart is for.
 */
export const AQI_THRESHOLDS: ReadonlyArray<{ label: string; pm25: number }> = [
  { label: 'Good', pm25: 9 },
  { label: 'Moderate', pm25: 35.4 },
  { label: 'Unhealthy — sensitive groups', pm25: 55.4 },
  { label: 'Unhealthy', pm25: 125.4 },
  { label: 'Very unhealthy', pm25: 225.4 },
];

/** Theme-role name per AQI category, in {@link AQI_THRESHOLDS} order, plus the
 *  open-ended top category the threshold list has no upper bound for. */
const AQI_ROLES = [
  'good',
  'moderate',
  'sensitive',
  'unhealthy',
  'veryUnhealthy',
  'hazardous',
] as const;

/**
 * The same categories as **bands** rather than boundaries — `[from, to)` pairs
 * derived from {@link AQI_THRESHOLDS}, so the breakpoints stay single-source
 * and this can't drift from them.
 *
 * A category is the span between one upper bound and the next; the first runs
 * up from 0 and the last (Hazardous) is genuinely **open-ended**, which is why
 * its `to` is `Infinity` rather than an invented ceiling — `<Zone>` resolves
 * that against the axis domain and clamps to the plot edge.
 */
export const AQI_BANDS: ReadonlyArray<{
  label: string;
  role: string;
  from: number;
  to: number;
}> = AQI_ROLES.map((role, i) => ({
  role,
  label: AQI_THRESHOLDS[i]?.label ?? 'Hazardous',
  from: i === 0 ? 0 : AQI_THRESHOLDS[i - 1]!.pm25,
  to: AQI_THRESHOLDS[i]?.pm25 ?? Infinity,
}));

/**
 * The EPA's category **colours** for {@link AQI_BANDS}, layered onto whatever
 * base theme the page is using.
 *
 * `<Zone role="good">` says *which category*; the theme says what a category
 * looks like. It lives beside the breakpoints because the two are halves of
 * one scale. The official hues are designed for filled status badges, so they
 * ride at a low `fillOpacity` — a wash the trace reads through rather than a
 * block of colour competing with it, and not uniform because the hues aren't
 * equally strong (pure yellow needs more alpha than red to register at all).
 */
export function aqiBandTheme(base: ChartTheme): ChartTheme {
  return {
    ...base,
    annotation: {
      ...(base.annotation ?? {
        color: '#14b8a6',
        fillOpacity: 0.1,
        depth: [1, 0.7, 0.4],
      }),
      roles: {
        good: { color: '#00e400', fillOpacity: 0.16 },
        moderate: { color: '#ffff00', fillOpacity: 0.22 },
        sensitive: { color: '#ff7e00', fillOpacity: 0.14 },
        unhealthy: { color: '#ff0000', fillOpacity: 0.12 },
        veryUnhealthy: { color: '#8f3f97', fillOpacity: 0.12 },
        hazardous: { color: '#7e0023', fillOpacity: 0.12 },
      },
    },
  };
}

/** `[begin, end]` of the air-quality record, epoch ms. */
export const AIR_RANGE: readonly [number, number] = [
  AIR_START_MS,
  AIR_START_MS + (AIR_PM25.length - 1) * AIR_STEP_MS,
];

/** The worst hour in the record, and when — computed, not quoted. */
export const AIR_PEAK = (() => {
  let value = -Infinity;
  let index = 0;
  AIR_PM25.forEach((v, i) => {
    if (v !== null && v > value) {
      value = v;
      index = i;
    }
  });
  return { value, at: AIR_START_MS + index * AIR_STEP_MS };
})();

/** How many hours the monitor didn't report, and where the run starts. */
export const AIR_MISSING = (() => {
  const at: number[] = [];
  AIR_PM25.forEach((v, i) => {
    if (v === null) at.push(AIR_START_MS + i * AIR_STEP_MS);
  });
  return { count: at.length, at };
})();

/** Hours spent at or above each threshold — the number the page quotes. */
export function hoursAbove(pm25: number): number {
  return AIR_PM25.reduce<number>(
    (n, v) => (v !== null && v >= pm25 ? n + 1 : n),
    0,
  );
}

export { HOUR };
