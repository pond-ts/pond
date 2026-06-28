import { describe, it, expect } from 'vitest';
import {
  haversineMeters,
  stepDistances,
  cumulative,
  totalDistanceMeters,
  elevationGainLoss,
  movingTimeSeconds,
  boundsOf,
  boundsViaPond,
  simplify,
  splitsByDistance,
  elevationProfile,
  profileByDistance,
  profileByDistanceWindow,
  rollingSpread,
  polylineCumulative,
  interpolateAtDistance,
  polylineSlice,
  buildTrack,
  readColumns,
  bestEffortsByDistance,
  segmentsInRange,
  type TrackPoint,
  type Spread,
} from '../src/geo/index.js';

describe('haversineMeters', () => {
  it('one degree of latitude is ~111.2 km', () => {
    expect(haversineMeters(0, 0, 1, 0)).toBeCloseTo(111194.9, 0);
  });
  it('is zero for identical points', () => {
    expect(haversineMeters(37.5, -122.3, 37.5, -122.3)).toBe(0);
  });
});

describe('distance series', () => {
  const lat = new Float64Array([0, 1, 2]);
  const lng = new Float64Array([0, 0, 0]);
  it('stepDistances has a zero first step then per-segment distances', () => {
    const step = stepDistances(lat, lng);
    expect(step[0]).toBe(0);
    expect(step[1]).toBeCloseTo(111194.9, 0);
    expect(step[2]).toBeCloseTo(111194.9, 0);
  });
  it('cumulative is the running total', () => {
    const cum = cumulative(stepDistances(lat, lng));
    expect(cum[2]).toBeCloseTo(222389.8, 0);
  });
  it('totalDistanceMeters matches the cumulative end', () => {
    expect(totalDistanceMeters(lat, lng)).toBeCloseTo(222389.8, 0);
  });
});

describe('elevationGainLoss', () => {
  it('counts a clean climb-and-descent above threshold', () => {
    const ele = new Float64Array([0, 10, 20, 10, 0]);
    const { gainMeters, lossMeters } = elevationGainLoss(ele, 3);
    expect(gainMeters).toBeCloseTo(20, 5);
    expect(lossMeters).toBeCloseTo(20, 5);
  });
  it('rejects sub-threshold jitter', () => {
    const ele = new Float64Array([100, 101, 100, 101, 100, 99, 100]);
    const { gainMeters } = elevationGainLoss(ele, 3);
    expect(gainMeters).toBe(0);
  });
  it('skips NaN (missing) samples', () => {
    const ele = new Float64Array([0, NaN, 10, NaN, 20]);
    expect(elevationGainLoss(ele, 3).gainMeters).toBeCloseTo(20, 5);
  });
});

describe('movingTimeSeconds', () => {
  it('excludes intervals slower than the threshold', () => {
    // 3 intervals of 10s: first moves 100m (10 m/s), second 1m (stopped), third 100m.
    const step = new Float64Array([0, 100, 1, 100]);
    const timeSec = new Float64Array([0, 10, 20, 30]);
    expect(movingTimeSeconds(step, timeSec, 0.5)).toBe(20);
  });
});

describe('bounds', () => {
  const lat = new Float64Array([37.0, 37.5, 37.2]);
  const lng = new Float64Array([-122.5, -122.1, -122.9]);
  it('boundsOf returns [[minLat,minLng],[maxLat,maxLng]]', () => {
    expect(boundsOf(lat, lng)).toEqual([
      [37.0, -122.9],
      [37.5, -122.1],
    ]);
  });
  it('boundsViaPond (column reductions) agrees with boundsOf', () => {
    const pts: TrackPoint[] = [
      [1000, 37.0, -122.5, 0, 0, undefined, undefined, undefined, undefined],
      [2000, 37.5, -122.1, 0, 0, undefined, undefined, undefined, undefined],
      [3000, 37.2, -122.9, 0, 0, undefined, undefined, undefined, undefined],
    ];
    const track = buildTrack('t', pts);
    expect(boundsViaPond(track)).toEqual(boundsOf(lat, lng));
  });
});

