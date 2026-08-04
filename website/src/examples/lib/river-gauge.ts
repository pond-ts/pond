import { TimeSeries } from 'pond-ts';

/**
 * A stream gauge — 15-minute discharge, in cubic feet per second, for three
 * weeks of a small upland catchment. The dataset behind the `@pond-ts/charts`
 * landing chart.
 *
 * **Modelled, not measured.** No gauge record is redistributed here; the
 * numbers come out of the standard hydrological decomposition, which is what
 * makes the shape read as real rather than as noise on a sine:
 *
 * - **Baseflow** — the groundwater contribution the channel would carry with
 *   no rain at all, in slow exponential recession (~26-day constant).
 * - **Storm response** — each rain event adds a Nash/SCS unit hydrograph,
 *   `peak · (t/tp)^k · e^(k(1 − t/tp))`: a rise over hours to a peak at `tp`,
 *   then a recession over days. Sharp up, slow down — the asymmetry is the
 *   single most recognisable thing about a hydrograph, and the thing a
 *   symmetric wiggle never gets right.
 * - **Recharge** — every storm also lifts the baseflow it recedes onto, so
 *   flow lands *above* where it started. Successive storms stack.
 * - **A diurnal cycle** — riparian evapotranspiration draws the channel down
 *   in the afternoon and lets it recover overnight. Small (~1.2%) and only
 *   legible at low flow, which is exactly where it's legible in a real record.
 * - **Sensor noise** — ±0.35%. A stage gauge is a precise instrument; most of
 *   the visible texture here is catchment, not measurement error.
 *
 * Deterministic — a seeded PRNG, never `Math.random()` or `Date.now()` — so a
 * live-embedded chart renders identically on the server and the client (no
 * hydration mismatch) and looks the same on every visit.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Gauge reporting interval. Real USGS instantaneous-values data is 15-minute. */
const STEP_MS = 15 * 60_000;
const DAYS = 21;
const SAMPLES = DAYS * 96;

const BASE = Date.UTC(2026, 3, 6, 0, 0, 0);

/** Baseflow at t=0, and its recession constant. */
const BASEFLOW_CFS = 172;
const BASEFLOW_RECESSION = 26 * DAY;

/** A tiny deterministic PRNG (mulberry32) — no external dependency. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Storm {
  /** Days after the record starts. */
  readonly at: number;
  /** Peak discharge contributed, cfs. */
  readonly peak: number;
  /** Hours from onset to peak. */
  readonly tp: number;
  /** Shape factor — higher is flashier (steeper rise, sharper peak). */
  readonly k: number;
}

/**
 * Five events over the three weeks. The pair at days 11.3 and 12.7 is
 * deliberate: a second storm landing on the first one's recession is what
 * produces the double-peaked shape every real spring record has, and it's the
 * case a naive generator never emits.
 */
const STORMS: readonly Storm[] = [
  { at: 3.1, peak: 470, tp: 8, k: 4.0 },
  { at: 5.9, peak: 205, tp: 5.5, k: 5.0 },
  { at: 11.3, peak: 900, tp: 10, k: 3.6 },
  { at: 12.7, peak: 505, tp: 6.5, k: 4.2 },
  { at: 17.5, peak: 330, tp: 7, k: 4.5 },
];

/** Nash/SCS unit hydrograph: zero before onset, peaking at `tp`. */
function stormPulse(
  since: number,
  peak: number,
  tp: number,
  k: number,
): number {
  if (since <= 0) return 0;
  const x = since / tp;
  return peak * Math.pow(x, k) * Math.exp(k * (1 - x));
}

/** The slow lift a storm leaves behind — fills over hours, drains over days. */
function recharge(since: number, peak: number): number {
  if (since <= 0) return 0;
  return (
    0.09 *
    peak *
    (1 - Math.exp(-since / (3 * HOUR))) *
    Math.exp(-since / (8 * DAY))
  );
}

export const GAUGE_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'cfs', kind: 'number' },
] as const;

/**
 * The gauge record — 2,016 samples on a 15-minute grid. Dense enough that the
 * raw trace is a texture rather than a polyline, which is the point: it's a
 * canvas renderer.
 */
export function riverGauge(): TimeSeries<typeof GAUGE_SCHEMA> {
  const rand = mulberry32(0x9e3779b9);
  const rows: { time: number; cfs: number }[] = [];

  for (let i = 0; i < SAMPLES; i++) {
    const time = BASE + i * STEP_MS;
    const elapsed = i * STEP_MS;

    let cfs = BASEFLOW_CFS * Math.exp(-elapsed / BASEFLOW_RECESSION);
    for (const storm of STORMS) {
      const since = elapsed - storm.at * DAY;
      cfs +=
        stormPulse(since, storm.peak, storm.tp * HOUR, storm.k) +
        recharge(since, storm.peak);
    }

    // Evapotranspiration: minimum mid-afternoon, recovering overnight.
    const hour = (time % DAY) / HOUR;
    cfs *= 1 - 0.012 * Math.sin((2 * Math.PI * (hour - 10)) / 24);
    cfs *= 1 + (rand() - 0.5) * 0.007;

    rows.push({ time, cfs: Math.round(cfs * 10) / 10 });
  }

  return TimeSeries.fromJSON({ name: 'gauge', schema: GAUGE_SCHEMA, rows });
}
