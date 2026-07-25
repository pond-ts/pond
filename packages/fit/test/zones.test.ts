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
    expect(out[2]!.openEnded).toBe(true); // open top
    expect(out[0]!.start).toBe(0);
  });

  it('carries chart-ready start/end, with a finite end on the open top', () => {
    const out = zoneDistributionByValue(
      [100, 150, 250, 400],
      [1, 1, 1, 1],
      zones,
    );
    // Real edges, except the open top which is drawn out to the observed max.
    expect(out.map((z) => z.start)).toEqual([0, 200, 300]);
    expect(out.map((z) => z.end)).toEqual([200, 300, 400]);
    expect(out.map((z) => z.openEnded)).toEqual([false, false, true]);
    for (const z of out) {
      expect(Number.isFinite(z.start)).toBe(true);
      expect(Number.isFinite(z.end)).toBe(true);
      expect(z.end).toBeGreaterThan(z.start);
    }
  });

  it('keeps the open top drawable when no value can set its width', () => {
    // Nothing here can raise the open top: NaN and ±Infinity are dropped from
    // binning, negatives clamp to 0, and an all-zero ride sits ON the floor.
    // `end` must stay finite AND wider than `start` — byColumn itself rejects a
    // zero-width bin, and it would vanish from a chart even while holding time.
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
      expect(top.end).toBeGreaterThan(top.start);
      expect(top.openEnded).toBe(true);
    }
  });

  it('flags only the FINAL band open-ended, even past the sentinel', () => {
    // Real edges that run past the 1e9 sentinel: an interior band must NOT be
    // treated as open (it would overlap the band above it).
    const out = zoneDistributionByValue([0], [1], {
      edges: [0, 2e9, 3e9],
      labels: ['a', 'b'],
    });
    expect(out.map((z) => z.openEnded)).toEqual([false, true]);
    expect(out[0]!.end).toBe(2e9); // its real edge, not a stand-in
    expect(out[1]!.start).toBe(2e9); // no overlap
    for (const z of out) expect(z.end).toBeGreaterThan(z.start);
  });

  it('keeps end > start even at magnitudes where +1 is a no-op', () => {
    // Above 2^53 adding a width does nothing; the guarantee still has to hold.
    const out = zoneDistributionByValue([0], [1], {
      edges: [1e16, 2e16],
      labels: ['huge'],
    });
    expect(out[0]!.end).toBeGreaterThan(out[0]!.start);
    expect(Number.isFinite(out[0]!.end)).toBe(true);
  });

  it('gives a single open-ended band width even when it holds all the time', () => {
    // One band, open-ended, every sample sitting exactly on its inclusive
    // floor: `end` cannot come from the data, but the band holds 100% of the
    // time and must still be drawable.
    const out = zoneDistributionByValue([0, 0, 0], [1, 1, 1], {
      edges: [0, 1e9],
      labels: ['all'],
    });
    expect(out[0]!.seconds).toBe(3);
    expect(out[0]!.fraction).toBeCloseTo(1, 6);
    expect(out[0]!.end).toBeGreaterThan(out[0]!.start);
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
