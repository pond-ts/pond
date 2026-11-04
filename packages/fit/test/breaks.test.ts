import { describe, expect, it } from 'vitest';
import {
  BREAK_OFFSETS,
  breakTrend,
  findBreaks,
  slowCutOff,
  pastBreaks,
  type PastBreak,
  type RunBreak,
} from '../src/index.js';

// Ported from Estela's breaks tests. Estela also checks three of its owner's
// real runs; those stay there (no personal recordings in this repo).

/** A made-up run: `plan` is [seconds, m/s, bpm at the end] legs, one sample
 *  a second, heart rate moving straight across each leg. */
function run(plan: [number, number, number][], start = { bpm: 150 }) {
  const timeSeconds: number[] = [0];
  const distanceMeters: number[] = [0];
  const heartrate: number[] = [start.bpm];
  for (const [secs, mps, bpm] of plan) {
    const from = heartrate[heartrate.length - 1]!;
    for (let i = 1; i <= secs; i++) {
      timeSeconds.push(timeSeconds[timeSeconds.length - 1]! + 1);
      distanceMeters.push(distanceMeters[distanceMeters.length - 1]! + mps);
      heartrate.push(from + ((bpm - from) * i) / secs);
    }
  }
  return { timeSeconds, distanceMeters, heartrate };
}

