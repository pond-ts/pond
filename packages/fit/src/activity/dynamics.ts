/**
 * Running dynamics as channels (RFC §15.7): `run.dynamics.cadence`.
 *
 * Cadence is normalised to steps per minute. Files and most apps record
 * on-foot cadence per leg (cycles per minute, one per two steps), so a
 * recorded 85 is 170 steps per minute here; `stats().cadence` and
 * `series.cadence` keep the recorded value. A stream that says it holds
 * steps (`cadenceUnit: 'steps'`), or whose median is above 120, isn't
 * doubled.
 *
 * The series keep every sample, standing ones included; `stats()` averages
 * over moving time only, so a series' lowest value can sit below anything
 * the stats show. Step length needs a distance, so a treadmill run with
 * no distance has none.
 *
 * Ground contact time and vertical oscillation are as the device recorded
 * them (Garmin's running dynamics, from a chest strap, pod or the watch).
 * Step length and vertical ratio are worked out, not recorded: step length
 * is speed ÷ steps per second, vertical ratio is vertical oscillation ÷ step
 * length. Each channel says which (`source`).
 */
import { TimeSeries } from 'pond-ts';
import { intervals } from '../intervals.js';
import {
  hasDistance,
  movingBeforeSample,
  type PreparedActivity,
} from '../summary/index.js';
import type { Span } from '../stats/index.js';
import { Distance, Duration, StepRate } from '../quantities.js';
import { Measured, sampleRange, type SeriesChannel } from './series.js';
import { sportOf } from './sport.js';

/** Where a running-dynamics channel came from. */
export type DynamicsSource = 'recorded' | 'derived';

/** One running-dynamics channel and its source. */
export interface DynamicsChannel<Q> {
  series: Measured<Q>;
  source: DynamicsSource;
}

/** The running-dynamics channels a stretch has; a channel the device
 *  didn't record (and can't be worked out) is `null`. */
export interface RunningDynamics {
  /** Steps per minute. `source` is `'recorded'` when the file wrote steps,
   *  `'derived'` when it wrote cycles (one per two steps) and they were
   *  doubled. */
  cadence: DynamicsChannel<StepRate> | null;
  /** Metres per step: speed ÷ steps per second, while moving. */
  stepLength: DynamicsChannel<Distance> | null;
  /** Milliseconds of foot contact per step. */
  groundContactTime: DynamicsChannel<Duration> | null;
  /** Millimetres of bounce per step. */
  verticalOscillation: DynamicsChannel<Distance> | null;
  /** Vertical oscillation ÷ step length, in %. */
  verticalRatio: DynamicsChannel<number> | null;
  /** Time-weighted averages over the stretch's moving time. */
  stats(): RunningDynamicsStats;
}

export interface RunningDynamicsStats {
  cadence: StepRate | null;
  stepLength: Distance | null;
  groundContactTime: Duration | null;
  verticalOscillation: Distance | null;
  /** In %. */
  verticalRatio: number | null;
}

const ON_FOOT = new Set(['run', 'walk', 'hike']);

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
] as const;

function recorded(a: ArrayLike<number> | undefined, n: number) {
  if (!a || a.length !== n) return undefined;
  const out = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const v = a[i];
    out[i] = v != null && Number.isFinite(v) ? v : NaN;
    if (Number.isFinite(out[i]!)) any = true;
  }
  return any ? out : undefined;
}

function anyFinite(a: Float64Array | undefined, lo: number, hi: number) {
  if (!a) return false;
  for (let i = lo; i < hi; i++) if (Number.isFinite(a[i]!)) return true;
  return false;
}

/** The running dynamics of `span`; every channel null off foot or without
 *  timestamps. @internal */
