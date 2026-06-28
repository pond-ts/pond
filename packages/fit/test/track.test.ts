import { describe, it, expect } from 'vitest';
import { Track } from '../src/track/index.js';
import { Distance } from '../src/quantities.js';
import type { GeoPoint } from '../src/types.js';

// A straight line east along the equator, 4 vertices ~111 m apart (0.001° lng).
const LINE: GeoPoint[] = [
  [0, 0],
  [0, 0.001],
  [0, 0.002],
  [0, 0.003],
];

describe('Track', () => {
  const t = Track.of(LINE);

  it('reports vertex count and non-empty', () => {
    expect(t.count).toBe(4);
    expect(t.isEmpty).toBe(false);
    expect(t.points).toBe(LINE);
  });

  it('cumulativeMeters is monotonic from 0 and matches the total distance', () => {
    const cum = t.cumulativeMeters();
    expect(cum.length).toBe(4);
    expect(cum[0]).toBe(0);
    expect(cum[1]! < cum[2]!).toBe(true);
    expect(cum[2]! < cum[3]!).toBe(true);
    expect(t.distance().meters).toBeCloseTo(cum[3]!, 9);
    // ~111.3 m per 0.001° lng at the equator × 3 segments.
    expect(t.distance().meters).toBeGreaterThan(330);
    expect(t.distance().meters).toBeLessThan(336);
  });

  it('bounds is the [min, max] lat/lng box', () => {
    expect(t.bounds()).toEqual([
      [0, 0],
      [0, 0.003],
    ]);
  });

  it('pointAt clamps to the ends and interpolates the middle', () => {
    expect(t.pointAt(Distance.meters(0))).toEqual([0, 0]);
    const end = t.pointAt(t.distance())!;
    expect(end[0]).toBeCloseTo(0, 9);
    expect(end[1]).toBeCloseTo(0.003, 9);
    // halfway along → ~0.0015° lng
    const mid = t.pointAt(Distance.meters(t.distance().meters / 2))!;
    expect(mid[1]).toBeCloseTo(0.0015, 4);
  });

  it('slice returns a sub-track with interpolated endpoints', () => {
    const half = t.slice(
      Distance.meters(0),
      Distance.meters(t.distance().meters / 2),
    );
    expect(half.points[0]).toEqual([0, 0]);
    const last = half.points[half.count - 1]!;
    expect(last[1]).toBeCloseTo(0.0015, 4);
    // a full-length slice round-trips the endpoints
    const whole = t.slice(Distance.meters(0), t.distance());
    expect(whole.points[0]).toEqual([0, 0]);
    expect(whole.points[whole.count - 1]![1]).toBeCloseTo(0.003, 9);
  });

  it('handles an empty track gracefully', () => {
    const e = Track.of([]);
    expect(e.isEmpty).toBe(true);
    expect(e.count).toBe(0);
    expect(e.distance().meters).toBe(0);
    expect(e.bounds()).toBeNull();
    expect(e.pointAt(Distance.meters(10))).toBeNull();
    expect(e.slice(Distance.meters(0), Distance.meters(10)).count).toBe(0);
  });
});
