import { describe, it, expect } from 'vitest';
import {
  computeActivitySummary,
  prepareActivity,
  windowChannels,
} from '../src/summary/index.js';
import { lineDistanceAt, lineRange } from '../src/geo/index.js';
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

describe('open water swims', () => {
  // 0.7 m/s due north for 30 min, a fix every 10 s; every third fix lands
  // 150 m east of the path (the arm came up into a bad fix). The watch's own
  // distance follows the real path.
  const dLat = 1 / 111195; // ~1 m of latitude
  function swim(openWater: boolean): ImportedActivity {
    const latlng: [number, number][] = [];
    const timeSeconds: number[] = [];
    const distanceMeters: number[] = [];
    for (let t = 0; t <= 1800; t += 10) {
      const along = 0.7 * t;
      const off = (t / 10) % 3 === 2 ? 150 / 111195 : 0;
      latlng.push([38.5 + along * dLat, -123 + off]);
      timeSeconds.push(t);
      distanceMeters.push(along);
    }
    return {
      activity: {
        id: 'test:ow',
        source: 'manual',
        externalId: 'ow',
        name: 'River swim',
        startTimeUtc: '2016-07-16T15:18:05Z',
        distanceMeters: 0,
        movingTimeSeconds: 0,
        elapsedTimeSeconds: 0,
        elevationGainMeters: 0,
        sportType: 'Swim',
      },
      streams: {
        latlng,
        timeSeconds,
        distanceMeters,
        ...(openWater ? { openWater } : {}),
      },
    };
  }

  it('measures by the line without the flag (as before)', () => {
    const s = computeActivitySummary(swim(false));
    expect(s.distanceMeters).toBeGreaterThan(2 * 1260);
  });

  it("measures by the watch's own distance", () => {
    const s = computeActivitySummary(swim(true));
    expect(s.distanceMeters).toBeCloseTo(1260, 6);
  });

  it('cleans the line: no point strays far from the path', () => {
    const p = prepareActivity(swim(true));
    expect(p.cols.lat.length).toBe(181);
    let worst = 0;
    for (let i = 0; i < p.cols.lng.length; i++)
      worst = Math.max(worst, Math.abs(p.cols.lng[i]! + 123) * 87000);
    // the bad fixes sat 150 m off; the cleaned line stays within a few metres
    expect(worst).toBeLessThan(10);
  });

  it('measures the cleaned line when the device distance is unusable', () => {
    const a = swim(true);
    a.streams.distanceMeters = a.streams.distanceMeters!.map(() => 0);
    const s = computeActivitySummary(a);
    // the bad fixes are gone, so the cleaned line reads near the real 1,260 m
    expect(s.distanceMeters).toBeGreaterThan(1000);
    expect(s.distanceMeters).toBeLessThan(1400);
  });

  it('keeps speed to swimming speed', () => {
    const p = prepareActivity(swim(true));
    const v = Array.from(p.speed).filter(Number.isFinite);
    expect(Math.max(...v)).toBeCloseTo(0.7, 6);
  });
});

