/**
 * The `Activity` / `Section` façade — the ergonomic object model of the fitness
 * library (see docs/fit/api.md). A thin, memoizing skin over the functional
 * operator core: `prepareActivity` (the canonical pond series + derived columns),
 * `summaryFromPrepared`, the geo splitters, and the power/zone analytics. Every
 * method delegates to a tested pure operator and hands back {@link quantities}
 * (Distance, Power, Speed, …) instead of bare numbers.
 *
 * `Activity` is **profile-agnostic**: anything that needs an athlete's FTP, body
 * weight, or zone definitions takes them as arguments (the caller resolves them
 * from the athlete profile as-of the activity date). The object wraps only the
 * activity's own evidence.
 *
 * `Section` is a range-with-metrics over the activity — a split, a recorded lap,
 * or an arbitrary `[from, to]` slice — exposing the same quantity-typed analytics
 * as the whole activity. (NOT `Segment`: that word is reserved for the story
 * hierarchy, Story → Chapter → Segment → Activity. See the RFC.)
 */
import type { ActivityMeta, ImportedActivity, Lap } from '../types.js';
import * as geo from '../geo/index.js';
import type { Split, TrackSeries, DistanceEffort } from '../geo/index.js';
import {
  prepareActivity,
  summaryFromPrepared,
  type PreparedActivity,
  type ActivitySummary,
  type ActivitySummaryOptions,
} from '../summary/index.js';
import {
  computePower,
  powerCurve,
  powerBestEfforts,
  normalizedPower,
  averagePower,
  maxPower,
  type PowerSummary,
  type PowerCurvePoint,
  type PowerEffort,
} from '../power/index.js';
import {
  hrZoneDistribution,
  paceZoneDistribution,
  type ZoneTime,
} from '../zones/index.js';
import type { ZoneDef } from '../profile/index.js';
import {
  Distance,
  Elevation,
  Duration,
  Speed,
  Pace,
  Power,
  HeartRate,
  Cadence,
} from '../quantities.js';

// ── small array helpers (validity-aware, gap-safe) ──────────────────────────

/** Copy a per-sample array to Float64 with non-finite → NaN; `undefined` if the
 *  channel is absent or has no finite sample (so callers can branch on presence). */
function clean(
  values: ArrayLike<number> | undefined,
): Float64Array | undefined {
  if (!values) return undefined;
  const out = new Float64Array(values.length);
  let any = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[i] = v;
      any = true;
    } else out[i] = NaN;
  }
  return any ? out : undefined;
}

