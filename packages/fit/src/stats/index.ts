/**
 * Section stats: the full set of numbers for one stretch of an activity (a
 * lap, a split, a user-marked segment) and for a group of stretches (all the
 * 800 m reps, every split), read from the activity's samples.
 *
 * {@link SectionMetrics} is the short bundle (averages and maxima). These go
 * further: first / last / min / max / average per channel, the same again for
 * the moving time only, normalized power over all of it and over the moving
 * time, climb and descent, and across a group the lowest and highest of the
 * stretches' own averages (which rep was slowest).
 *
 * "Moving" is the rule {@link movingTimeSeconds} uses for the activity's
 * moving time: the time between two samples counts when the speed over it is
 * at least {@link MOVING_SPEED_MPS}. So a section's `movingSeconds` adds up the
 * same way the activity's does. A sample counts as moving when the time just
 * before it does (a window's first sample goes by the time just after it).
 *
 * A section's time, moving time and distance run between its own two ends,
 * drawn straight between samples (a 1 km split measures 1 km even when no
 * sample falls on either end); its channel numbers come from the samples
 * inside it. A pool swim with a known pool length takes its distance from
 * its lengths, and its moving (swimming) time from their overlap with the
 * section, samples or not.
 *
 * Extracted from Estela's interval stats (estela-app/estela,
 * `packages/core/src/interval/stats.ts`), where these numbers were first
 * worked out for the lap list, the custom segments and Claude's answers.
 */
import * as geo from '../geo/index.js';
import { normalizedPower } from '../power/index.js';
import {
  distanceAtSeconds,
  movingBeforeSample,
  movingSecondsIn,
  overlapSeconds,
  type PreparedActivity,
} from '../summary/index.js';

/** The channels the stats cover. `speed` is metres per second (a pace is the
 *  same number read the other way up); `elevation` is metres. */
export type StatChannel = 'speed' | 'hr' | 'power' | 'cadence' | 'elevation';
export const STAT_CHANNELS: readonly StatChannel[] = [
  'speed',
  'hr',
  'power',
  'cadence',
  'elevation',
];

/** A stretch of the activity in elapsed seconds from its start. A
 *  {@link Section} (a lap, a split, a range) fits as it is. */
export interface Span {
  fromSeconds: number;
  toSeconds: number;
}

/** One channel's numbers over one section; a number left out had no samples.
 *  Speed's `avg` is distance over elapsed time and `avgMoving` distance over
 *  moving time; the other channels' are sample means. */
export interface ChannelStats {
  first?: number;
  last?: number;
  min?: number;
  max?: number;
  avg?: number;
  avgMoving?: number;
  /** The lowest and highest of the moving samples, so a stop doesn't set the
   *  minimum. */
  minMoving?: number;
  maxMoving?: number;
  /** Normalized power over all the samples, stops included (power only). */
  np?: number;
  /** Normalized power over the moving time only, on a clock that stops while
   *  stopped (power only). */
  movingNp?: number;
  /** Metres climbed and descended (elevation only), by
   *  {@link elevationGainLoss}'s rule. */
  gain?: number;
  loss?: number;
}

/** The numbers for one section. */
export interface SectionStats {
  /** Elapsed seconds at the section's first and last sample inside it.
   *  The section's own ends can fall between samples: `elapsedSeconds`,
   *  `movingSeconds` and `distanceMeters` measure between those. */
  fromSeconds: number;
  toSeconds: number;
  elapsedSeconds: number;
  movingSeconds: number;
  distanceMeters: number;
  /** Only the channels the activity recorded. */
  channels: Partial<Record<StatChannel, ChannelStats>>;
}

/** One channel's numbers over a group of sections. `min`, `max` and the two
 *  averages come from the samples inside the sections; `lowest` / `highest`
 *  are the sections' own averages, with which section (its index in the
 *  group) had them. Ties go to the earlier section. */
