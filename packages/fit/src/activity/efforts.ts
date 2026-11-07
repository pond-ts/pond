/**
 * Efforts and the recovery after each (RFC §14.2, §15.3, §16.3):
 * `run.analyze().efforts.fromLaps()`,
 * `ride.analyze().efforts.detect({ powerAbove: 300 })`, then `.compare()`.
 *
 * The model is effort plus recovery: each effort is an ordinary section, with
 * the stretch after it (up to the next effort) as its recovery, and the
 * warm-up before the first effort and the cool-down after the last kept
 * apart. Every set of efforts says where it came from (`source`).
 */
import type { PreparedActivity } from '../summary/index.js';
import { movingBeforeSample } from '../summary/index.js';
import { intervals } from '../intervals.js';
import { sectionWindow, type Span } from '../stats/index.js';
import { Duration } from '../quantities.js';
import type { ImportedActivity, Lap } from '../types.js';
import type { Stats } from './stats.js';
import { sportOf } from './sport.js';

/** A section, as efforts see it (a `Section`, typed loosely to keep the
 *  modules apart). */
export interface EffortSectionLike extends Span {
  readonly label: string;
  stats(options?: { time?: 'elapsed' | 'moving' }): Stats;
}

/** Where a set of efforts came from.
 *  - `'lap-intensity'`: the laps the device marked as work and rest (a
 *    structured workout).
 *  - `'lap-output'`: recorded laps, split into faster and slower by their
 *    average output, when the device marked none.
 *  - `'pool-laps'`: a pool swim's laps; one with distance is an effort, one
 *    with none the rest after it.
 *  - `'threshold'`: stretches above a power or speed threshold. */
export type EffortSource =
  | 'lap-intensity'
  | 'lap-output'
  | 'pool-laps'
  | 'threshold';

export interface Effort<S> {
  /** From 1. */
  number: number;
  section: S;
  /** From the end of this effort to the start of the next (or, after the
   *  last, to the cool-down); null when there is no gap. */
  recoveryAfter: S | null;
}

export interface DetectOptions {
  /** Watts. One of `powerAbove` or `speedAbove`. */
  powerAbove?: number;
  /** Metres per second. */
  speedAbove?: number;
  /** Shorter stretches are dropped. Default 30 s. */
  minimumDuration?: Duration;
  /** Dips below the threshold shorter than this don't end an effort.
   *  Default 5 s. */
  mergeGapsUnder?: Duration;
}

/** What {@link Efforts} reads from a section. @internal */
export interface EffortsSource<S> {
  prep: PreparedActivity;
  span: Span;
  make: (span: Span, label: string) => S;
}

/** Each recorded lap with its span, seconds from the activity's start: from
 *  its start time when it has one, else following on from the lap before.
 *  @internal */
export function lapSpans(record: ImportedActivity): { span: Span; lap: Lap }[] {
  const startMs = Date.parse(record.activity.startTimeUtc);
  let cursor = 0;
  return (record.laps ?? []).map((lap) => {
    const t = lap.startTimeUtc ? Date.parse(lap.startTimeUtc) : NaN;
    const from = Number.isFinite(t) ? (t - startMs) / 1000 : cursor;
    const to = from + lap.elapsedSeconds;
    cursor = to;
    return { span: { fromSeconds: from, toSeconds: to }, lap };
  });
}

/** The ways to find efforts in a section. */
export class EffortFinder<S extends EffortSectionLike> {
  readonly #src: EffortsSource<S>;

  /** @internal */
  constructor(src: EffortsSource<S>) {
    this.#src = src;
  }

