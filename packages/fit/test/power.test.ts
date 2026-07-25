import { describe, it, expect } from 'vitest';
import {
  averagePower,
  maxPower,
  totalWorkKj,
  normalizedPower,
  intensityFactor,
  trainingLoad,
  powerDistribution,
  zoneDistribution,
  powerCurve,
  powerBestEfforts,
  logDurations,
  computePower,
} from '../src/power/index.js';

const t = (n: number) => Float64Array.from({ length: n }, (_, i) => i); // 1 Hz

describe('computePower', () => {
  it('emits the distribution at the 1 W base by default', () => {
    const p = computePower(t(100), new Float64Array(100).fill(150), 200, 100);
    expect(p.distribution.length).toBeGreaterThan(1);
    // contiguous 1 W bins: each starts one watt above the last
    for (let i = 1; i < p.distribution.length; i++) {
      expect(p.distribution[i]!.start - p.distribution[i - 1]!.start).toBe(1);
    }
  });

  it('buckets to `binWatts` when asked, so the output is display-ready', () => {
    const p = computePower(t(100), new Float64Array(100).fill(150), 200, 100, {
      binWatts: 25,
    });
    expect(p.distribution.every((b) => b.end - b.start === 25)).toBe(true);
    // 150 W lands in the 150–175 bucket, which holds all the time
    const occupied = p.distribution.filter((b) => b.seconds > 0);
    expect(occupied.length).toBe(1);
    expect(occupied[0]!.start).toBe(150);
    expect(occupied[0]!.end).toBe(175);
  });

  it('rejects a binWatts that could not produce drawable bins', () => {
    for (const binWatts of [0, -25, NaN, Infinity]) {
      expect(() =>
        computePower(t(20), new Float64Array(20).fill(150), 250, 20, {
          binWatts,
        }),
      ).toThrow(/binWatts must be a positive finite number/);
    }
    // fractional widths are legitimate
    expect(() =>
      computePower(t(20), new Float64Array(20).fill(150), 250, 20, {
        binWatts: 0.5,
      }),
    ).not.toThrow();
  });
});

/** The shape `@pond-ts/charts` consumes (`BinRecord` in charts' data.ts).
 *  Mirrored here rather than imported — fit must not depend on charts. */
type BinRecord = { readonly start: number; readonly end: number };

describe('chart-ready bin edges', () => {
  it('distribution bins carry contiguous finite start/end (BinRecord)', () => {
    const p = computePower(t(100), new Float64Array(100).fill(150), 200, 100);

    // Compiles ⇒ structurally assignable to what <BarChart bins> takes.
    const asBins: BinRecord[] = p.distribution;
    expect(asBins.length).toBe(p.distribution.length);

    for (const b of p.distribution) {
      expect(Number.isFinite(b.start)).toBe(true);
      expect(Number.isFinite(b.end)).toBe(true);
      expect(b.end).toBeGreaterThan(b.start);
    }
    // contiguous: each bin starts where the previous ended
    for (let i = 1; i < p.distribution.length; i++) {
      expect(p.distribution[i]!.start).toBe(p.distribution[i - 1]!.end);
    }
  });

  it('honours the bin width in the edges', () => {
    const bins = powerDistribution(t(50), new Float64Array(50).fill(120), 25);
    expect(bins[0]!.start).toBe(0);
    expect(bins[0]!.end).toBe(25);
    expect(bins[4]!.start).toBe(100); // the 100–125 W bucket holds the samples
    expect(bins[4]!.end).toBe(125);
    expect(bins[4]!.seconds).toBeGreaterThan(0);
  });

  it('zones give the open-ended top a finite, drawable end', () => {
    // Ride tops out at 400 W; Z7 is open-ended.
    const watts = new Float64Array(100).fill(150);
    watts[50] = 400;
    const zones = zoneDistribution(t(100), watts, 200);
    const top = zones[zones.length - 1]!;

    expect(top.openEnded).toBe(true);
    expect(Number.isFinite(top.end)).toBe(true);
    expect(top.end).toBe(400); // the highest wattage observed
    expect(zones.slice(0, -1).every((z) => !z.openEnded)).toBe(true);

    const asBins: BinRecord[] = zones;
    expect(asBins.length).toBe(zones.length);
    for (const z of zones) {
      expect(Number.isFinite(z.start)).toBe(true);
      expect(Number.isFinite(z.end)).toBe(true);
      expect(z.end).toBeGreaterThan(z.start); // never zero-width
    }
    // contiguous: each zone starts where the previous ended
    for (let i = 1; i < zones.length; i++) {
      expect(zones[i]!.start).toBe(zones[i - 1]!.end);
    }
  });

  it('keeps the top zone drawable even when nothing reaches it', () => {
    // Nothing above Z1 — the open top is never entered, but must still have
    // width: a zero-width bin is what byColumn rejects as unrepresentable.
    const zones = zoneDistribution(t(20), new Float64Array(20).fill(10), 200);
    const top = zones[zones.length - 1]!;
    expect(top.seconds).toBe(0);
    expect(top.end).toBeGreaterThan(top.start);
  });

  it('never collapses a zone at a tiny FTP (rounding stays strictly ascending)', () => {
    // At FTP 1 every Coggan edge rounds to the same watt or two; the bands must
    // still come back strictly ascending rather than zero-width.
    const zones = zoneDistribution(
      t(4),
      Float64Array.from([1, 1, 1, 1]),
      1, // pathological FTP
    );
    for (const z of zones) expect(z.end).toBeGreaterThan(z.start);
    for (let i = 1; i < zones.length; i++) {
      expect(zones[i]!.start).toBe(zones[i - 1]!.end);
    }
    // and the time is still accounted for
    expect(zones.reduce((s, z) => s + z.seconds, 0)).toBeGreaterThan(0);
  });
});

