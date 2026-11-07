/**
 * Aerobic efficiency and decoupling on a section (RFC §14.1, §15.2).
 *
 * Efficiency is output per heartbeat: watts per beat-per-minute for power,
 * metres per heartbeat for speed (metres per minute ÷ beats per minute).
 * Higher always means more output for the same heart rate.
 *
 * Decoupling compares the efficiency of a section's first half with its
 * second half. The halves split the section's moving time in two, so a stop
 * doesn't push the split point. A positive `change` means the second half
 * took more heartbeats for the same output (heart rate drifted up, or output
 * fell at the same heart rate).
 */
import {
  hasDistance,
  movingBeforeSample,
  type PreparedActivity,
} from '../summary/index.js';
import { movingClock, type MovingClock, type Span } from '../stats/index.js';
import type { Stats } from './stats.js';
import { sportOf } from './sport.js';
import {
  gradeFactors,
  gradeModelFor,
  gradeRatio,
  type GradeModel,
} from './grade.js';

/** What efficiency is measured on. `'power'`: normalized power over average
 *  heart rate; `'speed'`: average speed over average heart rate;
 *  `'grade-adjusted-speed'`: the same with speed adjusted for grade
 *  (`section.pace.adjustedForGrade()`), on foot only, so a hilly run isn't
 *  read as uneven. All are on moving time, so a stop (resting heart rate,
 *  zero power) doesn't pull the number around. Coasting while moving still
 *  counts, as in NP. */
export type AerobicOutput = 'power' | 'speed' | 'grade-adjusted-speed';

export interface EfficiencyOptions {
  /** Default: `'power'` for a ride with power, else `'speed'`. */
  output?: AerobicOutput;
  /** For `'grade-adjusted-speed'`: the grade model. Default: the running
   *  curve for a run, the walking curve for a walk or hike; another sport
   *  needs one named (and reads as if run or walked). */
  gradeModel?: GradeModel;
}

export interface Efficiency {
  output: AerobicOutput;
  /** Watts per bpm (`'power'`), or metres per heartbeat (the speeds). */
  value: number;
  /** Share of the section's moving time with both heart rate and the
   *  output recorded, 0 to 1. For `'speed'` the output is worked out from
   *  the distance almost everywhere, so in practice this is heart-rate
   *  coverage; grade-adjusted speed also needs the grade (elevation). */
  coverage: number;
}

/** Why a section may not suit a decoupling reading. */
export type DecouplingCaution =
  /** Less than 20 minutes of moving time. */
  | 'short'
  /** Heart rate or the output is missing for more than a tenth of it. */
  | 'low-coverage'
  /** The output isn't steady: for power, a variability index above 1.10;
   *  for speed, minute-by-minute moving speed varying by more than 10 %
   *  (coefficient of variation). Intervals and hilly runs land here; with
   *  grade-adjusted speed, a steady effort over hills doesn't. */
  | 'variable';

export interface DecouplingOptions extends EfficiencyOptions {
  /** The only method so far: efficiency of the first half against the
   *  second half, split by moving time. */
  method?: 'halves';
}

export interface Decoupling {
  method: 'halves';
  output: AerobicOutput;
  firstHalf: Efficiency;
  secondHalf: Efficiency;
  /** (first − second) ÷ first, as a fraction: 0.05 is 5 % decoupling. */
  change: number;
  /** Coverage over the whole section. */
  coverage: number;
  /** True when no caution applies. */
  suitable: boolean;
  cautions: DecouplingCaution[];
}

/** What {@link Aerobic} reads from a section. @internal */
export interface AerobicSource {
  prep: PreparedActivity;
  span: Span;
  /** Moving-time stats for a stretch inside the section. */
  statsOf(span: Span, basis: 'moving'): Stats;
}

const SHORT_SECONDS = 20 * 60;
const MIN_COVERAGE = 0.9;
const MAX_POWER_VI = 1.1;
const MAX_SPEED_CV = 0.1;
/** Gaps longer than this count as this, as in every time-weighted number. */
const MAX_GAP_SECONDS = 10;

/** Aerobic readings for a section: `section.analyze({ athlete }).aerobic`. */
export class Aerobic {
  readonly #src: AerobicSource;
  #clock?: MovingClock;
  #decoupling = new Map<string, Decoupling | null>();