  /** Efforts from the recorded laps: the device's own work/rest marks when
   *  it made any; on a pool swim, laps with distance; else laps whose
   *  average power (rides with power) or speed is nearer the fastest lap's
   *  than the slowest's. That last split keeps the longest stretch of laps
   *  that take turns (effort, recovery, …, effort), as an interval session
   *  does, with the laps before it as the warm-up and after it as the
   *  cool-down; a steady run over hills has no such stretch and comes back
   *  empty. Also empty with fewer than two efforts, or laps too alike to
   *  split (fastest under 15 % above slowest). */
  fromLaps(): Efforts<S> {
    const src = this.#src;
    // the laps whose middle is inside the section
    const laps = lapSpans(src.prep.imported).filter(({ span }) => {
      const mid = (span.fromSeconds + span.toSeconds) / 2;
      return mid >= src.span.fromSeconds && mid < src.span.toSeconds;
    });
    const marked = laps.some(
      ({ lap }) => lap.intensity && lap.intensity !== 'active',
    );
    const pool = !!src.prep.poolLengths;
    let source: EffortSource;
    let isWork: (i: number) => boolean | null; // null: warm-up / cool-down
    if (pool) {
      source = 'pool-laps';
      isWork = (i) => laps[i]!.lap.distanceMeters > 0;
    } else if (marked) {
      source = 'lap-intensity';
      isWork = (i) => {
        const k = laps[i]!.lap.intensity;
        if (k === 'warmup' || k === 'cooldown') return null;
        return k === 'active' || k === 'interval';
      };
    } else {
      source = 'lap-output';
      const out = laps.map(({ lap, span }) => lapOutput(src.prep, lap, span));
      const known = out.filter((v): v is number => v !== null);
      if (laps.length < 2 || known.length < 2)
        return new Efforts<S>(source, [], null, null);
      const lo = Math.min(...known);
      const hi = Math.max(...known);
      if (!(lo > 0) || hi / lo < 1.15)
        return new Efforts<S>(source, [], null, null);
      const mid = (lo + hi) / 2;
      isWork = (i) => (out[i] ?? -Infinity) > mid;
    }
    let kinds = laps.map((_, i) => isWork(i));
    // Split by output alone, a steady run over hills would turn its climbs
    // into "recoveries". An interval session alternates, so the efforts are
    // the longest stretch of laps taking turns (effort, recovery, …,
    // effort) with at least two efforts; laps before it are the warm-up and
    // laps after it the cool-down.
    if (source === 'lap-output') {
      const run = longestAlternation(kinds);
      if (!run) return new Efforts<S>(source, [], null, null);
      // the slower lap right after the last effort is its recovery, unless
      // it's far longer than the recoveries before it (a cool-down jog)
      const length = (i: number) =>
        laps[i]!.span.toSeconds - laps[i]!.span.fromSeconds;
      const rests: number[] = [];
      for (let i = run[0] + 1; i < run[1]; i += 2) rests.push(length(i));
      rests.sort((x, y) => x - y);
      const typicalRest = rests[rests.length >> 1]!;
      const after = run[1] + 1;
      const end =
        kinds[after] === false && length(after) <= 2 * typicalRest
          ? after
          : run[1];
      kinds = kinds.map((k, i) => (i < run[0] || i > end ? null : k));
    }
    const work: Span[] = [];
    kinds.forEach((k, i) => {
      if (k) work.push(laps[i]!.span);
    });
    // warm-up: everything before the first effort, whether marked or not;
    // cool-down: from the first lap after the last effort that is marked as
    // cool-down (or left outside the efforts); an unmarked tail is the last
    // effort's recovery
    const first = kinds.indexOf(true);
    const last = kinds.lastIndexOf(true);
    const coolFrom =
      last >= 0 && kinds.slice(last + 1).some((k) => k === null)
        ? laps[last + 1 + kinds.slice(last + 1).indexOf(null)]!.span.fromSeconds
        : null;
    return this.#build(source, work, {
      warmUpTo: first > 0 ? laps[first]!.span.fromSeconds : null,
      coolDownFrom: coolFrom,
    });
  }

  /** Efforts as stretches above a power or speed threshold, sample by
   *  sample. */
  detect(options: DetectOptions): Efforts<S> {
    const { powerAbove, speedAbove } = options;
    if ((powerAbove === undefined) === (speedAbove === undefined))
      throw new RangeError('give one of powerAbove or speedAbove');
    const threshold = (powerAbove ?? speedAbove)!;
    if (!Number.isFinite(threshold))
      throw new RangeError('the threshold must be finite');
    const minimum = options.minimumDuration?.seconds ?? 30;
    const merge = options.mergeGapsUnder?.seconds ?? 5;
    const src = this.#src;
    const { prep } = src;
    const vals = powerAbove !== undefined ? prep.cols.power : prep.speed;
    const w = prep.hasTime ? sectionWindow(prep, src.span) : null;
    if (!w || !vals) return new Efforts<S>('threshold', [], null, null);
    const t = prep.timeRel;
    // stretches of samples above the threshold; a sample stands for the
    // time since the one before it
    const raw: Span[] = [];
    let open: number | null = null;
    for (let i = Math.max(w.lo, 1); i <= w.hi; i++) {
      const v = vals[i]!;
      const above =
        Number.isFinite(v) &&
        v > threshold &&
        (powerAbove !== undefined || movingBeforeSample(prep, i));
      if (above && open === null) open = t[i - 1]!;
      if (!above && open !== null) {
        raw.push({ fromSeconds: open, toSeconds: t[i - 1]! });
        open = null;
      }
    }
    if (open !== null) raw.push({ fromSeconds: open, toSeconds: t[w.hi]! });
    const merged: Span[] = [];
    for (const s of raw) {
      const prev = merged[merged.length - 1];
      if (prev && s.fromSeconds - prev.toSeconds < merge)
        merged[merged.length - 1] = {
          fromSeconds: prev.fromSeconds,
          toSeconds: s.toSeconds,
        };
      else merged.push(s);
    }
    const work = merged
      .map((s) => ({
        fromSeconds: Math.max(s.fromSeconds, src.span.fromSeconds),
        toSeconds: Math.min(s.toSeconds, src.span.toSeconds),
      }))
      .filter((s) => s.toSeconds - s.fromSeconds >= minimum);
    return this.#build('threshold', work, {
      warmUpTo: work.length ? work[0]!.fromSeconds : null,
      coolDownFrom: null,
    });
  }

  #build(
    source: EffortSource,
    work: Span[],
    ends: { warmUpTo: number | null; coolDownFrom: number | null },
  ): Efforts<S> {
    const src = this.#src;
    const { fromSeconds: from, toSeconds: to } = src.span;
    const end = ends.coolDownFrom ?? to;
    const efforts = work.map((span, i) => {
      const nextStart = work[i + 1]?.fromSeconds ?? end;
      return {
        number: i + 1,
        section: src.make(span, `Effort ${i + 1}`),
        recoveryAfter:
          nextStart > span.toSeconds + 1e-9
            ? src.make(
                { fromSeconds: span.toSeconds, toSeconds: nextStart },
                `Recovery ${i + 1}`,
              )
            : null,
      };
    });
    const warmUp =
      ends.warmUpTo !== null && ends.warmUpTo > from + 1e-9
        ? src.make({ fromSeconds: from, toSeconds: ends.warmUpTo }, 'Warm-up')
        : null;
    const coolDown =
      ends.coolDownFrom !== null && to > ends.coolDownFrom + 1e-9
        ? src.make(
            { fromSeconds: ends.coolDownFrom, toSeconds: to },
            'Cool-down',
          )
        : null;
    const swim = sportOf(src.prep.imported.activity.sportType) === 'swim';
    return new Efforts(source, efforts, warmUp, coolDown, swim);
  }
}