describe('scalar power metrics', () => {
  it('averagePower skips NaN', () => {
    expect(averagePower(new Float64Array([100, NaN, 200]))).toBe(150);
  });
  it('maxPower', () => {
    expect(maxPower(new Float64Array([100, 300, 200]))).toBe(300);
  });
  it('totalWorkKj integrates power over the 1 Hz intervals (first dt = 0)', () => {
    // dt = [0,1,1,1]; work = 100·3 = 300 J = 0.3 kJ
    expect(
      totalWorkKj(t(4), new Float64Array([100, 100, 100, 100])),
    ).toBeCloseTo(0.3, 6);
  });
  it('intensityFactor = NP / FTP', () => {
    expect(intensityFactor(150, 200)).toBe(0.75);
  });
  it('trainingLoad: 1 h exactly at FTP is 100 TSS', () => {
    expect(trainingLoad(200, 200, 3600)).toBeCloseTo(100, 6);
  });
});

describe('normalizedPower (pond rolling)', () => {
  it('constant power normalizes to that power', () => {
    const watts = new Float64Array(120).fill(200);
    expect(normalizedPower(t(120), watts)).toBeCloseTo(200, 0);
  });
});

describe('powerDistribution (value-axis histogram)', () => {
  it('buckets time by power bin', () => {
    // dt = [0,1,1,1]; 50→bin0 (1 s), 200→bin2 (2 s)
    const bins = powerDistribution(
      t(4),
      new Float64Array([50, 50, 200, 200]),
      100,
    );
    expect(bins[0]!.seconds).toBeCloseTo(1, 6);
    expect(bins[1]!.seconds).toBeCloseTo(0, 6);
    expect(bins[2]!.seconds).toBeCloseTo(2, 6);
  });
});

describe('zoneDistribution (FTP-relative bucketing)', () => {
  it('places samples in the right Coggan zone', () => {
    // FTP 100 → edges 55/75/90/105/120/150; dt = [0,1,1,1]
    const zones = zoneDistribution(
      t(4),
      new Float64Array([50, 120, 200, 50]),
      100,
    );
    expect(zones[0]!.seconds).toBeCloseTo(1, 6); // Z1: the 50 W sample at idx3
    expect(zones[4]!.seconds).toBeCloseTo(1, 6); // Z5: 120 W
    expect(zones[6]!.seconds).toBeCloseTo(1, 6); // Z7: 200 W
    expect(zones[6]!.openEnded).toBe(true);
    const total = zones.reduce((a, z) => a + z.seconds, 0);
    expect(zones[0]!.fraction).toBeCloseTo(1 / 3, 5);
    expect(total).toBeCloseTo(3, 6);
  });
});

describe('powerCurve (mean-maximal sweep)', () => {
  it('constant power yields that power at every duration, non-increasing', () => {
    const watts = new Float64Array(600).fill(150);
    const curve = powerCurve(t(600), watts, [1, 10, 60, 300]);
    for (const p of curve) expect(p.watts).toBeCloseTo(150, 0);
    expect(curve.at(-1)!.durationSeconds).toBe(300);
  });
  it('logDurations is strictly increasing, deduped, and bounded by total', () => {
    const ds = logDurations(3600);
    expect(ds[0]).toBe(1);
    expect(ds[ds.length - 1]).toBe(3600);
    for (let i = 1; i < ds.length; i++)
      expect(ds[i]!).toBeGreaterThan(ds[i - 1]!);
    expect(ds.length).toBeGreaterThan(40); // dense
  });

  it('stops at durations longer than the activity', () => {
    // 121 samples at 1 Hz span 120 s of intervals (first dt = 0), so 60 s fits
    // but 3600 s is dropped.
    const curve = powerCurve(
      t(121),
      new Float64Array(121).fill(100),
      [1, 60, 3600],
    );
    expect(curve.map((p) => p.durationSeconds)).toEqual([1, 60]);
  });

  it('reports the sample window where each peak was achieved', () => {
    // 200 samples at 1 Hz; a 10 s surge to 400 W at index 100, baseline 100 W.
    const watts = new Float64Array(200).fill(100);
    for (let i = 100; i < 110; i++) watts[i] = 400;
    const [p] = powerCurve(t(200), watts, [5]);
    expect(p!.watts).toBeGreaterThan(300); // the surge dominates the 5 s peak
    // window lands inside the surge (indices ~100–110)
    expect(p!.startIndex).toBeGreaterThanOrEqual(99);
    expect(p!.endIndex).toBeLessThanOrEqual(110);
  });
});

describe('powerBestEfforts', () => {
  it('carries each effort window through from the curve (for navigating to it)', () => {
    // baseline 100 W, a 10 s surge to 400 W at index 100 — the 5 s effort's
    // window must land inside the surge so the UI can focus that stretch.
    const watts = new Float64Array(200).fill(100);
    for (let i = 100; i < 110; i++) watts[i] = 400;
    const [e] = powerBestEfforts(t(200), watts, { durations: [5] });
    expect(e!.watts).toBeGreaterThan(300);
    expect(e!.startIndex).toBeGreaterThanOrEqual(99);
    expect(e!.endIndex).toBeLessThanOrEqual(110);
  });
});