  /** @internal */
  constructor(src: AerobicSource) {
    this.#src = src;
  }

  get #movingClock(): MovingClock {
    return (this.#clock ??= movingClock(this.#src.prep));
  }

  /** The default {@link EfficiencyOptions.output}: `'power'` on a ride with
   *  power, `'speed'` with a distance, else null. Grade-adjusted speed is
   *  asked for by name. */
  get defaultOutput(): AerobicOutput | null {
    const { prep } = this.#src;
    const sport = sportOf(prep.imported.activity.sportType);
    if (sport === 'ride' && hasFinite(prep.cols.power)) return 'power';
    return hasDistance(prep) ? 'speed' : null;
  }

  /** Efficiency factor: the section's {@link efficiency} value, or null. */
  get efficiencyFactor(): number | null {
    return this.efficiency()?.value ?? null;
  }

  /** Output per heartbeat over the section; null without heart rate, the
   *  output or timestamps. */
  efficiency(options: EfficiencyOptions = {}): Efficiency | null {
    const output = options.output ?? this.defaultOutput;
    if (!output) return null;
    const model = options.gradeModel ?? gradeModelFor(this.#src.prep);
    return efficiencyOver(this.#src, this.#src.span, output, model);
  }

  /** Efficiency in the first half against the second; null when either
   *  half has no efficiency, and for a pool swim (its speed comes in whole
   *  lengths, so halves and minute-by-minute steadiness don't mean the
   *  same thing there). */
  decoupling(options: DecouplingOptions = {}): Decoupling | null {
    const method = options.method ?? 'halves';
    if (method !== 'halves')
      throw new RangeError(`unknown decoupling method: ${String(method)}`);
    const output = options.output ?? this.defaultOutput;
    if (!output) return null;
    const model = options.gradeModel ?? gradeModelFor(this.#src.prep);
    const key = `${output}:${model ?? ''}`;
    if (this.#decoupling.has(key)) return this.#decoupling.get(key)!;
    const result = this.#decouple(output, model);
    this.#decoupling.set(key, result);
    return result;
  }

  #decouple(
    output: AerobicOutput,
    model: GradeModel | null,
  ): Decoupling | null {
    const method = 'halves';
    const src = this.#src;
    if (src.prep.poolLengths) return null;
    const { fromSeconds: from, toSeconds: to } = src.span;
    const clock = this.#movingClock;
    const moving = clock.upTo(to) - clock.upTo(from);
    if (!(moving > 0)) return null;
    const mid = elapsedAtMoving(clock.upTo, from, to, moving / 2);
    const first = efficiencyOver(
      src,
      { fromSeconds: from, toSeconds: mid },
      output,
      model,
    );
    const second = efficiencyOver(
      src,
      { fromSeconds: mid, toSeconds: to },
      output,
      model,
    );
    const whole = efficiencyOver(src, src.span, output, model);
    if (!first || !second || !whole) return null;

    const cautions: DecouplingCaution[] = [];
    if (moving < SHORT_SECONDS) cautions.push('short');
    if (whole.coverage < MIN_COVERAGE) cautions.push('low-coverage');
    if (isVariable(src, output, model, clock)) cautions.push('variable');
    return {
      method,
      output,
      firstHalf: first,
      secondHalf: second,
      change: (first.value - second.value) / first.value,
      coverage: whole.coverage,
      suitable: cautions.length === 0,
      cautions,
    };
  }
}

/** 1 for plain speed; level-equivalent metres per metre for grade-adjusted
 *  speed (NaN when it can't be worked out). */
function gradeMultiplier(
  src: AerobicSource,
  span: Span,
  output: AerobicOutput,
  model: GradeModel | null,
): number {
  if (output !== 'grade-adjusted-speed') return 1;
  const r = model ? gradeRatio(src.prep, span, model) : null;
  return r ? r.ratio : NaN;
}

function hasFinite(a: Float64Array | undefined): boolean {
  if (!a) return false;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]!)) return true;
  return false;
}

/** The elapsed second inside [from, to] where the moving clock has run
 *  `moving` seconds since `from`. */
