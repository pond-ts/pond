/**
 * The object model: an {@link Activity} records what happened, a
 * {@link Section} is any continuous stretch of it, and {@link Sections}
 * collects stretches (laps, splits, a group of laps). Every one of them
 * answers the same {@link Stats} contract.
 *
 * Properties are what the recording contains (`name`, `sport`, `laps`);
 * methods select, calculate or transform (`stats()`, `section()`,
 * `splits()`). See docs/rfcs/fit-api.md.
 */
import type { FileCreator, ImportedActivity, Lap } from '../types.js';
import { prepareActivity, type PreparedActivity } from '../summary/index.js';
import type { TrackSeries } from '../geo/index.js';
import { sectionGroupStats, sectionStats, type Span } from '../stats/index.js';
import { Distance, Duration } from '../quantities.js';
import { sportOf, type Sport } from './sport.js';
import { toStats, type Stats, type StatsOptions } from './stats.js';

/** Where a section starts and ends, on both axes. `elapsed` is null when
 *  the recording has no timestamps. */
export interface SectionBounds {
  elapsed: { from: Duration; to: Duration } | null;
  distance: { from: Distance; to: Distance };
}

/** A stretch picked by elapsed time or by distance, from the activity's start. */
export type SectionRange =
  | { elapsed: { from: Duration; to: Duration } }
  | { distance: { from: Distance; to: Distance } };

/** What a section is: the whole recording, a recorded lap, a computed split,
 *  or a stretch someone picked. */
export type SectionKind = 'activity' | 'lap' | 'split' | 'section';

/** Elapsed seconds at `meters` along the activity: the first sample that far,
 *  with the time drawn straight from the sample before. */
function secondsAtMeters(prep: PreparedActivity, meters: number): number {
  const { cum, timeRel } = prep;
  const n = cum.length;
  if (n === 0) return 0;
  if (meters <= cum[0]!) return timeRel[0]!;
  if (meters >= cum[n - 1]!) return timeRel[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! < meters) lo = mid + 1;
    else hi = mid;
  }
  const c0 = cum[lo - 1]!;
  const c1 = cum[lo]!;
  const t0 = timeRel[lo - 1]!;
  const t1 = timeRel[lo]!;
  return c1 > c0 ? t0 + ((meters - c0) / (c1 - c0)) * (t1 - t0) : t1;
}

/** Metres along the activity at elapsed `sec` (drawn straight between
 *  samples). */
function metersAtSeconds(prep: PreparedActivity, sec: number): number {
  const { cum, timeRel } = prep;
  const n = timeRel.length;
  if (n === 0) return 0;
  if (sec <= timeRel[0]!) return cum[0]!;
  if (sec >= timeRel[n - 1]!) return cum[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeRel[mid]! < sec) lo = mid + 1;
    else hi = mid;
  }
  const t0 = timeRel[lo - 1]!;
  const t1 = timeRel[lo]!;
  const c0 = cum[lo - 1]!;
  const c1 = cum[lo]!;
  return t1 > t0 ? c0 + ((sec - t0) / (t1 - t0)) * (c1 - c0) : c1;
}

/** One continuous stretch of an activity. Its stats come from the samples
 *  inside it (snapped to samples as {@link sectionStats} does). */
export class Section implements Span {
  /** @internal */
  protected readonly prep: PreparedActivity;
  readonly kind: SectionKind;
  readonly label: string;
  /** Elapsed seconds from the activity's start (the {@link Span} pair). */
  readonly fromSeconds: number;
  readonly toSeconds: number;
  /** @internal the file's timer time for this stretch, when it records one */
  protected readonly timerSeconds: number | undefined;
  #bounds?: SectionBounds;
  #stats = new Map<string, Stats>();

  /** @internal sections are made by an {@link Activity}, not directly */
  constructor(
    prep: PreparedActivity,
    kind: SectionKind,
    label: string,
    span: Span,
    timerSeconds?: number,
  ) {
    this.prep = prep;
    this.kind = kind;
    this.label = label;
    this.fromSeconds = span.fromSeconds;
    this.toSeconds = span.toSeconds;
    this.timerSeconds = timerSeconds;
  }