describe('a run whose first minutes have no GPS fix', () => {
  // 1,000 s at 2 m/s, a sample every 10 s. The watch finds satellites at
  // 300 s: before that it records its own distance (from the wrist's motion
  // sensor) and heart rate, but no position. The fixes run north at 2 m/s.
  const dLat = 1 / 111195; // ~1 m of latitude
  function run(withDistance = true): ImportedActivity {
    const latlng: Array<[number, number] | null> = [];
    const timeSeconds: number[] = [];
    const distanceMeters: number[] = [];
    const heartrate: number[] = [];
    for (let t = 0; t <= 1000; t += 10) {
      latlng.push(t < 300 ? null : [38.5 + (2 * t - 600) * dLat, -123]);
      timeSeconds.push(t);
      distanceMeters.push(2 * t);
      heartrate.push(120 + t / 100);
    }
    return {
      activity: {
        id: 'test:lock',
        source: 'manual',
        externalId: 'lock',
        name: 'Morning run',
        startTimeUtc: '2026-10-20T09:04:20Z',
        distanceMeters: 0,
        movingTimeSeconds: 0,
        elapsedTimeSeconds: 0,
        elevationGainMeters: 0,
        sportType: 'Run',
      },
      streams: {
        latlng,
        timeSeconds,
        heartrate,
        ...(withDistance ? { distanceMeters } : {}),
      },
    };
  }

  it("measures by the watch's own distance, the minutes before the fix included", () => {
    const s = computeActivitySummary(run());
    expect(s.distanceMeters).toBeCloseTo(2000, 6);
    expect(s.pointCount).toBe(101);
    // heart rate spans the whole run on the distance axis
    const hr = s.channels.find((c) => c.key === 'heartrate')!;
    expect(hr.points[0]!.distanceMeters).toBeLessThan(200);
  });

  it('draws only the fixes on the map', () => {
    const s = computeActivitySummary(run());
    expect(s.polyline.length).toBeGreaterThan(1);
    for (const [lat, lng] of s.polyline) {
      expect(Number.isFinite(lat)).toBe(true);
      expect(Number.isFinite(lng)).toBe(true);
    }
    expect(s.bounds![0][0]).toBeCloseTo(38.5, 6);
    expect(s.bounds![1][0]).toBeCloseTo(38.5 + 1400 * dLat, 6);
  });

  it('places chart metres on the line, and nothing before the fix', () => {
    const s = computeActivitySummary(run());
    expect(s.gpsSpans).toHaveLength(1);
    const span = s.gpsSpans![0]!;
    expect(span.startMeters).toBeCloseTo(600, 6);
    expect(span.endMeters).toBeCloseTo(2000, 6);
    expect(span.lineStartMeters).toBe(0);
    expect(span.lineEndMeters).toBeCloseTo(1400, 0);
    expect(lineDistanceAt(s.gpsSpans!, 300)).toBeNull();
    expect(lineDistanceAt(s.gpsSpans!, 1300)).toBeCloseTo(700, 0);
    // a lap over the first km lights the part with fixes
    const r = lineRange(s.gpsSpans!, 0, 1000)!;
    expect(r[0]).toBeCloseTo(0, 6);
    expect(r[1]).toBeCloseTo(400, 0);
    expect(lineRange(s.gpsSpans!, 0, 500)).toBeNull();
  });

  it('measures the joined fixes when the watch kept no distance', () => {
    const s = computeActivitySummary(run(false));
    expect(s.distanceMeters).toBeCloseTo(1400, 0);
    expect(s.pointCount).toBe(101);
  });

  it('leaves a full track as before: no spans', () => {
    const a = run();
    a.streams.latlng = a.streams.latlng.map(
      (p, i) => p ?? [38.5 + (2 * i * 10 - 600) * dLat, -123],
    );
    const s = computeActivitySummary(a);
    expect(s.gpsSpans).toBeUndefined();
  });
});

describe('a dropout in the middle', () => {
  it('splits the spans and joins the line across the gap', () => {
    const dLat = 1 / 111195;
    const latlng: Array<[number, number] | null> = [];
    const distanceMeters: number[] = [];
    const timeSeconds: number[] = [];
    for (let t = 0; t <= 100; t += 10) {
      latlng.push(t >= 40 && t <= 60 ? null : [38.5 + 2 * t * dLat, -123]);
      distanceMeters.push(2 * t);
      timeSeconds.push(t);
    }
    const s = computeActivitySummary({
      activity: {
        id: 'test:drop',
        source: 'manual',
        externalId: 'drop',
        name: 'Tunnel',
        startTimeUtc: '2026-10-20T09:00:00Z',
        distanceMeters: 0,
        movingTimeSeconds: 0,
        elapsedTimeSeconds: 0,
        elevationGainMeters: 0,
        sportType: 'Run',
      },
      streams: { latlng, distanceMeters, timeSeconds },
    });
    expect(s.distanceMeters).toBeCloseTo(200, 6);
    expect(s.gpsSpans!.map((g) => [g.startMeters, g.endMeters])).toEqual([
      [0, 60],
      [140, 200],
    ]);
    // the line joins 60 → 140 straight, so the second run starts 140 m along
    expect(s.gpsSpans![1]!.lineStartMeters).toBeCloseTo(140, 0);
    expect(lineDistanceAt(s.gpsSpans!, 100)).toBeNull();
  });
});