describe('readColumns reads pond columns back as typed arrays', () => {
  it('round-trips lat/lng/ele and the time key', () => {
    const pts: TrackPoint[] = [
      [10_000, 1, 2, 100, 80, undefined, undefined, undefined, undefined],
      [20_000, 3, 4, 110, 82, undefined, undefined, undefined, undefined],
    ];
    const cols = readColumns(buildTrack('t', pts));
    expect(Array.from(cols.lat)).toEqual([1, 3]);
    expect(Array.from(cols.ele)).toEqual([100, 110]);
    expect(Array.from(cols.timeSec)).toEqual([10, 20]);
  });

  it('reads a missing ele cell back as NaN (validity-aware, not 0)', () => {
    // undefined goes in (lossless); readColumns maps it to NaN via the
    // validity bitmap — so a gap is distinguishable from a real sea-level 0.
    const pts: TrackPoint[] = [
      [10_000, 1, 2, 100, 80, undefined, undefined, undefined, undefined],
      [20_000, 3, 4, undefined, 82, undefined, undefined, undefined, undefined],
      [30_000, 5, 6, 120, 84, undefined, undefined, undefined, undefined],
    ];
    const cols = readColumns(buildTrack('t', pts));
    expect(cols.ele[0]).toBe(100);
    expect(Number.isNaN(cols.ele[1]!)).toBe(true);
    expect(cols.ele[2]).toBe(120);
    // and the gain math skips the gap rather than seeing a 100→0→120 plunge
    expect(elevationGainLoss(cols.ele, 3).gainMeters).toBeCloseTo(20, 5);
  });
});

describe('simplify (Douglas–Peucker)', () => {
  it('collapses collinear points to the endpoints', () => {
    const line: Array<[number, number]> = [
      [0, 0],
      [0, 0.001],
      [0, 0.002],
      [0, 0.003],
    ];
    expect(simplify(line, 5)).toEqual([
      [0, 0],
      [0, 0.003],
    ]);
  });
  it('keeps a point that deviates beyond tolerance', () => {
    const spike: Array<[number, number]> = [
      [0, 0],
      [0.01, 0.0005], // ~1 km north of the straight line
      [0, 0.001],
    ];
    expect(simplify(spike, 50).length).toBe(3);
  });
});

describe('segmentsInRange (zone / power-band selection driver)', () => {
  // cum 0,10,20,30,40,50; value crosses in/out of [15,25] twice.
  const cum = new Float64Array([0, 10, 20, 30, 40, 50]);
  const vals = new Float64Array([10, 20, 20, 5, 18, 30]);

  it('returns the contiguous track runs where value is in [lo, hi]', () => {
    const segs = segmentsInRange(cum, vals, 15, 25);
    // in-range at idx 1,2 (run 10–20) and idx 4 (lone point at 40)
    expect(segs).toEqual([
      { startMeters: 10, endMeters: 20 },
      { startMeters: 40, endMeters: 40 },
    ]);
  });

  it('treats non-finite samples as out of range (breaks a run)', () => {
    const v = new Float64Array([20, NaN, 20]);
    const c = new Float64Array([0, 10, 20]);
    expect(segmentsInRange(c, v, 15, 25)).toEqual([
      { startMeters: 0, endMeters: 0 },
      { startMeters: 20, endMeters: 20 },
    ]);
  });

  it('merges runs separated by ≤ bridgeMeters so a blip does not shatter it', () => {
    const segs = segmentsInRange(cum, vals, 15, 25, 25); // 40−20 = 20 ≤ 25 → merge
    expect(segs).toEqual([{ startMeters: 10, endMeters: 40 }]);
  });

  it('is empty when nothing matches', () => {
    expect(segmentsInRange(cum, vals, 100, 200)).toEqual([]);
  });
});

describe('bestEffortsByDistance window location', () => {
  it('reports the inclusive sample range of the fastest window', () => {
    // 5 points, 1 km apart, but the middle km is ridden fast (10 s vs 100 s).
    const cum = new Float64Array([0, 1000, 2000, 3000, 4000]);
    const timeSec = new Float64Array([0, 100, 110, 210, 310]);
    const [e] = bestEffortsByDistance(cum, timeSec, [1000]);
    expect(e!.seconds).toBe(10); // the 1000→2000 km
    expect(e!.startIndex).toBe(1);
    expect(e!.endIndex).toBe(2);
  });
});

describe('splitsByDistance (F-geo-2: distance-domain bucketing)', () => {
  it('cuts a straight track into per-interval splits', () => {
    // ~2.5 deg of latitude ≈ 278 km; expect ~278 1-km splits.
    const lat = new Float64Array(2501);
    const lng = new Float64Array(2501);
    const timeSec = new Float64Array(2501);
    const ele = new Float64Array(2501);
    for (let i = 0; i <= 2500; i++) {
      lat[i] = i * 0.001;
      timeSec[i] = i * 10;
    }
    const step = stepDistances(lat, lng);
    const splits = splitsByDistance(step, timeSec, ele, 1000);
    expect(splits.length).toBeGreaterThanOrEqual(277);
    expect(splits.length).toBeLessThanOrEqual(279);
    // each full split is ~1000 m
    expect(splits[0]!.distanceMeters).toBeGreaterThan(950);
    expect(splits[0]!.distanceMeters).toBeLessThan(1050);
  });
});