  /** Where it starts and ends, in elapsed time and in distance. */
  get bounds(): SectionBounds {
    return (this.#bounds ??= {
      elapsed: this.prep.hasTime
        ? {
            from: Duration.seconds(this.fromSeconds),
            to: Duration.seconds(this.toSeconds),
          }
        : null,
      distance: {
        from: Distance.meters(metersAtSeconds(this.prep, this.fromSeconds)),
        to: Distance.meters(metersAtSeconds(this.prep, this.toSeconds)),
      },
    });
  }

  /** The numbers for this stretch, on one time basis (elapsed by default). */
  stats(options: StatsOptions = {}): Stats {
    const basis = options.time ?? 'elapsed';
    let s = this.#stats.get(basis);
    if (!s) {
      s = toStats(sectionStats(this.prep, this), basis, {
        timerSeconds: this.timerSeconds,
        hasTime: this.prep.hasTime,
        hasDistance: hasDistance(this.prep),
        swim: isSwim(this.prep),
      });
      this.#stats.set(basis, s);
    }
    return s;
  }
}

function isSwim(prep: PreparedActivity): boolean {
  return sportOf(prep.imported.activity.sportType) === 'swim';
}

function hasDistance(prep: PreparedActivity): boolean {
  return prep.hasTrack || !!prep.imported.streams.distanceMeters?.length;
}

/** A recorded lap: a {@link Section} plus what the device kept for it. */
export class LapSection extends Section {
  /** The lap's number in the recording, from 1. */
  readonly id: number;
  /** What the file recorded for the lap. */
  readonly recorded: Lap;

  /** @internal */
  constructor(prep: PreparedActivity, lap: Lap, span: Span) {
    super(prep, 'lap', `Lap ${lap.index}`, span, lap.timerSeconds);
    this.id = lap.index;
    this.recorded = lap;
  }
}

/** A collection of stretches (laps, splits, a group of laps). Not itself a
 *  section: the gaps between its members (a rep's recovery) belong to none
 *  of them, and its stats leave them out. */
export class Sections<T extends Section = Section> implements Iterable<T> {
  readonly #prep: PreparedActivity;
  readonly #items: readonly T[];
  #stats = new Map<string, Stats>();

  /** @internal */
  constructor(prep: PreparedActivity, items: readonly T[]) {
    this.#prep = prep;
    this.#items = items;
  }

