/**
 * Swim stroke metrics over the lengths of a pool swim (RFC §16.4):
 * `swim.analyze().technique`.
 *
 * Counts keep their convention. Garmin counts cycles of the watch arm (one
 * per two arm pulls in freestyle), so a stroke rate here is cycles per
 * minute and distance per stroke is distance per cycle. Nothing is
 * normalised to arm pulls, since the mapping depends on the stroke.
 *
 * Only lengths wholly inside the section count (to half a second, since lap
 * and length times are rounded differently in a file), and only those with
 * a time and a stroke count above 0 (a watch writes 0 when it couldn't
 * count, on a kick set say); drill lengths never count (their count, if
 * any, isn't a swimming stroke). Stroke rate is worked out from each
 * length's whole time, push-off and glide included, as Garmin defines it. SWOLF (seconds per length + strokes per length)
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
  /** Swum lengths inside the section left out for having no stroke count
   *  (missing or 0). Drills aren't included here. */
  uncounted: number;
  /** The one stroke the counted lengths were swum in (lengths the watch
   *  didn't name don't contradict it), `'mixed'` for several, or null when
   *  the watch named none. */
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
  const eps = 0.5;
  let lengths = 0;
  let uncounted = 0;
  let strokes = 0;
  let seconds = 0;
  const kinds = new Set<string>();
  for (const l of swim.lengths ?? []) {
    if (!l.active || l.stroke === 'drill' || !(l.seconds > 0)) continue;
    const from = (Date.parse(l.startTimeUtc) - start) / 1000;
    if (!Number.isFinite(from)) continue;
    const to = from + l.seconds;
    if (from < span.fromSeconds - eps || to > span.toSeconds + eps) continue;
    if (l.strokes === undefined || !(l.strokes > 0)) {
      uncounted++;
      continue;
    }
    lengths++;
    strokes += l.strokes;
    seconds += l.seconds;
    if (l.stroke) kinds.add(l.stroke);
  }
  if (!lengths) return null;
  const poolMeters = swim.pool?.lengthMeters;
  const perLength = strokes / lengths;
  const secondsPerLength = seconds / lengths;
  return {
    lengths,
    uncounted,
    stroke:
      kinds.size === 0 ? null : kinds.size === 1 ? [...kinds][0]! : 'mixed',
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
  // FIT manufacturer 1 is Garmin. Garmin-made devices that report as
  // Dynastream (13, 15) read as unknown: none we know of counts strokes.
  const garmin = source !== null && (/garmin/i.test(source) || source === '1');
  return { counts: garmin ? 'arm-cycles' : 'unknown', source };
}
