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

/** A grade-adjustment curve given as points: level-equivalent metres per
 *  metre at each grade, such as one fitted from an athlete's own history
 *  (`history.analyze().pace.gradeCurve()`). Between points it's read in a
 *  straight line. Past the first or last point it follows `fallback`'s
 *  shape, scaled to meet the end point; ACSM (the default) is level on
 *  every descent, so a curve holds its lowest point's factor below it.
 *  Include a point at grade 0, or the flat is read from the fallback
 *  too. */
export class GradeCurve {
  /** A label for the curve, e.g. `'personal'`; results name a curve
   *  `'curve'` and carry it, so this is `result.curve.name`. */
  readonly name: string;
  /** Grades as fractions (0.1 is 10 %), rising; factors positive. */
  readonly points: readonly { grade: number; factor: number }[];
  readonly fallback: GradeModel;
  /** @internal a stable key for caches */
  readonly key: string;
  static #next = 0;

  constructor(
    points: readonly { grade: number; factor: number }[],
    options: { name?: string; fallback?: GradeModel } = {},
  ) {
    if (points.length === 0) throw new RangeError('a grade curve needs points');
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (
        !Number.isFinite(p.grade) ||
        !(p.factor > 0) ||
        !Number.isFinite(p.factor)
      )
        throw new RangeError(
          'grade curve points need a finite grade and a positive factor',
        );
      if (i > 0 && !(p.grade > points[i - 1]!.grade))
        throw new RangeError('grade curve points must rise in grade');
    }
    this.points = points.map((p) => ({ grade: p.grade, factor: p.factor }));
    this.name = options.name ?? 'curve';
    this.fallback = options.fallback ?? 'acsm-running';
    if (!Object.prototype.hasOwnProperty.call(COST, this.fallback))
      throw new RangeError(`unknown grade model ${String(this.fallback)}`);
    this.key = `curve#${GradeCurve.#next++}`;
  }

  /** Level-equivalent metres per metre at grade `g` (a fraction). */
  factorAt(g: number): number {
    const pts = this.points;
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    const fb = (x: number) => COST[this.fallback](x) / COST[this.fallback](0);
    if (g <= first.grade) return first.factor * (fb(g) / fb(first.grade));
    if (g >= last.grade) return last.factor * (fb(g) / fb(last.grade));
    let i = 1;
    while (pts[i]!.grade < g) i++;
    const a = pts[i - 1]!;
    const b = pts[i]!;
    return (
      a.factor + ((b.factor - a.factor) * (g - a.grade)) / (b.grade - a.grade)
    );
  }

  /** Plain JSON, for storing beside athlete settings. */
  toJSON(): {
    name: string;
    fallback: GradeModel;
    points: { grade: number; factor: number }[];
  } {
    return {
      name: this.name,
      fallback: this.fallback,
      points: [...this.points],
    };
  }

  static fromJSON(json: {
    name?: string;
    fallback?: GradeModel;
    points: readonly { grade: number; factor: number }[];
  }): GradeCurve {
    return new GradeCurve(json.points, {
      ...(json.name !== undefined ? { name: json.name } : {}),
      ...(json.fallback !== undefined ? { fallback: json.fallback } : {}),
    });
  }
}

/** A named model or a curve of points. */
export type GradeModelInput = GradeModel | GradeCurve;

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
  model: GradeModelInput;
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

const cache = new WeakMap<
  PreparedActivity,
  Map<GradeModelInput, Factors | null>
>();
const gradeCache = new WeakMap<PreparedActivity, Float64Array | null>();

/** Level-equivalent metres per metre for each step, or null without a
 *  distance or any elevation. @internal */
export function gradeFactors(
  prep: PreparedActivity,
  model: GradeModelInput,
): Factors | null {
  let byModel = cache.get(prep);
  if (!byModel) cache.set(prep, (byModel = new Map()));
  if (byModel.has(model)) return byModel.get(model)!;
  const f = computeFactors(prep, model);
  byModel.set(model, f);
  return f;
}

/** The grade of each step (sample i ≥ 1, the step ending at i) as a
 *  fraction, capped at ±45 %; NaN where it isn't known. Null without a
 *  distance or any elevation. @internal */
export function stepGrades(prep: PreparedActivity): Float64Array | null {
  if (gradeCache.has(prep)) return gradeCache.get(prep)!;
  const g = computeGrades(prep);
  gradeCache.set(prep, g);
  return g;
}

function computeGrades(prep: PreparedActivity): Float64Array | null {
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
  const grade = new Float64Array(n).fill(NaN);
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
    grade[i] = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, g));
  }
  return grade;
}