/** The longest run of laps [from, to] that starts and ends with an effort
 *  and alternates in between, with at least two efforts; null if none. */
function longestAlternation(
  kinds: (boolean | null)[],
): [number, number] | null {
  let best: [number, number] | null = null;
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] !== true) continue;
    let j = i;
    while (j + 2 < kinds.length && kinds[j + 1] === false && kinds[j + 2])
      j += 2;
    if (j > i && (!best || j - i > best[1] - best[0])) best = [i, j];
  }
  return best;
}

/** A lap's average output for splitting laps: power on a ride with power,
 *  else moving speed (distance over moving time). */
function lapOutput(
  prep: PreparedActivity,
  lap: Lap,
  span: Span,
): number | null {
  const ride = sportOf(prep.imported.activity.sportType) === 'ride';
  if (ride && lap.avgWatts !== undefined && Number.isFinite(lap.avgWatts))
    return lap.avgWatts;
  if (lap.avgSpeedMps !== undefined && Number.isFinite(lap.avgSpeedMps))
    return lap.avgSpeedMps;
  // no lap average: work it out from the samples
  const w = prep.hasTime ? sectionWindow(prep, span) : null;
  if (!w) return null;
  const dt = intervals(prep.timeRel.subarray(w.lo, w.hi + 1));
  let secs = 0;
  for (let k = 1; k <= w.hi - w.lo; k++)
    if (movingBeforeSample(prep, w.lo + k)) secs += dt[k]!;
  const meters = prep.cum[w.hi]! - prep.cum[w.lo]!;
  return secs > 0 && Number.isFinite(meters) ? meters / secs : null;
}

/** A metric to compare efforts on. */
export type EffortMetric =
  | 'duration'
  | 'distance'
  | 'pace'
  | 'power'
  | 'heartRate'
  | 'cadence';

/** One metric across the efforts. */
export interface MetricComparison {
  metric: EffortMetric;
  /** `'s'`, `'m'`, `'s/km'` (`'s/100m'` on a swim), `'W'`, `'bpm'` or
   *  `'rpm'`. */
  unit: string;
  /** Each effort's value in {@link unit}, in effort order; null where it
   *  has none. */
  values: (number | null)[];
  /** The effort with the best value (shortest time or pace, most power),
   *  by number; for heart rate and cadence, the highest. */
  best: { number: number; value: number } | null;
  worst: { number: number; value: number } | null;
  /** The median. */
  typical: number | null;
  /** Coefficient of variation (standard deviation ÷ mean), 0 to 1. */
  spread: number | null;
  /** (last − first) ÷ first, as a fraction. */
  firstToLast: number | null;
}

