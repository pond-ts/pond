import { describe, it, expect } from 'vitest';
import { Activity, Section } from '../src/activity/index.js';
import {
  Distance,
  Duration,
  Power,
  HeartRate,
  Speed,
} from '../src/quantities.js';
import { summaryFromPrepared, prepareActivity } from '../src/summary/index.js';
import { paceZonesFrom } from '../src/profile/index.js';
import type { ImportedActivity, ActivityStreams, Lap } from '../src/types.js';

const META = {
  id: 'test:1',
  source: 'manual' as const,
  externalId: '1',
  name: 'Test',
  startTimeUtc: '2020-01-01T00:00:00Z',
  distanceMeters: 0,
  movingTimeSeconds: 0,
  elapsedTimeSeconds: 0,
  elevationGainMeters: 0,
  sportType: 'Ride',
};

/** A GPS ride: n points ~10 m apart eastward, 1 Hz, wiggling elevation. Extra
 *  parallel channels merged in via `extra`. */
function ride(
  n: number,
  extra: Partial<ActivityStreams> = {},
  laps?: Lap[],
): ImportedActivity {
  const dLng = 10 / 111320; // ~10 m/step at the equator
  const latlng: [number, number][] = [];
  const altitudeMeters: number[] = [];
  const timeSeconds: number[] = [];
  for (let i = 0; i < n; i++) {
    latlng.push([0, i * dLng]);
    altitudeMeters.push(100 + Math.sin(i / 3) * 20);
    timeSeconds.push(i);
  }
  return {
    activity: { ...META },
    streams: { latlng, altitudeMeters, timeSeconds, ...extra },
    laps,
  };
}

/** A GPS-less indoor session: time + device distance + power + HR, no positions. */
function indoor(n: number): ImportedActivity {
  const timeSeconds: number[] = [];
  const distanceMeters: number[] = [];
  const watts: number[] = [];
  const heartrate: number[] = [];
  for (let i = 0; i < n; i++) {
    timeSeconds.push(i);
    distanceMeters.push(i * 8); // 8 m/s
    watts.push(200);
    heartrate.push(150);
  }
  return {
    activity: { ...META, sportType: 'VirtualRide' },
    streams: { latlng: [], timeSeconds, distanceMeters, watts, heartrate },
  };
}

describe('Activity.fromStreams + basics', () => {
  it('exposes metadata and the canonical series', () => {
    const a = Activity.fromStreams(ride(50));
    expect(a.meta.sportType).toBe('Ride');
    expect(a.hasTrack).toBe(true);
    expect(a.timeSeries().keyColumn().begin.length).toBe(50);
  });

  it('hasTrack is false for a GPS-less activity; series still present', () => {
    const a = Activity.fromStreams(indoor(60));
    expect(a.hasTrack).toBe(false);
    expect(a.timeSeries().keyColumn().begin.length).toBe(60);
    expect(a.distance().meters).toBeCloseTo(59 * 8, 0);
  });

  it('totals are quantity-typed and match the journey summary', () => {
    const a = Activity.fromStreams(ride(100));
    const s = summaryFromPrepared(prepareActivity(ride(100)));
    expect(a.distance()).toBeInstanceOf(Distance);
    expect(a.distance().meters).toBeCloseTo(s.distanceMeters, 6);
    expect(a.elapsedTime().seconds).toBeCloseTo(s.elapsedTimeSeconds, 6);
    expect(a.movingTime().seconds).toBeCloseTo(s.movingTimeSeconds, 6);
  });
});

