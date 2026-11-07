/**
 * Grade-adjusted pace (RFC §15.1): the pace the same effort would give on
 * level ground. An estimate, not a measurement, so the result names the
 * model that made it.
 *
 * The model is Minetti et al. (2002), "Energy cost of walking and running
 * at extreme uphill and downhill slopes", J Appl Physiol 93: 1039–1046. It
 * gives the energy one metre costs at each grade, as a curve fitted to
 * treadmill measurements from −45 % to +45 %. A metre at grade g counts as
 * cost(g) ÷ cost(0) level metres, so a stretch's grade-adjusted speed is its
 * speed times the ratio of level-equivalent metres to metres. Runs use the
 * running curve; walks and hikes the walking one.
 *
 * Its known limit: the curve is cheapest near −20 %, where a metre costs
 * about half a level one, so a steep descent gets a slower adjusted pace
 * than its recorded pace, and steeper still costs more again. Runners often
 * feel steep descents as harder than that (braking, footing), and other
 * models (Strava's, from its own heart-rate data) treat them so.
 *
 * Grade comes from the elevation over 100 m of distance centred on each
 * sample (less at the ends, none under 20 m), so a few metres of GPS or
 * barometer noise don't turn into steep grades. Grades past ±45 % (the
 * curve's measured range) count as ±45 %.
 */
import {
  hasDistance,
  movingBeforeSample,
  type PreparedActivity,
} from '../summary/index.js';
import type { Span } from '../stats/index.js';
import { sportOf } from './sport.js';

/** The grade models so far: Minetti (2002)'s running and walking curves. */
export type GradeModel = 'minetti-2002-running' | 'minetti-2002-walking';

/** Half the distance a grade is read over, in metres. */
const HALF_WINDOW_M = 50;
/** Shortest distance a grade is read over. */
const MIN_WINDOW_M = 20;
/** The curves' measured range. */
const MAX_GRADE = 0.45;

/** Energy cost in J/kg/m at grade `g` (a fraction: 0.1 is 10 %). */
const COST: Record<GradeModel, (g: number) => number> = {
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

/** The model for an activity's sport: running for runs, walking for walks
 *  and hikes, none for anything else. @internal */
export function gradeModelFor(prep: PreparedActivity): GradeModel | null {
  const sport = sportOf(prep.imported.activity.sportType);
  if (sport === 'run') return 'minetti-2002-running';
  if (sport === 'walk' || sport === 'hike') return 'minetti-2002-walking';
  return null;
}

interface Factors {
  model: GradeModel;
  /** Per sample i ≥ 1: level-equivalent metres per metre for the step
   *  ending at i; NaN where the grade isn't known. */
  factor: Float64Array;
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
    if (hi - lo < MIN_WINDOW_M) continue;
    const g = (eleAt(hi) - eleAt(lo)) / (hi - lo);
    const clamped = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, g));
    factor[i] = cost(clamped) / level;
  }
  return { model, factor };
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
  const cum = prep.cum;
  let metres = 0;
  let level = 0;
  let known = 0;
  for (let i = 1; i < t.length; i++) {
    const t0 = t[i - 1]!;
    const t1 = t[i]!;
    const a = Math.max(t0, span.fromSeconds);
    const b = Math.min(t1, span.toSeconds);
    if (!(b > a) || !(t1 > t0) || !movingBeforeSample(prep, i)) continue;
    const step = (cum[i]! - cum[i - 1]!) * ((b - a) / (t1 - t0));
    if (!(step > 0)) continue;
    const k = f.factor[i]!;
    metres += step;
    if (Number.isFinite(k)) {
      level += step * k;
      known += step;
    } else level += step;
  }
  if (!(metres > 0)) return null;
  return { ratio: level / metres, coverage: known / metres };
}