export function dynamicsOf(
  prep: PreparedActivity,
  span: Span,
): RunningDynamics {
  const onFoot = ON_FOOT.has(sportOf(prep.imported.activity.sportType));
  const n = prep.timeRel.length;
  const streams = prep.imported.streams;

  const c = onFoot ? prep.cols.cadence : undefined;
  const steps = c ? recordsSteps(streams.cadenceUnit, c) : false;
  const spm = (() => {
    if (!c) return undefined;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = steps ? c[i]! : c[i]! * 2;
    return out;
  })();
  const gct = onFoot ? recorded(streams.groundContactMs, n) : undefined;
  const vo = onFoot ? recorded(streams.verticalOscillationMm, n) : undefined;
  const step = (() => {
    if (!spm || !hasDistance(prep)) return undefined;
    const out = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n; i++) {
      const s = spm[i]!;
      const v = prep.speed[i]!;
      if (s > 0 && Number.isFinite(v) && movingBeforeSample(prep, i))
        out[i] = (v * 60) / s;
    }
    return out;
  })();
  const ratio = (() => {
    if (!vo || !step) return undefined;
    const out = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const l = step[i]!;
      if (l > 0) out[i] = (vo[i]! / 1000 / l) * 100;
    }
    return out;
  })();

  const [lo, end] = prep.hasTime ? sampleRange(prep, span) : [0, 0];
  const times = prep.timeRel.subarray(lo, end);
  const startMs = Date.parse(prep.imported.activity.startTimeUtc);
  const stretch = () => prep.track.slice(lo, end);
  const make = <Q>(
    channel: SeriesChannel,
    unit: string,
    vals: Float64Array | undefined,
    q: (v: number) => Q,
    source: DynamicsSource,
  ): DynamicsChannel<Q> | null => {
    if (!vals || !times.length || !anyFinite(vals, lo, end)) return null;
    const values = vals.subarray(lo, end);
    const pond = () =>
      stretch().select().withColumn('value', values) as unknown as TimeSeries<
        typeof SCHEMA
      >;
    return {
      series: new Measured(channel, unit, times, values, q, startMs, pond),
      source,
    };
  };

  const cadence = make(
    'cadence',
    'spm',
    spm,
    StepRate.stepsPerMinute,
    steps ? 'recorded' : 'derived',
  );
  const stepLength = make('stepLength', 'm', step, Distance.meters, 'derived');
  const groundContactTime = make(
    'groundContactTime',
    'ms',
    gct,
    (ms) => Duration.seconds(ms / 1000),
    'recorded',
  );
  const verticalOscillation = make(
    'verticalOscillation',
    'mm',
    vo,
    (mm) => Distance.meters(mm / 1000),
    'recorded',
  );
  const verticalRatio = make('verticalRatio', '%', ratio, (v) => v, 'derived');

  let cached: RunningDynamicsStats | undefined;
  return {
    cadence,
    stepLength,
    groundContactTime,
    verticalOscillation,
    verticalRatio,
    stats() {
      if (cached) return cached;
      const avg = (vals: Float64Array | undefined) =>
        movingAverage(prep, lo, end, vals);
      const c = avg(cadence ? spm : undefined);
      const l = avg(stepLength ? step : undefined);
      const g = avg(gct);
      const o = avg(vo);
      const r = avg(ratio);
      return (cached = {
        cadence: c === null ? null : StepRate.stepsPerMinute(c),
        stepLength: l === null ? null : Distance.meters(l),
        groundContactTime: g === null ? null : Duration.seconds(g / 1000),
        verticalOscillation: o === null ? null : Distance.meters(o / 1000),
        verticalRatio: r,
      });
    },
  };
}

/** Whether on-foot cadence was written as steps per minute: as the stream
 *  says, else when its median is above 120 (no one runs 240 steps a minute,
 *  so a median that high can't be cycles). */
function recordsSteps(
  unit: 'cycles' | 'steps' | undefined,
  cadence: Float64Array,
): boolean {
  if (unit) return unit === 'steps';
  const vals = Array.from(cadence).filter((v) => Number.isFinite(v) && v > 0);
  if (!vals.length) return false;
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1]! > 120;
}

/** Time-weighted average of `vals` over the moving samples in [lo, end),
 *  each standing for the time since the sample before (capped at 10 s). */
function movingAverage(
  prep: PreparedActivity,
  lo: number,
  end: number,
  vals: Float64Array | undefined,
): number | null {
  if (!vals || end - lo < 2) return null;
  const dt = intervals(prep.timeRel.subarray(lo, end));
  let sum = 0;
  let w = 0;
  for (let k = 1; k < end - lo; k++) {
    const i = lo + k;
    const v = vals[i]!;
    if (!Number.isFinite(v) || !movingBeforeSample(prep, i)) continue;
    sum += v * dt[k]!;
    w += dt[k]!;
  }
  return w > 0 ? sum / w : null;
}
