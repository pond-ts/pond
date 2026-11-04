import { describe, expect, it } from 'vitest';
import {
  Activity,
  computeActivitySummary,
  trackLine,
  prepareActivity,
  type ImportedActivity,
} from '../src/index.js';

const META = {
  id: 'test:x',
  source: 'manual' as const,
  externalId: 'x',
  name: 'Test',
  startTimeUtc: '2026-01-01T08:00:00Z',
  distanceMeters: 0,
  movingTimeSeconds: 0,
  elapsedTimeSeconds: 0,
  elevationGainMeters: 0,
  sportType: 'Ride',
};

/** 10 minutes a second apart at ~3.3 m/s, with samples 200–299 missing from
 *  every value channel (written as `gap`). */
function ride(gap: number | null): ImportedActivity {
  const t = Array.from({ length: 600 }, (_, i) => i);
  const g = (v: (i: number) => number) =>
    t.map((i) => (i >= 200 && i < 300 ? gap : v(i))) as number[];
  return {
    activity: META,
    streams: {
      latlng: t.map((i) => [37 + i * 0.00003, -122] as [number, number]),
      timeSeconds: t,
      watts: g((i) => 200 + (i % 50)),
      heartrate: g((i) => 140 + (i % 20)),
      cadence: g(() => 90),
      altitudeMeters: g((i) => 10 + i / 10),
      temperatureC: g(() => 20),
    },
    laps: [
      {
        index: 1,
        startTimeUtc: META.startTimeUtc,
        startDistanceMeters: 0,
        distanceMeters: 1000,
        elapsedSeconds: 300,
        movingSeconds: 300,
      },
      {
        index: 2,
        startTimeUtc: '2026-01-01T08:05:00Z',
        startDistanceMeters: 1000,
        distanceMeters: 1000,
        elapsedSeconds: 299,
        movingSeconds: 299,
      },
    ],
  };
}

describe('a missing sample written as null', () => {
  it('reads exactly as one written as NaN', () => {
    const read = (gap: number | null) => {
      const a = Activity.fromStreams(ride(gap));
      return {
        summary: a.summary(),
        power: a.power(250),
        laps: a.laps().map((l) => l.normalizedPower()?.watts),
        window: a.windowChannels({ startMeters: 500, endMeters: 1500 }),
      };
    };
    const nan = read(NaN);
    const nul = read(null);
    expect(nul).toEqual(nan);
    // and the gap is a gap, not a 0 W coast
    expect(nul.power!.averageWatts).toBeGreaterThan(200);
  });
});

describe('channel times', () => {
  /** A pool swim with no GPS: one record per 25 m length, the first at the
   *  end of the first length. */
  function pool(): ImportedActivity {
    const n = 40;
    return {
      activity: { ...META, sportType: 'Swim' },
      streams: {
        latlng: [],
        timeSeconds: Array.from({ length: n }, (_, i) => 30 + i * 30),
        distanceMeters: Array.from({ length: n }, (_, i) => 25 + i * 25),
        heartrate: Array.from({ length: n }, () => 130),
      },
    };
  }

  it('are finite and never run backwards, even before the first sample', () => {
    const a = Activity.fromStreams(pool());
    for (const chs of [
      a.summary().channels,
      a.windowChannels({ startMeters: 0, endMeters: 200, minBucketMeters: 1 }),
    ])
      for (const c of chs) {
        const times = c.points.map((p) => p.timeSeconds);
        expect(times.every(Number.isFinite)).toBe(true);
        for (let i = 1; i < times.length; i++)
          expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
      }
  });
});

describe('channel times in a zoomed window', () => {
  /** No GPS: 0–1000 m over 0–300 s, nothing until 4000 m at 1800 s, then on
   *  to 5000 m at 2100 s. */
  function gappy(): ImportedActivity {
    const t: number[] = [];
    const d: number[] = [];
    for (let i = 0; i <= 300; i++) (t.push(i), d.push((i * 1000) / 300));
    for (let i = 0; i <= 300; i++)
      (t.push(1800 + i), d.push(4000 + (i * 1000) / 300));
    return {
      activity: { ...META, sportType: 'Run' },
      streams: {
        latlng: [],
        timeSeconds: t,
        distanceMeters: d,
        heartrate: t.map(() => 140),
      },
    };
  }
  const timeAt = (
    pts: { distanceMeters: number; timeSeconds: number }[],
    m: number,
  ) => pts.find((p) => p.distanceMeters >= m)!.timeSeconds;

  it('give an empty stretch the time before it, as the summary does', () => {
    const a = Activity.fromStreams(gappy());
    const whole = a.summary().channels[0]!.points;
    const win = a.windowChannels({ startMeters: 2500, endMeters: 4500 })[0]!
      .points;
    expect(timeAt(whole, 2500)).toBeCloseTo(300, 0);
    expect(timeAt(win, 2500)).toBeCloseTo(300, 0);
    expect(timeAt(win, 3900)).toBeCloseTo(300, 0);
    expect(timeAt(win, 4400)).toBeGreaterThan(1800);
  });

  it('inside a gap or past the end, carry the time already reached', () => {
    const a = Activity.fromStreams(gappy());
    const inGap = a.windowChannels({ startMeters: 2000, endMeters: 3000 });
    const past = a.windowChannels({ startMeters: 6000, endMeters: 7000 });
    expect(inGap[0]!.points.length).toBeGreaterThan(0);
    expect(past[0]!.points.length).toBeGreaterThan(0);
    for (const p of inGap[0]!.points) expect(p.timeSeconds).toBe(300);
    for (const p of past[0]!.points) expect(p.timeSeconds).toBe(2100);
  });
});

describe('trackLine', () => {
  it('is the fixes in order, leaving out samples with no fix', () => {
    const r = ride(NaN);
    r.streams.latlng = r.streams.latlng.map((p, i) => (i < 30 ? null : p));
    const line = Activity.fromStreams(r).trackLine();
    expect(line).toHaveLength(570);
    expect(line[0]).toEqual(r.streams.latlng[30]);
  });

  it("is an open water swim's cleaned line, not its raw fixes", () => {
    const dLat = 1 / 111195;
    const latlng: [number, number][] = [];
    const timeSeconds: number[] = [];
    const distanceMeters: number[] = [];
    for (let t = 0; t <= 1800; t += 10) {
      const off = (t / 10) % 3 === 2 ? 150 / 111195 : 0;
      latlng.push([38.5 + 0.7 * t * dLat, -123 + off]);
      timeSeconds.push(t);
      distanceMeters.push(0.7 * t);
    }
    const swim: ImportedActivity = {
      activity: { ...META, sportType: 'Swim' },
      streams: { latlng, timeSeconds, distanceMeters, openWater: true },
    };
    const line = trackLine(prepareActivity(swim));
    expect(line).toHaveLength(181);
    // the raw bad fixes sat 150 m east; the line stays within a few metres
    expect(
      Math.max(...line.map(([, lng]) => Math.abs(lng + 123) * 87000)),
    ).toBeLessThan(10);
    // the summary's map line is drawn from the same cleaned points
    const poly = computeActivitySummary(swim).polyline;
    expect(poly.length).toBeGreaterThan(1);
    expect(
      Math.max(...poly.map(([, lng]) => Math.abs(lng + 123) * 87000)),
    ).toBeLessThan(10);
  });

  it('is empty with no GPS', () => {
    const r = ride(NaN);
    r.streams.latlng = [];
    expect(Activity.fromStreams(r).trackLine()).toEqual([]);
  });
});