describe('Activity.splits → Section[]', () => {
  it('cuts even-distance splits, quantity-typed, faithful to the operator', () => {
    const a = Activity.fromStreams(ride(250)); // ~2.49 km → 2 full km splits + tail
    const sections = a.splits(Distance.km(1));
    const raw = a.summary({ splitMeters: 1000 }).splits;
    expect(sections.length).toBe(raw.length);
    expect(sections[0]).toBeInstanceOf(Section);
    expect(sections[0]!.distance().meters).toBeCloseTo(
      raw[0]!.distanceMeters,
      6,
    );
    expect(sections[0]!.distance().meters).toBeGreaterThan(950);
    expect(sections[0]!.distance().meters).toBeLessThan(1050);
    // elapsed windows tile contiguously from 0
    expect(sections[0]!.fromSeconds).toBe(0);
    expect(sections[1]!.fromSeconds).toBeCloseTo(sections[0]!.toSeconds, 6);
    // a quantity, not a number
    expect(sections[0]!.duration()).toBeInstanceOf(Duration);
  });

  it('power/HR sections expose those channels; absent ones are undefined', () => {
    const withPower = Activity.fromStreams(
      ride(250, {
        watts: Array(250).fill(180),
        heartrate: Array(250).fill(145),
      }),
    );
    const s = withPower.splits(Distance.km(1))[0]!;
    expect(s.avgPower()).toBeInstanceOf(Power);
    expect(s.avgPower()!.watts).toBeCloseTo(180, 0);
    expect(s.avgHeartRate()).toBeInstanceOf(HeartRate);
    expect(s.avgHeartRate()!.bpm).toBeCloseTo(145, 0);

    const noPower = Activity.fromStreams(ride(250));
    expect(noPower.splits(Distance.km(1))[0]!.avgPower()).toBeUndefined();
    expect(noPower.splits(Distance.km(1))[0]!.avgHeartRate()).toBeUndefined();
  });

  it('avgSpeed falls back to distance ÷ moving time and inverts to pace', () => {
    const s = Activity.fromStreams(ride(250)).splits(Distance.km(1))[0]!;
    expect(s.avgSpeed()).toBeInstanceOf(Speed);
    expect(s.avgSpeed()!.metersPerSecond).toBeCloseTo(10, 1); // ~10 m/s
    expect(s.pace()!.secondsPerKm).toBeCloseTo(100, 0); // 1000 m / 10 m·s⁻¹
  });

  it('sections carry a cumulative-distance window that tiles from 0', () => {
    const sections = Activity.fromStreams(ride(250)).splits(Distance.km(1));
    expect(sections[0]!.startMeters).toBe(0);
    expect(sections[0]!.endMeters).toBeGreaterThan(950);
    // contiguous: each split's start == the previous split's end
    expect(sections[1]!.startMeters).toBeCloseTo(sections[0]!.endMeters, 6);
    // end − start == the reported distance
    const s0 = sections[0]!;
    expect(s0.endMeters - s0.startMeters).toBeCloseTo(s0.distance().meters, 6);
  });
});

describe('Activity.laps → Section[]', () => {
  it('wraps recorded laps; empty when the source had none', () => {
    expect(Activity.fromStreams(ride(50)).laps()).toEqual([]);
    const laps: Lap[] = [
      {
        index: 1,
        startTimeUtc: '2020-01-01T00:00:00Z',
        startDistanceMeters: 0,
        distanceMeters: 500,
        elapsedSeconds: 50,
        movingSeconds: 48,
        avgWatts: 210,
        avgHeartrate: 150,
      },
      {
        index: 2,
        startTimeUtc: '2020-01-01T00:00:50Z',
        startDistanceMeters: 500,
        distanceMeters: 500,
        elapsedSeconds: 50,
        movingSeconds: 50,
        avgWatts: 190,
      },
    ];
    const sections = Activity.fromStreams(ride(100, {}, laps)).laps();
    expect(sections.length).toBe(2);
    expect(sections[0]!.label).toBe('Lap 1');
    expect(sections[0]!.fromSeconds).toBe(0);
    expect(sections[1]!.fromSeconds).toBeCloseTo(50, 6);
    expect(sections[0]!.avgPower()!.watts).toBe(210);
    expect(sections[0]!.movingTime().seconds).toBe(48);
    // distance window from the recorded lap offsets
    expect(sections[0]!.startMeters).toBe(0);
    expect(sections[0]!.endMeters).toBe(500);
    expect(sections[1]!.startMeters).toBe(500);
    expect(sections[1]!.endMeters).toBe(1000);
  });
});