function elapsedAtMoving(
  upTo: (sec: number) => number,
  from: number,
  to: number,
  moving: number,
): number {
  const target = upTo(from) + moving;
  let lo = from;
  let hi = to;
  // upTo never falls, so bisect to well under a millisecond
  for (let k = 0; k < 60 && hi - lo > 1e-4; k++) {
    const mid = (lo + hi) / 2;
    if (upTo(mid) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

function efficiencyOver(
  src: AerobicSource,
  span: Span,
  output: AerobicOutput,
  model: GradeModel | null,
): Efficiency | null {
  const s = src.statsOf(span, 'moving');
  const hr = s.heartRate.average?.bpm;
  if (!hr || !(hr > 0)) return null;
  const out =
    output === 'power'
      ? s.power.normalized?.watts
      : s.speed.average
        ? s.speed.average.metersPerSecond *
          60 *
          gradeMultiplier(src, span, output, model)
        : undefined;
  if (out === undefined || !Number.isFinite(out)) return null;
  return {
    output,
    value: out / hr,
    coverage: coverage(src.prep, span, output, model),
  };
}

/** Share of moving time inside `span` where heart rate and the output are
 *  both recorded. Each sample covers the time since the one before (capped
 *  at {@link MAX_GAP_SECONDS}), as in the time-weighted averages. */
function coverage(
  prep: PreparedActivity,
  span: Span,
  output: AerobicOutput,
  model: GradeModel | null,
): number {
  const t = prep.timeRel;
  const hr = prep.cols.hr;
  const out = output === 'power' ? prep.cols.power : prep.speed;
  const grade =
    output === 'grade-adjusted-speed' && model
      ? gradeFactors(prep, model)?.factor
      : undefined;
  if (!hr || !out || (output === 'grade-adjusted-speed' && !grade)) return 0;
  let total = 0;
  let covered = 0;
  for (let i = 1; i < t.length; i++) {
    const a = Math.max(t[i - 1]!, span.fromSeconds);
    const b = Math.min(t[i]!, span.toSeconds);
    if (!(b > a) || !movingBeforeSample(prep, i)) continue;
    const dt = Math.min(b - a, MAX_GAP_SECONDS);
    total += dt;
    if (
      Number.isFinite(hr[i]!) &&
      Number.isFinite(out[i]!) &&
      (!grade || Number.isFinite(grade[i]!))
    )
      covered += dt;
  }
  return total > 0 ? covered / total : 0;
}

function isVariable(
  src: AerobicSource,
  output: AerobicOutput,
  model: GradeModel | null,
  clock: MovingClock,
): boolean {
  if (output === 'power') {
    const p = src.statsOf(src.span, 'moving').power;
    if (!p.normalized || !p.average || !(p.average.watts > 0)) return false;
    return p.normalized.watts / p.average.watts > MAX_POWER_VI;
  }
  return minuteSpeedCv(src, clock, output, model) > MAX_SPEED_CV;
}

/** Coefficient of variation of moving speed across whole minutes of moving
 *  time. A minute is one minute on the moving clock, so stops drop out. */
function minuteSpeedCv(
  src: AerobicSource,
  clock: MovingClock,
  output: AerobicOutput,
  model: GradeModel | null,
): number {
  const { span } = src;
  const moving = clock.upTo(span.toSeconds) - clock.upTo(span.fromSeconds);
  const minutes = Math.floor(moving / 60);
  if (minutes < 2) return 0;
  const speeds: number[] = [];
  let prev = span.fromSeconds;
  for (let m = 1; m <= minutes; m++) {
    const end = elapsedAtMoving(
      clock.upTo,
      span.fromSeconds,
      span.toSeconds,
      m * 60,
    );
    const minute = { fromSeconds: prev, toSeconds: end };
    const raw = src.statsOf(minute, 'moving').speed.average?.metersPerSecond;
    const v =
      raw === undefined
        ? undefined
        : raw * gradeMultiplier(src, minute, output, model);
    if (v !== undefined && Number.isFinite(v)) speeds.push(v);
    prev = end;
  }
  if (speeds.length < 2) return 0;
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  if (!(mean > 0)) return 0;
  const sd = Math.sqrt(
    speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length,
  );
  return sd / mean;
}
