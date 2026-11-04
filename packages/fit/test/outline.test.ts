import { describe, it, expect } from 'vitest';
import {
  decodePolyline,
  encodePolyline,
  levelFor,
  simplifyToPoints,
  trackLevels,
  trackShape,
  type GeoPoint,
} from '../src/index.js';

describe('polyline', () => {
  it('matches the reference example and round-trips', () => {
    const pts: GeoPoint[] = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    const s = encodePolyline(pts);
    expect(s).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline(s)).toEqual(pts);
  });

  it('decodes an empty or broken string without throwing', () => {
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline('_p~iF')).toEqual([]);
  });
});

describe('trackShape', () => {
  it('says there is no GPS when no point is usable', () => {
    expect(trackShape([])).toEqual({ hasGps: false });
    expect(
      trackShape([
        [0, 0],
        [NaN, 3],
        [95, 10],
      ]),
    ).toEqual({ hasGps: false });
  });

  it('leaves out samples with no fix', () => {
    const s = trackShape([null, [40.42, -3.7], null, [40.43, -3.71]]);
    expect(s.start).toEqual({ lat: 40.42, lng: -3.7 });
    expect(decodePolyline(s.outline!)).toHaveLength(2);
  });

  it('starts at the first real fix, skipping 0,0 placeholders', () => {
    const s = trackShape([
      [0, 0],
      [40.4167812, -3.7037902],
      [40.42, -3.7],
    ]);
    expect(s.hasGps).toBe(true);
    expect(s.start).toEqual({ lat: 40.41678, lng: -3.70379 });
    expect(decodePolyline(s.outline!)).toHaveLength(2);
  });

  it('keeps a long track to at most 100 points, ends included', () => {
    // A 20,000-point loop.
    const loop: GeoPoint[] = Array.from({ length: 20000 }, (_, i) => {
      const a = (i / 19999) * 2 * Math.PI;
      return [40 + 0.05 * Math.sin(a), -3.7 + 0.05 * Math.cos(a)];
    });
    const pts = decodePolyline(trackShape(loop).outline!);
    expect(pts.length).toBeLessThanOrEqual(100);
    expect(pts.length).toBeGreaterThan(20);
    expect(pts[0]).toEqual([40, -3.65]);
    expect(pts.at(-1)![0]).toBeCloseTo(40, 4);
  });
});

describe('simplifyToPoints', () => {
  it('keeps the corner of an L and drops the straight runs', () => {
    const line: GeoPoint[] = [];
    for (let i = 0; i <= 50; i++) line.push([40, -3 + i * 0.001]);
    for (let i = 1; i <= 50; i++) line.push([40 + i * 0.001, -2.95]);
    const s = simplifyToPoints(line, 10);
    expect(s).toContainEqual([40, -2.95]);
    expect(s.length).toBeLessThanOrEqual(10);
  });
});

describe('trackLevels', () => {
  // A wiggly line ~11 km east near the equator, a point every ~11 m, with a
  // 3 m wobble that only the finest level should keep.
  const wiggly: [number, number][] = Array.from({ length: 1000 }, (_, i) => [
    1 + (i % 2 ? 3 : 0) / 111_320 + Math.sin(i / 50) * 0.002,
    10 + i * 0.0001,
  ]);

  it('builds coarse to fine levels, each with more points', () => {
    const levels = trackLevels(wiggly);
    expect(levels.map((l) => l.metres)).toEqual([40, 10, 2.5]);
    const counts = levels.map((l) => decodePolyline(l.line).length);
    expect(counts[0]).toBeLessThan(counts[1]!);
    expect(counts[1]).toBeLessThan(counts[2]!);
    // ends kept at every level
    for (const l of levels) {
      const pts = decodePolyline(l.line);
      expect(pts[0]![1]).toBeCloseTo(10, 5);
      expect(pts[pts.length - 1]![1]).toBeCloseTo(10 + 999 * 0.0001, 4);
    }
  });

  it("keeps every recorded point within each level's metres", () => {
    const toM = (p: [number, number]) => [
      p[1] * 111_320 * Math.cos(Math.PI / 180),
      p[0] * 111_320,
    ];
    const offBy = (p: [number, number], line: [number, number][]) => {
      const [px, py] = toM(p);
      let best = Infinity;
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = toM(line[i - 1]!);
        const [bx, by] = toM(line[i]!);
        const dx = bx! - ax!;
        const dy = by! - ay!;
        const len2 = dx * dx + dy * dy;
        const t = len2
          ? Math.max(
              0,
              Math.min(1, ((px! - ax!) * dx + (py! - ay!) * dy) / len2),
            )
          : 0;
        best = Math.min(
          best,
          Math.hypot(px! - ax! - t * dx, py! - ay! - t * dy),
        );
      }
      return best;
    };
    for (const l of trackLevels(wiggly)) {
      const line = decodePolyline(l.line) as [number, number][];
      // + 1.5 m: the encoding rounds to 5 decimal places (~1.1 m)
      const worst = Math.max(...wiggly.map((p) => offBy(p, line)));
      expect(worst).toBeLessThanOrEqual(l.metres + 1.5);
    }
    // Only the finest level keeps the 3 m wobble.
    const [coarse, , fine] = trackLevels(wiggly);
    expect(
      Math.max(
        ...wiggly.map((p) =>
          offBy(p, decodePolyline(coarse!.line) as [number, number][]),
        ),
      ),
    ).toBeGreaterThan(2.5);
    expect(decodePolyline(fine!.line).length).toBeGreaterThan(500);
  });

  it('has no levels without GPS', () => {
    expect(trackLevels([])).toEqual([]);
    expect(trackLevels([[0, 0]])).toEqual([]);
  });
});

describe('levelFor', () => {
  const levels = [
    { metres: 2.5, line: 'fine' },
    { metres: 40, line: 'coarse' },
    { metres: 10, line: 'mid' },
  ];
  it('picks the coarsest level within a pixel', () => {
    expect(levelFor(levels, 100)?.line).toBe('coarse');
    expect(levelFor(levels, 40)?.line).toBe('coarse');
    expect(levelFor(levels, 20)?.line).toBe('mid');
    expect(levelFor(levels, 3)?.line).toBe('fine');
  });
  it('falls back to the finest when zoomed in past them all', () => {
    expect(levelFor(levels, 0.5)?.line).toBe('fine');
    expect(levelFor([], 10)).toBeUndefined();
  });
});