  get length(): number {
    return this.#items.length;
  }
  /** The member at `index` (negative counts from the end), if any. */
  at(index: number): T | undefined {
    return this.#items.at(index);
  }
  [Symbol.iterator](): Iterator<T> {
    return this.#items[Symbol.iterator]();
  }
  toArray(): T[] {
    return [...this.#items];
  }
  map<U>(fn: (item: T, index: number) => U): U[] {
    return this.#items.map(fn);
  }
  filter(fn: (item: T, index: number) => boolean): Sections<T> {
    return new Sections(this.#prep, this.#items.filter(fn));
  }

  /** The members grouped by `key`, in the order each key first appears. */
  groupBy<K>(key: (item: T, index: number) => K): Map<K, Sections<T>> {
    const buckets = new Map<K, T[]>();
    this.#items.forEach((item, i) => {
      const k = key(item, i);
      const b = buckets.get(k);
      if (b) b.push(item);
      else buckets.set(k, [item]);
    });
    const out = new Map<K, Sections<T>>();
    for (const [k, items] of buckets)
      out.set(k, new Sections(this.#prep, items));
    return out;
  }

  /** The numbers across the members only. Pace is their total distance over
   *  their total time; timer time is known only when it is for every member. */
  stats(options: StatsOptions = {}): Stats {
    const basis = options.time ?? 'elapsed';
    let s = this.#stats.get(basis);
    if (!s) {
      const timers = this.#items.map((i) => i.stats().time.timer?.seconds);
      const timerSeconds =
        timers.length && timers.every((t) => t !== undefined)
          ? timers.reduce((a, b) => a! + b!, 0)
          : undefined;
      s = toStats(sectionGroupStats(this.#prep, this.#items), basis, {
        timerSeconds,
        hasTime: this.#prep.hasTime,
        hasDistance: hasDistance(this.#prep),
        swim: isSwim(this.#prep),
      });
      this.#stats.set(basis, s);
    }
    return s;
  }
}

/** The whole recording: identity and metadata, plus everything a
 *  {@link Section} answers. */
export class Activity extends Section {
  readonly #record: ImportedActivity;
  #laps?: Sections<LapSection>;
  readonly #splits = new Map<number, Sections<Section>>();

  private constructor(prep: PreparedActivity) {
    const last = prep.timeRel.length
      ? prep.timeRel[prep.timeRel.length - 1]!
      : 0;
    const laps = prep.imported.laps ?? [];
    const timers = laps.map((l) => l.timerSeconds);
    // the file's own total first, else the laps' when every lap has one
    const timer =
      prep.imported.timerSeconds ??
      (laps.length && timers.every((t) => t !== undefined)
        ? timers.reduce((a, b) => a! + b!, 0)
        : undefined);
    super(
      prep,
      'activity',
      prep.imported.activity.name,
      { fromSeconds: 0, toSeconds: last },
      timer,
    );
    this.#record = prep.imported;
  }

  /** An activity from a plain record (what the file readers produce, or one
   *  you build from another source). */
  static from(record: ImportedActivity): Activity {
    return new Activity(prepareActivity(record));
  }

  get id(): string {
    return this.#record.activity.id;
  }
  get name(): string {
    return this.#record.activity.name;
  }
  /** The sport family; {@link sportType} keeps the file's own label. */
  get sport(): Sport {
    return sportOf(this.#record.activity.sportType);
  }
  get sportType(): string {
    return this.#record.activity.sportType;
  }
  get startedAt(): Date {
    return new Date(this.#record.activity.startTimeUtc);
  }
  /** What made the recording, as the file states it; null when it doesn't. */
  get device(): FileCreator | null {
    return this.#record.creator ?? null;
  }
  /** Whether the recording has GPS positions. */
  get hasRoute(): boolean {
    return this.prep.hasTrack;
  }
  /** The plain record behind this activity. */
  get record(): ImportedActivity {
    return this.#record;
  }

  /** The laps the device recorded (empty when it recorded none). */
  get laps(): Sections<LapSection> {
    if (!this.#laps) {
      const startMs = Date.parse(this.#record.activity.startTimeUtc);
      let cursor = 0;
      const items = (this.#record.laps ?? []).map((lap) => {
        const t = lap.startTimeUtc ? Date.parse(lap.startTimeUtc) : NaN;
        const from = Number.isFinite(t) ? (t - startMs) / 1000 : cursor;
        const to = from + lap.elapsedSeconds;
        cursor = to;
        return new LapSection(this.prep, lap, {
          fromSeconds: from,
          toSeconds: to,
        });
      });
      this.#laps = new Sections(this.prep, items);
    }
    return this.#laps;
  }

  /** Any stretch, by elapsed time or by distance from the start, held to
   *  the recording. Throws a RangeError when its end comes before its start,
   *  when it lies wholly outside the recording, or when it asks for elapsed
   *  time from a recording with no timestamps. */
  section(range: SectionRange, label = 'Section'): Section {
    if ('elapsed' in range && !this.prep.hasTime)
      throw new RangeError('section: the recording has no timestamps');
    const [from, to] =
      'elapsed' in range
        ? [range.elapsed.from.seconds, range.elapsed.to.seconds]
        : [
            secondsAtMeters(this.prep, range.distance.from.meters),
            secondsAtMeters(this.prep, range.distance.to.meters),
          ];
    if (!(to >= from))
      throw new RangeError('section: the end comes before the start');
    if (to < this.fromSeconds || from > this.toSeconds)
      throw new RangeError('section: outside the recording');
    return new Section(this.prep, 'section', label, {
      fromSeconds: Math.max(from, this.fromSeconds),
      toSeconds: Math.min(to, this.toSeconds),
    });
  }

  /** Even-distance splits (every km, every mile), in order; the last may be
   *  short. Empty with no distance. */
  splits(interval: Distance): Sections<Section> {
    const step = interval.meters;
    if (!(step > 0)) throw new RangeError('splits: the interval must be > 0');
    let cached = this.#splits.get(step);
    if (!cached) {
      const cum = this.prep.cum;
      const total = cum.length ? cum[cum.length - 1]! - cum[0]! : 0;
      const base = cum.length ? cum[0]! : 0;
      const items: Section[] = [];
      // a sliver under a millimetre left by rounding is not a split
      for (let k = 0; k * step < total - 1e-3; k++) {
        const a = base + k * step;
        const b = base + Math.min((k + 1) * step, total);
        items.push(
          new Section(this.prep, 'split', `Split ${k + 1}`, {
            fromSeconds: secondsAtMeters(this.prep, a),
            toSeconds: secondsAtMeters(this.prep, b),
          }),
        );
      }
      cached = new Sections(this.prep, items);
      this.#splits.set(step, cached);
    }
    return cached;
  }

  /** The recording as a pond timeseries, for anything the library doesn't
   *  answer directly. */
  toSeries(): TrackSeries {
    return this.prep.track;
  }
  /** @internal the prepared columns, for the functional layer */
  prepared(): PreparedActivity {
    return this.prep;
  }
}