function computeFactors(
  prep: PreparedActivity,
  model: GradeModelInput,
): Factors | null {
  const grade = stepGrades(prep);
  if (!grade) return null;
  const n = grade.length;
  const factorAt =
    model instanceof GradeCurve
      ? (g: number) => model.factorAt(g)
      : (g: number) => COST[model](g) / COST[model](0);
  const factor = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const g = grade[i]!;
    if (Number.isFinite(g)) factor[i] = factorAt(g);
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
  model: GradeModelInput,
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

/** Steady minutes of a run summed by grade, for fitting a personal grade
 *  curve across a history. @internal (shape documented on the digest) */
export interface GradeBand {
  /** Band centre as a fraction: 0.06 holds grades from 5 % to 7 %. */
  grade: number;
  /** Steady one-minute windows in the band. */
  windows: number;
  /** Metres covered in those windows. */
  metres: number;
  /** Heartbeats over the same windows, read 30 s later. */
  beats: number;
}

const BAND = 0.02;
const WINDOW_S = 60;
const WINDOW_STEP_S = 30;
/** Heart rate trails effort; reading it 30 s later steadied the test fit. */
const HR_LAG_S = 30;
/** Longest sample gap a window may span. */
const MAX_GAP_S = 10;
const MIN_SPEED = 1.2;
const MAX_HR_CV = 0.04;
const MAX_SPEED_CV = 0.2;
const MAX_GRADE_SPREAD = 0.03;

function cv(a: readonly number[]): number {
  let s = 0;
  for (const x of a) s += x;
  const m = s / a.length;
  if (!(m > 0)) return Infinity;
  let v = 0;
  for (const x of a) v += (x - m) * (x - m);
  return Math.sqrt(v / a.length) / m;
}

/**
 * A run's steady minutes, banded by grade. Windows are one minute long,
 * started every 30 s; a window counts when it is all moving with no sample
 * gap over 10 s, at 1.2 m/s or faster, with speed varying under 20 %,
 * grade spread under 3 points, and heart rate (read 30 s later) varying
 * under 4 %. Null without heart rate, distance or elevation.
 * @internal
 */
export function gradeBandsOf(prep: PreparedActivity): GradeBand[] | null {
  const grade = stepGrades(prep);
  const hrCol = prep.cols.hr;
  if (!grade || !hrCol || !prep.hasTime || !hasDistance(prep)) return null;
  const t = prep.timeRel;
  const n = t.length;
  if (n < 2) return null;
  const end = Math.floor(t[n - 1]!);
  // One value per whole second, from the sample at or before it (heart rate,
  // distance) or the step after it (speed, grade, moving).
  const hr = new Float64Array(end + 1);
  const x = new Float64Array(end + 1);
  const v = new Float64Array(end + 1);
  const g = new Float64Array(end + 1);
  const ok = new Uint8Array(end + 1);
  let j = 0;
  for (let s = 0; s <= end; s++) {
    while (j + 1 < n && t[j + 1]! <= s) j++;
    const k = Math.min(j + 1, n - 1);
    hr[s] = hrCol[j]!;
    const span = t[k]! - t[j]!;
    x[s] =
      span > 0
        ? prep.cum[j]! + ((prep.cum[k]! - prep.cum[j]!) * (s - t[j]!)) / span
        : prep.cum[j]!;
    v[s] = prep.speed[k]!;
    g[s] = grade[k]!;
    ok[s] = k > j && span <= MAX_GAP_S && movingBeforeSample(prep, k) ? 1 : 0;
  }
  const bands = new Map<number, GradeBand>();
  for (let s = 0; s + HR_LAG_S + WINDOW_S <= end; s += WINDOW_STEP_S) {
    const hs: number[] = [];
    const vs: number[] = [];
    let gSum = 0;
    let gSq = 0;
    let steady = true;
    for (let i = s; i < s + WINDOW_S; i++) {
      const h = hr[i + HR_LAG_S]!;
      // The lagged heart rate must come from a moving second too, not from
      // a stop or a gap where the last reading is held.
      if (!ok[i] || !ok[i + HR_LAG_S] || !Number.isFinite(g[i]!) || !(h > 0)) {
        steady = false;
        break;
      }
      hs.push(h);
      vs.push(v[i]!);
      gSum += g[i]!;
      gSq += g[i]! * g[i]!;
    }
    if (!steady) continue;
    const metres = x[s + WINDOW_S]! - x[s]!;
    if (metres / WINDOW_S < MIN_SPEED) continue;
    const gMean = gSum / WINDOW_S;
    const spread = Math.sqrt(Math.max(0, gSq / WINDOW_S - gMean * gMean));
    if (
      spread > MAX_GRADE_SPREAD ||
      cv(hs) > MAX_HR_CV ||
      cv(vs) > MAX_SPEED_CV
    )
      continue;
    const key = Math.round(gMean / BAND);
    const beats = hs.reduce((a, b) => a + b, 0) / 60;
    const band = bands.get(key);
    if (band) {
      band.windows++;
      band.metres += metres;
      band.beats += beats;
    } else
      bands.set(key, {
        grade: Math.round(key * BAND * 100) / 100,
        windows: 1,
        metres,
        beats,
      });
  }
  return [...bands.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
}
