/**
 * Time spent at each level of a channel, and coasting time on a ride
 * (RFC §14.1: `a.distribution('power', { binWidth: 25 })`, `a.coasting`).
 *
 * Every sample stands for the time since the one before it, capped at 10 s
 * (a pause counts as at most 10 s), as in every time-weighted number here.
 * The binning runs on pond's `byColumn` over the section's samples.
 */
import { TimeSeries } from 'pond-ts';
import { intervals } from '../intervals.js';
import {
  hasDistance,
  movingBeforeSample,
  type PreparedActivity,
} from '../summary/index.js';
import { sectionWindow, type Span } from '../stats/index.js';
import { Duration } from '../quantities.js';
import { sportOf } from './sport.js';

/** A channel to spread over bins. `'pace'` is seconds per km, and leaves
 *  out the time stopped (a stop has no pace). */
export type DistributionChannel =
  | 'power'
  | 'heartRate'
  | 'cadence'
  | 'speed'
  | 'pace';

export interface DistributionOptions {
  /** Bin width in the channel's unit: W, bpm, rpm, m/s, or s/km. Defaults:
   *  25 W, 5 bpm, 5 rpm, 0.5 m/s, 15 s/km. */
  binWidth?: number;
  /** `'elapsed'` (the default): every sample. `'moving'`: only time judged
   *  moving, by the same rule as the moving clock. */
  time?: 'elapsed' | 'moving';
}

/** One bin: values from `start` up to (not including) `end`. Carries pond's
 *  `start` / `end` edges so the array feeds `@pond-ts/charts` unmapped. */
export interface DistributionBin {
  start: number;
  end: number;
  seconds: number;
}

export interface Distribution {
  channel: DistributionChannel;
  /** `'W'`, `'bpm'`, `'rpm'`, `'m/s'` or `'s/km'`. */
  unit: string;
  binWidth: number;
  time: 'elapsed' | 'moving';
  /** Lowest to highest, every bin in between kept (empty ones at 0 s).
   *  Power and cadence start at 0, so coasting and freewheeling show; the
   *  others start at the lowest bin with time in it. */
  bins: DistributionBin[];
  /** Seconds counted into the bins. */
  seconds: number;
}

/** Time freewheeling on a ride. */
export interface Coasting {
  /** Moving time with the pedals still. */
  duration: Duration;
  /** Of the section's moving time, 0 to 1. */
  share: number;
  /** What told the pedals were still: zero cadence, or zero power when no
   *  cadence was recorded. */
  source: 'cadence' | 'power';
}

const UNIT: Record<DistributionChannel, string> = {
  power: 'W',
  heartRate: 'bpm',
  cadence: 'rpm',
  speed: 'm/s',
  pace: 's/km',
};

const DEFAULT_WIDTH: Record<DistributionChannel, number> = {
  power: 25,
  heartRate: 5,
  cadence: 5,
  speed: 0.5,
  pace: 15,
};

const FROM_ZERO = new Set<DistributionChannel>(['power', 'cadence']);

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
  { name: 'dt', kind: 'number' },
] as const;

function channelValues(
  prep: PreparedActivity,
  channel: DistributionChannel,
): Float64Array | undefined {
  switch (channel) {
    case 'power':
      return prep.cols.power;
    case 'heartRate':
      return prep.cols.hr;
    case 'cadence':
      return prep.cols.cadence;
    case 'speed':
    case 'pace':
      return prep.speed;
  }
}

function hasFinite(a: Float64Array | undefined, lo = 0, hi = Infinity) {
  if (!a) return false;
  for (let i = lo; i <= Math.min(hi, a.length - 1); i++)
    if (Number.isFinite(a[i]!)) return true;
  return false;
}

/** The time at each level of `channel` inside `span`; null when the channel
 *  wasn't recorded there or the samples have no timestamps. @internal */
export function distributionOf(
  prep: PreparedActivity,
  span: Span,
  channel: DistributionChannel,
  options: DistributionOptions = {},
): Distribution | null {
  const width = options.binWidth ?? DEFAULT_WIDTH[channel];
  if (!(width > 0) || !Number.isFinite(width))
    throw new RangeError('binWidth must be positive and finite');
  const time = options.time ?? 'elapsed';
  const raw = channelValues(prep, channel);
  if ((channel === 'speed' || channel === 'pace') && !hasDistance(prep))
    return null;
  const w = prep.hasTime ? sectionWindow(prep, span) : null;
  if (!w || !raw || !hasFinite(raw, w.lo, w.hi)) return null;

  const t = prep.timeRel.subarray(w.lo, w.hi + 1);
  const dt = intervals(t);
  const rows: Array<[number, number | undefined, number]> = [];
  let counted = 0;
  for (let k = 1; k < t.length; k++) {
    const i = w.lo + k;
    const moving = movingBeforeSample(prep, i);
    if (time === 'moving' && !moving) continue;
    let v = raw[i]!;
    if (!Number.isFinite(v)) continue;
    if (channel === 'pace') {
      if (!moving || !(v > 0)) continue;
      v = 1000 / v;
    }
    if (FROM_ZERO.has(channel)) v = Math.max(0, v);
    const d = dt[k]!;
    if (!(d > 0)) continue;
    rows.push([t[k]!, v, d]);
    counted += d;
  }
  if (!rows.length) return null;

  const binned = new TimeSeries({
    name: 'distribution',
    schema: SCHEMA,
    rows,
  }).byColumn(
    'value',
    { width, origin: 0 },
    { seconds: { from: 'dt', using: 'sum' } },
  );
  // byColumn emits the occupied bins, lowest first; fill the gaps between
  const index = (start: number) => Math.round(start / width);
  const first = FROM_ZERO.has(channel) ? 0 : index(binned[0]!.start);
  const last = index(binned[binned.length - 1]!.start);
  const seconds = new Array<number>(last - first + 1).fill(0);
  for (const b of binned)
    seconds[index(b.start) - first] = (b.seconds as number) ?? 0;
  return {
    channel,
    unit: UNIT[channel],
    binWidth: width,
    time,
    bins: seconds.map((s, k) => ({
      start: (first + k) * width,
      end: (first + k + 1) * width,
      seconds: s,
    })),
    seconds: counted,
  };
}

/** Coasting time inside `span`: null for any sport but cycling, or with
 *  neither cadence nor power recorded. @internal */
export function coastingOf(
  prep: PreparedActivity,
  span: Span,
): Coasting | null {
  if (sportOf(prep.imported.activity.sportType) !== 'ride') return null;
  const w = prep.hasTime ? sectionWindow(prep, span) : null;
  if (!w) return null;
  const source = hasFinite(prep.cols.cadence, w.lo, w.hi)
    ? 'cadence'
    : hasFinite(prep.cols.power, w.lo, w.hi)
      ? 'power'
      : null;
  if (!source) return null;
  const pedal = source === 'cadence' ? prep.cols.cadence! : prep.cols.power!;
  const t = prep.timeRel.subarray(w.lo, w.hi + 1);
  const dt = intervals(t);
  let moving = 0;
  let still = 0;
  for (let k = 1; k < t.length; k++) {
    const i = w.lo + k;
    if (!movingBeforeSample(prep, i)) continue;
    const d = dt[k]!;
    moving += d;
    if (pedal[i] === 0) still += d;
  }
  return {
    duration: Duration.seconds(still),
    share: moving > 0 ? still / moving : 0,
    source,
  };
}
