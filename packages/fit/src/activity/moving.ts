/**
 * When an activity counts as moving, by sport (docs/rfcs/fit-api.md §5, §12).
 *
 * - Pool swim (the record says the pool, or has length records): only while
 *   swimming a length. Its samples come one per length, too far apart for a
 *   speed rule, and its rests at the wall are its stopped time. The lengths
 *   come from the swim watch's length records; without them, from the laps
 *   that covered distance.
 * - A swim with no GPS and none of that, but the watch's own swim time
 *   (`swim.movingSeconds`): that total is the whole swim's moving time.
 *   Which samples were swimming isn't known, so a section's moving time
 *   and every channel number on a moving basis are unavailable.
 * - Everything else (run, walk, hike, ride, open water swim): the speed rule,
 *   moving at or above `MOVING_SPEED_MPS` (0.5 m/s). A ride's coasting counts
 *   as moving because the rule looks only at speed. Whether a ride should use
 *   another threshold is open (RFC §12.1).
 */
import type { ImportedActivity } from '../types.js';
import { sportOf } from './sport.js';

/** Which rule decided moving. */
export type MovingRule = 'speed' | 'pool-lengths' | 'pool-laps' | 'swim-time';

/** The rule for a record, and for a pool swim the stretches it swam
 *  (seconds from the activity's start, in order). */
export function movingRuleOf(imported: ImportedActivity): {
  rule: MovingRule;
  spans?: Array<[number, number]>;
} {
  const { activity, streams, swim, laps } = imported;
  const swimming = sportOf(activity.sportType) === 'swim' && !streams.openWater;
  if (!swimming) return { rule: 'speed' };
  const pool = !!swim?.pool || !!swim?.lengths?.some((l) => l.active);
  const noGps = !streams.latlng.some((p) => p != null);
  const swimTime =
    noGps &&
    typeof swim?.movingSeconds === 'number' &&
    Number.isFinite(swim.movingSeconds) &&
    swim.movingSeconds > 0;
  const fallback = swimTime
    ? { rule: 'swim-time' as const }
    : { rule: 'speed' as const };
  if (!pool) return fallback;
  const start = Date.parse(activity.startTimeUtc);
  const rel = (iso: string | undefined) =>
    iso ? (Date.parse(iso) - start) / 1000 : NaN;
  const lengths = (swim?.lengths ?? [])
    .filter((l) => l.active)
    .map((l): [number, number] => {
      const a = rel(l.startTimeUtc);
      return [a, a + l.seconds];
    })
    .filter(([a, b]) => Number.isFinite(a) && b > a);
  if (lengths.length) return { rule: 'pool-lengths', spans: tidy(lengths) };
  // laps with no start time follow the one before, as Activity.laps places
  // them
  let cursor = 0;
  const swum: Array<[number, number]> = [];
  for (const l of laps ?? []) {
    const t = rel(l.startTimeUtc);
    const a = Number.isFinite(t) ? t : cursor;
    cursor = a + l.elapsedSeconds;
    const b = a + (l.timerSeconds ?? l.elapsedSeconds);
    if (l.distanceMeters > 0 && b > a) swum.push([a, b]);
  }
  if (swum.length) return { rule: 'pool-laps', spans: tidy(swum) };
  return fallback;
}

/** Sorted, with overlaps merged. */
function tidy(spans: Array<[number, number]>): Array<[number, number]> {
  spans.sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Per sample i ≥ 1: whether the time just before it (from sample i-1) lies
 *  in a swum stretch, judged at its midpoint. */
export function movingMask(
  timeRel: Float64Array,
  spans: ReadonlyArray<readonly [number, number]>,
): Uint8Array {
  const n = timeRel.length;
  const out = new Uint8Array(n);
  let k = 0;
  for (let i = 1; i < n; i++) {
    const mid = (timeRel[i - 1]! + timeRel[i]!) / 2;
    while (k < spans.length && spans[k]![1] < mid) k++;
    const s = spans[k];
    if (s && mid >= s[0] && mid <= s[1]) out[i] = 1;
  }
  return out;
}
