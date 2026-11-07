import { describe, expect, it } from 'vitest';
import { Activity } from '../src/activity/index.js';
import type { ImportedActivity } from '../src/types.js';
import { seconds } from '../src/quantities.js';
import { gradeFactors, gradeRatio } from '../src/activity/grade.js';
import {
  movingBeforeSample,
  type PreparedActivity,
} from '../src/summary/index.js';

const START = '2024-06-01T08:00:00Z';
const META = {
  id: 't:1',
  source: 'manual' as const,
  externalId: '1',
  name: 'Test',
  startTimeUtc: START,
  distanceMeters: 0,
  movingTimeSeconds: 0,
  elapsedTimeSeconds: 0,
  elevationGainMeters: 0,
  sportType: 'Run',
};

/** Minetti (2002) running cost, J/kg/m. */
const run = (g: number) =>
  155.4 * g ** 5 -
  30.4 * g ** 4 -
  43.3 * g ** 3 +
  46.3 * g ** 2 +
  19.5 * g +
  3.6;

/** 1 Hz blocks of [seconds, speed m/s, grade]; heart rate steady at 150. */
function hills(
  parts: {
    secs: number;
    speed: number;
    grade: number;
    /** No elevation recorded in this block. */
    gap?: boolean;
    /** Added to each elevation reading: (k) => metres. */
    noise?: (k: number) => number;
  }[],
  sportType = 'Run',
  withElevation = true,
): Activity {
  const timeSeconds = [0];
  const distanceMeters = [0];
  const altitudeMeters: number[] = [100];
  const heartrate = [150];
  let t = 0;
  let d = 0;
  let e = 100;
  for (const p of parts)
    for (let k = 0; k < p.secs; k++) {
      t++;
      d += p.speed;
      e += p.speed * p.grade;
      timeSeconds.push(t);
      distanceMeters.push(d);
      altitudeMeters.push(p.gap ? NaN : e + (p.noise?.(t) ?? 0));
      heartrate.push(150);
    }
  const rec: ImportedActivity = {
    activity: { ...META, sportType },
    streams: {
      latlng: [],
      timeSeconds,
      distanceMeters,
      heartrate,
      ...(withElevation ? { altitudeMeters } : {}),
    },
  };
  return Activity.from(rec);
}

