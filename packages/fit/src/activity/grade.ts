/**
 * Grade-adjusted pace (RFC §15.1): the pace the same effort would give on
 * level ground. An estimate, not a measurement, so the result names the
 * model that made it. A metre at grade g counts as cost(g) ÷ cost(0) level
 * metres, so a stretch's grade-adjusted speed is its speed times the ratio
 * of level-equivalent metres to metres. Two families of model:
 *
 * - `'acsm-running'` (the default for runs): the American College of
 *   Sports Medicine's running equation (ACSM's Guidelines for Exercise
 *   Testing and Prescription), oxygen cost 0.2 + 0.9 × grade per metre.
 *   A climb at grade g counts 1 + 4.5 g level metres per metre. The
 *   equation doesn't cover descents, so a descent counts as level. The
 *   equation has stayed the same across the Guidelines' editions, so the id
 *   carries no year. It is validated on climbs up to about 15 %; steeper
 *   climbs read as the straight line goes on, which credits a steep hiked
 *   climb less than Minetti does. Because descents count as level, running
 *   faster downhill at the same effort reads as a faster adjusted pace.
 * - Minetti et al. (2002), "Energy cost of walking and running at extreme
 *   uphill and downhill slopes", J Appl Physiol 93: 1039–1046: the energy
 *   one metre costs at each grade, a curve fitted to treadmill
 *   measurements from −45 % to +45 % (`'minetti-2002-running'`, and
 *   `'minetti-2002-walking'`, the default for walks and hikes). Its known
 *   limit: the curve is cheapest near −20 %, where a metre costs about
 *   half a level one, so a steep descent gets a much slower adjusted pace
 *   than its recorded pace. Runners feel steep descents as harder than
 *   that (braking, footing).
 *
 * Grade comes from the elevation over 100 m of distance centred on each
 * sample (less at the ends, none under 20 m), so a few metres of GPS or
 * barometer noise don't turn into steep grades. Grades past ±45 % (the
 * Minetti curves' measured range) count as ±45 %.
 */
import {
  hasDistance,
  movingBeforeSample,
  type PreparedActivity,
} from '../summary/index.js';
import type { Span } from '../stats/index.js';
import { sportOf } from './sport.js';

/** The grade models so far: ACSM's running equation and Minetti (2002)'s
 *  running and walking curves. */
export type GradeModel =
  | 'minetti-2002-running'
  | 'minetti-2002-walking'
  | 'acsm-running';

/** Half the distance a grade is read over, in metres. */
const HALF_WINDOW_M = 50;
/** Shortest distance a grade is read over. */
const MIN_WINDOW_M = 20;
/** The curves' measured range. */
const MAX_GRADE = 0.45;

/** Cost per metre at grade `g` (a fraction: 0.1 is 10 %): J/kg/m for
 *  Minetti, mL O₂/kg/m for ACSM. Only ratios to level ground are used. */
const COST: Record<GradeModel, (g: number) => number> = {
  'acsm-running': (g) => 0.2 + 0.9 * Math.max(g, 0),
  'minetti-2002-running': (g) =>
    155.4 * g ** 5 -
    30.4 * g ** 4 -
    43.3 * g ** 3 +
    46.3 * g ** 2 +
    19.5 * g +
    3.6,
  'minetti-2002-walking': (g) =>
    280.5 * g ** 5 -
    58.7 * g ** 4 -
    76.8 * g ** 3 +
    51.9 * g ** 2 +
    19.6 * g +
    2.5,
};

/** The default model for an activity's sport: ACSM running for runs,
 *  Minetti walking for walks and hikes, none for anything else.
 *  @internal */
export function gradeModelFor(prep: PreparedActivity): GradeModel | null {
  const sport = sportOf(prep.imported.activity.sportType);
  if (sport === 'run') return 'acsm-running';
  if (sport === 'walk' || sport === 'hike') return 'minetti-2002-walking';
  return null;
}

interface Factors {
  model: GradeModel;
  /** Per sample i ≥ 1: level-equivalent metres per metre for the step
   *  ending at i; NaN where the grade isn't known. */
  factor: Float64Array;
  /** Running totals over whole moving steps 1..i (index i): metres,
   *  level-equivalent metres (unknown grade counted as level) and metres
   *  with a known grade. Index 0 is 0. */
  metres: Float64Array;
  level: Float64Array;
  known: Float64Array;
}

const cache = new WeakMap<PreparedActivity, Map<GradeModel, Factors | null>>();

/** Level-equivalent metres per metre for each step, or null without a
 *  distance or any elevation. @internal */
