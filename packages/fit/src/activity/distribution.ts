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

/** A channel to spread over bins. `'pace'` is seconds per km (per 100 m on
 *  an open-water swim), and always leaves out the time stopped (a stop has no pace).
 *  `'cadence'` is as recorded: rpm on a bike, cycles per minute on foot (one
 *  per two steps, the FIT convention). */
export type DistributionChannel =
  | 'power'
  | 'heartRate'
  | 'cadence'
  | 'speed'
  | 'pace';

export interface DistributionOptions {
  /** Bin width in the channel's unit: W, bpm, rpm, m/s, or s/km (s/100 m on
   *  a swim). Defaults: 25 W, 5 bpm, 5 rpm, 0.5 m/s, 15 s/km (5 s/100 m).
   *  At most 10,000 bins: a narrower width throws. */
  binWidth?: number;
  /** `'elapsed'` (the default): every sample, so a stop counts at 0 W, 0 rpm
   *  and 0 m/s. `'moving'`: only time judged moving, by the same rule as the
   *  moving clock. Pace is always on moving time, and null on a pool swim. */
  time?: 'elapsed' | 'moving';
  /** Pace only: slower paces count in the bin at this pace, so a slow
   *  stretch doesn't spread over hundreds of empty bins. Default 1200 s/km
   *  (20:00 per km), or 300 s/100 m on a swim. */
  slowestPace?: number;
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
  /** `'W'`, `'bpm'`, `'rpm'`, `'m/s'`, `'s/km'` or `'s/100m'`. */
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
  /** Moving time with the pedals still. A sample with no cadence (or power)
   *  reading counts as moving but not as still, as in WKO and Golden
   *  Cheetah's "zero cadence while moving". */
  duration: Duration;
  /** Of the section's moving time, 0 to 1. */
  share: number;
  /** What told the pedals were still: zero cadence, or zero power when no
   *  cadence was recorded. A cadence channel that is all zeros (a device
   *  writing 0 with no sensor paired) counts as not recorded. */
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

const MAX_BINS = 10_000;

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

function hasPositive(a: Float64Array | undefined, lo: number, hi: number) {
  if (!a) return false;
  for (let i = lo; i <= Math.min(hi, a.length - 1); i++)
    if (a[i]! > 0) return true;
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
  const swim = sportOf(prep.imported.activity.sportType) === 'swim';
  const paceMeters = swim ? 100 : 1000;
  const width =
    options.binWidth ??
    (channel === 'pace' && swim ? 5 : DEFAULT_WIDTH[channel]);
  if (!(width > 0) || !Number.isFinite(width))
    throw new RangeError('binWidth must be positive and finite');
  const slowest = options.slowestPace ?? (swim ? 300 : 1200);
  if (!(slowest > 0) || !Number.isFinite(slowest))
    throw new RangeError('slowestPace must be positive and finite');
  const time = channel === 'pace' ? 'moving' : (options.time ?? 'elapsed');
  const raw = channelValues(prep, channel);
  // A pool swim's speed lives in its lengths, not its samples (the watch
  // writes few); its pace spread comes with the per-length swim metrics.
  if (
    (channel === 'speed' || channel === 'pace') &&
    (!hasDistance(prep) || prep.poolLengths)
  )
    return null;
  const w = prep.hasTime ? sectionWindow(prep, span) : null;
  if (!w || !raw || !hasFinite(raw, w.lo, w.hi)) return null;

  const t = prep.timeRel.subarray(w.lo, w.hi + 1);
  const dt = intervals(t);
  // Each row carries its bin's number, worked out here so a fractional width
  // can't put 0.3 in the 0.2 bin (0.3 / 0.1 is 2.999… in floating point);
  // pond's byColumn then sums the time per bin.
  const rows: Array<[number, number | undefined, number]> = [];
  const binOf = (v: number) => Math.floor(v / width + 1e-9);
  let counted = 0;
  for (let k = 1; k < t.length; k++) {
    const i = w.lo + k;
    const moving = movingBeforeSample(prep, i);
    if (time === 'moving' && !moving) continue;
    let v = raw[i]!;
    if (!Number.isFinite(v)) continue;
    if (channel === 'pace') {
      if (!(v > 0)) continue;
      v = Math.min(paceMeters / v, slowest);
    }
    if (FROM_ZERO.has(channel)) v = Math.max(0, v);
    const d = dt[k]!;
    if (!(d > 0)) continue;
    rows.push([t[k]!, binOf(v), d]);
    counted += d;
  }
  if (!rows.length) return null;

  const binned = new TimeSeries({
    name: 'distribution',
    schema: SCHEMA,
    rows,
  }).byColumn(
    'value',
    { width: 1, origin: 0 },
    { seconds: { from: 'dt', using: 'sum' } },
  );
  // byColumn emits the occupied bins, lowest first; fill the gaps between
  const first = FROM_ZERO.has(channel) ? 0 : Math.round(binned[0]!.start);
  const last = Math.round(binned[binned.length - 1]!.start);
  if (last - first + 1 > MAX_BINS)
    throw new RangeError(
      `binWidth ${width} makes ${last - first + 1} bins (at most ${MAX_BINS})`,
    );
  const seconds = new Array<number>(last - first + 1).fill(0);
  for (const b of binned)
    seconds[Math.round(b.start) - first] = (b.seconds as number) ?? 0;
  return {
    channel,
    unit: channel === 'pace' && swim ? 's/100m' : UNIT[channel],
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
  const source = hasPositive(prep.cols.cadence, w.lo, w.hi)
    ? 'cadence'
    : hasPositive(prep.cols.power, w.lo, w.hi)
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
