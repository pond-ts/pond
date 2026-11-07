/**
 * Swim stroke metrics over the lengths of a pool swim (RFC §16.4):
 * `swim.analyze().technique`.
 *
 * Counts keep their convention. Garmin counts cycles of the watch arm (one
 * per two arm pulls in freestyle), so a stroke rate here is cycles per
 * minute and distance per stroke is distance per cycle. Nothing is
 * normalised to arm pulls, since the mapping depends on the stroke.
 *
 * Only lengths wholly inside the section count, and only those with a
 * stroke count and a time; drill lengths never count (their count, if any,
 * isn't a swimming stroke). SWOLF (seconds per length + strokes per length)
 * is descriptive, not a technique score: compare it only within the same
 * pool, stroke and convention.
 */
import type { PreparedActivity } from '../summary/index.js';
import type { Span } from '../stats/index.js';
import { Distance, Duration } from '../quantities.js';

/** How the strokes were counted. `'arm-cycles'`: cycles of the arm wearing
 *  the watch (Garmin). `'unknown'`: the maker doesn't say. */
export type StrokeCounting = 'arm-cycles' | 'unknown';

export interface StrokeConvention {
  counts: StrokeCounting;
  /** The device maker, as the file names it, or null. */
  source: string | null;
}

export interface Technique {
  /** Lengths that counted. */
  lengths: number;
  /** The one stroke they were all swum in, `'mixed'` for several, or null
   *  when the watch didn't say. */
  stroke: string | null;
  /** Strokes counted over those lengths. */
  strokes: number;
  /** Average strokes per length. */
  strokesPerLength: number;
  /** Strokes per minute of swimming (cycles per minute for arm cycles). */
  strokeRate: number;
  /** Distance per stroke (per cycle for arm cycles); null without the pool
   *  length. */
  distancePerStroke: Distance | null;
  /** Average seconds per length plus average strokes per length. */
  swolf: number;
  /** Average time per length. */
  timePerLength: Duration;
  convention: StrokeConvention;
}

/** Technique over the pool lengths inside `span`; null off the pool or
 *  with no counted length there. @internal */
export function techniqueOf(
  prep: PreparedActivity,
  span: Span,
): Technique | null {
  const swim = prep.imported.swim;
  if (!swim || !prep.poolLengths) return null;
  const start = Date.parse(prep.imported.activity.startTimeUtc);
  const eps = 1e-6;
  let lengths = 0;
  let strokes = 0;
  let seconds = 0;
  const kinds = new Set<string>();
  let unnamed = false;
  for (const l of swim.lengths ?? []) {
    if (!l.active || l.stroke === 'drill') continue;
    if (!(l.seconds > 0) || l.strokes === undefined || !(l.strokes >= 0))
      continue;
    const from = (Date.parse(l.startTimeUtc) - start) / 1000;
    if (!Number.isFinite(from)) continue;
    const to = from + l.seconds;
    if (from < span.fromSeconds - eps || to > span.toSeconds + eps) continue;
    lengths++;
    strokes += l.strokes;
    seconds += l.seconds;
    if (l.stroke) kinds.add(l.stroke);
    else unnamed = true;
  }
  if (!lengths) return null;
  const poolMeters = swim.pool?.lengthMeters;
  const perLength = strokes / lengths;
  const secondsPerLength = seconds / lengths;
  return {
    lengths,
    stroke:
      kinds.size === 0
        ? null
        : kinds.size === 1 && !unnamed
          ? [...kinds][0]!
          : 'mixed',
    strokes,
    strokesPerLength: perLength,
    strokeRate: (strokes / seconds) * 60,
    distancePerStroke:
      poolMeters && poolMeters > 0 && strokes > 0
        ? Distance.meters((poolMeters * lengths) / strokes)
        : null,
    swolf: secondsPerLength + perLength,
    timePerLength: Duration.seconds(secondsPerLength),
    convention: conventionOf(prep),
  };
}

function conventionOf(prep: PreparedActivity): StrokeConvention {
  const m = prep.imported.creator?.manufacturer;
  const source = m === undefined || m === null ? null : String(m);
  // FIT manufacturer 1 is Garmin
  const garmin = source !== null && (/garmin/i.test(source) || source === '1');
  return { counts: garmin ? 'arm-cycles' : 'unknown', source };
}
