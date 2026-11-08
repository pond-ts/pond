import { describe, expect, it } from 'vitest';
import { Activity, GradeCurve } from '../src/activity/index.js';
import type { ImportedActivity } from '../src/types.js';
import { TrainingHistory, type ActivityDigest } from '../src/history/index.js';

/** 1 Hz blocks of [seconds, speed m/s, grade, heart rate]. */
function run(
  parts: { secs: number; speed: number; grade: number; hr: number }[],
  sportType = 'Run',
): Activity {
  const timeSeconds = [0];
  const distanceMeters = [0];
  const altitudeMeters = [100];
  const heartrate = [parts[0]!.hr];
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
      altitudeMeters.push(e);
      heartrate.push(p.hr);
    }
  const rec: ImportedActivity = {
    activity: {
      id: 'r',
      source: 'manual',
      externalId: 'r',
      name: 'r',
      startTimeUtc: '2026-06-01T08:00:00Z',
      distanceMeters: 0,
      movingTimeSeconds: 0,
      elapsedTimeSeconds: 0,
      elevationGainMeters: 0,
      sportType,
    },
    streams: {
      latlng: [],
      timeSeconds,
      distanceMeters,
      altitudeMeters,
      heartrate,
    },
  };
  return Activity.from(rec);
}

describe('GradeCurve', () => {
  const c = new GradeCurve(
    [
      { grade: -0.1, factor: 0.9 },
      { grade: 0, factor: 1 },
      { grade: 0.1, factor: 1.5 },
    ],
    { name: 'mine' },
  );

  it('reads between points in a straight line', () => {
    expect(c.factorAt(0)).toBe(1);
    expect(c.factorAt(0.05)).toBeCloseTo(1.25, 9);
    expect(c.factorAt(-0.05)).toBeCloseTo(0.95, 9);
  });

  it("follows the fallback's shape past the ends", () => {
    // ACSM: 1 + 4.5 g uphill, 1 downhill.
    expect(c.factorAt(0.2)).toBeCloseTo((1.5 * 1.9) / 1.45, 9);
    expect(c.factorAt(-0.2)).toBeCloseTo(0.9, 9);
  });

  it('checks its points and round-trips through JSON', () => {
    expect(() => new GradeCurve([])).toThrow();
    expect(
      () =>
        new GradeCurve([
          { grade: 0.1, factor: 1 },
          { grade: 0, factor: 1 },
        ]),
    ).toThrow();
    expect(() => new GradeCurve([{ grade: 0, factor: 0 }])).toThrow();
    expect(() =>
      GradeCurve.fromJSON({
        points: [{ grade: 0, factor: 1 }],
        fallback: 'nope' as never,
      }),
    ).toThrow();
    const back = GradeCurve.fromJSON(JSON.parse(JSON.stringify(c)));
    expect(back.name).toBe('mine');
    expect(back.fallback).toBe('acsm-running');
    expect(back.factorAt(0.05)).toBeCloseTo(1.25, 9);
  });

  it('adjusts pace and efficiency, naming the curve', () => {
    const a = run([{ secs: 600, speed: 3, grade: 0.05, hr: 150 }]);
    const g = a.pace.adjustedForGrade({ model: c })!;
    expect(g.model).toBe('curve');
    expect(g.curve).toBe(c);
    expect(g.factor).toBeCloseTo(1.25, 2);
    const named = a.pace.adjustedForGrade({ model: 'acsm-running' })!;
    expect(named.curve).toBeNull();
    const e = a.analyze().aerobic.efficiency({
      output: 'grade-adjusted-speed',
      gradeModel: c,
    })!;
    const plain = a.analyze().aerobic.efficiency({ output: 'speed' })!;
    expect(e.value / plain.value).toBeCloseTo(1.25, 2);
  });
});

describe('digest grades', () => {
  it("sums a run's steady minutes by grade band", () => {
    const a = run([
      { secs: 600, speed: 3, grade: 0, hr: 140 },
      { secs: 600, speed: 3, grade: 0.06, hr: 160 },
    ]);
    const g = a.digest().grades!;
    const flat = g.find((b) => b.grade === 0)!;
    const up = g.find((b) => b.grade === 0.06)!;
    expect(flat.windows).toBeGreaterThan(15);
    expect(up.windows).toBeGreaterThan(15);
    // 3 m/s for a minute, at the heart rate read 30 s later.
    expect(flat.metres / flat.windows).toBeCloseTo(180, 0);
    expect(up.beats / up.windows).toBeCloseTo(160, 0);
    // Grade is read over 100 m, so it ramps across the change; the few
    // minutes in between land in the bands between.
    const between = g.filter((b) => b.grade !== 0 && b.grade !== 0.06);
    expect(between.reduce((s, b) => s + b.windows, 0)).toBeLessThan(4);
  });

  it('is null for other sports and without heart rate', () => {
    const ride = run([{ secs: 600, speed: 8, grade: 0, hr: 140 }], 'Ride');
    expect(ride.digest().grades).toBeNull();
    const a = run([{ secs: 600, speed: 3, grade: 0, hr: 0 }]);
    expect(a.digest().grades).toEqual([]);
  });
});