export function gradeFactors(
  prep: PreparedActivity,
  model: GradeModel,
): Factors | null {
  let byModel = cache.get(prep);
  if (!byModel) cache.set(prep, (byModel = new Map()));
  if (byModel.has(model)) return byModel.get(model)!;
  const f = computeFactors(prep, model);
  byModel.set(model, f);
  return f;
}

function computeFactors(
  prep: PreparedActivity,
  model: GradeModel,
): Factors | null {
  const ele = prep.cols.ele;
  const cum = prep.cum;
  const n = cum.length;
  if (!ele || ele.length !== n || !hasDistance(prep)) return null;
  // elevation against distance, from the samples that have both
  const d: number[] = [];
  const e: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = cum[i]!;
    const y = ele[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (d.length && x === d[d.length - 1]) {
      // standing still: keep the latest reading for that distance
      e[e.length - 1] = y;
      continue;
    }
    if (d.length && x < d[d.length - 1]!) continue;
    d.push(x);
    e.push(y);
  }
  if (d.length < 2) return null;
  const first = d[0]!;
  const last = d[d.length - 1]!;
  const eleAt = (x: number) => {
    let lo = 0;
    let hi = d.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid]! <= x) lo = mid;
      else hi = mid;
    }
    const x0 = d[lo]!;
    const x1 = d[hi]!;
    return x1 > x0
      ? e[lo]! + ((e[hi]! - e[lo]!) * (x - x0)) / (x1 - x0)
      : e[lo]!;
  };
  const cost = COST[model];
  const level = cost(0);
  const factor = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const a = cum[i - 1]!;
    const b = cum[i]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const mid = (a + b) / 2;
    const lo = Math.max(mid - HALF_WINDOW_M, first);
    const hi = Math.min(mid + HALF_WINDOW_M, last);
    // the grade is known only where elevation was recorded at the step's
    // end; across a gap in the recording it would only be a guess
    if (hi - lo < MIN_WINDOW_M || !Number.isFinite(ele[i]!)) continue;
    const g = (eleAt(hi) - eleAt(lo)) / (hi - lo);
    const clamped = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, g));
    factor[i] = cost(clamped) / level;
  }
  const metres = new Float64Array(n);
  const lvl = new Float64Array(n);
  const known = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const s = stepOf(prep, i);
    const k = factor[i]!;
    metres[i] = metres[i - 1]! + s;
    lvl[i] = lvl[i - 1]! + (Number.isFinite(k) ? s * k : s);
    known[i] = known[i - 1]! + (Number.isFinite(k) ? s : 0);
  }
  return { model, factor, metres, level: lvl, known };
}

/** Metres of the moving step ending at sample i (0 for a standing or
 *  invalid step). */
function stepOf(prep: PreparedActivity, i: number): number {
  const t = prep.timeRel;
  const s = prep.cum[i]! - prep.cum[i - 1]!;
  return t[i]! > t[i - 1]! && s > 0 && movingBeforeSample(prep, i) ? s : 0;
}

/** First index i with t[i] > x (t never falls). */
function firstAfter(t: Float64Array, x: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Over the moving steps inside `span`: level-equivalent metres per metre
 *  (a step with no grade counts as level), and the share of metres whose
 *  grade was known. Null with no factors or no moving distance.
 *  @internal */
export function gradeRatio(
  prep: PreparedActivity,
  span: Span,
  model: GradeModel,
): { ratio: number; coverage: number } | null {
  const f = gradeFactors(prep, model);
  if (!f) return null;
  const t = prep.timeRel;
  const n = t.length;
  // steps ending at i in [first, last] overlap the span; the two end steps
  // may only partly, the ones between wholly
  const first = Math.max(firstAfter(t, span.fromSeconds), 1);
  const last = Math.min(firstAfter(t, span.toSeconds), n - 1);
  if (last < first) return null;
  let metres = 0;
  let level = 0;
  let known = 0;
  const part = (i: number) => {
    const s = stepOf(prep, i);
    if (!(s > 0)) return;
    const t0 = t[i - 1]!;
    const t1 = t[i]!;
    const a = Math.max(t0, span.fromSeconds);
    const b = Math.min(t1, span.toSeconds);
    if (!(b > a)) return;
    const m = s * ((b - a) / (t1 - t0));
    const k = f.factor[i]!;
    metres += m;
    level += Number.isFinite(k) ? m * k : m;
    if (Number.isFinite(k)) known += m;
  };
  part(first);
  if (last > first) {
    part(last);
    const lo = first;
    const hi = last - 1;
    if (hi > lo) {
      metres += f.metres[hi]! - f.metres[lo]!;
      level += f.level[hi]! - f.level[lo]!;
      known += f.known[hi]! - f.known[lo]!;
    }
  }
  if (!(metres > 0)) return null;
  return { ratio: level / metres, coverage: known / metres };
}
