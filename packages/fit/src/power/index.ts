/**
 * Power analytics for a ride with a real power meter — normalized power, the
 * power distribution + FTP zones, the mean-maximal power curve, work, and
 * training load. How each maps onto pond:
 *   - **Normalized power** is a 30 s rolling mean → pond's `rolling` (see
 *     `normalizedPower`).
 *   - **Power distribution / zones** bucket over the *power value* axis (not
 *     time) → pond's `byColumn` over the watts column (see `zones`).
 *   - **The power curve** is a rolling-*mean*-then-*max* swept over MANY window
 *     sizes — pond's `rolling` is single-window, so the sweep is done here. A
 *     multi-window rolling primitive is a candidate pond enhancement.
 */
import { TimeSeries } from 'pond-ts';
import { intervals } from '../intervals.js';
import { zoneDistributionByValue } from '../zones/index.js';
import { powerZonesFrom, type ZoneDef } from '../profile/index.js';

const POWER_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'watts', kind: 'number' },
] as const;

/** Schema for the value-axis power histograms (distribution + zones): the
 *  power value to bin on, plus the per-sample seconds we sum into each bin.
 *  `watts` is optional so a non-finite sample rides as `undefined` and pond's
 *  `byColumn` drops it from binning (matches the old `if (!finite) continue`). */
const POWER_BIN_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'watts', kind: 'number', required: false },
  { name: 'dt', kind: 'number' },
] as const;

const finite = (v: number) => Number.isFinite(v);

/** Mean of the finite samples. */
export function averagePower(watts: Float64Array): number {
  let sum = 0;
  let n = 0;
  for (const w of watts)
    if (finite(w)) {
      sum += w;
      n += 1;
    }
  return n ? sum / n : 0;
}

/** Max finite sample. */
export function maxPower(watts: Float64Array): number {
  let max = 0;
  for (const w of watts) if (finite(w) && w > max) max = w;
  return max;
}

/** Total mechanical work in kilojoules: Σ power·dt / 1000. */
export function totalWorkKj(
  timeSec: Float64Array,
  watts: Float64Array,
): number {
  const dt = intervals(timeSec);
  let j = 0;
  for (let i = 0; i < watts.length; i++)
    if (finite(watts[i]!)) j += watts[i]! * dt[i]!;
  return j / 1000;
}

/**
 * Normalized Power: 30 s rolling mean of power, raised to the 4th, averaged,
 * 4th-rooted. The rolling step is pond-native — we build a time-keyed power
 * series and call `rolling('30s', { watts: 'mean' })`, then read the smoothed
 * column back via `toFloat64Array()`. The 4th-power reduction is array-side.
 */
export function normalizedPower(
  timeSec: Float64Array,
  watts: Float64Array,
): number {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < watts.length; i++) {
    if (finite(watts[i]!))
      rows.push([Math.round(timeSec[i]! * 1000), watts[i]!]);
  }
  if (rows.length === 0) return 0;
  const series = new TimeSeries({ name: 'power', schema: POWER_SCHEMA, rows });
  // pond 0.29 added a `'mean'` alias matching the column API's `.mean()` (the
  // old `'avg'`/`.mean()` split — F-reducer-naming — is resolved).
  const rolled = series.rolling('30s', { watts: 'mean' });
  const smoothed = rolled.column('watts').toFloat64Array();
  let sum = 0;
  let n = 0;
  for (const v of smoothed)
    if (finite(v)) {
      sum += v ** 4;
      n += 1;
    }
  return n ? (sum / n) ** 0.25 : 0;
}

/** Intensity Factor = NP / FTP. */
export function intensityFactor(normalizedPowerW: number, ftp: number): number {
  return ftp > 0 ? normalizedPowerW / ftp : 0;
}

/**
 * Training load (TSS): `duration · NP · IF / (FTP · 3600) · 100`. Pass the
 * activity's elapsed seconds (the convention that matches Strava's number).
 */
export function trainingLoad(
  normalizedPowerW: number,
  ftp: number,
  durationSeconds: number,
): number {
  if (ftp <= 0) return 0;
  const intensity = normalizedPowerW / ftp;
  return (
    ((durationSeconds * normalizedPowerW * intensity) / (ftp * 3600)) * 100
  );
}

/** One bucket of the power histogram. */
export interface PowerBin {
  /** Inclusive lower edge of the bin, watts. */
  wattsFrom: number;
  /** Seconds spent in this bin. */
  seconds: number;
}

/**
 * Time spent in each `binWatts`-wide power bucket — a histogram over the POWER
 * value axis. Pond-native: `byColumn` buckets rows by the watts value and sums
 * each bin's per-sample seconds. We emit bins from 0 up to the highest occupied
 * (the old grid: low-power bins that
 * happen to be empty still appear as 0 s). Sub-zero samples clamp to bin 0.
 */