/** Mean of the finite samples in `[lo, hi)`; `undefined` if none. */
function meanIn(
  arr: Float64Array | undefined,
  lo: number,
  hi: number,
): number | undefined {
  if (!arr) return undefined;
  let sum = 0;
  let n = 0;
  for (let i = lo; i < hi; i++) {
    const v = arr[i]!;
    if (Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : undefined;
}

/** Max of the finite samples in `[lo, hi)`; `undefined` if none. */
function maxIn(
  arr: Float64Array | undefined,
  lo: number,
  hi: number,
): number | undefined {
  if (!arr) return undefined;
  let hiV = -Infinity;
  for (let i = lo; i < hi; i++) {
    const v = arr[i]!;
    if (Number.isFinite(v) && v > hiV) hiV = v;
  }
  return hiV > -Infinity ? hiV : undefined;
}

/** Smallest index `i` with `timeRel[i] >= t` (binary search; clamped to range). */
function indexAtElapsed(timeRel: Float64Array, t: number): number {
  let lo = 0;
  let hi = timeRel.length - 1;
  if (t <= timeRel[0]!) return 0;
  if (t >= timeRel[hi]!) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeRel[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ── Section ─────────────────────────────────────────────────────────────────

/** The normalized metric bundle a {@link Section} is a quantity-typed view over.
 *  Produced three ways — a computed split, a recorded lap, or an arbitrary range
 *  — all reduced to the same shape (native SI). Optional fields are absent when
 *  the underlying channel wasn't recorded. */
export interface SectionMetrics {
  label: string;
  /** Elapsed seconds from activity start to the section's start / end. */
  fromSec: number;
  toSec: number;
  /** Cumulative-distance window into the activity (metres) — the map-highlight
   *  anchor, mirroring [fromSec, toSec] on the distance axis. */
  startMeters: number;
  endMeters: number;
  distanceMeters: number;
  /** Wall-clock span (toSec − fromSec). */
  durationSeconds: number;
  /** Time actually moving — equals duration for computed splits. */
  movingSeconds: number;
  elevationGainMeters: number;
  elevationLossMeters?: number | undefined;
  normalizedWatts?: number | undefined;
  avgWatts?: number | undefined;
  maxWatts?: number | undefined;
  avgHeartrate?: number | undefined;
  maxHeartrate?: number | undefined;
  avgCadence?: number | undefined;
  avgSpeedMps?: number | undefined;
  maxSpeedMps?: number | undefined;
}

/**
 * A range of an activity with its own analytics — a split, a lap, or a slice.
 * Quantity-typed views over a {@link SectionMetrics} bundle; nothing computes
 * here (the producer already did), so accessors are pure getters.
 */
export class Section {
  constructor(private readonly m: SectionMetrics) {}

  get label(): string {
    return this.m.label;
  }
  /** Elapsed `[from, to]` window into the activity, in seconds — the time anchor
   *  a contiguous Focus / range annotation maps onto. */
  get fromSeconds(): number {
    return this.m.fromSec;
  }
  get toSeconds(): number {
    return this.m.toSec;
  }
  /** Cumulative-distance window [start, end] into the activity (metres) — the
   *  anchor for a map-segment highlight, the distance-axis peer of from/toSeconds. */
  get startMeters(): number {
    return this.m.startMeters;
  }
  get endMeters(): number {
    return this.m.endMeters;
  }

  distance(): Distance {
    return Distance.meters(this.m.distanceMeters);
  }
  duration(): Duration {
    return Duration.seconds(this.m.durationSeconds);
  }
  movingTime(): Duration {
    return Duration.seconds(this.m.movingSeconds);
  }
  elevationGain(): Elevation {
    return Elevation.meters(this.m.elevationGainMeters);
  }
  elevationLoss(): Elevation | undefined {
    return this.m.elevationLossMeters == null
      ? undefined
      : Elevation.meters(this.m.elevationLossMeters);
  }
  normalizedPower(): Power | undefined {
    return this.m.normalizedWatts == null
      ? undefined
      : Power.watts(this.m.normalizedWatts);
  }
  avgPower(): Power | undefined {
    return this.m.avgWatts == null ? undefined : Power.watts(this.m.avgWatts);
  }
  maxPower(): Power | undefined {
    return this.m.maxWatts == null ? undefined : Power.watts(this.m.maxWatts);
  }
  avgHeartRate(): HeartRate | undefined {
    return this.m.avgHeartrate == null
      ? undefined
      : HeartRate.bpm(this.m.avgHeartrate);
  }
  maxHeartRate(): HeartRate | undefined {
    return this.m.maxHeartrate == null
      ? undefined
      : HeartRate.bpm(this.m.maxHeartrate);
  }
  avgCadence(): Cadence | undefined {
    return this.m.avgCadence == null
      ? undefined
      : Cadence.rpm(this.m.avgCadence);
  }
  /** Average speed — the recorded average when present, else distance ÷ moving
   *  time. `undefined` only when neither is available (no distance / no time). */
  avgSpeed(): Speed | undefined {
    if (this.m.avgSpeedMps != null)
      return Speed.metersPerSecond(this.m.avgSpeedMps);
    const t = this.m.movingSeconds;
    return t > 0 && this.m.distanceMeters > 0
      ? Speed.metersPerSecond(this.m.distanceMeters / t)
      : undefined;
  }
  maxSpeed(): Speed | undefined {
    return this.m.maxSpeedMps == null
      ? undefined
      : Speed.metersPerSecond(this.m.maxSpeedMps);
  }
  /** Average pace — the inverse view of {@link avgSpeed}. */
  pace(): Pace | undefined {
    return this.avgSpeed()?.pace();
  }
}

// ── Activity ──────────────────────────────────────────────────────────────

/** Channel values interpolated at one instant — what {@link Activity.at} returns.
 *  Only channels the activity carries are present. */
export interface Sample {
  /** Elapsed seconds from the start (the query time, clamped to the activity). */
  atSeconds: number;
  distance?: Distance;
  elevation?: Elevation;
  heartRate?: HeartRate;
  power?: Power;
  cadence?: Cadence;
  speed?: Speed;
}

/**
 * The activity façade. Construct from an imported activity (`fromStreams`); read
 * the canonical series (`timeSeries`), slice it (`splits` / `laps` / `range`),
 * sample it (`at`), and run analytics (`power` / `powerCurve` / `bestEfforts` /
 * `hrZones`). Immutable; derived results memoize on first call.
 */
export class Activity {
  private _summary?: ActivitySummary;
  /** NaN-for-missing power, lazily cleaned; `null` once we know there is none. */
  private _watts?: Float64Array | null;
  /** Splits memoized per interval (metres) — the summary recompute isn't cheap. */
  private readonly _splits = new Map<number, Section[]>();

  private constructor(private readonly prep: PreparedActivity) {}

  /** Build from an imported activity (streams + metadata + optional laps) — the
   *  Strava / fixture path. `fromFit` / `fromGpx` / `fromTcx` land with ingest. */
  static fromStreams(imported: ImportedActivity): Activity {
    return new Activity(prepareActivity(imported));
  }

  /** Session metadata — id, name, sport, start, totals. */
  get meta(): ActivityMeta {
    return this.prep.imported.activity;
  }
  /** Whether the activity carries GPS positions (a map; otherwise indoor / GPS-off). */
  get hasTrack(): boolean {
    return this.prep.hasTrack;
  }
  /** Whether a power channel was recorded. */
  get hasPower(): boolean {
    return this.watts() != null;
  }

  /** The canonical pond series (the escape hatch to the functional/pond layer). */
  timeSeries(): TrackSeries {
    return this.prep.track;
  }
  /** The prepared per-sample columns + derived series — for consumers still on
   *  the functional path (e.g. the chart) while they migrate to the façade. */
  prepared(): PreparedActivity {
    return this.prep;
  }
  /** The full journey summary (totals, channels, polyline, splits, laps). */
  summary(options: ActivitySummaryOptions = {}): ActivitySummary {
    // memoize only the default summary; a custom-options call recomputes.
    if (Object.keys(options).length === 0) {
      return (this._summary ??= summaryFromPrepared(this.prep));
    }
    return summaryFromPrepared(this.prep, options);
  }

  /** Total moving / elapsed / distance, quantity-typed. */
  distance(): Distance {
    return Distance.meters(this.summary().distanceMeters);
  }
  elapsedTime(): Duration {
    return Duration.seconds(this.summary().elapsedTimeSeconds);
  }
  movingTime(): Duration {
    return Duration.seconds(this.summary().movingTimeSeconds);
  }

  /** Even-distance splits (per-km, per-mile, …) as Sections, in order. */
  splits(interval: Distance): Section[] {
    const key = interval.meters;
    const cached = this._splits.get(key);
    if (cached) return cached;
    const splits = this.summary({ splitMeters: key }).splits;
    let fromSec = 0;
    let fromMeters = 0;
    const sections = splits.map((s) => {
      const sec = sectionFromSplit(s, fromSec, fromMeters);
      fromSec += s.durationSeconds;
      fromMeters += s.distanceMeters;
      return new Section(sec);
    });
    this._splits.set(key, sections);
    return sections;
  }

  /** Device-recorded laps as Sections (empty if the source recorded none). */
  laps(): Section[] {
    const laps = this.prep.imported.laps ?? [];
    const startMs = Date.parse(this.meta.startTimeUtc);
    let acc = 0; // fallback elapsed cursor when a lap has no start time
    return laps.map((lap) => {
      const sec = sectionFromLap(lap, startMs, acc);
      acc = sec.toSec;
      return new Section(sec);
    });
  }

  /** An arbitrary slice `[from, to]` (elapsed time) as a Section, with metrics
   *  computed from the series over that window. Clamped to the activity. */
  range(from: Duration, to: Duration, label = 'Range'): Section {
    const { timeRel, cols, step } = this.prep;
    const lo = indexAtElapsed(timeRel, from.seconds);
    const hi = indexAtElapsed(timeRel, to.seconds);
    return new Section(
      this.metricsForRange(lo, hi, label, cols, step, timeRel),
    );
  }

  /** Power summary (NP, IF, TSS, distribution, zones, curve) at the given FTP —
   *  `undefined` when no power was recorded. `elapsedSeconds` drives TSS. */
  power(ftp: number): PowerSummary | undefined {
    const watts = this.watts();
    if (!watts) return undefined;
    // elapsed = last − first sample, straight off the prepared relative-time axis
    // (timeRel[n−1]); avoids forcing the full journey summary just to read TSS.
    const elapsed =
      this.prep.n > 0 ? (this.prep.timeRel[this.prep.n - 1] ?? 0) : 0;
    return computePower(this.prep.cols.timeSec, watts, ftp, elapsed);
  }
  /** Mean-maximal power curve; `[]` when no power. */
  powerCurve(durations?: number[]): PowerCurvePoint[] {
    const watts = this.watts();
    return watts ? powerCurve(this.prep.cols.timeSec, watts, durations) : [];
  }
  /** Power best efforts at the canonical durations (+ W/kg if `weightKg`); `[]`
   *  when no power. */
  bestEfforts(
    opts: { weightKg?: number; durations?: number[] } = {},
  ): PowerEffort[] {
    const watts = this.watts();
    return watts ? powerBestEfforts(this.prep.cols.timeSec, watts, opts) : [];
  }
  /** Distance best efforts — fastest time over each canonical distance window
   *  (400 m … marathon), with avg HR. Needs a time axis; `[]` otherwise. */
  distanceBestEfforts(distances?: number[]): DistanceEffort[] {
    if (!this.prep.hasTime) return [];
    return geo.bestEffortsByDistance(
      this.prep.cum,
      this.prep.cols.timeSec,
      distances,
      clean(this.prep.cols.hr),
    );
  }

  /** Time-in-zone for heart rate against the given zone definition; `[]` with no HR. */
  hrZones(def: ZoneDef): ZoneTime[] {
    const hr = clean(this.prep.cols.hr);
    return hr ? hrZoneDistribution(this.prep.cols.timeSec, hr, def) : [];
  }
  /** Time-in-zone for pace (from the derived speed) against `def`; `[]` with no time. */
  paceZones(def: ZoneDef): ZoneTime[] {
    if (!this.prep.hasTime) return [];
    return paceZoneDistribution(this.prep.cols.timeSec, this.prep.speed, def);
  }

  /** Channel values interpolated at one elapsed instant — the scrub / annotation
   *  anchor sample. Linear between the bracketing samples. */
  at(t: Duration): Sample {
    const { timeRel, cols, cum, speed } = this.prep;
    const tc = Math.max(
      timeRel[0]!,
      Math.min(t.seconds, timeRel[timeRel.length - 1]!),
    );
    const hi = indexAtElapsed(timeRel, tc);
    const lo = hi > 0 ? hi - 1 : 0;
    const span = timeRel[hi]! - timeRel[lo]!;
    const f = span > 0 ? (tc - timeRel[lo]!) / span : 0;
    const lerp = (a: ArrayLike<number> | undefined): number | undefined => {
      if (!a) return undefined;
      const x = a[lo]!;
      const y = a[hi]!;
      if (!Number.isFinite(x) || !Number.isFinite(y))
        return Number.isFinite(y) ? y : x;
      return x + (y - x) * f;
    };
    const out: Sample = { atSeconds: tc };
    const dist = lerp(cum);
    if (dist != null && Number.isFinite(dist))
      out.distance = Distance.meters(dist);
    const ele = lerp(cols.ele);
    if (ele != null && Number.isFinite(ele))
      out.elevation = Elevation.meters(ele);
    const hr = lerp(cols.hr);
    if (hr != null && Number.isFinite(hr)) out.heartRate = HeartRate.bpm(hr);
    const pw = lerp(cols.power);
    if (pw != null && Number.isFinite(pw)) out.power = Power.watts(pw);
    const cad = lerp(cols.cadence);
    if (cad != null && Number.isFinite(cad)) out.cadence = Cadence.rpm(cad);
    const sp = lerp(speed);
    if (sp != null && Number.isFinite(sp))
      out.speed = Speed.metersPerSecond(sp);
    return out;
  }

  // ── internals ──

  /** Cleaned (NaN-for-missing) power column, memoized; `undefined` if no power. */
  private watts(): Float64Array | undefined {
    if (this._watts === undefined)
      this._watts = clean(this.prep.cols.power) ?? null;
    return this._watts ?? undefined;
  }

  /** Compute a range's metrics from the columns over `[lo, hi]` (inclusive). */
  private metricsForRange(
    lo: number,
    hi: number,
    label: string,
    cols: PreparedActivity['cols'],
    step: Float64Array,
    timeRel: Float64Array,
  ): SectionMetrics {
    const a = Math.min(lo, hi);
    const b = Math.max(lo, hi);
    const end = b + 1; // exclusive bound for the slice
    const timeSlice = cols.timeSec.slice(a, end);
    const stepSlice = step.slice(a, end);
    const { gainMeters, lossMeters } = geo.elevationGainLoss(
      cols.ele.slice(a, end),
    );
    const distanceMeters = (this.prep.cum[b] ?? 0) - (this.prep.cum[a] ?? 0);
    const durationSeconds = timeRel[b]! - timeRel[a]!;
    const movingSeconds = geo.movingTimeSeconds(stepSlice, timeSlice);
    const watts = this.watts();
    const wattsSlice = watts?.slice(a, end);
    const m: SectionMetrics = {
      label,
      fromSec: timeRel[a]!,
      toSec: timeRel[b]!,
      startMeters: this.prep.cum[a] ?? 0,
      endMeters: this.prep.cum[b] ?? 0,
      distanceMeters,
      durationSeconds,
      movingSeconds,
      elevationGainMeters: gainMeters,
      elevationLossMeters: lossMeters,
    };
    // Only when the window actually has a finite watt: averagePower/normalizedPower
    // return 0 (not undefined) on an all-missing slice, which would fabricate a
    // "0 W" reading over a power gap — and diverge from splits(), where the same
    // window reports `undefined`. Gate on presence so the two agree.
    if (wattsSlice && wattsSlice.some((v) => Number.isFinite(v))) {
      m.normalizedWatts = normalizedPower(timeSlice, wattsSlice);
      m.avgWatts = averagePower(wattsSlice);
      m.maxWatts = maxPower(wattsSlice);
    }
    m.avgHeartrate = meanIn(clean(cols.hr), a, end);
    m.maxHeartrate = maxIn(clean(cols.hr), a, end);
    m.avgCadence = meanIn(clean(cols.cadence), a, end);
    if (this.prep.hasTime) {
      m.avgSpeedMps =
        movingSeconds > 0 ? distanceMeters / movingSeconds : undefined;
      m.maxSpeedMps = maxIn(this.prep.speed, a, end);
    }
    return m;
  }
}

/** Normalize a computed {@link Split} to the shared metric bundle. Splits report
 *  elapsed duration only (no separate moving time). */
function sectionFromSplit(
  s: Split,
  fromSec: number,
  fromMeters: number,
): SectionMetrics {
  return {
    label: `Split ${s.index}`,
    fromSec,
    toSec: fromSec + s.durationSeconds,
    startMeters: fromMeters,
    endMeters: fromMeters + s.distanceMeters,
    distanceMeters: s.distanceMeters,
    durationSeconds: s.durationSeconds,
    movingSeconds: s.durationSeconds,
    elevationGainMeters: s.elevationGainMeters,
    elevationLossMeters: s.elevationLossMeters,
    normalizedWatts: s.normalizedWatts,
    avgWatts: s.avgWatts,
    maxWatts: s.maxWatts,
    avgHeartrate: s.avgHeartrate,
    maxHeartrate: s.maxHeartrate,
    avgCadence: s.avgCadence,
    avgSpeedMps: s.avgSpeedMps,
    maxSpeedMps: s.maxSpeedMps,
  };
}

/** Normalize a recorded {@link Lap} to the shared metric bundle. The lap's elapsed
 *  window is its start (from its timestamp, else the running cursor) + elapsed. */
function sectionFromLap(
  lap: Lap,
  startMs: number,
  cursorSec: number,
): SectionMetrics {
  const fromSec =
    lap.startTimeUtc && Number.isFinite(Date.parse(lap.startTimeUtc))
      ? (Date.parse(lap.startTimeUtc) - startMs) / 1000
      : cursorSec;
  return {
    label: `Lap ${lap.index}`,
    fromSec,
    toSec: fromSec + lap.elapsedSeconds,
    startMeters: lap.startDistanceMeters,
    endMeters: lap.startDistanceMeters + lap.distanceMeters,
    distanceMeters: lap.distanceMeters,
    durationSeconds: lap.elapsedSeconds,
    movingSeconds: lap.movingSeconds,
    elevationGainMeters: lap.elevationGainMeters ?? 0,
    normalizedWatts: undefined, // not recorded per lap; compute via range() if needed
    avgWatts: lap.avgWatts,
    maxWatts: lap.maxWatts,
    avgHeartrate: lap.avgHeartrate,
    maxHeartrate: lap.maxHeartrate,
    avgSpeedMps: lap.avgSpeedMps,
    maxSpeedMps: lap.maxSpeedMps,
  };
}
