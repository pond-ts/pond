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
import type {
  FileCreator,
  ImportedActivity,
  Lap,
  SwimLength,
} from '../types.js';
import {
  distanceAtSeconds,
  hasDistance,
  prepareActivity,
  secondsAtDistance,
  swimMoving,
  type PreparedActivity,
} from '../summary/index.js';
import type { TrackSeries } from '../geo/index.js';
import { sectionGroupStats, sectionStats, type Span } from '../stats/index.js';
import { Distance, Duration } from '../quantities.js';
import { sportOf, type Sport } from './sport.js';
import { isPoolRecord } from './moving.js';
import { toStats, type Stats, type StatsOptions } from './stats.js';
import { seriesOf, type ActivitySeries } from './series.js';
import { routeOf, type Route } from './route.js';
import { explainOf, type Explainable, type Explanation } from './explain.js';
import {
  editParts,
  isNoEdit,
  type ActivityEdit,
  type EditChange,
} from './editing.js';
import {
  Analysis,
  PaceEfforts,
  PowerEfforts,
  resolveAthlete,
  type AnalysisSource,
  type AnalyzeOptions,
} from './analysis.js';

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
 *  a stretch someone picked, a pool swim's parts, or a best effort. */
export type SectionKind =
  | 'activity'
  | 'lap'
  | 'split'
  | 'section'
  | 'length'
  | 'rest'
  | 'repeat'
  | 'recovery'
  | 'effort';

const PREPARED = new WeakMap<Section, PreparedActivity>();

/** The prepared activity a section reads, for `@pond-ts/fit/views`.
 *  @internal */
export function preparedOf(section: Section): PreparedActivity {
  return PREPARED.get(section)!;
}

/** One continuous stretch of an activity. Its time and distance run between
 *  its own ends; its channel numbers come from the samples inside it (see
 *  {@link sectionStats}). */
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
  #power?: PowerEfforts<Section>;
  #pace?: PaceEfforts<Section>;
  #series?: ActivitySeries;

  /** @internal sections are made by an {@link Activity}, not directly */
  constructor(
    prep: PreparedActivity,
    kind: SectionKind,
    label: string,
    span: Span,
    timerSeconds?: number,
  ) {
    this.prep = prep;
    PREPARED.set(this, prep);
    this.kind = kind;
    this.label = label;
    this.fromSeconds = span.fromSeconds;
    this.toSeconds = span.toSeconds;
    this.timerSeconds = timerSeconds;
  }

  /** Where it starts and ends, in elapsed time and in distance. */
  get bounds(): SectionBounds {
    return (this.#bounds ??= {
      elapsed: this.prep.hasClock
        ? {
            from: Duration.seconds(this.fromSeconds),
            to: Duration.seconds(this.toSeconds),
          }
        : null,
      distance: {
        from: Distance.meters(distanceAtSeconds(this.prep, this.fromSeconds)),
        to: Distance.meters(distanceAtSeconds(this.prep, this.toSeconds)),
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
        hasTime: this.prep.hasClock,
        hasDistance: hasDistance(this.prep),
        swim: isSwim(this.prep),
        movingRule: this.prep.movingRule,
        wholeSwimSeconds: this.wholeSwimSeconds(),
      });
      this.#stats.set(basis, s);
    }
    return s;
  }

  /** This stretch read for one athlete: intensity, load and zones from
   *  their settings in force on the activity's date. */
  analyze(options: AnalyzeOptions): Analysis {
    const start = this.prep.imported.activity.startTimeUtc;
    return new Analysis(this.#source(), resolveAthlete(options.athlete, start));
  }

  /** Best efforts by power: `ride.power.bestEffort(minutes(20))`. */
  get power(): PowerEfforts<Section> {
    return (this.#power ??= new PowerEfforts(this.#source(), (span, label) =>
      this.#effort(span, label),
    ));
  }

  /** Best efforts by pace: `run.pace.bestEffort(km(5))`. */
  get pace(): PaceEfforts<Section> {
    return (this.#pace ??= new PaceEfforts(this.#source(), (span, label) =>
      this.#effort(span, label),
    ));
  }

  /** The measured values inside this stretch, by channel:
   *  `run.series.heartRate`. */
  get series(): ActivitySeries {
    return (this.#series ??= seriesOf(this.prep, this));
  }

  #source(): AnalysisSource {
    return {
      prep: this.prep,
      span: this,
      stats: () => this.stats(),
      statsOf: (span, basis) =>
        new Section(this.prep, 'effort', 'Part', span).stats({ time: basis }),
    };
  }

  #effort(span: Span, label: string): Section {
    return new Section(this.prep, 'effort', label, span);
  }

  /** @internal the watch's swim time, when this is the whole activity */
  protected wholeSwimSeconds(): number | undefined {
    return undefined;
  }
}