describe('splitsByDistance normalized power', () => {
  it('computes per-split NP = (mean rolled⁴)^¼ from the rolled power', () => {
    // 4 × 500 m steps → two 1 km splits; rolled power 100 W then 200 W
    const step = new Float64Array([0, 500, 500, 500, 500]);
    const timeSec = new Float64Array([0, 1, 2, 3, 4]);
    const ele = new Float64Array(5);
    const npRolled = new Float64Array([100, 100, 100, 200, 200]);
    const splits = splitsByDistance(step, timeSec, ele, 1000, npRolled);
    expect(splits.length).toBe(2);
    expect(splits[0]!.normalizedWatts).toBeCloseTo(100, 6);
    expect(splits[1]!.normalizedWatts).toBeCloseTo(200, 6);
  });
  it('leaves normalizedWatts undefined when no power is given', () => {
    const step = new Float64Array([0, 500, 500]);
    const splits = splitsByDistance(
      step,
      new Float64Array([0, 1, 2]),
      new Float64Array(3),
      1000,
    );
    expect(splits[0]!.normalizedWatts).toBeUndefined();
  });
});

describe('splitsByDistance oversized steps (GPS gaps)', () => {
  it('peels one step bigger than the interval into multiple splits', () => {
    // A 2500 m haversine jump between two fixes (tunnel / lost signal) over
    // 250 s. The original `if` closed ONE 2500 m split; it must yield three:
    // 1000 + 1000 + 500, with time apportioned linearly by distance (0.1 s/m).
    const step = new Float64Array([0, 2500]);
    const timeSec = new Float64Array([0, 250]);
    const ele = new Float64Array(2);
    const splits = splitsByDistance(step, timeSec, ele, 1000);
    expect(splits.length).toBe(3);
    expect(splits[0]!.distanceMeters).toBeCloseTo(1000, 6);
    expect(splits[1]!.distanceMeters).toBeCloseTo(1000, 6);
    expect(splits[2]!.distanceMeters).toBeCloseTo(500, 6);
    // distance is conserved — nothing folded away, nothing duplicated
    expect(splits.reduce((s, x) => s + x.distanceMeters, 0)).toBeCloseTo(
      2500,
      6,
    );
    // duration apportioned by distance fraction up to each boundary
    expect(splits[0]!.durationSeconds).toBeCloseTo(100, 6);
    expect(splits[1]!.durationSeconds).toBeCloseTo(100, 6);
    expect(splits[2]!.durationSeconds).toBeCloseTo(50, 6);
    // indices stay contiguous
    expect(splits.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it('apportions a step crossing a single boundary (interval < step < 2·interval)', () => {
    // 1500 m in one step → 1000 + 500, not a single folded 1500 m split.
    const splits = splitsByDistance(
      new Float64Array([0, 1500]),
      new Float64Array([0, 150]),
      new Float64Array(2),
      1000,
    );
    expect(splits.length).toBe(2);
    expect(splits[0]!.distanceMeters).toBeCloseTo(1000, 6);
    expect(splits[1]!.distanceMeters).toBeCloseTo(500, 6);
    expect(splits[0]!.durationSeconds).toBeCloseTo(100, 6);
    expect(splits[1]!.durationSeconds).toBeCloseTo(50, 6);
  });

  it('leaves the dense portion untouched when a gap step follows it', () => {
    // Eight dense 250 m steps form two clean 1 km splits, THEN one 2500 m gap.
    // The dense splits must be byte-identical to the same track without the gap.
    const dense = [250, 250, 250, 250, 250, 250, 250, 250];
    const denseTimes = [0, 10, 20, 30, 40, 50, 60, 70, 80];

    const denseOnly = splitsByDistance(
      new Float64Array([0, ...dense]),
      new Float64Array(denseTimes),
      new Float64Array(dense.length + 1),
      1000,
    );
    expect(denseOnly.length).toBe(2);

    const mixed = splitsByDistance(
      new Float64Array([0, ...dense, 2500]),
      new Float64Array([...denseTimes, 330]),
      new Float64Array(dense.length + 2),
      1000,
    );
    // two unchanged dense splits + three peeled gap splits
    expect(mixed.length).toBe(5);
    expect(mixed[0]).toEqual(denseOnly[0]);
    expect(mixed[1]).toEqual(denseOnly[1]);
    expect(mixed[2]!.distanceMeters).toBeCloseTo(1000, 6);
    expect(mixed[3]!.distanceMeters).toBeCloseTo(1000, 6);
    expect(mixed[4]!.distanceMeters).toBeCloseTo(500, 6);
  });

  it('keeps the end-of-step sample when a gap lands exactly on a boundary', () => {
    // dStep == 2·interval: distance divides evenly, so a naive peel would leave
    // a 0 m remainder and discard the end-of-step fix. The sample must survive
    // in the final 1000 m split (no folding, no lost channel data).
    const splits = splitsByDistance(
      new Float64Array([0, 2000]),
      new Float64Array([0, 200]),
      new Float64Array(2),
      1000,
      undefined,
      { heartrate: new Float64Array([NaN, 150]) },
    );
    expect(splits.length).toBe(2);
    expect(splits[0]!.distanceMeters).toBeCloseTo(1000, 6);
    expect(splits[1]!.distanceMeters).toBeCloseTo(1000, 6);
    expect(splits[0]!.avgHeartrate).toBeUndefined();
    expect(splits[1]!.avgHeartrate).toBeCloseTo(150, 6);
    expect(splits.reduce((s, x) => s + x.distanceMeters, 0)).toBeCloseTo(
      2000,
      6,
    );
  });

  it('puts channel samples only in the split where the end-of-step fix lands', () => {
    // The single HR sample sits at the end of the 2500 m gap, so it belongs to
    // the final (remainder) split; the two synthetic peels carry no samples.
    const splits = splitsByDistance(
      new Float64Array([0, 2500]),
      new Float64Array([0, 250]),
      new Float64Array(2),
      1000,
      undefined,
      { heartrate: new Float64Array([NaN, 150]) },
    );
    expect(splits.length).toBe(3);
    expect(splits[0]!.avgHeartrate).toBeUndefined();
    expect(splits[1]!.avgHeartrate).toBeUndefined();
    expect(splits[2]!.avgHeartrate).toBeCloseTo(150, 6);
  });
});

describe('distance-grid size guards', () => {
  const step = new Float64Array([0, 500, 500]);
  const cum = new Float64Array([0, 250, 500]);
  const vals = new Float64Array([1, 2, 3]);
  for (const bad of [0, -100, NaN, Infinity]) {
    it(`splitsByDistance rejects intervalMeters=${bad}`, () => {
      expect(() =>
        splitsByDistance(
          step,
          new Float64Array([0, 1, 2]),
          new Float64Array(3),
          bad,
        ),
      ) //
        .toThrow(RangeError);
    });
    it(`profileByDistance rejects bucketMeters=${bad}`, () => {
      expect(() => profileByDistance(cum, vals, bad)).toThrow(RangeError);
    });
    it(`profileByDistanceWindow rejects bucketMeters=${bad}`, () => {
      expect(() => profileByDistanceWindow(cum, vals, 0, 500, bad)).toThrow(
        RangeError,
      );
    });
  }
});

describe('readColumns requires lat AND lng to count as a track', () => {
  it('treats a track with positions present as GPS (lat/lng full)', () => {
    const pts: TrackPoint[] = [
      [
        0,
        1,
        2,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ],
      [
        1000,
        1.1,
        2.1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ],
    ];
    const cols = readColumns(buildTrack('t', pts));
    expect(cols.lat.length).toBe(2);
    expect(cols.lng.length).toBe(2);
  });
  it('emits NO positions (length 0) when lng is missing on every row', () => {
    // A malformed track: lat present, lng absent. Must NOT fabricate (lat, 0)
    // points on the prime meridian — degrade to a GPS-less track instead.
    const pts: TrackPoint[] = [
      [
        0,
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ],
      [
        1000,
        1.1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ],
    ];
    const cols = readColumns(buildTrack('t', pts));
    expect(cols.lat.length).toBe(0);
    expect(cols.lng.length).toBe(0);
  });
});

describe('splitsByDistance per-split aggregates (geek mode)', () => {
  // 4 × 500 m steps → two 1 km splits. Sample i contributes to split ⌈i/2⌉.
  const step = new Float64Array([0, 500, 500, 500, 500]);
  const timeSec = new Float64Array([0, 10, 20, 30, 40]);
  const ele = new Float64Array([0, 5, 10, 3, 0]); // up 10 in split 1, down 10 in split 2

  it('computes elevation gain AND loss per split (±3 m hysteresis)', () => {
    const splits = splitsByDistance(step, timeSec, ele, 1000);
    expect(splits.length).toBe(2);
    expect(splits[0]!.elevationGainMeters).toBeCloseTo(10, 6);
    expect(splits[0]!.elevationLossMeters).toBeCloseTo(0, 6);
    expect(splits[1]!.elevationGainMeters).toBeCloseTo(0, 6);
    expect(splits[1]!.elevationLossMeters).toBeCloseTo(10, 6);
  });

  it('averages and peaks HR / power / cadence / speed, skipping NaN', () => {
    const splits = splitsByDistance(step, timeSec, ele, 1000, undefined, {
      heartrate: new Float64Array([NaN, 140, 160, 150, 130]),
      watts: new Float64Array([NaN, 200, 300, 100, NaN]), // last sample missing
      cadence: new Float64Array([NaN, 80, 90, 70, 60]),
      speed: new Float64Array([NaN, 50, 50, 50, 50]),
    });
    expect(splits[0]!.avgHeartrate).toBeCloseTo(150, 6);
    expect(splits[0]!.maxHeartrate).toBe(160);
    expect(splits[0]!.avgWatts).toBeCloseTo(250, 6);
    expect(splits[0]!.maxWatts).toBe(300);
    expect(splits[0]!.avgCadence).toBeCloseTo(85, 6);
    expect(splits[0]!.maxSpeedMps).toBe(50);
    // split 2: the missing watt sample is skipped → avg over the one present value
    expect(splits[1]!.avgHeartrate).toBeCloseTo(140, 6);
    expect(splits[1]!.avgWatts).toBeCloseTo(100, 6);
    expect(splits[1]!.avgCadence).toBeCloseTo(65, 6);
  });

  it('leaves channel aggregates undefined when the stream is not supplied', () => {
    const splits = splitsByDistance(step, timeSec, ele, 1000);
    expect(splits[0]!.avgHeartrate).toBeUndefined();
    expect(splits[0]!.maxWatts).toBeUndefined();
    expect(splits[0]!.avgCadence).toBeUndefined();
    expect(splits[0]!.avgSpeedMps).toBeUndefined();
  });
});

describe('elevationProfile (F-geo-2)', () => {
  it('buckets elevation onto an even distance grid', () => {
    const cum = new Float64Array([0, 100, 200, 300, 400]);
    const ele = new Float64Array([0, 10, 20, 30, 40]);
    const profile = elevationProfile(cum, ele, 100);
    expect(profile.length).toBeGreaterThanOrEqual(4);
    expect(profile[0]!.distanceMeters).toBe(0);
    expect(profile[profile.length - 1]!.elevationMeters).toBeGreaterThan(
      profile[0]!.elevationMeters,
    );
  });
});

describe('segment geometry (polyline slicing)', () => {
  // 3 collinear points up a meridian (lng fixed) — each step ≈ 111.19 m, so
  // distance is linear in latitude and interpolation is easy to reason about.
  const P: Array<[number, number]> = [
    [0, 0],
    [0.001, 0],
    [0.002, 0],
  ];
  const cum = polylineCumulative(P);
  const total = cum[cum.length - 1]!;

  it('cumulative starts at 0 and is monotonic', () => {
    expect(cum[0]).toBe(0);
    expect(cum[1]).toBeCloseTo(111.19, 0);
    expect(cum[2]).toBeCloseTo(222.39, 0);
  });

  it('interpolates a point at a given distance, clamping to the ends', () => {
    expect(interpolateAtDistance(P, 0)).toEqual([0, 0]);
    expect(interpolateAtDistance(P, total)![0]).toBeCloseTo(0.002, 9);
    expect(interpolateAtDistance(P, cum[1]!)![0]).toBeCloseTo(0.001, 9); // the mid vertex
    expect(interpolateAtDistance(P, cum[1]! / 2)![0]).toBeCloseTo(0.0005, 9);
    expect(interpolateAtDistance(P, -100)).toEqual([0, 0]); // clamp low
    expect(interpolateAtDistance(P, total + 1e6)![0]).toBeCloseTo(0.002, 9); // clamp high
    expect(interpolateAtDistance([], 5)).toBeNull();
    // non-finite resolves to the start (never [NaN,NaN])
    expect(interpolateAtDistance(P, NaN)).toEqual([0, 0]);
    expect(interpolateAtDistance(P, Infinity)).toEqual([0, 0]);
  });

  it('slices with interpolated endpoints plus the interior vertices', () => {
    const slice = polylineSlice(P, cum[1]! * 0.5, cum[1]! * 1.5);
    expect(slice.length).toBe(3); // start-interp, mid vertex, end-interp
    expect(slice[0]![0]).toBeCloseTo(0.0005, 9);
    expect(slice[1]![0]).toBeCloseTo(0.001, 9);
    expect(slice[2]![0]).toBeCloseTo(0.0015, 9);
  });

  it('a full-range slice returns the whole line; clamps out-of-range', () => {
    const full = polylineSlice(P, 0, total);
    expect(full.map((p) => p[0])).toEqual([0, 0.001, 0.002]);
    expect(polylineSlice(P, -100, total + 1e6).length).toBe(3); // clamped == full
  });

  it('rescales the window when domainTotal differs from the polyline length', () => {
    // P is ~222 m long. A window [0, 222] in a 444 m ruler is the first half of
    // the route → maps to polyline [0, 111] → first vertex + the midpoint.
    const half = polylineSlice(P, 0, total * 2, { domainTotal: total * 4 });
    expect(half[0]![0]).toBeCloseTo(0, 9);
    expect(half[half.length - 1]![0]).toBeCloseTo(0.001, 6); // ~half way (the mid vertex)
    // domainTotal === polyline length → no rescale (same as omitting it)
    expect(polylineSlice(P, 0, total, { domainTotal: total })).toEqual(
      polylineSlice(P, 0, total),
    );
  });

  it('normalizes reversed ranges and degenerates safely', () => {
    expect(polylineSlice(P, total, 0).map((p) => p[0])).toEqual([
      0, 0.001, 0.002,
    ]); // reversed
    const zero = polylineSlice(P, cum[1]!, cum[1]!); // zero-length → two coincident pts
    expect(zero.length).toBe(2);
    expect(zero[0]![0]).toBeCloseTo(0.001, 9);
    expect(polylineSlice([], 0, 100)).toEqual([]);
  });
});

describe('profileByDistance (percentile band)', () => {
  it('value is the bucket median; band is p5..p95, not raw min/max', () => {
    // one bucket [0,100): an outlier at index 0 plus a tight cluster
    const cum = new Float64Array([0, 10, 20, 30, 40]);
    const vals = new Float64Array([1000, 10, 11, 12, 13]);
    const [p] = profileByDistance(cum, vals, 100);
    expect(p!.value).toBe(12); // median ignores the 1000 spike
    expect(p!.bandHi).toBeLessThan(1000); // p95 trims the outlier
    expect(p!.bandLo).toBeLessThanOrEqual(p!.value);
    expect(p!.bandHi).toBeGreaterThanOrEqual(p!.value);
  });

  it('keeps the median inside [bandLo, bandHi] for every bucket', () => {
    const cum = new Float64Array([0, 100, 100, 200, 200, 200]);
    const vals = new Float64Array([5, 0, 100, 7, 8, 9]);
    for (const p of profileByDistance(cum, vals, 100)) {
      if (!Number.isFinite(p.value)) continue;
      expect(p.bandLo).toBeLessThanOrEqual(p.value);
      expect(p.value).toBeLessThanOrEqual(p.bandHi);
    }
  });

  it('carries across a short gap but BREAKS the line across a sustained hole', () => {
    // samples at 0, 100, then nothing until 3000 (a ~2.9 km hole) — a dropped
    // sensor. With 100 m buckets and a 1 km carry window, the first ~10 empty
    // buckets carry the last value; beyond that the line breaks (NaN) instead of
    // drawing a long flat line at a stale value, then resumes when data returns.
    const cum = new Float64Array([0, 100, 3000, 3100]);
    const vals = new Float64Array([50, 50, 90, 90]);
    const prof = profileByDistance(cum, vals, 100);
    const at = (m: number) =>
      prof.find((p) => Math.abs(p.distanceMeters - m) < 1)!;
    expect(at(500).value).toBe(50); // 400 m into the gap → still carried
    expect(Number.isNaN(at(2000).value)).toBe(true); // ~1.9 km in → broken
    expect(at(3000).value).toBe(90); // data returns → line resumes
  });

  it('emits a tighter inner band (p25..p75) inside the outer (p5..p95)', () => {
    const cum = new Float64Array([0, 10, 20, 30, 40]);
    const vals = new Float64Array([10, 20, 30, 40, 50]);
    const [p] = profileByDistance(cum, vals, 100);
    expect(p!.value).toBe(30); // median
    expect(p!.innerLo).toBe(20); // p25
    expect(p!.innerHi).toBe(40); // p75
    // inner sits strictly inside the outer envelope
    expect(p!.bandLo).toBeLessThan(p!.innerLo);
    expect(p!.innerHi).toBeLessThan(p!.bandHi);
  });

  it('handles single-sample buckets (median = the sample)', () => {
    const cum = new Float64Array([0, 100, 250]);
    const vals = new Float64Array([3, 7, 11]);
    const out = profileByDistance(cum, vals, 100);
    expect(out.map((p) => p.value)).toEqual([3, 7, 11]);
    expect(out[0]!.bandLo).toBe(3);
    expect(out[0]!.bandHi).toBe(3);
  });

  it('carries the last seen bucket forward across gaps (leading + interior)', () => {
    // nothing in bucket 0 (distances all land in 1 and 3); bucket 0 stays NaN,
    // empty interior buckets carry the previous value forward.
    const cum = new Float64Array([100, 110, 400]);
    const vals = new Float64Array([20, 22, 40]);
    const out = profileByDistance(cum, vals, 100);
    expect(Number.isNaN(out[0]!.value)).toBe(true); // bucket 0 never seen → NaN
    expect(out[1]!.value).toBe(21); // median of [20,22]
    expect(out[2]!.value).toBe(21); // empty interior bucket → carried forward
    expect(out[3]!.value).toBe(40);
  });

  it('returns all-NaN points when every sample is NaN', () => {
    const cum = new Float64Array([0, 100, 200]);
    const vals = new Float64Array([NaN, NaN, NaN]);
    for (const p of profileByDistance(cum, vals, 100)) {
      expect(Number.isNaN(p.value)).toBe(true);
      expect(Number.isNaN(p.bandLo)).toBe(true);
      expect(Number.isNaN(p.bandHi)).toBe(true);
    }
  });
});

describe('profileByDistanceWindow (zoom resolution)', () => {
  it('buckets only samples in [start,end], at the finer bucket', () => {
    // 0..700 m, one sample per 100 m. A 200..500 window at 100 m → 3 buckets.
    const cum = new Float64Array([0, 100, 200, 300, 400, 500, 600, 700]);
    const vals = new Float64Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const out = profileByDistanceWindow(cum, vals, 200, 500, 100);
    expect(out.length).toBe(3);
    // samples at 200/300/400 → buckets 0/1/2; the inclusive end sample at 500
    // clamps into the last bucket (same as profileByDistance), so bucket 2 is
    // the median of [4, 5].
    expect(out.map((p) => p.value)).toEqual([2, 3, 4.5]);
  });

  it('returns ABSOLUTE distances offset by the window start', () => {
    const cum = new Float64Array([0, 100, 200, 300, 400, 500]);
    const vals = new Float64Array([0, 1, 2, 3, 4, 5]);
    const out = profileByDistanceWindow(cum, vals, 200, 500, 100);
    expect(out.map((p) => p.distanceMeters)).toEqual([200, 300, 400]);
  });

  it('reveals detail a coarse whole-track bucket averages away', () => {
    // five distinct readings inside one 0..500 region. The whole-track profile
    // at a 500 m bucket collapses them to one median; the windowed profile at
    // 100 m keeps all five.
    const cum = new Float64Array([0, 100, 200, 300, 400]);
    const vals = new Float64Array([10, 20, 30, 40, 50]);
    const coarse = profileByDistance(cum, vals, 500);
    expect(coarse.length).toBe(1);
    expect(coarse[0]!.value).toBe(30); // median, detail lost
    // window [0,300] → 3 buckets: 10 and 20 survive as their own buckets (detail
    // the coarse median erased); the 200 + end-edge 300 samples share the last
    // bucket → median(30,40)=35. Either way, far more resolution than one 30.
    const fine = profileByDistanceWindow(cum, vals, 0, 300, 100);
    expect(fine.map((p) => p.value)).toEqual([10, 20, 35]);
  });

  it('matches profileByDistance when the window is the whole track', () => {
    const cum = new Float64Array([0, 50, 100, 150, 200, 250]);
    const vals = new Float64Array([1, 9, 2, 8, 3, 7]);
    const total = cum[cum.length - 1]!;
    const whole = profileByDistance(cum, vals, 100);
    const win = profileByDistanceWindow(cum, vals, 0, total, 100);
    expect(win.map((p) => p.value)).toEqual(whole.map((p) => p.value));
    expect(win.map((p) => p.distanceMeters)).toEqual(
      whole.map((p) => p.distanceMeters),
    );
  });

  it('rollingSpread reads a FIXED ±radius window of raw samples', () => {
    const cum = new Float64Array([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    const vals = new Float64Array([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    const [s] = rollingSpread(cum, vals, [50], 25); // window [25,75] → 30..70
    expect(s!.innerLo).toBe(40); // p25 of [30,40,50,60,70]
    expect(s!.innerHi).toBe(60); // p75
    expect(s!.bandLo).toBeLessThan(s!.innerLo); // outer wider than inner
    expect(s!.bandHi).toBeGreaterThan(s!.innerHi);
  });

  it('rollingSpread is zoom-stable: same distance → same spread, any query grid', () => {
    const cum = new Float64Array([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    const vals = new Float64Array([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    const coarse = rollingSpread(cum, vals, [50], 25)[0]!;
    const fine = rollingSpread(cum, vals, [48, 49, 50, 51, 52], 25)[2]!; // the d=50 entry
    expect(fine.bandLo).toBe(coarse.bandLo);
    expect(fine.bandHi).toBe(coarse.bandHi);
    expect(fine.innerLo).toBe(coarse.innerLo);
    expect(fine.innerHi).toBe(coarse.innerHi);
  });

  it('rollingSpread is NaN where the window has no samples', () => {
    const cum = new Float64Array([0, 1000]);
    const vals = new Float64Array([5, 9]);
    const [s] = rollingSpread(cum, vals, [500], 50); // nothing within ±50 of 500
    expect(Number.isNaN(s!.bandLo)).toBe(true);
    expect(Number.isNaN(s!.innerHi)).toBe(true);
  });

  it('rollingSpread skips NaN samples in the window', () => {
    const cum = new Float64Array([0, 10, 20, 30, 40]);
    const vals = new Float64Array([10, NaN, 30, NaN, 50]);
    const [s] = rollingSpread(cum, vals, [20], 25); // window [-5,45] → finite {10,30,50}
    expect(s!.innerLo).toBe(20); // p25 of [10,30,50] → rank 0.5 → 10+(30-10)*0.5
    expect(s!.innerHi).toBe(40); // p75 → rank 1.5 → 30+(50-30)*0.5
  });

  it('rollingSpread matches a brute-force ±radius percentile (parity)', () => {
    // Independent reference: for each center, collect finite samples in the
    // closed ±radius window and take linear-interpolated percentiles. This is
    // the pre-pond hand-rolled algorithm, kept here to pin the rollingByColumn
    // adoption to identical numbers.
    const q = (sorted: number[], p: number): number => {
      if (sorted.length === 0) return NaN;
      if (sorted.length === 1) return sorted[0]!;
      const idx = (sorted.length - 1) * p;
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
    };
    const ref = (
      cum: Float64Array,
      vals: Float64Array,
      centers: number[],
      r: number,
    ): Spread[] =>
      centers.map((d) => {
        const win: number[] = [];
        for (let i = 0; i < cum.length; i++) {
          if (cum[i]! >= d - r && cum[i]! <= d + r && Number.isFinite(vals[i]!))
            win.push(vals[i]!);
        }
        win.sort((a, b) => a - b);
        if (win.length === 0)
          return { bandLo: NaN, bandHi: NaN, innerLo: NaN, innerHi: NaN };
        return {
          bandLo: q(win, 0.05),
          bandHi: q(win, 0.95),
          innerLo: q(win, 0.25),
          innerHi: q(win, 0.75),
        };
      });

    // a deterministic pseudo-random ride (no Math.random — reproducible)
    const N = 600;
    const cum = new Float64Array(N);
    const vals = new Float64Array(N);
    let acc = 0;
    for (let i = 0; i < N; i++) {
      acc += 3 + ((i * 7919) % 17); // irregular ascending spacing 3..19 m
      cum[i] = acc;
      const seed = (i * 2654435761) % 1000;
      vals[i] = i % 23 === 0 ? NaN : 50 + (seed - 500) * 0.4; // sprinkle gaps
    }
    const total = cum[N - 1]!;
    const centers: number[] = [];
    for (let d = 0; d <= total; d += 25) centers.push(d); // even query grid

    const got = rollingSpread(cum, vals, centers, 120);
    const want = ref(cum, vals, centers, 120);
    expect(got.length).toBe(want.length);
    for (let k = 0; k < got.length; k++) {
      for (const key of ['bandLo', 'bandHi', 'innerLo', 'innerHi'] as const) {
        const g = got[k]![key];
        const w = want[k]![key];
        if (Number.isNaN(w)) expect(Number.isNaN(g)).toBe(true);
        else expect(g).toBeCloseTo(w, 9);
      }
    }
  });

  it('skips NaN samples and carries forward inside the window', () => {
    const cum = new Float64Array([0, 100, 200, 300, 400]);
    const vals = new Float64Array([5, NaN, NaN, NaN, 9]);
    const out = profileByDistanceWindow(cum, vals, 0, 400, 100);
    expect(out[0]!.value).toBe(5);
    expect(out[1]!.value).toBe(5); // NaN bucket carries previous forward
    expect(out[2]!.value).toBe(5);
    expect(out[3]!.value).toBe(9); // end-edge sample lands in the last bucket
  });
});