export function powerDistribution(
  timeSec: Float64Array,
  watts: Float64Array,
  binWatts = 25,
): PowerBin[] {
  const dt = intervals(timeSec);
  const rows: Array<[number, number | undefined, number]> = [];
  for (let i = 0; i < watts.length; i++) {
    const w = watts[i]!;
    rows.push([i, finite(w) ? Math.max(0, w) : undefined, dt[i]!]);
  }
  const bins = new TimeSeries({
    name: 'pdist',
    schema: POWER_BIN_SCHEMA,
    rows,
  }).byColumn(
    'watts',
    { width: binWatts, origin: 0 },
    { seconds: { from: 'dt', using: 'sum' } },
  );
  // byColumn emits lowest→highest OCCUPIED bin; the old grid runs from bin 0, so
  // scatter onto 0..maxBin with empty bins as 0 s.
  const maxBin = bins.length
    ? Math.round(bins[bins.length - 1]!.start / binWatts)
    : -1;
  const seconds = new Array<number>(maxBin + 1).fill(0);
  for (const b of bins)
    seconds[Math.round(b.start / binWatts)] = (b.seconds as number) ?? 0;
  return seconds.map((s, b) => ({ wattsFrom: b * binWatts, seconds: s }));
}

/** One FTP-based training zone. */
export interface PowerZone {
  zone: number;
  label: string;
  minWatts: number;
  /** Upper edge, watts; `Infinity` for the top zone. */
  maxWatts: number;
  seconds: number;
  /** Fraction of total in-zone time [0, 1]. */
  fraction: number;
}

/**
 * Time in each of the 7 Coggan power zones for the given FTP. Like
 * {@link powerDistribution} this is value-axis bucketing — here with
 * FTP-relative edges rather than even bins.
 */
export function zoneDistribution(
  timeSec: Float64Array,
  watts: Float64Array,
  ftp: number,
): PowerZone[] {
  // FTP-relative Coggan zones as a watt-axis ZoneDef, then the shared value-axis
  // engine (the same one HR + pace use — see ../zones). PowerZone keeps its
  // watts-named shape, so the display contract is unchanged.
  const zones = powerZoneDef(ftp);
  return zoneDistributionByValue(watts, intervals(timeSec), zones).map((z) => ({
    zone: z.zone,
    label: z.label,
    minWatts: Math.round(z.lo),
    maxWatts: z.hi === Infinity ? Infinity : Math.round(z.hi),
    seconds: z.seconds,
    fraction: z.fraction,
  }));
}

/** The 7 Coggan power zones as a watt-axis {@link ZoneDef} (FTP-relative).
 *  Delegates to {@link powerZonesFrom} — the scheme's canonical home is the
 *  profile module, alongside the HR + pace zone builders. */
export function powerZoneDef(ftp: number): ZoneDef {
  return powerZonesFrom(ftp);
}

/** A point on the mean-maximal power curve. */
export interface PowerCurvePoint {
  durationSeconds: number;
  /** Best average power sustained over any window of this length, watts. */
  watts: number;
  /** Inclusive sample range of the window that achieved it — for focusing the
   *  chart/map on where the peak happened. The caller maps these to distance /
   *  time via the prepared `cum` / `timeSec`. Absent only if no window qualified. */
  startIndex?: number;
  endIndex?: number;
}

/**
 * A dense, log-spaced set of durations (1 s → `total`, ~`steps` points) so the
 * power curve reads as a smooth line rather than a few segments. Deduped to
 * whole seconds.
 */
export function logDurations(total: number, steps = 140): number[] {
  if (total < 1 || steps < 2) return [1];
  const lnMax = Math.log(total);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < steps; i++) {
    const d = Math.round(Math.exp((lnMax * i) / (steps - 1)));
    if (d > prev) {
      out.push(d);
      prev = d;
    }
  }
  return out;
}

/**
 * The mean-maximal power curve: for each duration, the highest average power
 * sustained over any window of that length. Computed from a cumulative-work
 * prefix sum with a two-pointer scan per duration — O(n) each. This is the
 * sweep pond's single-window `rolling` doesn't do in one call (see friction).
 */