export interface EffortComparison {
  count: number;
  metrics: MetricComparison[];
  /** Each recovery's length in seconds, in effort order (null with none). */
  recoveries: (number | null)[];
}

const LOWER_IS_BETTER = new Set<EffortMetric>(['duration', 'pace']);

/** Efforts found in a section, with the warm-up and cool-down apart. */
export class Efforts<S extends EffortSectionLike> implements Iterable<
  Effort<S>
> {
  readonly source: EffortSource;
  readonly warmUp: S | null;
  readonly coolDown: S | null;
  readonly #items: readonly Effort<S>[];
  readonly #swim: boolean;

  /** @internal */
  constructor(
    source: EffortSource,
    items: readonly Effort<S>[],
    warmUp: S | null,
    coolDown: S | null,
    swim = false,
  ) {
    this.source = source;
    this.#swim = swim;
    this.#items = items;
    this.warmUp = warmUp;
    this.coolDown = coolDown;
  }

  get length(): number {
    return this.#items.length;
  }

  at(index: number): Effort<S> | undefined {
    return this.#items[index < 0 ? this.#items.length + index : index];
  }

  toArray(): Effort<S>[] {
    return [...this.#items];
  }

  [Symbol.iterator](): Iterator<Effort<S>> {
    return this.#items[Symbol.iterator]();
  }

  /** Each effort side by side. Numbers are on moving time (a pause inside an
   *  effort doesn't count against it), except duration, which is elapsed. */
  compare(
    metrics: readonly EffortMetric[] = [
      'duration',
      'distance',
      'pace',
      'power',
      'heartRate',
      'cadence',
    ],
  ): EffortComparison {
    const swim = this.#swim;
    const stats = this.#items.map((e) => ({
      elapsed: e.section.stats(),
      moving: e.section.stats({ time: 'moving' }),
    }));
    const valueOf = (
      m: EffortMetric,
      s: { elapsed: Stats; moving: Stats },
    ): number | null => {
      switch (m) {
        case 'duration':
          return s.elapsed.time.elapsed?.seconds ?? null;
        case 'distance':
          return s.elapsed.distance?.meters ?? null;
        case 'pace': {
          const perKm = s.moving.pace.average?.secondsPerKm;
          return perKm === undefined ? null : swim ? perKm / 10 : perKm;
        }
        case 'power':
          return s.moving.power.average?.watts ?? null;
        case 'heartRate':
          return s.moving.heartRate.average?.bpm ?? null;
        case 'cadence':
          return s.moving.cadence.average?.rpm ?? null;
      }
    };
    return {
      count: this.#items.length,
      metrics: metrics.map((m) =>
        compareOne(
          m,
          m === 'pace' && swim ? 's/100m' : UNITS[m],
          stats.map((s) => valueOf(m, s)),
        ),
      ),
      recoveries: this.#items.map((e) =>
        e.recoveryAfter
          ? e.recoveryAfter.toSeconds - e.recoveryAfter.fromSeconds
          : null,
      ),
    };
  }
}

const UNITS: Record<EffortMetric, string> = {
  duration: 's',
  distance: 'm',
  pace: 's/km',
  power: 'W',
  heartRate: 'bpm',
  cadence: 'rpm',
};

function compareOne(
  metric: EffortMetric,
  unit: string,
  values: (number | null)[],
): MetricComparison {
  const known = values
    .map((v, i) => ({ number: i + 1, value: v }))
    .filter(
      (x): x is { number: number; value: number } =>
        x.value !== null && Number.isFinite(x.value),
    );
  if (!known.length)
    return {
      metric,
      unit,
      values,
      best: null,
      worst: null,
      typical: null,
      spread: null,
      firstToLast: null,
    };
  const lowerBetter = LOWER_IS_BETTER.has(metric);
  const sorted = [...known].sort((a, b) => a.value - b.value);
  const best = lowerBetter ? sorted[0]! : sorted[sorted.length - 1]!;
  const worst = lowerBetter ? sorted[sorted.length - 1]! : sorted[0]!;
  const vs = sorted.map((x) => x.value);
  const mid = vs.length >> 1;
  const typical = vs.length % 2 ? vs[mid]! : (vs[mid - 1]! + vs[mid]!) / 2;
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length);
  const first = known[0]!.value;
  const last = known[known.length - 1]!.value;
  return {
    metric,
    unit,
    values,
    best,
    worst,
    typical,
    spread: mean !== 0 ? sd / Math.abs(mean) : null,
    firstToLast:
      known.length > 1 && first !== 0 ? (last - first) / first : null,
  };
}