describe('history.analyze().pace.gradeCurve()', () => {
  /** The curve the synthetic runs follow. */
  const truth = (g: number) => (g < 0 ? 1 + 2 * g * g : 1 + 4 * g);

  /** A run whose minutes take `scale × truth(g)` heartbeats per metre. */
  const digestOf = (
    id: string,
    day: string,
    scale: number,
    grades: number[],
    windows = 30,
  ): ActivityDigest => ({
    version: 1,
    id,
    fingerprint: `f-${id}`,
    name: id,
    sport: 'run',
    sportType: 'Run',
    startedAt: `${day}T08:00:00Z`,
    localStart: `${day}T08:00:00`,
    device: null,
    time: { elapsed: 3600, moving: 3600 },
    distance: 10000,
    ascent: 100,
    heartRate: null,
    power: null,
    pace: [],
    grades: grades.map((g) => ({
      grade: g,
      windows,
      metres: windows * 180,
      beats: windows * 180 * scale * truth(g),
    })),
  });

  const runs = [
    digestOf('a', '2026-05-01', 0.5, [-0.04, 0, 0.04, 0.08]),
    digestOf('b', '2026-05-03', 0.6, [-0.04, -0.02, 0.04]),
    digestOf('c', '2026-05-05', 0.55, [0, 0.02, 0.08]),
    digestOf('d', '2026-05-07', 0.45, [-0.02, 0, 0.02, 0.04, 0.08]),
    // One thin minute-set at 20 %: below minWindows across the history.
    digestOf('e', '2026-05-09', 0.5, [0, 0.2], 10),
  ];

  it('recovers the curve, each run scaled for its day', () => {
    const fit = TrainingHistory.of(runs).analyze().pace.gradeCurve()!;
    expect(fit.curve.name).toBe('personal');
    expect(fit.bands.map((b) => b.grade)).toEqual([
      -0.04, -0.02, 0, 0.02, 0.04, 0.08,
    ]);
    for (const b of fit.bands) expect(b.factor).toBeCloseTo(truth(b.grade), 6);
    // Run b has no flat ground and still counts.
    expect(fit.activities).toContain('b');
    expect(fit.bands.find((b) => b.grade === 0.04)!.activities).toBe(3);
    // No noise, so the halves agree wherever both have the band.
    for (const b of fit.bands)
      if (b.spread !== null) expect(b.spread).toBeCloseTo(0, 6);
    expect(fit.bands.find((b) => b.grade === 0)!.spread).toBeNull();
  });

  it('leaves thin bands to the fallback', () => {
    const fit = TrainingHistory.of(runs).analyze().pace.gradeCurve()!;
    expect(fit.bands.some((b) => b.grade === 0.2)).toBe(false);
    const top = truth(0.08);
    expect(fit.curve.factorAt(0.2)).toBeCloseTo((top * 1.9) / 1.36, 6);
    const loose = TrainingHistory.of(runs)
      .analyze()
      .pace.gradeCurve({ minWindows: 10 })!;
    expect(loose.bands.some((b) => b.grade === 0.2)).toBe(true);
  });

  it('settles when runs share only neighbouring bands', () => {
    // Each run covers two neighbouring bands, so the curve is linked up the
    // hill one band at a time: slow for alternating rounds to settle.
    const chain = Array.from({ length: 9 }, (_, i) =>
      digestOf(
        `c${i}`,
        `2026-05-${String(i + 1).padStart(2, '0')}`,
        0.4 + i * 0.03,
        [i * 0.02, (i + 1) * 0.02],
      ),
    );
    const fit = TrainingHistory.of(chain).analyze().pace.gradeCurve()!;
    for (const b of fit.bands) expect(b.factor).toBeCloseTo(truth(b.grade), 6);
    expect(fit.bands.at(-1)!.grade).toBe(0.18);
  });

  it('drops runs that add nothing and bands not linked to the flat', () => {
    const fit = TrainingHistory.of([
      ...runs,
      // One band only: its own scale absorbs it.
      digestOf('lone', '2026-05-11', 0.5, [0.04]),
      // Shares no band with the rest, so nothing ties it to the flat.
      digestOf('island', '2026-05-12', 0.5, [0.12, 0.14]),
      digestOf('island2', '2026-05-13', 0.7, [0.12, 0.14]),
    ])
      .analyze()
      .pace.gradeCurve()!;
    expect(fit.activities).not.toContain('lone');
    expect(fit.activities).not.toContain('island');
    expect(fit.bands.some((b) => b.grade === 0.12)).toBe(false);
    expect(fit.bands.find((b) => b.grade === 0.04)!.activities).toBe(3);
  });

  it('reports how far the halves disagree', () => {
    // Every other run finds climbs 20 % harder.
    const noisy = runs.slice(0, 4).map((d, i) =>
      i % 2
        ? {
            ...d,
            grades: d.grades!.map((b) => ({
              ...b,
              beats: b.grade > 0 ? b.beats * 1.2 : b.beats,
            })),
          }
        : d,
    );
    const fit = TrainingHistory.of(noisy).analyze().pace.gradeCurve()!;
    const up = fit.bands.find((b) => b.grade === 0.04)!;
    expect(up.spread).toBeGreaterThan(0.1);
  });

  it('is null without flat ground or runs with grades', () => {
    const hilly = runs.filter((d) => d.id === 'b');
    expect(TrainingHistory.of(hilly).analyze().pace.gradeCurve()).toBeNull();
    expect(TrainingHistory.of([]).analyze().pace.gradeCurve()).toBeNull();
    expect(() =>
      TrainingHistory.of(runs).analyze().pace.gradeCurve({ minWindows: 0 }),
    ).toThrow();
  });
});