describe('findBreaks', () => {
  it('finds every walk of a run/walk run whose walking pace wavers', () => {
    // A minute's walk every 5 minutes, walking at 1.5-1.8 m/s and running at
    // 2.2-2.5. With slow = under 3/4 of the usual speed each walk would
    // break into pieces under 30 s; the cut-off between the two groups keeps
    // each walk whole.
    const plan: [number, number, number][] = [];
    for (let k = 0; k < 8; k++) {
      for (let s = 0; s < 240; s += 20)
        plan.push([20, 2.2 + ((s / 20) % 4) * 0.1, 158]);
      for (let s = 0; s < 60; s += 10)
        plan.push([10, 1.5 + ((s / 10) % 4) * 0.1, 140]);
    }
    plan.push([300, 2.4, 160]);
    const b = findBreaks(run(plan, { bpm: 158 }));
    expect(b).toHaveLength(8);
    expect(b.every((x) => x.kind === 'walk')).toBe(true);
    for (const [k, x] of b.entries()) {
      expect(Math.abs(x.startSec - (240 + k * 300))).toBeLessThanOrEqual(10);
      expect(x.seconds).toBeGreaterThanOrEqual(50);
    }
  });

  it('reads a missing sample written as null as a gap', () => {
    const r = run([
      [300, 3, 160],
      [100, 0, 120],
      [300, 3, 160],
    ]);
    const nullHr = r.heartrate.map((v, i) => (i % 7 === 3 ? null : v));
    const nanHr = r.heartrate.map((v, i) => (i % 7 === 3 ? NaN : v));
    expect(findBreaks({ ...r, heartrate: nullHr })).toEqual(
      findBreaks({ ...r, heartrate: nanHr }),
    );
    expect(findBreaks({ ...r, heartrate: nullHr })).toHaveLength(1);
  });

  it('skips samples with no GPS fix when measuring along the line', () => {
    const r = run([
      [300, 3, 160],
      [100, 0, 120],
      [300, 3, 160],
    ]);
    const latlng = r.distanceMeters.map((d, i) =>
      i % 9 === 4 ? null : ([37 + d / 111195, -122] as [number, number]),
    );
    const b = findBreaks({
      timeSeconds: r.timeSeconds,
      heartrate: r.heartrate,
      latlng,
    });
    expect(b).toHaveLength(1);
    expect(b[0]!.kind).toBe('stop');
  });

  it('reads heart rate at each offset while the break lasts', () => {
    const [b] = findBreaks(
      run([
        [300, 3, 160],
        [100, 0, 120],
        [300, 3, 160],
      ]),
    );
    expect(b).toMatchObject({ kind: 'stop', startBpm: 160 });
    // The stop shows from about 5 s early, as speed is measured over 10 s.
    expect(Math.abs(b!.startSec - 300)).toBeLessThanOrEqual(5);
    expect(b!.bpmAt.slice(0, 4).every((x) => typeof x === 'number')).toBe(true);
    expect(b!.bpmAt[5]).toBeNull(); // over before 120 s
    expect(b!.bpmAt[1]!).toBeLessThan(160);
  });

  it('calls a slow stretch that keeps moving a walk break', () => {
    const [b] = findBreaks(
      run([
        [300, 3, 160],
        [60, 1.4, 140],
        [300, 3, 160],
      ]),
    );
    expect(b?.kind).toBe('walk');
  });

  it('leaves out short ones, ones while warming up, and walks', () => {
    expect(
      findBreaks(
        run([
          [300, 3, 160],
          [20, 0, 150],
          [300, 3, 160],
        ]),
      ),
    ).toEqual([]);
    // Heart rate before the stop well under the run's usual.
    expect(
      findBreaks(
        run(
          [
            [120, 3, 110],
            [60, 0, 100],
            [1200, 3, 160],
          ],
          { bpm: 100 },
        ),
      ),
    ).toEqual([]);
    // Mostly walking with a few jogs: still a walk.
    expect(
      findBreaks(
        run([
          [300, 1.4, 110],
          [120, 2.6, 130],
          [300, 1.4, 110],
          [120, 2.6, 130],
          [300, 1.4, 110],
        ]),
      ),
    ).toEqual([]);
    // A walk (usual speed 1.4 m/s) has no breaks.
    expect(
      findBreaks(
        run([
          [600, 1.4, 110],
          [60, 0, 100],
          [600, 1.4, 110],
        ]),
      ),
    ).toEqual([]);
  });

  it('leaves out a stretch where the watch paused', () => {
    const r = run([
      [300, 3, 160],
      [100, 0, 120],
      [300, 3, 160],
    ]);
    // Take the samples from 320 to 360 s out.
    const keep = r.timeSeconds.map((t) => t < 320 || t > 360);
    const pick = <T>(xs: T[]) => xs.filter((_, i) => keep[i]);
    expect(
      findBreaks({
        timeSeconds: pick(r.timeSeconds),
        distanceMeters: pick(r.distanceMeters),
        heartrate: pick(r.heartrate),
      }),
    ).toEqual([]);
  });

  it('cuts a stop off where the watch paused', () => {
    const r = run([
      [300, 3, 160],
      [100, 0, 120],
      [300, 3, 160],
    ]);
    // No samples from 365 to 385 s (auto-pause at the crossing).
    const keep = r.timeSeconds.map((t) => t < 365 || t > 385);
    const pick = <T>(xs: T[]) => xs.filter((_, i) => keep[i]);
    const b = findBreaks({
      timeSeconds: pick(r.timeSeconds),
      distanceMeters: pick(r.distanceMeters),
      heartrate: pick(r.heartrate),
    });
    expect(b).toHaveLength(1);
    expect(b[0]!.kind).toBe('stop');
    expect(b[0]!.startSec + b[0]!.seconds).toBeLessThanOrEqual(365);
    expect(typeof b[0]!.bpmAt[3]).toBe('number'); // 60 s: before the pause
    expect(b[0]!.bpmAt.slice(4)).toEqual([null, null]); // 90 s on: unknown
  });

  it('leaves out the walk or stand once the run is over', () => {
    expect(
      findBreaks(
        run([
          [600, 3, 160],
          [120, 0, 110],
        ]),
      ),
    ).toEqual([]);
  });

  it('measures along the GPS line when there is no distance', () => {
    const r = run([
      [300, 3, 160],
      [100, 0, 120],
      [300, 3, 160],
    ]);
    // 3 m a second north is 3 / 111195 degrees of latitude.
    const latlng = r.distanceMeters.map(
      (d) => [37 + d / 111195, -122] as [number, number],
    );
    const b = findBreaks({
      timeSeconds: r.timeSeconds,
      heartrate: r.heartrate,
      latlng,
    });
    expect(b).toHaveLength(1);
    expect(b[0]!.kind).toBe('stop');
  });

  it('needs heart rate', () => {
    const r = run([
      [300, 3, 160],
      [100, 0, 120],
      [300, 3, 160],
    ]);
    expect(findBreaks({ ...r, heartrate: undefined })).toEqual([]);
    expect(findBreaks({ ...r, heartrate: r.heartrate.map(() => 0) })).toEqual(
      [],
    );
  });
});

describe('slowCutOff', () => {
  const many = (v: number, n: number) =>
    Array.from({ length: n }, (_, i) => v + (i % 5) * 0.04);
  it('puts the cut-off between walking and running speeds', () => {
    const c = slowCutOff([...many(1.6, 200), ...many(2.3, 800)]);
    expect(c.cut).toBeGreaterThan(1.8);
    expect(c.cut).toBeLessThan(2.3);
    expect(c.usual).toBeCloseTo(2.38);
  });
  it('uses 3/4 of the usual speed when there is no walking group', () => {
    const c = slowCutOff(many(2.4, 1000));
    expect(c.usual).toBeCloseTo(2.48);
    expect(c.cut).toBeCloseTo(0.75 * 2.48);
    // A handful of slow seconds isn't a group.
    expect(slowCutOff([...many(1.5, 10), ...many(2.4, 1000)]).cut).toBeCloseTo(
      0.75 * 2.48,
    );
    // Too few seconds to tell.
    expect(slowCutOff([2, 3]).cut).toBeCloseTo(0.75 * 2.5);
  });
  it('leaves easy running with fast pickups alone', () => {
    // More easy running than fast: the easy running is the run.
    const c = slowCutOff([...many(2.8, 700), ...many(4.5, 300)]);
    expect(c.cut).toBeLessThan(2.8);
  });
  it('keeps the old cut-off when the slower group is jogging, not walking', () => {
    // Reps with jogged recoveries: no walking group, so 3/4 of usual speed.
    const c = slowCutOff([...many(2.6, 300), ...many(4.2, 700)]);
    expect(c.cut).toBeCloseTo(0.75 * c.usual);
  });
});

