import { describe, it, expect } from 'vitest';
import {
  zoneDistributionByValue,
  hrZoneDistribution,
  paceZoneDistribution,
} from '../src/zones/index.js';
import {
  hrZonesFrom,
  paceZonesFrom,
  type ZoneDef,
} from '../src/profile/index.js';

const zones: ZoneDef = {
  edges: [0, 200, 300, 1e9],
  labels: ['low', 'mid', 'high'],
};

describe('zoneDistributionByValue', () => {
  it('sums each sample dt into the right band and totals the fractions to 1', () => {
    const out = zoneDistributionByValue(
      [100, 150, 250, 400],
      [1, 1, 1, 1],
      zones,
    );
    expect(out.map((z) => z.seconds)).toEqual([2, 1, 1]); // 100,150 → low; 250 → mid; 400 → high
    expect(out.map((z) => z.label)).toEqual(['low', 'mid', 'high']);
    expect(out.reduce((s, z) => s + z.fraction, 0)).toBeCloseTo(1, 6);
    expect(out[2]!.hi).toBe(Infinity); // open top
    expect(out[0]!.lo).toBe(0);
  });

  it('carries chart-ready start/end, with a finite end on the open top', () => {
    const out = zoneDistributionByValue(
      [100, 150, 250, 400],
      [1, 1, 1, 1],
      zones,
    );
    // start/end mirror lo/hi, except the open top is clamped to the observed max.
    expect(out.map((z) => z.start)).toEqual([0, 200, 300]);
    expect(out.map((z) => z.end)).toEqual([200, 300, 400]);
    expect(out[2]!.hi).toBe(Infinity); // the true edge is still available
    for (const z of out) {
      expect(Number.isFinite(z.start)).toBe(true);
      expect(Number.isFinite(z.end)).toBe(true);
      expect(z.start).toBe(z.lo); // alias agrees
    }
  });

  it('keeps end finite when no value can set it (unplaceable input)', () => {
    // Nothing here can raise the open top: NaN and ±Infinity are dropped from
    // binning, negatives clamp to 0. `end` must not leak -Infinity/Infinity.
    for (const values of [
      [NaN, NaN],
      [] as number[],
      [-50, -10],
      [Infinity, 150],
    ]) {
      const out = zoneDistributionByValue(
        values,
        values.map(() => 1),
        zones,
      );
      const top = out[out.length - 1]!;
      expect(Number.isFinite(top.end)).toBe(true);
      expect(top.end).toBe(top.start); // collapses to zero width
      expect(top.hi).toBe(Infinity); // …while the true edge is untouched
    }
  });

  it('is inclusive-upper at a boundary (a sample exactly on an edge → lower band)', () => {
    // value 200 sits on the low/mid edge → counts in `low` (pond `inclusive: '(]'`)
    const out = zoneDistributionByValue([200], [5], zones);
    expect(out[0]!.seconds).toBe(5);
    expect(out[1]!.seconds).toBe(0);
  });

  it('drops non-finite samples and clamps sub-zero to the bottom band', () => {
    const out = zoneDistributionByValue([NaN, -10, 250], [3, 3, 3], zones);
    expect(out[0]!.seconds).toBe(3); // the -10 clamps into `low`; NaN dropped
    expect(out[1]!.seconds).toBe(3); // the 250
  });
});

describe('hr/paceZoneDistribution wrappers', () => {
  it('hrZoneDistribution buckets bpm over the derived HR zones', () => {
    const timeSec = new Float64Array([0, 1, 2, 3]);
    const hr = [100, 140, 175, 195]; // vs maxHr 200 → edges 0,130,162,178,194,∞
    const out = hrZoneDistribution(timeSec, hr, hrZonesFrom({ maxHr: 200 }));
    expect(out).toHaveLength(5);
    // dt[0]=0 (first sample), so only samples 1..3 carry time; total = 3 s
    expect(out.reduce((s, z) => s + z.seconds, 0)).toBeCloseTo(3, 6);
  });

  it('paceZoneDistribution buckets speed so faster = higher zone', () => {
    const timeSec = new Float64Array([0, 1, 2]);
    const speed = [1.0, 2.5, 3.5]; // slow, mid, fast vs 5 k speed 2.976
    const out = paceZoneDistribution(timeSec, speed, paceZonesFrom(1680));
    expect(out).toHaveLength(6);
    expect(out.reduce((s, z) => s + z.seconds, 0)).toBeCloseTo(2, 6); // dt[0]=0
  });
});