export function powerCurve(
  timeSec: Float64Array,
  watts: Float64Array,
  durations?: number[],
): PowerCurvePoint[] {
  const n = watts.length;
  // cumulative work and time over finite samples (gap-clamped)
  const dt = intervals(timeSec);
  const cumWork = new Float64Array(n + 1);
  const cumTime = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const w = finite(watts[i]!) ? watts[i]! : 0;
    cumWork[i + 1] = cumWork[i]! + w * dt[i]!;
    cumTime[i + 1] = cumTime[i]! + dt[i]!;
  }
  const totalTime = cumTime[n]!;
  const ds = durations ?? logDurations(totalTime);
  const out: PowerCurvePoint[] = [];
  for (const d of ds) {
    if (d > totalTime) break;
    let best = 0;
    let bestLo = -1;
    let bestHi = -1;
    let lo = 0;
    for (let hi = 1; hi <= n; hi++) {
      // shrink to the SMALLEST window ending at hi whose span is still ≥ d
      while (lo + 1 < hi && cumTime[hi]! - cumTime[lo + 1]! >= d) lo++;
      const span = cumTime[hi]! - cumTime[lo]!;
      // only a window that actually lasts ≥ d counts as a d-second effort
      // (no sub-d slack — that would bias short windows upward at gaps)
      if (span >= d) {
        const avg = (cumWork[hi]! - cumWork[lo]!) / span;
        if (avg > best) {
          best = avg;
          bestLo = lo;
          bestHi = hi;
        }
      }
    }
    // mean-maximal power is non-increasing in duration by definition (best over
    // ≥d windows ⊇ best over ≥d' windows for d'>d); clamp to kill the tiny
    // upward blips the discrete window-snapping can produce between close
    // durations. The window still points at THIS duration's own best stretch.
    const prev = out[out.length - 1]?.watts ?? Infinity;
    const point: PowerCurvePoint = {
      durationSeconds: d,
      watts: Math.min(best, prev),
    };
    if (bestLo >= 0) {
      // cumWork[hi]-cumWork[lo] sums samples lo..hi-1 → inclusive [lo, hi-1].
      point.startIndex = bestLo;
      point.endIndex = bestHi - 1;
    }
    out.push(point);
  }
  return out;
}

/** Everything the power view needs, computed from a power-equipped activity. */
export interface PowerSummary {
  averageWatts: number;
  maxWatts: number;
  normalizedWatts: number;
  intensityFactor: number;
  trainingLoad: number;
  totalWorkKj: number;
  ftp: number;
  /** Time per power bucket at the **finest (1 W)** resolution — the canonical
   *  base the UI re-aggregates to wider bins (10/15/25 W). Always 1 W so the
   *  display contract doesn't depend on a compute-time bin choice. */
  distribution: PowerBin[];
  zones: PowerZone[];
  curve: PowerCurvePoint[];
}

/** Compute the full power summary. `elapsedSeconds` drives TSS. */
export function computePower(
  timeSec: Float64Array,
  watts: Float64Array,
  ftp: number,
  elapsedSeconds: number,
): PowerSummary {
  const np = normalizedPower(timeSec, watts);
  return {
    averageWatts: averagePower(watts),
    maxWatts: maxPower(watts),
    normalizedWatts: np,
    intensityFactor: intensityFactor(np, ftp),
    trainingLoad: trainingLoad(np, ftp, elapsedSeconds),
    totalWorkKj: totalWorkKj(timeSec, watts),
    ftp,
    // 1 W base; the UI aggregates to its chosen bin width (see PowerSummary).
    distribution: powerDistribution(timeSec, watts, 1),
    zones: zoneDistribution(timeSec, watts, ftp),
    curve: powerCurve(timeSec, watts),
  };
}

/** Canonical durations (s) for the power best-efforts table: 5 s … 1 h. */
export const BEST_EFFORT_DURATIONS = [
  5, 15, 30, 60, 120, 180, 300, 480, 600, 900, 1200, 1800, 2700, 3600,
];

/** One row of the power best-efforts table. */
export interface PowerEffort {
  durationSeconds: number;
  /** Best average power sustained over any window of this length, watts. */
  watts: number;
  /** Power-to-weight, when a body weight (as of the activity date) is known. */
  wattsPerKg?: number;
  /** Inclusive sample range of the window that achieved it — for focusing the
   *  chart/map on where the effort happened (maps to distance/time via the
   *  prepared `cum` / `timeSec`). Carried through from the {@link powerCurve}
   *  point; absent only if no window qualified. */
  startIndex?: number;
  endIndex?: number;
}

/**
 * Power best efforts: the mean-maximal power at each canonical duration — the
 * {@link powerCurve} sampled at the table's durations — plus W/kg when a body
 * weight is supplied (resolved from the athlete profile as of the activity
 * date). Same cumulative-work two-pointer as the curve; clamped non-increasing.
 */
export function powerBestEfforts(
  timeSec: Float64Array,
  watts: Float64Array,
  opts: { weightKg?: number; durations?: number[] } = {},
): PowerEffort[] {
  const ds = opts.durations ?? BEST_EFFORT_DURATIONS;
  return powerCurve(timeSec, watts, ds).map((p) => {
    const e: PowerEffort = {
      durationSeconds: p.durationSeconds,
      watts: Math.round(p.watts),
    };
    if (opts.weightKg && opts.weightKg > 0)
      e.wattsPerKg = p.watts / opts.weightKg;
    if (p.startIndex != null) e.startIndex = p.startIndex;
    if (p.endIndex != null) e.endIndex = p.endIndex;
    return e;
  });
}