describe('grade-adjusted pace', () => {
  it('equals the recorded pace on the flat', () => {
    const g = hills([
      { secs: 600, speed: 3, grade: 0 },
    ]).pace.adjustedForGrade()!;
    expect(g.model).toBe('minetti-2002-running');
    expect(g.factor).toBeCloseTo(1, 9);
    expect(g.speed.metersPerSecond).toBeCloseTo(3, 6);
    expect(g.coverage).toBe(1);
  });

  it('is faster than recorded up a steady climb, by the cost ratio', () => {
    const a = hills([{ secs: 600, speed: 3, grade: 0.1 }]);
    const g = a.pace.adjustedForGrade()!;
    expect(g.factor).toBeCloseTo(run(0.1) / run(0), 6);
    expect(g.speed.metersPerSecond).toBeCloseTo(3 * g.factor, 6);
    expect(g.recorded.speed.metersPerSecond).toBeCloseTo(3, 6);
    expect(g.pace.secondsPerKm).toBeLessThan(g.recorded.pace.secondsPerKm);
  });

  it('is slower than recorded down a gentle descent', () => {
    const g = hills([
      { secs: 600, speed: 3, grade: -0.1 },
    ]).pace.adjustedForGrade()!;
    expect(g.factor).toBeCloseTo(run(-0.1) / run(0), 6);
    expect(g.factor).toBeLessThan(1);
  });

  it('counts grades past ±45 % as ±45 %', () => {
    const g = hills([
      { secs: 300, speed: 1, grade: 0.8 },
    ]).pace.adjustedForGrade()!;
    expect(g.factor).toBeCloseTo(run(0.45) / run(0), 6);
  });

  it('works on any section', () => {
    const a = hills([
      { secs: 600, speed: 3, grade: 0 },
      { secs: 600, speed: 3, grade: 0.1 },
    ]);
    const flat = a.section({ elapsed: { from: seconds(0), to: seconds(500) } });
    const climb = a.section({
      elapsed: { from: seconds(700), to: seconds(1200) },
    });
    expect(flat.pace.adjustedForGrade()!.factor).toBeCloseTo(1, 6);
    expect(climb.pace.adjustedForGrade()!.factor).toBeCloseTo(
      run(0.1) / run(0),
      6,
    );
  });

  it('uses the walking curve for a hike', () => {
    const g = hills(
      [{ secs: 600, speed: 1.2, grade: 0.1 }],
      'Hike',
    ).pace.adjustedForGrade()!;
    expect(g.model).toBe('minetti-2002-walking');
    const walk = (x: number) =>
      280.5 * x ** 5 -
      58.7 * x ** 4 -
      76.8 * x ** 3 +
      51.9 * x ** 2 +
      19.6 * x +
      2.5;
    expect(g.factor).toBeCloseTo(walk(0.1) / walk(0), 6);
  });

  it('counts steps with no elevation recorded as level, and says how many', () => {
    const g = hills([
      { secs: 300, speed: 3, grade: 0.1 },
      { secs: 700, speed: 3, grade: 0.1, gap: true },
    ]).pace.adjustedForGrade()!;
    expect(g.coverage).toBeGreaterThan(0.28);
    expect(g.coverage).toBeLessThan(0.32);
    const climb = run(0.1) / run(0);
    expect(g.factor).toBeCloseTo(g.coverage * climb + (1 - g.coverage), 2);
  });

  it('leaves stops out', () => {
    const a = hills([
      { secs: 300, speed: 3, grade: 0.1 },
      { secs: 120, speed: 0, grade: 0 },
      { secs: 300, speed: 3, grade: 0.1 },
    ]);
    const g = a.pace.adjustedForGrade()!;
    expect(g.factor).toBeCloseTo(run(0.1) / run(0), 2);
    expect(g.recorded.speed.metersPerSecond).toBeCloseTo(3, 1);
  });

  it('matches a step-by-step sum on sections that cut through samples', () => {
    const a = hills([
      { secs: 200, speed: 3, grade: 0 },
      { secs: 120, speed: 0, grade: 0 },
      { secs: 200, speed: 3, grade: 0.08 },
      { secs: 200, speed: 3, grade: -0.05 },
    ]);
    const prep = (a as unknown as { prep: PreparedActivity }).prep;
    const f = gradeFactors(prep, 'minetti-2002-running')!;
    const naive = (from: number, to: number) => {
      const t = prep.timeRel;
      let m = 0;
      let l = 0;
      for (let i = 1; i < t.length; i++) {
        const lo = Math.max(t[i - 1]!, from);
        const hi = Math.min(t[i]!, to);
        if (!(hi > lo) || !movingBeforeSample(prep, i)) continue;
        const step = (prep.cum[i]! - prep.cum[i - 1]!) * (hi - lo);
        if (!(step > 0)) continue;
        const k = f.factor[i]!;
        m += step;
        l += step * (Number.isFinite(k) ? k : 1);
      }
      return l / m;
    };
    for (const [from, to] of [
      [10.5, 690.25],
      [150.3, 350.7],
      [519.9, 520.1],
      [0, 720],
    ] as const) {
      const r = gradeRatio(
        prep,
        { fromSeconds: from, toSeconds: to },
        'minetti-2002-running',
      )!;
      expect(r.ratio).toBeCloseTo(naive(from, to), 9);
    }
    const tiny = a
      .section({ elapsed: { from: seconds(420.2), to: seconds(420.7) } })
      .pace.adjustedForGrade()!;
    expect(tiny.factor).toBeCloseTo(run(0.08) / run(0), 6);
  });

  it('smooths elevation noise over its 100 m window', () => {
    // ±2 m of noise every second on the flat: per-step grades of ±100 %,
    // but over 100 m it stays within a few per cent
    const g = hills([
      { secs: 600, speed: 3, grade: 0, noise: (t) => (t % 2 ? 2 : -2) },
    ]).pace.adjustedForGrade()!;
    expect(Math.abs(g.factor - 1)).toBeLessThan(0.05);
  });

  it('is null with no moving time', () => {
    expect(
      hills([{ secs: 300, speed: 0, grade: 0 }]).pace.adjustedForGrade(),
    ).toBeNull();
  });

  it('is null without elevation, and off foot unless a model is given', () => {
    expect(
      hills(
        [{ secs: 300, speed: 3, grade: 0 }],
        'Run',
        false,
      ).pace.adjustedForGrade(),
    ).toBeNull();
    const ride = hills([{ secs: 300, speed: 8, grade: 0.05 }], 'Ride');
    expect(ride.pace.adjustedForGrade()).toBeNull();
    expect(
      ride.pace.adjustedForGrade({ model: 'minetti-2002-running' })!.model,
    ).toBe('minetti-2002-running');
  });
});

describe('grade-adjusted efficiency', () => {
  /** 40 min of 5-minute climbs and descents at 6 %, run at the speed that
   *  keeps the effort level by the running curve. */
  function steadyOverHills() {
    const parts: { secs: number; speed: number; grade: number }[] = [];
    for (let k = 0; k < 8; k++) {
      const grade = k % 2 ? -0.06 : 0.06;
      parts.push({ secs: 300, speed: (3.3 * run(0)) / run(grade), grade });
    }
    return hills(parts);
  }

  it('reads a steady effort over hills as steady', () => {
    const aerobic = steadyOverHills().analyze().aerobic;
    const plain = aerobic.decoupling({ output: 'speed' })!;
    const adjusted = aerobic.decoupling({ output: 'grade-adjusted-speed' })!;
    expect(plain.cautions).toContain('variable');
    expect(adjusted.cautions).not.toContain('variable');
    expect(Math.abs(adjusted.change)).toBeLessThan(0.02);
    expect(adjusted.coverage).toBeGreaterThan(0.95);
  });

  it('gives grade-adjusted metres per heartbeat', () => {
    const a = hills([{ secs: 1200, speed: 3, grade: 0.1 }]);
    const e = a
      .analyze()
      .aerobic.efficiency({ output: 'grade-adjusted-speed' })!;
    const plain = a.analyze().aerobic.efficiency({ output: 'speed' })!;
    expect(e.value / plain.value).toBeCloseTo(run(0.1) / run(0), 3);
  });
  it('takes a grade model for another sport', () => {
    const a = hills([{ secs: 1200, speed: 3, grade: 0.1 }], 'Ride');
    const aerobic = a.analyze().aerobic;
    expect(aerobic.efficiency({ output: 'grade-adjusted-speed' })).toBeNull();
    const e = aerobic.efficiency({
      output: 'grade-adjusted-speed',
      gradeModel: 'minetti-2002-walking',
    });
    expect(e).not.toBeNull();
  });
});