function isSwim(prep: PreparedActivity): boolean {
  return sportOf(prep.imported.activity.sportType) === 'swim';
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
        hasTime: this.#prep.hasClock,
        hasDistance: hasDistance(this.#prep),
        swim: isSwim(this.#prep),
        movingRule: this.#prep.movingRule,
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
  #route?: Route | null;
  #laps?: Sections<LapSection>;
  /** Set on an edited activity: what it was made from, and how. */
  #edited?: {
    original: Activity;
    edit: ActivityEdit;
    /** Where this activity's clock starts on the original's. */
    offset: number;
    /** The kept stretch, on the original's clock. */
    from: number;
    to: number;
    parts: Activity[];
    changes: EditChange[];
  };
  readonly #splits = new Map<number, Sections<Section>>();

  protected constructor(prep: PreparedActivity) {
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
      // the start (or an earlier first sample) to the last sample, or to
      // a pool swim's last recorded length
      { fromSeconds: prep.extent.from, toSeconds: prep.extent.to },
      timer,
    );
    this.#record = prep.imported;
  }

  /** An activity from a plain record (what the file readers produce, or one
   *  you build from another source). */
  static from(record: ImportedActivity): Activity {
    const prep = prepareActivity(record);
    return isPoolRecord(record) ? new PoolSwim(prep) : new Activity(prep);
  }

  /**
   * The recording edited: cropped, laps split or joined, or split into
   * several activities. Every position is a duration from the original
   * recording's start, so editing an edited activity starts again from the
   * original, and the same edit always means the same thing. Throws a
   * `RangeError` on a crop that keeps nothing, a part split outside it, or
   * a crop of a recording with no timestamps.
   */
  edit(edit: ActivityEdit): Activity {
    const original = this.original;
    if (isNoEdit(edit)) return original;
    const pieces = editParts(original.#record, edit);
    const parts = pieces.map((p) => Activity.from(p.record));
    pieces.forEach((p, i) => {
      parts[i]!.#edited = {
        original,
        edit,
        offset: p.offset,
        from: p.from,
        to: p.to,
        parts,
        changes: p.changes,
      };
    });
    return parts[0]!;
  }

  /** Where one of its numbers comes from: the source, the method, how much
   *  of the recording backs it, and the edits it went through. */
  explain(quantity: Explainable): Explanation {
    return explainOf(this.prep, quantity, this.timerSeconds, this.changes);
  }

  /** The untouched recording this was edited from; itself when unedited. */
  get original(): Activity {
    return this.#edited?.original ?? this;
  }

  /** The edit that made this activity, in the original's terms; null when
   *  unedited. */
  get appliedEdit(): ActivityEdit | null {
    return this.#edited?.edit ?? null;
  }

  /** What the edit changed in this activity, in order along the original
   *  recording: only what took effect (a crop that cut something, a join
   *  where a lap started), and for one of several parts only what falls in
   *  it, with the part splits at its ends. */
  get changes(): EditChange[] {
    return this.#edited ? [...this.#edited.changes] : [];
  }

  /** Every activity the edit made, in order; this one is among them. Just
   *  this one when the edit made no parts, or when unedited. */
  get parts(): readonly Activity[] {
    return this.#edited?.parts ?? [this];
  }

  /** A stretch of this activity, as the same stretch of the original
   *  recording (held to this activity's ends first). */
  toOriginal(span: Span): Section {
    const off = this.#edited?.offset ?? 0;
    const a = Math.max(span.fromSeconds, this.fromSeconds);
    const b = Math.min(span.toSeconds, this.toSeconds);
    if (!(b >= a))
      throw new RangeError('toOriginal: the stretch is outside this activity');
    return new Section(this.original.prep, 'section', 'Section', {
      fromSeconds: a + off,
      toSeconds: b + off,
    });
  }

  /** A stretch saved on the original recording's clock (a mark, a note), on
   *  this activity's clock: cut to what this activity kept, or null when
   *  none of it was kept. */
  fromOriginal(range: { from: Duration; to: Duration }): Section | null {
    const a = range.from.seconds;
    const b = range.to.seconds;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a > b)
      throw new RangeError('fromOriginal: the end comes before the start');
    const e = this.#edited;
    const off = e?.offset ?? 0;
    const lo = e ? Math.max(a, e.from) : a;
    const hi = e ? Math.min(b, e.to) : b;
    const from = Math.max(lo - off, this.fromSeconds);
    const to = Math.min(hi - off, this.toSeconds);
    // a stretch with length that only touches what was kept was not kept
    if (!(to >= from) || hi < lo || (b > a && !(to > from))) return null;
    return new Section(this.prep, 'section', 'Section', {
      fromSeconds: from,
      toSeconds: to,
    });
  }

  /** Where a swim was: `'pool'` or `'open-water'`; null for any other sport,
   *  or a swim whose record doesn't say. Informational: to reach a pool
   *  swim's `pool`, `segments` and `repeats`, narrow with
   *  {@link isPoolSwim}. */
  get environment(): 'pool' | 'open-water' | null {
    if (this.sport !== 'swim') return null;
    if (this.#record.streams.openWater) return 'open-water';
    return isPoolRecord(this.#record) ? 'pool' : null;
  }

  /** Narrows to a {@link PoolSwim}: its pool, lengths, rests and repeats. */
  isPoolSwim(): this is PoolSwim {
    return this instanceof PoolSwim;
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
  /** Where it went: the line and its bounds; null with no GPS. */
  get route(): Route | null {
    if (this.#route === undefined) this.#route = routeOf(this.prep);
    return this.#route;
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
    if ('elapsed' in range && !this.prep.hasClock)
      throw new RangeError('section: the recording has no timestamps');
    const [from, to] =
      'elapsed' in range
        ? [range.elapsed.from.seconds, range.elapsed.to.seconds]
        : [
            secondsAtDistance(this.prep, range.distance.from.meters),
            secondsAtDistance(this.prep, range.distance.to.meters),
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
      // from the activity's distance where it starts (a pool swim's first
      // length can come before its first sample), so the splits cover it all
      const base = distanceAtSeconds(this.prep, this.fromSeconds);
      const total = distanceAtSeconds(this.prep, this.toSeconds) - base;
      const items: Section[] = [];
      // a sliver under a millimetre left by rounding is not a split
      for (let k = 0; k * step < total - 1e-3; k++) {
        const a = base + k * step;
        const b = base + Math.min((k + 1) * step, total);
        items.push(
          new Section(this.prep, 'split', `Split ${k + 1}`, {
            fromSeconds: secondsAtDistance(this.prep, a),
            toSeconds: secondsAtDistance(this.prep, b),
          }),
        );
      }
      cached = new Sections(this.prep, items);
      this.#splits.set(step, cached);
    }
    return cached;
  }

  protected override wholeSwimSeconds(): number | undefined {
    return swimMoving(this.#record, this.toSeconds - this.fromSeconds);
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

/** The pool a swim was in. */
export interface Pool {
  /** One length of the pool. */
  length: Distance;
  /** The course, as swimmers name it: `'25m'`, `'50m'`, `'25yd'`. Courses
   *  stay distinct (a 25 yd pool isn't a short 25 m one: the turns differ). */
  course: string;
}

/** One length of the pool, as the swim watch recorded it. */
export class LengthSection extends Section {
  override readonly kind = 'length' as const;
  /** Its number among the swim's lengths, from 1. */
  readonly number: number;
  /** The stroke the watch recognised (`'freestyle'`, `'breaststroke'`,
   *  `'backstroke'`, `'butterfly'`, `'drill'`, `'mixed'`), or null. */
  readonly stroke: string | null;
  /** Strokes the watch counted over the length, or null. As reported:
   *  Garmin counts cycles of the watch arm, not every arm pull. */
  readonly strokeCount: number | null;
  /** What the file recorded. */
  readonly recorded: SwimLength;
  /** One pool length, or null when the record doesn't give the pool. */
  readonly distance: Distance | null;

  /** @internal */
  constructor(
    prep: PreparedActivity,
    length: SwimLength,
    number: number,
    span: Span,
    distance: Distance | null,
  ) {
    super(prep, 'length', `Length ${number}`, span, length.seconds);
    this.number = number;
    this.distance = distance;
    this.stroke = length.stroke ?? null;
    this.strokeCount = length.strokes ?? null;
    this.recorded = length;
  }

  /** A drill length: its stroke count, if any, is not a swimming stroke. */
  get drill(): boolean {
    return this.stroke === 'drill';
  }
}

/** A rest at the wall between lengths. A rest, not an inactive length. */
export class RestSection extends Section {
  override readonly kind = 'rest' as const;

  /** @internal */
  constructor(prep: PreparedActivity, span: Span, seconds: number) {
    super(prep, 'rest', 'Rest', span, seconds);
  }

  get duration(): Duration {
    return Duration.seconds(this.toSeconds - this.fromSeconds);
  }
}

/** The rest after a repeat: a recorded lap that covered no distance. */
export class RecoverySection extends Section {
  override readonly kind = 'recovery' as const;
  /** The recorded lap it comes from. */
  readonly lap: LapSection;

  /** @internal */
  constructor(prep: PreparedActivity, lap: LapSection) {
    super(prep, 'recovery', 'Recovery', lap, lap.recorded.timerSeconds);
    this.lap = lap;
  }

  get duration(): Duration {
    return Duration.seconds(this.toSeconds - this.fromSeconds);
  }
}

/** What a pool swim is made of, in order. */
export type SwimSegment = LengthSection | RestSection;

/** Where a repeat came from. Only recorded laps today; a workout,
 *  annotations or detection come later (RFC §16.1). */
export type RepeatSource = 'laps';

/** One effort: a recorded lap that covered distance, with its lengths and
 *  the rest that followed it. */
export class RepeatSection extends Section {
  override readonly kind = 'repeat' as const;
  /** Its number among the repeats, from 1. */
  readonly number: number;
  readonly source: RepeatSource = 'laps';
  /** The recorded lap it comes from. */
  readonly lap: LapSection;
  /** The rest right after it (a recorded lap with no distance), or null. */
  readonly recoveryAfter: RecoverySection | null;
  readonly #lengths: Sections<LengthSection>;

  /** @internal */
  constructor(
    prep: PreparedActivity,
    number: number,
    lap: LapSection,
    recoveryAfter: RecoverySection | null,
    lengths: Sections<LengthSection>,
  ) {
    super(prep, 'repeat', `Repeat ${number}`, lap, lap.recorded.timerSeconds);
    this.number = number;
    this.lap = lap;
    this.recoveryAfter = recoveryAfter;
    this.#lengths = lengths;
  }

  /** The lengths swum in it. */
  get lengths(): Sections<LengthSection> {
    return this.#lengths;
  }
}

/** A pool swim: an {@link Activity} with its pool, the lengths and rests it
 *  is made of, and its repeats. Get one with {@link Activity.isPoolSwim}. */
export class PoolSwim extends Activity {
  #segments?: readonly SwimSegment[];
  #lengths?: Sections<LengthSection>;
  #repeats?: Sections<RepeatSection>;
  #pool?: Pool | null;

  /** @internal */
  constructor(prep: PreparedActivity) {
    super(prep);
  }

  override get environment(): 'pool' {
    return 'pool';
  }

  /** The pool, or null when the record doesn't give its length. */
  get pool(): Pool | null {
    if (this.#pool === undefined) {
      const p = this.record.swim?.pool;
      if (!p || !(p.lengthMeters > 0)) this.#pool = null;
      else {
        const length = Distance.meters(p.lengthMeters);
        const n = p.unit === 'yd' ? length.yards : p.lengthMeters;
        this.#pool = { length, course: `${Math.round(n * 10) / 10}${p.unit}` };
      }
    }
    return this.#pool;
  }

  /** The lengths and the rests between them, in order. Empty when the watch
   *  kept no length records. */
  get segments(): readonly SwimSegment[] {
    if (!this.#segments) {
      const start = this.startedAt.getTime();
      const poolLength = this.pool?.length ?? null;
      let n = 0;
      this.#segments = (this.record.swim?.lengths ?? []).flatMap((l) => {
        const from = (Date.parse(l.startTimeUtc) - start) / 1000;
        if (!Number.isFinite(from)) return [];
        const span = { fromSeconds: from, toSeconds: from + l.seconds };
        return [
          l.active
            ? new LengthSection(this.prep, l, ++n, span, poolLength)
            : new RestSection(this.prep, span, l.seconds),
        ];
      });
    }
    return this.#segments;
  }

  /** The lengths alone. */
  get lengths(): Sections<LengthSection> {
    return (this.#lengths ??= new Sections(
      this.prep,
      this.segments.filter((s): s is LengthSection => s.kind === 'length'),
    ));
  }

  /** The efforts, from the recorded laps: each lap that covered distance,
   *  with the lengths inside it and the no-distance lap after it as its
   *  recovery. */
  get repeats(): Sections<RepeatSection> {
    if (!this.#repeats) {
      const laps = this.laps.toArray();
      const items: RepeatSection[] = [];
      laps.forEach((lap, i) => {
        if (!(lap.recorded.distanceMeters > 0)) return;
        const next = laps[i + 1];
        const recovery =
          next && !(next.recorded.distanceMeters > 0)
            ? new RecoverySection(this.prep, next)
            : null;
        const inside = this.lengths.filter((l) => {
          const mid = (l.fromSeconds + l.toSeconds) / 2;
          // half-open, so a length on a boundary belongs to one repeat
          return mid >= lap.fromSeconds && mid < lap.toSeconds;
        });
        items.push(
          new RepeatSection(this.prep, items.length + 1, lap, recovery, inside),
        );
      });
      this.#repeats = new Sections(this.prep, items);
    }
    return this.#repeats;
  }
}