describe('Activity.range → computed Section', () => {
  it('computes metrics over an elapsed window', () => {
    const a = Activity.fromStreams(
      ride(200, {
        watts: Array(200).fill(160),
        heartrate: Array(200).fill(140),
      }),
    );
    const sec = a.range(Duration.seconds(50), Duration.seconds(150), 'mid');
    expect(sec.label).toBe('mid');
    expect(sec.fromSeconds).toBeCloseTo(50, 6);
    expect(sec.toSeconds).toBeCloseTo(150, 6);
    expect(sec.duration().seconds).toBeCloseTo(100, 6);
    expect(sec.distance().meters).toBeGreaterThan(990); // 100 s × ~10 m/s
    expect(sec.distance().meters).toBeLessThan(1010);
    expect(sec.avgPower()!.watts).toBeCloseTo(160, 0);
    expect(sec.avgHeartRate()!.bpm).toBeCloseTo(140, 0);
    // distance window = the cumulative-distance bounds of the slice
    expect(sec.startMeters).toBeCloseTo(500, -1); // ~50 s × ~10 m/s
    expect(sec.endMeters - sec.startMeters).toBeCloseTo(
      sec.distance().meters,
      6,
    );
  });

  it('reports no power over an all-missing-power window (matches splits, not 0 W)', () => {
    // power present overall, but NaN across [50, 150) — a recording gap.
    const watts = Array.from({ length: 200 }, (_, i) =>
      i >= 50 && i < 150 ? NaN : 200,
    );
    const a = Activity.fromStreams(ride(200, { watts }));
    const sec = a.range(Duration.seconds(60), Duration.seconds(140));
    expect(sec.avgPower()).toBeUndefined();
    expect(sec.normalizedPower()).toBeUndefined();
    expect(sec.maxPower()).toBeUndefined();
    // a powered window still reports power
    expect(
      a.range(Duration.seconds(0), Duration.seconds(40)).avgPower()!.watts,
    ).toBeCloseTo(200, 0);
  });

  it('clamps to the activity bounds', () => {
    const a = Activity.fromStreams(ride(100));
    const sec = a.range(Duration.seconds(-10), Duration.seconds(9999));
    expect(sec.fromSeconds).toBe(0);
    expect(sec.toSeconds).toBeCloseTo(99, 6);
  });
});

describe('Activity power analytics (profile-agnostic)', () => {
  it('power(ftp) is undefined without power, populated with it', () => {
    expect(Activity.fromStreams(ride(120)).power(200)).toBeUndefined();
    const a = Activity.fromStreams(ride(120, { watts: Array(120).fill(200) }));
    const p = a.power(250)!;
    expect(p.ftp).toBe(250);
    expect(p.normalizedWatts).toBeCloseTo(200, 0);
    expect(a.powerCurve().length).toBeGreaterThan(0);
    expect(a.bestEfforts({ weightKg: 80 })[0]!.wattsPerKg).toBeGreaterThan(0);
  });

  it('powerCurve/bestEfforts are empty without power', () => {
    const a = Activity.fromStreams(ride(120));
    expect(a.powerCurve()).toEqual([]);
    expect(a.bestEfforts()).toEqual([]);
    expect(a.hasPower).toBe(false);
  });

  it('distanceBestEfforts: fastest time per distance; [] without a time axis', () => {
    // 2000 m of GPS at ~10 m/s → the 400 m / 800 m / 1000 m / 1 mi windows qualify.
    const efforts = Activity.fromStreams(ride(200)).distanceBestEfforts([
      400, 800, 1000, 5000,
    ]);
    const m = new Map(efforts.map((e) => [e.meters, e.seconds]));
    expect(m.get(400)).toBeGreaterThan(0);
    expect(m.get(800)).toBeGreaterThan(m.get(400)!); // longer distance ⇒ more time
    expect(m.has(5000)).toBe(false); // ride is too short for a 5 k window
    // no timestamps ⇒ no time axis ⇒ no efforts
    const noTime: ImportedActivity = {
      activity: { ...META },
      streams: {
        latlng: Array.from(
          { length: 50 },
          (_, i) => [0, i * 0.001] as [number, number],
        ),
      },
    };
    expect(Activity.fromStreams(noTime).distanceBestEfforts()).toEqual([]);
  });

  it('paceZones bucket the derived speed', () => {
    const a = Activity.fromStreams(ride(300));
    const zones = a.paceZones(paceZonesFrom(1500));
    const total = zones.reduce((s, z) => s + z.seconds, 0);
    expect(total).toBeGreaterThan(0);
  });
});

describe('Activity.at → interpolated Sample', () => {
  it('samples channels at an instant and clamps the range', () => {
    const a = Activity.fromStreams(
      ride(100, {
        watts: Array(100).fill(175),
        heartrate: Array(100).fill(155),
      }),
    );
    const start = a.at(Duration.seconds(0));
    expect(start.atSeconds).toBe(0);
    expect(start.distance!.meters).toBeCloseTo(0, 3);

    const mid = a.at(Duration.seconds(50));
    expect(mid.distance!.meters).toBeGreaterThan(start.distance!.meters);
    expect(mid.power!.watts).toBeCloseTo(175, 3);
    expect(mid.heartRate!.bpm).toBeCloseTo(155, 3);

    const past = a.at(Duration.seconds(10_000));
    expect(past.atSeconds).toBeCloseTo(99, 6); // clamped to last sample
  });

  it('omits channels the activity never recorded', () => {
    const s = Activity.fromStreams(ride(40)).at(Duration.seconds(10));
    expect(s.power).toBeUndefined();
    expect(s.heartRate).toBeUndefined();
    expect(s.elevation).toBeDefined();
  });
});