export interface GroupChannelStats {
  min?: number;
  max?: number;
  minMoving?: number;
  maxMoving?: number;
  avg?: number;
  avgMoving?: number;
  /** Elevation: the sections' climbs and descents added up. */
  gain?: number;
  loss?: number;
  lowest?: number;
  lowestAt?: number;
  highest?: number;
  highestAt?: number;
  lowestMoving?: number;
  lowestMovingAt?: number;
  highestMoving?: number;
  highestMovingAt?: number;
}

/** The numbers for a group of sections. */
export interface SectionGroupStats {
  count: number;
  /** Time inside the sections, added up (the gaps between them, a rep's
   *  recovery, don't count). */
  elapsedSeconds: number;
  movingSeconds: number;
  distanceMeters: number;
  channels: Partial<Record<StatChannel, GroupChannelStats>>;
  /** Each section's own stats, in the order given. */
  sections: SectionStats[];
}

/** A clock that only runs while moving — for drawing an activity with its
 *  stops taken out. */
export interface MovingClock {
  /** Moving seconds at elapsed `sec`, or `null` when `sec` falls inside a
   *  stop. */
  at(sec: number): number | null;
  /** Moving seconds up to elapsed `sec`; inside a stop, those up to where it
   *  began. */
  upTo(sec: number): number;
}

const fin = (v: number | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** The samples the stats read, taken from the prepared activity. */
interface Samples {
  t: Float64Array;
  speed: Float64Array;
  cum: Float64Array;
  hr: Float64Array | undefined;
  power: Float64Array | undefined;
  cadence: Float64Array | undefined;
  elevation: Float64Array | undefined;
  hasTime: boolean;
  /** The sport's own moving rule, when it isn't the speed rule. */
  moving: Uint8Array | undefined;
  /** …and the stretches it counts as moving (moving time by overlap). */
  movingSpans: ReadonlyArray<readonly [number, number]> | undefined;
  /** A pool swim's swum lengths, when the pool length is known. */
  poolLengths: PreparedActivity['poolLengths'];
  prep: PreparedActivity;
}

const samplesCache = new WeakMap<PreparedActivity, Samples>();

/** A column, or `undefined` when it holds no finite sample. */
function present(a: Float64Array | undefined): Float64Array | undefined {
  if (!a) return undefined;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]!)) return a;
  return undefined;
}

function samplesOf(prep: PreparedActivity): Samples {
  let s = samplesCache.get(prep);
  if (!s) {
    s = {
      t: prep.timeRel,
      speed: prep.speed,
      cum: prep.cum,
      hr: present(prep.cols.hr),
      power: present(prep.cols.power),
      cadence: present(prep.cols.cadence),
      elevation: present(prep.cols.ele),
      hasTime: prep.hasTime,
      moving: prep.movingMask,
      movingSpans: prep.movingSpans,
      poolLengths: prep.poolLengths,
      prep,
    };
    samplesCache.set(prep, s);
  }
  return s;
}

/** The first sample at or after `sec` (clamped), as `Activity.range` finds a
 *  range's ends. */
