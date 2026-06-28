import { describe, it, expect } from 'vitest';
import {
  computeActivitySummary,
  prepareActivity,
  windowChannels,
} from '../src/summary/index.js';
import type { ImportedActivity } from '../src/types.js';

/** A synthetic ride: N points ~10 m apart (eastward), 1 Hz, with a finely
 *  varying elevation so coarse vs fine bucketing is visibly different. */
function syntheticRide(n: number): ImportedActivity {
  const dLng = 10 / 111320; // ~10 m per step at the equator
  const latlng: [number, number][] = [];
  const altitudeMeters: number[] = [];
  const timeSeconds: number[] = [];
  for (let i = 0; i < n; i++) {
    latlng.push([0, i * dLng]);
    altitudeMeters.push(100 + Math.sin(i / 3) * 20); // wiggles every few samples
    timeSeconds.push(i);
  }
  return {
    activity: {
      id: 'test:1',
      source: 'manual',
      externalId: '1',
      name: 'Synthetic',
      startTimeUtc: '2020-01-01T00:00:00Z',
      distanceMeters: 0,
      movingTimeSeconds: 0,
      elapsedTimeSeconds: 0,
      elevationGainMeters: 0,
      sportType: 'Ride',
    },
    streams: { latlng, altitudeMeters, timeSeconds },
  };
}

describe('coast classification (sustained → flag, brief → ignored)', () => {
  // 1 Hz, ~10 m/step, steady 150 W except for the given 0-W ranges [from,to).
  function powerRide(
    zeroRanges: Array<[number, number]>,
    n = 400,
  ): ImportedActivity {
    const dLng = 10 / 111320;
    const latlng: [number, number][] = [];
    const timeSeconds: number[] = [];
    const watts: number[] = [];
    for (let i = 0; i < n; i++) {
      latlng.push([0, i * dLng]);
      timeSeconds.push(i);
      watts.push(zeroRanges.some(([a, b]) => i >= a && i < b) ? 0 : 150);
    }
    return {
      activity: {
        id: 'test:p',
        source: 'manual',
        externalId: 'p',
        name: 'Power',
        startTimeUtc: '2020-01-01T00:00:00Z',
        distanceMeters: 0,
        movingTimeSeconds: 0,
        elapsedTimeSeconds: 0,
        elevationGainMeters: 0,
        sportType: 'Ride',
      },
      streams: { latlng, timeSeconds, watts },
    };
  }
  const powerOf = (ride: ImportedActivity) =>
    computeActivitySummary(ride, { profileBucketMeters: 50 }).channels.find(
      (c) => c.key === 'power',
    )!;
  const coastNear = (p: ReturnType<typeof powerOf>, from: number, to: number) =>
    p.points
      .filter((pt) => pt.distanceMeters >= from && pt.distanceMeters < to)
      .some((pt) => pt.coast);

  it('flags the sustained coast (NaN value) and bridges the flicker', () => {
    const power = powerOf(
      powerRide([
        [100, 130],
        [200, 202],
      ]),
    ); // 30 s sustained, 2 s flicker
    const coastPts = power.points.filter(
      (p) => p.distanceMeters >= 1000 && p.distanceMeters < 1300,
    );
    expect(coastPts.length).toBeGreaterThan(0);
    expect(coastPts.every((p) => p.coast && Number.isNaN(p.value))).toBe(true);
    expect(coastNear(power, 1990, 2020)).toBe(false); // flicker bridged
    const steady = power.points.find(
      (p) => p.distanceMeters >= 500 && p.distanceMeters < 600,
    )!;
    expect(steady.coast).toBe(false);
    expect(Number.isFinite(steady.value)).toBe(true);
  });

  it('pins the maxGap boundary (~10 s): 9 s bridges, 11 s flags', () => {
    expect(coastNear(powerOf(powerRide([[100, 109]])), 990, 1100)).toBe(false); // 9 s → bridge
    expect(coastNear(powerOf(powerRide([[100, 111]])), 990, 1130)).toBe(true); // 11 s → flag
  });

  it('treats a LEADING brief coast as a flicker, not sustained (bfill edge)', () => {
    // coasting off the line for 3 s (moving downhill, 0 W from sample 0) must NOT
    // flag — hold can't fill a left-edgeless gap, bfill must rescue it.
    expect(coastNear(powerOf(powerRide([[0, 3]])), 0, 60)).toBe(false);
    // but a LONG leading coast (15 s) still flags
    expect(coastNear(powerOf(powerRide([[0, 15]])), 0, 60)).toBe(true);
  });
});

describe('windowChannels (chart resolution on zoom)', () => {
  it('resolves a locked window far finer than the whole-activity profile', () => {
    const ride = syntheticRide(300); // ~3 km
    const summary = computeActivitySummary(ride); // 100 m buckets
    const prep = prepareActivity(ride);
    const total = summary.distanceMeters;

    const overviewElev = summary.channels.find((c) => c.key === 'elevation')!;
    // a 500 m window in the middle of the ride
    const start = total / 2;
    const end = start + 500;
    const fine = windowChannels(prep, { startMeters: start, endMeters: end });
    const fineElev = fine.find((c) => c.key === 'elevation')!;

    // how many overview points fall in that same window
    const overviewInWindow = overviewElev.points.filter(
      (p) => p.distanceMeters >= start && p.distanceMeters <= end,
    ).length;

    expect(fineElev.points.length).toBeGreaterThan(overviewInWindow * 5);
  });

  it('emits absolute distances within the window, on the same axis as the summary', () => {
    const ride = syntheticRide(300);
    const prep = prepareActivity(ride);
    const fine = windowChannels(prep, { startMeters: 1000, endMeters: 1400 });
    const elev = fine.find((c) => c.key === 'elevation')!;
    for (const p of elev.points) {
      expect(p.distanceMeters).toBeGreaterThanOrEqual(1000);
      expect(p.distanceMeters).toBeLessThanOrEqual(1400);
    }
  });

  it('clamps the bucket so it never out-resolves the floor or coarsens past 100 m', () => {
    const ride = syntheticRide(300);
    const prep = prepareActivity(ride);
    // a tiny 20 m window would want sub-metre buckets — clamped to the 5 m floor
    const tiny = windowChannels(prep, { startMeters: 1000, endMeters: 1020 });
    const tinyElev = tiny.find((c) => c.key === 'elevation')!;
    // 20 m / 5 m floor → at most ~4 buckets, not hundreds
    expect(tinyElev.points.length).toBeLessThanOrEqual(5);
  });

  it('emits the same channel set as the summary (present channels only)', () => {
    const ride = syntheticRide(120);
    const summary = computeActivitySummary(ride);
    const prep = prepareActivity(ride);
    const fine = windowChannels(prep, { startMeters: 200, endMeters: 700 });
    expect(fine.map((c) => c.key)).toEqual(summary.channels.map((c) => c.key));
  });
});
