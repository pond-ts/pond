import { describe, it, expect } from 'vitest';
import { bestEffortsByDistance } from '../src/geo/index.js';
import { powerBestEfforts } from '../src/power/index.js';

describe('bestEffortsByDistance (fastest time over distance)', () => {
  // 1 km at a uniform 10 s / 100 m, HR a flat 150.
  const cumDist = new Float64Array(
    Array.from({ length: 11 }, (_, i) => i * 100),
  );
  const timeSec = new Float64Array(
    Array.from({ length: 11 }, (_, i) => i * 10),
  );
  const hr = new Float64Array(11).fill(150);

  it('finds the fastest time over each distance (uniform → exact)', () => {
    const out = bestEffortsByDistance(cumDist, timeSec, [400, 800], hr);
    expect(out.map((e) => e.meters)).toEqual([400, 800]);
    expect(out[0]!.seconds).toBeCloseTo(40, 6); // 400 m at 10 s/100 m
    expect(out[1]!.seconds).toBeCloseTo(80, 6);
    expect(out[0]!.avgHeartrate).toBeCloseTo(150, 6);
  });

  it('times are non-decreasing with distance', () => {
    const out = bestEffortsByDistance(cumDist, timeSec, [400, 800, 1000]);
    const secs = out.map((e) => e.seconds);
    for (let i = 1; i < secs.length; i++)
      expect(secs[i]!).toBeGreaterThanOrEqual(secs[i - 1]!);
  });

  it('skips distances longer than the activity', () => {
    const out = bestEffortsByDistance(cumDist, timeSec, [400, 5000]);
    expect(out.map((e) => e.meters)).toEqual([400]); // 5 k > 1 km total
  });

  it('picks the exact fastest window over a faster stretch', () => {
    // same 1 km but the 300–700 m stretch is twice as fast (5 s/100 m), so the
    // fastest 400 m is that stretch end-to-end: t[7]−t[3] = 50−30 = 20 s.
    const t = new Float64Array([0, 10, 20, 30, 35, 40, 45, 50, 60, 70, 80]);
    expect(bestEffortsByDistance(cumDist, t, [400])[0]!.seconds).toBeCloseTo(
      20,
      6,
    );
  });

  it('handles a non-zero-start cumulative distance', () => {
    // cumDist offset by 500 m (e.g. a windowed slice) — total is still 1 km.
    const offset = new Float64Array(cumDist.map((d) => d + 500));
    const out = bestEffortsByDistance(offset, timeSec, [400, 800]);
    expect(out[0]!.seconds).toBeCloseTo(40, 6);
    expect(out.map((e) => e.meters)).toEqual([400, 800]);
  });
});

describe('powerBestEfforts (power curve sampled + W/kg)', () => {
  // 121 s at a flat 200 W, 1 Hz.
  const timeSec = new Float64Array(Array.from({ length: 121 }, (_, i) => i));
  const watts = new Float64Array(121).fill(200);

  it('returns the canonical durations within the activity, at the sustained power', () => {
    const out = powerBestEfforts(timeSec, watts);
    expect(out.map((e) => e.durationSeconds)).toEqual([5, 15, 30, 60, 120]); // 180 s > 120 s total
    for (const e of out) expect(e.watts).toBe(200);
    expect(out[0]!.wattsPerKg).toBeUndefined(); // no weight supplied
  });

  it('adds W/kg when a body weight is given', () => {
    const out = powerBestEfforts(timeSec, watts, { weightKg: 80 });
    for (const e of out) expect(e.wattsPerKg).toBeCloseTo(2.5, 6); // 200 / 80
  });
});
