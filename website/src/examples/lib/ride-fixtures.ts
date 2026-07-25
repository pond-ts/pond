import { TimeSeries } from 'pond-ts';

/**
 * A seeded, deterministic **ride** — the Getting-started worked example's data.
 *
 * One sample per second of a ~40 min structured session: warm-up, three hard
 * efforts with recoveries, a steady climb, then a cool-down. Power is the
 * headline channel (that's what the page analyses); heart rate lags it, and
 * cumulative distance rides along so the value-axis story has something real to
 * key on.
 *
 * Deterministic by construction — a small LCG, never `Math.random()` /
 * `Date.now()` at render (the embed house rule), so the chart is identical on
 * every build and safe to assert against.
 */

export const RIDE_FTP = 250;

export const RIDE_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'watts', kind: 'number' },
  { name: 'hr', kind: 'number' },
  { name: 'cumDist', kind: 'number' },
] as const;

const BASE = Date.UTC(2026, 4, 17, 8, 0, 0);
const DURATION_S = 40 * 60;

/** Deterministic [0,1) noise — a tiny LCG, seeded once. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Target watts at second `t` — the session's structure. */
function targetWatts(t: number): number {
  const min = t / 60;
  if (min < 8) return 120 + 6 * min; // warm-up ramp
  if (min < 11) return 315; // effort 1
  if (min < 14) return 145; // recovery
  if (min < 17) return 330; // effort 2
  if (min < 20) return 145; // recovery
  if (min < 23) return 340; // effort 3
  if (min < 26) return 140; // recovery
  if (min < 35) return 255 + 12 * Math.sin((min - 26) * 0.7); // steady climb
  return 150 - 4 * (min - 35); // cool-down
}

/**
 * The ride as a pond `TimeSeries` — 1 Hz, 40 minutes (2400 rows).
 * Power carries realistic sample-to-sample jitter (a power meter is noisy);
 * heart rate is a lagged, smoothed response to it.
 */
export function ride(): TimeSeries<typeof RIDE_SCHEMA> {
  const rnd = lcg(20260517);
  const rows: Array<[number, number, number, number]> = [];

  let hr = 96;
  let cumDist = 0;

  for (let t = 0; t < DURATION_S; t++) {
    const target = targetWatts(t);
    // Power-meter jitter: ±8% plus a little spikiness.
    const jitter = (rnd() - 0.5) * 0.16 * target + (rnd() - 0.5) * 14;
    const watts = Math.max(0, target + jitter);

    // HR chases power with a long time constant, and drifts up over the ride.
    const hrTarget = 92 + target * 0.29 + (t / DURATION_S) * 12;
    hr += (hrTarget - hr) * 0.02;

    // Speed loosely tracks power; distance accumulates monotonically (m).
    const speed = 5.4 + watts * 0.021; // m/s
    cumDist += speed;

    rows.push([BASE + t * 1000, watts, hr, cumDist]);
  }

  return TimeSeries.fromJSON({ name: 'ride', schema: RIDE_SCHEMA, rows });
}

/** Elapsed seconds of the ride — what `computePower` wants for TSS. */
export const RIDE_ELAPSED_S = DURATION_S;
