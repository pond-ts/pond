/**
 * Recovery during a run: the stops and walk breaks inside it, and how far
 * heart rate fell in each. One reading after the end of a run says little on its own,
 * because how far heart rate falls depends on how high it was and how long
 * you stood. A run with traffic lights or walk breaks holds many small
 * recoveries, each with its own starting heart rate and length, and those
 * can be compared like for like across months.
 *
 * Ported from Estela (docs/heart-rate-recovery.md there, "Stops and walk
 * breaks").
 *
 * Found from the track's distance (or GPS line), time and heart rate. Small
 * enough to keep with an activity's record, so runs can be compared without
 * opening each track. Look for breaks in runs only: elsewhere a slow stretch
 * is mostly the activity itself (a hike's climb, a ride's corner).
 */
import type { GeoPoint } from '../types.js';
import { haversineMeters } from '../geo/index.js';

/** A full stop (standing still) or a walk break. */
export type BreakKind = 'stop' | 'walk';

/** The seconds into a break that heart rate is read at. */
export const BREAK_OFFSETS = [15, 30, 45, 60, 90, 120] as const;

/** Bump when {@link findBreaks} changes, so stored breaks are found again. */
export const BREAKS_VERSION = 3;

export interface RunBreak {
  /** Seconds from the activity's start when the slowdown began (found from
   *  speed over 10 s, so a sudden stop shows a few seconds early). */
  startSec: number;
  kind: BreakKind;
  /** How long it lasted, seconds. */
  seconds: number;
  /** Heart rate over the 15 seconds before the slowdown. */
  startBpm: number;
  /** Heart rate at each of {@link BREAK_OFFSETS} seconds into the break,
   *  null where the break had ended or there was no reading. */
  bpmAt: (number | null)[];
}

/** The parts of a track this reads ({@link ActivityStreams} fits). A
 *  missing sample may be `null` or NaN. */
export interface BreakStreams {
  timeSeconds?: readonly number[] | undefined;
  distanceMeters?: readonly (number | null)[] | undefined;
  heartrate?: readonly (number | null)[] | undefined;
  latlng?: readonly (GeoPoint | null)[] | undefined;
}

/** Shortest break kept, seconds. */
const MIN_BREAK = 30;
/** Running needed before a break, seconds, so heart rate was up. */
const RUN_BEFORE = 60;
/** Share of {@link RUN_BEFORE} that must be running (a city run has short
 *  stops close together). */
const RUN_BEFORE_SHARE = 0.6;
/** Heart rate before the break must be at least this share of the run's
 *  middle heart rate: a break while still warming up is left out. */
const START_HR_SHARE = 0.9;
/** Slower than this share of the run's usual speed counts as a break,
 *  unless the run's speeds fall into a walking and a running group (see
 *  {@link slowCutOff}). */
const SLOW_SHARE = 0.75;
/** A walking group must be at least this share of the moving seconds… */
const WALK_GROUP_SHARE = 0.03;
/** …and under this share (more and it's the run, e.g. easy running with
 *  fast pickups)… */
const WALK_GROUP_MAX_SHARE = 0.5;
/** …at most this share of the running group's speed… */
const WALK_GROUP_MAX = 0.8;
/** …and at walking speed on average (m/s, about 13:25/mile), so jogged
 *  recoveries between fast reps aren't taken for walks. */
const WALK_MAX_MPS = 2;
/** Seconds within this much (m/s) of a speed count as "near" it, when
 *  comparing how many seconds sit in the gap with how many at walking speed. */
const GAP_HALF_WIDTH = 0.1;
/** Slower than this (m/s) counts as standing still. */
const STILL_MPS = 0.5;
/** A run whose usual speed is below this (m/s, about 10:25/km) is mostly
 *  walking, and has no breaks to find. */
const MIN_RUN_MPS = 1.6;
/** Speed is measured over this many seconds each side. */
const SPEED_HALF_WINDOW = 5;
/** A faster stretch shorter than this doesn't end a break (a few steps). */
const MERGE_GAP = 6;
/** No sample for longer than this (the watch paused) and the stretch is
 *  left out: what happened in it isn't known. */