function indexAt(t: Float64Array, sec: number): number {
  const n = t.length;
  if (n === 0) return 0;
  if (sec <= t[0]!) return 0;
  if (sec >= t[n - 1]!) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether the time just before sample i (i ≥ 1) was moving. */
function movingBefore(s: Samples, i: number): boolean {
  return movingBeforeSample(s.prep, i);
}

/** The part of a window that judges its samples moving: its samples, and
 *  where the window itself starts. */
interface Judge {
  lo: number;
  hi: number;
  from: number;
}

/**
 * Whether sample i counts as moving inside a window. A reading stands for
 * the time leading up to it, so it is judged by the gap before it. The
 * window's first sample is judged by the gap before it too when the window
 * starts inside that gap; when the window starts on the sample (or it is the
 * recording's first), by the gap after it, the one the window covers.
 */
function movingSample(s: Samples, w: Judge, i: number): boolean {
  if (i > w.lo) return movingBefore(s, i);
  const n = s.t.length;
  const startsInGap = i >= 1 && w.from < s.t[i]! - EPS;
  if (startsInGap) return movingBefore(s, i);
  if (i + 1 < n) return movingBefore(s, i + 1);
  return i >= 1 ? movingBefore(s, i) : false;
}

interface Tally {
  sum: number;
  n: number;
  movingSum: number;
  movingN: number;
  min: number;
  max: number;
  movingMin: number;
  movingMax: number;
}

function tally(
  s: Samples,
  vals: ArrayLike<number>,
  lo: number,
  hi: number,
  /** The window, for judging moving (speed may start its tally one sample
   *  in, but the window still starts where it starts). */
  judge: Judge,
): Tally {
  const out: Tally = {
    sum: 0,
    n: 0,
    movingSum: 0,
    movingN: 0,
    min: Infinity,
    max: -Infinity,
    movingMin: Infinity,
    movingMax: -Infinity,
  };
  for (let i = lo; i <= hi; i++) {
    const v = vals[i];
    if (!fin(v)) continue;
    out.sum += v;
    out.n++;
    if (v < out.min) out.min = v;
    if (v > out.max) out.max = v;
    if (movingSample(s, judge, i)) {
      out.movingSum += v;
      out.movingN++;
      if (v < out.movingMin) out.movingMin = v;
      if (v > out.movingMax) out.movingMax = v;
    }
  }
  return out;
}

/** {@link normalizedPower} over a window; `movingOnly`: the moving samples
 *  alone, on a clock that stops while stopped. `undefined` with no power. */
function windowNp(
  s: Samples,
  watts: Float64Array,
  judge: Judge,
  movingOnly: boolean,
): number | undefined {
  const { lo, hi } = judge;
  const clock: number[] = [];
  const w: number[] = [];
  let tm = 0;
  for (let i = lo; i <= hi; i++) {
    const moving = !movingOnly || movingSample(s, judge, i);
    if (i > lo && moving) tm += s.t[i]! - s.t[i - 1]!;
    const v = watts[i];
    if (moving && fin(v)) {
      clock.push(tm);
      w.push(v);
    }
  }
  if (!w.length) return undefined;
  return normalizedPower(Float64Array.from(clock), Float64Array.from(w));
}

function ends(vals: ArrayLike<number>, lo: number, hi: number) {
  let first: number | undefined;
  let last: number | undefined;
  for (let i = lo; i <= hi; i++)
    if (fin(vals[i])) {
      first = vals[i];
      break;
    }
  for (let i = hi; i >= lo; i--)
    if (fin(vals[i])) {
      last = vals[i];
      break;
    }
  return { first, last };
}

/** A bundle under construction: any number may still be `undefined`. */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };

/** Drop keys left `undefined`, so a missing number is simply absent. */
function defined<T extends object>(o: Loose<T>): T {
  for (const k of Object.keys(o) as (keyof T)[])
    if (o[k] === undefined) delete o[k];
  return o as T;
}

interface Window {
  /** The samples inside (both ends included); meaningful when `samples`. */
  lo: number;
  hi: number;
  /** The span held to the recording, seconds. */
  from: number;
  to: number;
  elapsed: number;
  moving: number;
  meters: number;
  /** The span misses the recording: no samples, no numbers. */
  empty: boolean;
  /** At least one sample lies inside. */
  samples: boolean;
}

/** Throws on a span that isn't one: a non-finite end, or ends reversed. */
function checkSpan(span: Span): void {
  const { fromSeconds: a, toSeconds: b } = span;
  if (!Number.isFinite(a) || !Number.isFinite(b))
    throw new RangeError(`span ends must be finite seconds, got [${a}, ${b}]`);
  if (a > b) throw new RangeError(`span starts after it ends: [${a}, ${b}]`);
}

/** Whether a span lies wholly outside the recording: before or after its
 *  extent, or a recording with nothing in it (no samples and no pool
 *  lengths). */