const brk = (
  kind: RunBreak['kind'],
  startBpm: number,
  at30: number,
): RunBreak => ({
  startSec: 600,
  kind,
  seconds: 40,
  startBpm,
  bpmAt: [startBpm - 2, at30, null, null, null, null],
});

describe('pastBreaks', () => {
  it('lists the breaks with a reading at the offset, oldest first', () => {
    const runs = [
      {
        id: 'b',
        activity: { startTimeUtc: '2026-02-01T08:00:00Z' },
        breaks: [brk('stop', 150, 130)],
      },
      {
        id: 'a',
        activity: { startTimeUtc: '2026-01-01T08:00:00Z' },
        breaks: [brk('walk', 160, 150), brk('stop', 140, 125)],
      },
      { id: 'c', activity: { startTimeUtc: '2026-03-01T08:00:00Z' } },
    ];
    expect(
      pastBreaks(runs, 30).map((b) => [b.activityId, b.kind, b.bpm]),
    ).toEqual([
      ['a', 'walk', 150],
      ['a', 'stop', 125],
      ['b', 'stop', 130],
    ]);
    expect(pastBreaks(runs, 45)).toEqual([]);
    expect(BREAK_OFFSETS[1]).toBe(30);
  });
});

describe('breakTrend', () => {
  const day = (n: number) =>
    new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
  const pb = (
    n: number,
    startBpm: number,
    bpm: number,
    kind: PastBreak['kind'] = 'stop',
  ): PastBreak => ({
    activityId: `r${n}`,
    startUtc: day(n),
    kind,
    startBpm,
    bpm,
  });

  it('needs five breaks in the window for a point', () => {
    const xs = [
      pb(0, 140, 120),
      pb(1, 140, 120),
      pb(2, 140, 120),
      pb(3, 140, 120),
      pb(4, 140, 120),
    ];
    const t = breakTrend(xs, 'stop')!;
    expect(t.points.map((p) => [p.activityId, p.count, p.fallBpm])).toEqual([
      ['r4', 5, 20],
    ]);
    expect(breakTrend(xs.slice(0, 4), 'stop')).toBeUndefined();
    expect(breakTrend(xs, 'walk')).toBeUndefined();
  });

  it('gives the middle half of the falls around the typical one', () => {
    const xs = [10, 20, 30, 40, 50].map((fall, n) => pb(n, 150, 150 - fall));
    const [p] = breakTrend(xs, 'stop')!.points;
    expect(p).toMatchObject({ fallBpm: 30, lowBpm: 20, highBpm: 40 });
  });

  it('only counts the 30 days up to each run', () => {
    const early = [0, 1, 2, 3, 4].map((n) => pb(n, 140, 130)); // fell 10
    const late = [40, 41, 42, 43, 44].map((n) => pb(n, 140, 110)); // fell 30
    const t = breakTrend([...early, ...late], 'stop')!;
    expect(t.points.map((p) => [p.activityId, p.fallBpm])).toEqual([
      ['r4', 10],
      ['r44', 30],
    ]);
  });

  it('adjusts each fall to one starting heart rate', () => {
    // Every break falls 0.5 bpm per bpm above 100, so a higher start falls
    // further; once adjusted they all match.
    const xs = Array.from({ length: 12 }, (_, i) => {
      const start = 120 + i * 4;
      return pb(i, start, start - 0.5 * (start - 100));
    });
    const t = breakTrend(xs, 'stop')!;
    expect(t.slope).toBeCloseTo(0.5);
    expect(t.adjusted).toBe(true);
    expect(t.refBpm).toBe(140);
    expect(new Set(t.points.map((p) => p.fallBpm))).toEqual(new Set([20]));
  });

  it('makes no adjustment from too little spread', () => {
    const xs = Array.from({ length: 12 }, (_, i) => pb(i, 140 + (i % 2), 120));
    expect(breakTrend(xs, 'stop')).toMatchObject({ slope: 0, adjusted: false });
  });
});