const MAX_SAMPLE_GAP = 10;
/** A heart rate reading counts for a moment within this many seconds. */
const READ_WITHIN = 4;
/** Heart rate before the slowdown is the average over this many seconds. */
const START_WINDOW = 15;

const isHr = (b: number | null | undefined): b is number =>
  typeof b === 'number' && Number.isFinite(b) && b >= 25 && b <= 250;

const fix = (p: GeoPoint | null | undefined): p is GeoPoint =>
  !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Distance from the start at each sample (the recorded distance, else
 *  measured along the GPS line), and whether it is known there (a missing
 *  distance or fix is not; the next known one takes up the distance
 *  covered). */
function distances(
  s: BreakStreams,
  n: number,
): { d: number[]; ok: boolean[] } | undefined {
  const rec = s.distanceMeters;
  const d: number[] = [];
  const ok: boolean[] = [];
  if (rec && rec.length === n) {
    let prev = 0;
    for (const v of rec) {
      const has = typeof v === 'number' && Number.isFinite(v);
      if (has) prev = v;
      d.push(prev);
      ok.push(has);
    }
    return { d, ok };
  }
  const line = s.latlng;
  if (!line || line.length !== n) return undefined;
  let last: GeoPoint | undefined;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = line[i];
    const has = fix(p);
    if (has) {
      if (last) total += haversineMeters(last[0], last[1], p[0], p[1]);
      last = p;
    }
    d.push(total);
    ok.push(has);
  }
  return { d, ok };
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The value a share `q` of the way through, between neighbours. */
function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

