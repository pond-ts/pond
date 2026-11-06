/**
 * Measured values over time (RFC §8): `run.series.heartRate`. Each channel is
 * its samples as recorded, on the activity's clock (seconds from its start),
 * with gaps kept as gaps. The way down to pond is explicit:
 * `series.toTimeSeries()`.
 */
import { TimeSeries } from 'pond-ts';
import { hasDistance, type PreparedActivity } from '../summary/index.js';
import type { Span } from '../stats/index.js';
import {
  Cadence,
  Distance,
  Duration,
  Elevation,
  HeartRate,
  Power,
  Speed,
} from '../quantities.js';

/** One sample: when it was taken, and its value (`null` in a gap). */
export interface SeriesPoint<Q> {
  elapsed: Duration;
  value: Q | null;
}

/** Which channel a series holds. */
export type SeriesChannel =
  | 'heartRate'
  | 'power'
  | 'cadence'
  | 'speed'
  | 'elevation'
  | 'distance';

const SERIES_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
] as const;

/** One channel's samples, in order. */
export class Measured<Q> implements Iterable<SeriesPoint<Q>> {
  readonly channel: SeriesChannel;
  /** The unit `values()` and `toTimeSeries()` hold: `'bpm'`, `'W'`, `'rpm'`,
   *  `'m/s'` or `'m'`. */
  readonly unit: string;
  readonly #t: Float64Array;
  readonly #v: Float64Array;
  readonly #make: (v: number) => Q;
  readonly #startMs: number;
  readonly #pond: () => TimeSeries<typeof SERIES_SCHEMA>;

  /** @internal */
  constructor(
    channel: SeriesChannel,
    unit: string,
    t: Float64Array,
    v: Float64Array,
    make: (v: number) => Q,
    startMs: number,
    pond: () => TimeSeries<typeof SERIES_SCHEMA>,
  ) {
    this.channel = channel;
    this.unit = unit;
    this.#t = t;
    this.#v = v;
    this.#make = make;
    this.#startMs = startMs;
    this.#pond = pond;
  }

  get length(): number {
    return this.#t.length;
  }

  /** The sample at `index` (negative counts from the end). */
  at(index: number): SeriesPoint<Q> | undefined {
    const i = index < 0 ? this.#t.length + index : index;
    if (i < 0 || i >= this.#t.length) return undefined;
    const v = this.#v[i]!;
    return {
      elapsed: Duration.seconds(this.#t[i]!),
      value: Number.isFinite(v) ? this.#make(v) : null,
    };
  }

  *[Symbol.iterator](): Iterator<SeriesPoint<Q>> {
    for (let i = 0; i < this.#t.length; i++) yield this.at(i)!;
  }

  /** Seconds from the activity's start, one per sample (a copy). */
  times(): Float64Array {
    return this.#t.slice();
  }

  /** Each sample's instant, in milliseconds since the epoch (a copy). */
  instants(): Float64Array {
    return this.#t.map((sec) => this.#startMs + sec * 1000);
  }

  /** The values in {@link unit}, one per sample, `NaN` in a gap (a copy). */
  values(): Float64Array {
    return this.#v.slice();
  }

  /** As a pond `TimeSeries` with one `value` column (in {@link unit}), keyed
   *  by each sample's instant. A gap is a missing cell. Shares the
   *  activity's own storage: nothing is copied. */
  toTimeSeries(): TimeSeries<typeof SERIES_SCHEMA> {
    return this.#pond();
  }
}

/** The channels a stretch recorded. A channel the activity didn't record is
 *  `null`, and so is every one when its samples have no timestamps. */
export interface ActivitySeries {
  heartRate: Measured<HeartRate> | null;
  power: Measured<Power> | null;
  cadence: Measured<Cadence> | null;
  /** Worked out from distance and time between samples, not recorded. */
  speed: Measured<Speed> | null;
  elevation: Measured<Elevation> | null;
  /** Metres from the start, on the activity's distance axis (a pool swim's
   *  lengths, else GPS or the device's distance). */
  distance: Measured<Distance> | null;
}

function recorded(a: Float64Array | undefined): a is Float64Array {
  if (!a) return false;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]!)) return true;
  return false;
}

/** The samples inside `span` (both ends included), as the index range
 *  `[from, to)` on the activity's samples. @internal */
export function sampleRange(
  prep: PreparedActivity,
  span: Span,
): [number, number] {
  const t = prep.timeRel;
  let lo = 0;
  while (lo < t.length && t[lo]! < span.fromSeconds - 1e-9) lo++;
  let hi = t.length;
  while (hi > lo && t[hi - 1]! > span.toSeconds + 1e-9) hi--;
  return [lo, hi];
}

/** The samples of `prep` inside `span` (both ends included), by channel.
 *  @internal */
export function seriesOf(prep: PreparedActivity, span: Span): ActivitySeries {
  const none: ActivitySeries = {
    heartRate: null,
    power: null,
    cadence: null,
    speed: null,
    elevation: null,
    distance: null,
  };
  if (!prep.hasTime) return none;
  const [lo, end] = sampleRange(prep, span);
  const hi = end - 1;
  const times = prep.timeRel.subarray(lo, end);
  const startMs = Date.parse(prep.imported.activity.startTimeUtc);
  // The stretch of the activity's own pond series: a view, not a copy.
  const stretch = prep.track.slice(lo, hi + 1);
  type TrackChannel = 'hr' | 'power' | 'cadence' | 'ele';
  const make = <Q>(
    channel: SeriesChannel,
    unit: string,
    vals: Float64Array | undefined,
    q: (v: number) => Q,
    column?: TrackChannel,
  ): Measured<Q> | null => {
    if (!recorded(vals) || !times.length) return null;
    const values = vals.subarray(lo, hi + 1);
    // A recorded channel is one of the track's columns; a worked-out one
    // (speed, distance on the activity's axis) is attached to the stretch.
    const pond = () =>
      (column
        ? stretch.select(column).rename({ [column]: 'value' })
        : stretch
            .select()
            .withColumn('value', values)) as unknown as TimeSeries<
        typeof SERIES_SCHEMA
      >;
    return new Measured(channel, unit, times, values, q, startMs, pond);
  };
  const { cols } = prep;
  const hasDist = hasDistance(prep);
  return {
    heartRate: make('heartRate', 'bpm', cols.hr, HeartRate.bpm, 'hr'),
    power: make('power', 'W', cols.power, Power.watts, 'power'),
    cadence: make('cadence', 'rpm', cols.cadence, Cadence.rpm, 'cadence'),
    speed: hasDist
      ? make('speed', 'm/s', prep.speed, Speed.metersPerSecond)
      : null,
    elevation: make('elevation', 'm', cols.ele, Elevation.meters, 'ele'),
    distance: hasDist ? make('distance', 'm', prep.cum, Distance.meters) : null,
  };
}