function outside(s: Samples, span: Span): boolean {
  const { from, to } = s.prep.extent;
  if (s.t.length === 0 && !s.poolLengths) return true;
  return span.toSeconds < from || span.fromSeconds > to;
}

/** Times within this of a sample count as on it (float noise from
 *  distance-to-time lookups). */
const EPS = 1e-9;

/** The first sample at or after `sec`, or `n` when none. */
function firstAtOrAfter(t: Float64Array, sec: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! < sec - EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The last sample at or before `sec`, or -1 when none. */
function lastAtOrBefore(t: Float64Array, sec: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! <= sec + EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Metres in [a, b], on the activity's one distance axis. */
function metersIn(s: Samples, a: number, b: number): number {
  const d = distanceAtSeconds(s.prep, b) - distanceAtSeconds(s.prep, a);
  return fin(d) ? d : 0;
}

/**
 * The span measured on the recording. Its time, moving time and distance
 * run between its own ends (held to the recording), drawn straight between
 * samples, so a split from 1 km to 2 km measures 1 km. Its channel numbers
 * come only from the samples inside it (`lo`…`hi`); a span between two
 * samples has none.
 */
function measure(s: Samples, span: Span): Window {
  checkSpan(span);
  if (outside(s, span)) {
    const at = s.t.length ? indexAt(s.t, span.fromSeconds) : 0;
    return {
      lo: at,
      hi: at,
      from: span.fromSeconds,
      to: span.fromSeconds,
      elapsed: 0,
      moving: 0,
      meters: 0,
      empty: true,
      samples: false,
    };
  }
  const a = Math.max(span.fromSeconds, s.prep.extent.from);
  const b = Math.min(span.toSeconds, s.prep.extent.to);
  const lo = firstAtOrAfter(s.t, a);
  const hi = lastAtOrBefore(s.t, b);
  return {
    lo,
    hi,
    from: a,
    to: b,
    // with no timestamps the sample axis is a count, not seconds
    elapsed: s.hasTime ? b - a : 0,
    moving: movingSecondsIn(s.prep, a, b),
    meters: metersIn(s, a, b),
    empty: false,
    samples: lo <= hi,
  };
}

/** How many samples the speed's running median spans. */
const SPEED_MEDIAN = 5;
const steadyCache = new WeakMap<Samples, Float64Array>();

/**
 * Speed with one- and two-sample jumps taken out: the median of the five
 * samples around each one. GPS speed jumps when one fix lands wide (a ride
 * showed 188 mph for a second), and first / last / min / max are single
 * samples, so they would show the jump. The averages are distance over time
 * and don't need it.
 */
function steadySpeed(s: Samples): Float64Array {
  const hit = steadyCache.get(s);
  if (hit) return hit;
  const n = s.speed.length;
  const out = new Float64Array(n);
  const half = SPEED_MEDIAN >> 1;
  const win: number[] = [];
  for (let i = 0; i < n; i++) {
    win.length = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++)
      if (fin(s.speed[k])) win.push(s.speed[k]!);
    if (!fin(s.speed[i]) || !win.length) {
      out[i] = NaN;
      continue;
    }
    win.sort((a, b) => a - b);
    const m = win.length >> 1;
    out[i] = win.length % 2 ? win[m]! : (win[m - 1]! + win[m]!) / 2;
  }
  steadyCache.set(s, out);
  return out;
}

function statsOf(s: Samples, w: Window): SectionStats {
  const { lo, hi } = w;
  const channels: Partial<Record<StatChannel, ChannelStats>> = {};
  if (!w.samples) {
    // no sample inside: the time and distance still hold, no channel does
    return {
      fromSeconds: w.from,
      toSeconds: w.to,
      elapsedSeconds: w.elapsed,
      movingSeconds: w.moving,
      distanceMeters: w.meters,
      channels,
    };
  }
  if (s.hasTime && s.t.length > 1 && w.elapsed > 0) {
    const sp = steadySpeed(s);
    // A sample's speed is over the gap before it: count it when the window
    // starts inside that gap, else start from the next sample.
    const from = lo >= 1 && w.from < s.t[lo]! - EPS ? lo : lo + 1;
    const t = tally(s, sp, from, hi, w);
    const e = ends(sp, from, hi);
    const speed = defined<ChannelStats>({
      first: e.first,
      last: e.last,
      min: t.n ? t.min : undefined,
      max: t.n ? t.max : undefined,
      minMoving: t.movingN ? t.movingMin : undefined,
      maxMoving: t.movingN ? t.movingMax : undefined,
      avg: w.meters > 0 ? w.meters / w.elapsed : undefined,
      avgMoving: w.meters > 0 && w.moving > 0 ? w.meters / w.moving : undefined,
    });
    if (Object.keys(speed).length) channels.speed = speed;
  }
  for (const ch of ['hr', 'power', 'cadence', 'elevation'] as const) {
    const vals = s[ch];
    if (!vals) continue;
    const t = tally(s, vals, lo, hi, w);
    if (!t.n) continue;
    const e = ends(vals, lo, hi);
    const c: Loose<ChannelStats> = {
      first: e.first,
      last: e.last,
      min: t.min,
      max: t.max,
      avg: t.sum / t.n,
      avgMoving: t.movingN ? t.movingSum / t.movingN : undefined,
      minMoving: t.movingN ? t.movingMin : undefined,
      maxMoving: t.movingN ? t.movingMax : undefined,
    };
    if (ch === 'power') {
      c.np = windowNp(s, vals, w, false);
      c.movingNp = windowNp(s, vals, w, true);
    }
    if (ch === 'elevation') {
      const { gainMeters, lossMeters } = geo.elevationGainLoss(
        vals.subarray(lo, hi + 1),
      );
      c.gain = gainMeters;
      c.loss = lossMeters;
    }
    channels[ch] = defined<ChannelStats>(c);
  }
  return {
    fromSeconds: s.t[lo]!,
    toSeconds: s.t[hi]!,
    elapsedSeconds: w.elapsed,
    movingSeconds: w.moving,
    distanceMeters: w.meters,
    channels,
  };
}

/** Normalized power over a span (all samples), `undefined` when the span
 *  misses the recording or holds no power. */
export function spanNormalizedPower(
  prep: PreparedActivity,
  span: Span,
): number | undefined {
  const s = samplesOf(prep);
  if (!s.power) return undefined;
  const w = measure(s, span);
  return !w.samples ? undefined : windowNp(s, s.power, w, false);
}

/** The sample indexes a section covers, both ends included (snapped as
 *  {@link sectionStats} snaps them); null when the span misses the
 *  recording. @internal */
export function sectionWindow(
  prep: PreparedActivity,
  span: Span,
): { lo: number; hi: number } | null {
  const w = measure(samplesOf(prep), span);
  return !w.samples ? null : { lo: w.lo, hi: w.hi };
}

/** A section's ends held to the recording, seconds from the start; null
 *  when the span misses it. @internal */
export function sectionBounds(
  prep: PreparedActivity,
  span: Span,
): { from: number; to: number } | null {
  const w = measure(samplesOf(prep), span);
  return w.empty ? null : { from: w.from, to: w.to };
}

/** The stats for one section of a prepared activity. Throws `RangeError` on
 *  a span with a non-finite end or ends reversed; a span that misses the
 *  recording gives zeros and no channels. */
export function sectionStats(prep: PreparedActivity, span: Span): SectionStats {
  const s = samplesOf(prep);
  return statsOf(s, measure(s, span));
}

function extremesOf(vals: (number | undefined)[]) {
  let lo: number | undefined;
  let hi: number | undefined;
  vals.forEach((v, i) => {
    if (!fin(v)) return;
    if (lo === undefined || v < vals[lo]!) lo = i;
    if (hi === undefined || v > vals[hi]!) hi = i;
  });
  return lo === undefined || hi === undefined
    ? undefined
    : { lowest: vals[lo]!, lowestAt: lo, highest: vals[hi]!, highestAt: hi };
}

/** The stats for a group of sections (a type of lap, all the splits). */
export function sectionGroupStats(
  prep: PreparedActivity,
  spans: readonly Span[],
): SectionGroupStats {
  const s = samplesOf(prep);
  const windows = spans.map((r) => measure(s, r));
  const sections = windows.map((w) => statsOf(s, w));
  const timeElapsed = windows.reduce((a, w) => a + w.elapsed, 0);
  const timeMoving = windows.reduce((a, w) => a + w.moving, 0);
  const meters = windows.reduce((a, w) => a + w.meters, 0);
  const channels: Partial<Record<StatChannel, GroupChannelStats>> = {};
  for (const ch of STAT_CHANNELS) {
    if (!sections.some((x) => x.channels[ch])) continue;
    const out: GroupChannelStats = {};
    let min = Infinity;
    let max = -Infinity;
    let mMin = Infinity;
    let mMax = -Infinity;
    for (const x of sections) {
      const c = x.channels[ch];
      if (fin(c?.min) && c.min < min) min = c.min;
      if (fin(c?.max) && c.max > max) max = c.max;
      if (fin(c?.minMoving) && c.minMoving < mMin) mMin = c.minMoving;
      if (fin(c?.maxMoving) && c.maxMoving > mMax) mMax = c.maxMoving;
    }
    if (min <= max) {
      out.min = min;
      out.max = max;
    }
    if (mMin <= mMax) {
      out.minMoving = mMin;
      out.maxMoving = mMax;
    }
    if (ch === 'elevation') {
      out.gain = sections.reduce(
        (a, x) => a + (x.channels.elevation?.gain ?? 0),
        0,
      );
      out.loss = sections.reduce(
        (a, x) => a + (x.channels.elevation?.loss ?? 0),
        0,
      );
    }
    if (ch === 'speed') {
      if (meters > 0 && timeElapsed > 0) out.avg = meters / timeElapsed;
      if (meters > 0 && timeMoving > 0) out.avgMoving = meters / timeMoving;
    } else {
      const vals = s[ch]!;
      let sum = 0;
      let n = 0;
      let mSum = 0;
      let mN = 0;
      // each sample once, though touching sections share their end one;
      // a shared sample is moving if it is moving in either section, so
      // the order of the sections doesn't matter
      const inAny = new Uint8Array(vals.length);
      const movingInAny = new Uint8Array(vals.length);
      for (const w of windows) {
        if (!w.samples) continue;
        for (let i = w.lo; i <= w.hi; i++) {
          if (!fin(vals[i])) continue;
          inAny[i] = 1;
          if (movingSample(s, w, i)) movingInAny[i] = 1;
        }
      }
      for (let i = 0; i < vals.length; i++) {
        if (!inAny[i]) continue;
        sum += vals[i]!;
        n++;
        if (movingInAny[i]) {
          mSum += vals[i]!;
          mN++;
        }
      }
      if (n) out.avg = sum / n;
      if (mN) out.avgMoving = mSum / mN;
    }
    const avg = extremesOf(sections.map((x) => x.channels[ch]?.avg));
    if (avg) Object.assign(out, avg);
    const mov = extremesOf(sections.map((x) => x.channels[ch]?.avgMoving));
    if (mov)
      Object.assign(out, {
        lowestMoving: mov.lowest,
        lowestMovingAt: mov.lowestAt,
        highestMoving: mov.highest,
        highestMovingAt: mov.highestAt,
      });
    if (Object.keys(out).length) channels[ch] = out;
  }
  return {
    count: spans.length,
    elapsedSeconds: timeElapsed,
    movingSeconds: timeMoving,
    distanceMeters: meters,
    channels,
    sections,
  };
}

/** Longest gap between two samples that still carries the later sample's
 *  power; the rest of a longer gap (a dropout, a pause) counts as 0 W. */
const POWER_GAP_SEC = 5;

/**
 * The highest average power held for `seconds` inside any one of the spans (a
 * window never crosses from one span into the next). Time-weighted on a
 * one-second grid: each sample's power covers the time just before it, up to
 * 5 s; beyond that a gap counts as 0 W, so a spike after a dropout isn't a
 * minute's effort. `moving`: the moving time alone, on a clock that stops
 * while stopped. `undefined` when no span is that long, or there's no power.
 *
 * Not the same rule as {@link powerBestEfforts} / the power curve, which
 * clamp a gap's time (to 10 s) and hold the sample's power over it; here
 * only 5 s of a gap carries power. The stricter rule is for laps and
 * intervals, where a dropout followed by a spike would otherwise pass for
 * a minute's effort.
 */
export function bestAveragePower(
  prep: PreparedActivity,
  spans: readonly Span[],
  seconds: number,
  options: { moving?: boolean } = {},
): number | undefined {
  spans.forEach(checkSpan);
  const s = samplesOf(prep);
  const watts = s.power;
  if (!watts || !(seconds > 0)) return undefined;
  const w = Math.round(seconds);
  let best = -Infinity;
  for (const span of spans) {
    if (outside(s, span)) continue;
    const lo = indexAt(s.t, span.fromSeconds);
    const hi = indexAt(s.t, span.toSeconds);
    const grid: number[] = [];
    let clock = 0;
    for (let i = lo + 1; i <= hi; i++) {
      if (options.moving && !movingBefore(s, i)) continue;
      const dt = s.t[i]! - s.t[i - 1]!;
      if (!(dt > 0)) continue;
      const v = watts[i];
      const from = Math.round(clock);
      clock += dt;
      const to = Math.round(clock);
      // the power holds over the last 5 s before the sample at most
      const held = to - Math.round(Math.min(dt, POWER_GAP_SEC));
      for (let k = from; k < to; k++) grid.push(fin(v) && k >= held ? v : 0);
    }
    if (grid.length < w) continue;
    let sum = 0;
    for (let k = 0; k < grid.length; k++) {
      sum += grid[k]!;
      if (k >= w) sum -= grid[k - w]!;
      if (k >= w - 1 && sum / w > best) best = sum / w;
    }
  }
  return best > -Infinity ? best : undefined;
}

/** A clock that only runs while moving (see {@link MovingClock}), by the same
 *  rule as the moving time: a pool swim's swum stretches, else the moving
 *  sample gaps. */
export function movingClock(prep: PreparedActivity): MovingClock {
  const s = samplesOf(prep);
  const spans = s.movingSpans;
  if (spans) {
    // a pool swim: the clock runs inside its swum stretches, exactly
    const before = (sec: number) => overlapSeconds(spans, -Infinity, sec);
    return {
      at(sec) {
        const inside = spans.some(([a, b]) => sec >= a && sec <= b);
        return inside ? before(sec) : null;
      },
      upTo: before,
    };
  }
  const n = s.t.length;
  // moving seconds up to each sample, and whether the time before it moved
  const upTo = new Float64Array(n);
  const moved = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    const m = movingBefore(s, i);
    moved[i] = m ? 1 : 0;
    upTo[i] = upTo[i - 1]! + (m ? s.t[i]! - s.t[i - 1]! : 0);
  }
  /** The first sample at or after sec (1 … n-1). */
  const after = (sec: number) => {
    let lo = 1;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.t[mid]! < sec) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return {
    at(sec) {
      if (n < 2 || sec <= s.t[0]!) return 0;
      if (sec >= s.t[n - 1]!) return moved[n - 1] ? upTo[n - 1]! : null;
      const i = after(sec);
      if (!moved[i]) return null;
      return upTo[i - 1]! + (sec - s.t[i - 1]!);
    },
    upTo(sec) {
      if (n < 2 || sec <= s.t[0]!) return 0;
      if (sec >= s.t[n - 1]!) return upTo[n - 1]!;
      const i = after(sec);
      return upTo[i - 1]! + (moved[i] ? sec - s.t[i - 1]! : 0);
    },
  };
}