const mean = (xs: readonly number[]) =>
  xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Where "slow" starts, from the speeds of a run's moving seconds. On a
 * run/walk run they fall in two groups, walking and running, with few
 * seconds between; the cut-off goes in that gap, so a walk whose speed
 * wavers isn't cut into pieces. The split is the one that keeps each group's
 * speeds closest together (Otsu's method), and is used only when the slower
 * group is big enough, clearly slower, and the gap holds fewer seconds than
 * the walking speeds do (and the slower group is under half the seconds and
 * at walking speed). Otherwise slow is under three quarters of the usual
 * speed. `usual` is the running group's middle speed when there are two
 * groups, else the middle speed of all moving seconds. Both are 0 for no
 * speeds.
 */
export function slowCutOff(moving: readonly number[]): {
  usual: number;
  cut: number;
} {
  if (moving.length === 0) return { usual: 0, cut: 0 };
  const usual = median(moving);
  const plain = { usual, cut: SLOW_SHARE * usual };
  const s = [...moving].sort((a, b) => a - b);
  const n = s.length;
  if (n < 2 * MIN_BREAK) return plain;
  // Running sums, to score every split quickly.
  const sum = [0];
  for (const v of s) sum.push(sum[sum.length - 1]! + v);
  let best = -1;
  let at = 0;
  for (let k = 1; k < n; k++) {
    if (s[k] === s[k - 1]) continue;
    const m0 = sum[k]! / k;
    const m1 = (sum[n]! - sum[k]!) / (n - k);
    const score = k * (n - k) * (m1 - m0) ** 2;
    if (score > best) {
      best = score;
      at = k;
    }
  }
  if (at === 0) return plain;
  const walk = s.slice(0, at);
  const run = s.slice(at);
  const cut = (s[at - 1]! + s[at]!) / 2;
  const walkMean = mean(walk);
  const runUsual = median(run);
  const near = (c: number) =>
    s.filter((v) => Math.abs(v - c) <= GAP_HALF_WIDTH).length;
  const twoGroups =
    walk.length >= Math.max(MIN_BREAK, WALK_GROUP_SHARE * n) &&
    walk.length < WALK_GROUP_MAX_SHARE * n &&
    walkMean <= WALK_MAX_MPS &&
    walkMean <= WALK_GROUP_MAX * mean(run) &&
    near(cut) * 2 <= near(walkMean);
  return twoGroups ? { usual: runUsual, cut } : plain;
}

/**
 * The stops and walk breaks in a run: each stretch of at least 30 seconds
 * slower than the run's cut-off between walking and running (see
 * {@link slowCutOff}), after a minute mostly running, and with running again
 * after it (the walk or stand once the run is over is the end-of-run
 * recovery, not a break), with heart rate before it near the run's usual (so
 * not while warming up). One where you stood still for most of it is a
 * stop; else a walk break. Where the watch paused (no samples for over 10
 * seconds) heart rate isn't known: a break is cut off where a pause starts,
 * and one with a pause in the minute before it is left out.
 */
export function findBreaks(s: BreakStreams): RunBreak[] {
  const t = s.timeSeconds;
  const hr = s.heartrate;
  if (!t || !hr || t.length < 2 || hr.length !== t.length) return [];
  const measured = distances(s, t.length);
  if (!measured) return [];
  const { d, ok } = measured;
  if (!hr.some(isHr)) return [];

  // One value a second: distance between samples is drawn straight, and a
  // second inside a pause is marked unknown. A sample with no distance (or
  // no fix) is passed over, so a stretch of them counts as a pause: unknown
  // when it runs past 10 s, else drawn straight across.
  const kt: number[] = [];
  const kd: number[] = [];
  for (let i = 0; i < t.length; i++)
    if (ok[i]) {
      kt.push(t[i]!);
      kd.push(d[i]!);
    }
  if (kt.length < 2) return [];
  const t0 = t[0]!;
  const len = Math.floor(t[t.length - 1]! - t0) + 1;
  if (len < RUN_BEFORE + MIN_BREAK) return [];
  const dist = new Float64Array(len);
  const known = new Uint8Array(len);
  const kLast = kt.length - 1;
  let j = 0;
  for (let sec = 0; sec < len; sec++) {
    const at = t0 + sec;
    while (j < kLast - 1 && kt[j + 1]! <= at) j++;
    const ta = kt[j]!;
    const tb = kt[j + 1]!;
    const f = tb > ta ? Math.min(1, Math.max(0, (at - ta) / (tb - ta))) : 0;
    dist[sec] = kd[j]! + f * (kd[j + 1]! - kd[j]!);
    known[sec] =
      at >= kt[0]! && at <= kt[kLast]! && tb - ta <= MAX_SAMPLE_GAP ? 1 : 0;
  }
  const speed = new Float64Array(len);
  for (let sec = 0; sec < len; sec++) {
    const a = Math.max(0, sec - SPEED_HALF_WINDOW);
    const b = Math.min(len - 1, sec + SPEED_HALF_WINDOW);
    speed[sec] = b > a ? (dist[b]! - dist[a]!) / (b - a) : 0;
  }
  const moving: number[] = [];
  for (let sec = 0; sec < len; sec++)
    if (known[sec] && speed[sec]! > 1) moving.push(speed[sec]!);
  if (moving.length < RUN_BEFORE) return [];
  // Mostly walking: judged on all moving seconds, not the running group.
  if (median(moving) < MIN_RUN_MPS) return [];
  const { cut: slowBelow } = slowCutOff(moving);
  const slow = (sec: number) => speed[sec]! < slowBelow;

  // Slow stretches, joined across a few faster seconds.
  const spans: [number, number][] = [];
  let open = -1;
  let fastRun = 0;
  for (let sec = 0; sec < len; sec++) {
    if (slow(sec)) {
      if (open < 0) open = sec;
      fastRun = 0;
    } else if (open >= 0 && ++fastRun > MERGE_GAP) {
      spans.push([open, sec - fastRun]);
      open = -1;
      fastRun = 0;
    }
  }
  // A slow stretch still open when the recording ends is the finish, not a
  // break, so it isn't kept.

  // Heart rate samples by second from the start, for reading.
  const hrAt: { sec: number; bpm: number }[] = [];
  for (let i = 0; i < t.length; i++) {
    const bpm = hr[i];
    if (isHr(bpm)) hrAt.push({ sec: t[i]! - t0, bpm });
  }
  const readNear = (sec: number): number | null => {
    let best: { sec: number; bpm: number } | undefined;
    for (const x of hrAt) {
      if (x.sec < sec - READ_WITHIN) continue;
      if (x.sec > sec + READ_WITHIN) break;
      if (!best || Math.abs(x.sec - sec) < Math.abs(best.sec - sec)) best = x;
    }
    return best ? best.bpm : null;
  };
  const averageOver = (from: number, to: number): number | undefined => {
    let sum = 0;
    let n = 0;
    for (const x of hrAt) {
      if (x.sec < from) continue;
      if (x.sec >= to) break;
      sum += x.bpm;
      n++;
    }
    return n ? sum / n : undefined;
  };

  const runBpm = median(hrAt.map((x) => x.bpm));
  const out: RunBreak[] = [];
  for (const [from, end] of spans) {
    // Cut off where the watch paused (auto-pause at a crossing, or a watch
    // that records seldom while still): what's before the pause is known.
    let to = end;
    for (let sec = from; sec <= end; sec++)
      if (!known[sec]) {
        to = sec - 1;
        break;
      }
    const seconds = to - from + 1;
    const before = from - RUN_BEFORE;
    if (seconds < MIN_BREAK || before < 0) continue;
    let running = 0;
    let gap = false;
    for (let sec = before; sec < from; sec++) {
      if (!known[sec]) gap = true;
      if (!slow(sec)) running++;
    }
    if (gap || running < RUN_BEFORE_SHARE * RUN_BEFORE) continue;
    const startBpm = averageOver(from - START_WINDOW, from);
    if (startBpm === undefined || startBpm < START_HR_SHARE * runBpm) continue;
    let still = 0;
    for (let sec = from; sec <= to; sec++) if (speed[sec]! < STILL_MPS) still++;
    const bpmAt = BREAK_OFFSETS.map((o) =>
      o <= seconds ? readNear(from + o) : null,
    );
    if (bpmAt.every((b) => b === null)) continue;
    out.push({
      startSec: from,
      kind: still >= seconds / 2 ? 'stop' : 'walk',
      seconds,
      startBpm: Math.round(startBpm),
      bpmAt,
    });
  }
  return out;
}

/** One break of a past run, for comparing. */
export interface PastBreak {
  activityId: string;
  /** The run's start, ISO UTC. */
  startUtc: string;
  kind: BreakKind;
  startBpm: number;
  /** Heart rate at the compared offset. */
  bpm: number;
}

/** The breaks of these runs that lasted to `offset` seconds and have a
 *  reading there, oldest run first. */
export function pastBreaks(
  runs: readonly {
    id: string;
    breaks?: RunBreak[] | undefined;
    activity: { startTimeUtc: string };
  }[],
  offset: (typeof BREAK_OFFSETS)[number],
): PastBreak[] {
  const k = BREAK_OFFSETS.indexOf(offset);
  const out: PastBreak[] = [];
  for (const r of runs)
    for (const b of r.breaks ?? []) {
      const bpm = b.bpmAt[k];
      if (typeof bpm === 'number')
        out.push({
          activityId: r.id,
          startUtc: r.activity.startTimeUtc,
          kind: b.kind,
          startBpm: b.startBpm,
          bpm,
        });
    }
  return out.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

/** One point of the over-time line: the 30 days up to a run. */
export interface BreakTrendPoint {
  /** The run the window ends at. */
  activityId: string;
  startUtc: string;
  /** The typical fall over the window, adjusted to {@link BreakTrend.refBpm}. */
  fallBpm: number;
  /** The middle half of the window's adjusted falls: a quarter fell less
   *  than `lowBpm`, a quarter more than `highBpm`. */
  lowBpm: number;
  highBpm: number;
  /** How many breaks the window holds. */
  count: number;
}

export interface BreakTrend {
  kind: BreakKind;
  /** The starting heart rate falls are adjusted to. */
  refBpm: number;
  /** bpm more fall for each bpm higher at the start, from all the breaks. */
  slope: number;
  /** Whether there were enough breaks, spread widely enough, to measure
   *  {@link slope}; when not, it is 0 and nothing was adjusted. */
  adjusted: boolean;
  points: BreakTrendPoint[];
}

/** Days in each window. */
export const TREND_DAYS = 30;
/** Fewest breaks a window needs for a point. */
export const TREND_MIN_BREAKS = 5;
/** Fewest breaks, and spread of starting heart rates, needed to measure how
 *  the fall changes with the starting heart rate. */
const SLOPE_MIN_BREAKS = 10;
const SLOPE_MIN_SPREAD = 5;

/**
 * How far heart rate typically fell, `offset` seconds into a break, over the
 * 30 days up to each run:
 *
 * 1. Across all the breaks of this kind, how much more heart rate falls for
 *    each beat higher it was at the start (a straight-line fit). Fewer than
 *    10 breaks, or starting heart rates within 5 bpm of each other, and no
 *    adjustment is made.
 * 2. Each break's fall is moved to what it would be from one starting heart
 *    rate: `refBpm`, by default the middle one of these breaks (rounded to
 *    5; pass one {@link trendRefBpm} of all kinds to compare stops with walk
 *    breaks).
 * 3. For each run, the middle adjusted fall of the breaks in the 30 days up
 *    to and including it, when there are at least 5.
 *
 * So a point is "in the month up to this run, from a start of 140, heart
 * rate fell by about N after 30 seconds", and points can be compared.
 */
export function breakTrend(
  breaks: readonly PastBreak[],
  kind: BreakKind,
  refBpm = trendRefBpm(breaks.filter((b) => b.kind === kind)),
): BreakTrend | undefined {
  // Oldest run first, each run's breaks together (any order in).
  const xs = breaks
    .filter((b) => b.kind === kind)
    .map((b) => ({ b, ms: Date.parse(b.startUtc) }))
    .sort((x, y) => x.ms - y.ms || x.b.activityId.localeCompare(y.b.activityId))
    .map((x) => x.b);
  if (xs.length < TREND_MIN_BREAKS) return undefined;
  const fitted = fitSlope(xs);
  const slope = fitted ?? 0;
  const adjusted = xs.map((b) => ({
    b,
    ms: Date.parse(b.startUtc),
    fall: b.startBpm - b.bpm - slope * (b.startBpm - refBpm),
  }));
  const points: BreakTrendPoint[] = [];
  const window = TREND_DAYS * 86_400_000;
  const seen = new Set<string>();
  let from = 0;
  for (let i = 0; i < adjusted.length; i++) {
    const end = adjusted[i]!;
    // The last break of each run closes that run's window.
    if (adjusted[i + 1]?.b.activityId === end.b.activityId) continue;
    if (seen.has(end.b.activityId)) continue;
    seen.add(end.b.activityId);
    while (adjusted[from]!.ms <= end.ms - window) from++;
    const inWindow = adjusted.slice(from, i + 1).map((x) => x.fall);
    if (inWindow.length < TREND_MIN_BREAKS) continue;
    points.push({
      activityId: end.b.activityId,
      startUtc: end.b.startUtc,
      fallBpm: Math.round(median(inWindow) * 10) / 10,
      lowBpm: Math.round(quantile(inWindow, 0.25) * 10) / 10,
      highBpm: Math.round(quantile(inWindow, 0.75) * 10) / 10,
      count: inWindow.length,
    });
  }
  return {
    kind,
    refBpm,
    slope: Math.round(slope * 100) / 100,
    adjusted: fitted !== undefined,
    points,
  };
}

/** The middle starting heart rate of these breaks, rounded to 5. */
export function trendRefBpm(breaks: readonly PastBreak[]): number {
  return breaks.length
    ? Math.round(median(breaks.map((b) => b.startBpm)) / 5) * 5
    : 0;
}

/** Least-squares slope of fall on starting heart rate; undefined when
 *  there's too little to go on. */
function fitSlope(xs: readonly PastBreak[]): number | undefined {
  if (xs.length < SLOPE_MIN_BREAKS) return undefined;
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (const b of xs) {
    mx += b.startBpm;
    my += b.startBpm - b.bpm;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (const b of xs) {
    const dx = b.startBpm - mx;
    sxx += dx * dx;
    sxy += dx * (b.startBpm - b.bpm - my);
  }
  if (Math.sqrt(sxx / n) < SLOPE_MIN_SPREAD) return undefined;
  // A higher start falls further, by at most beat for beat; outside that
  // the fit is following noise, so it is held to 0..1.
  return Math.min(1, Math.max(0, sxy / sxx));
}
