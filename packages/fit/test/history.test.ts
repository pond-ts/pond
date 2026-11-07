import { describe, expect, it } from 'vitest';
import { Activity } from '../src/activity/index.js';
import type { ImportedActivity } from '../src/types.js';
import {
  TrainingHistory,
  dayOf,
  type ActivityDigest,
} from '../src/history/index.js';

function meta(id: string, startUtc: string, sportType = 'Run', local?: string) {
  return {
    id,
    source: 'manual' as const,
    externalId: id,
    name: id,
    startTimeUtc: startUtc,
    ...(local ? { startTimeLocal: local } : {}),
    distanceMeters: 0,
    movingTimeSeconds: 0,
    elapsedTimeSeconds: 0,
    elevationGainMeters: 0,
    sportType,
  };
}

/** A steady 1 Hz recording: `secs` seconds at `speed` m/s, climbing `climb`
 *  m/s, heart rate `hr`, optional power. */
function steady(opts: {
  id: string;
  start: string;
  local?: string;
  sportType?: string;
  secs: number;
  speed: number;
  hr?: number;
  watts?: number;
  climb?: number;
}): Activity {
  const n = opts.secs + 1;
  const t = Array.from({ length: n }, (_, i) => i);
  const rec: ImportedActivity = {
    activity: meta(opts.id, opts.start, opts.sportType, opts.local),
    streams: {
      latlng: [],
      timeSeconds: t,
      distanceMeters: t.map((i) => i * opts.speed),
      altitudeMeters: t.map((i) => 100 + i * (opts.climb ?? 0)),
      ...(opts.hr !== undefined ? { heartrate: t.map(() => opts.hr!) } : {}),
      ...(opts.watts !== undefined ? { watts: t.map(() => opts.watts!) } : {}),
    },
  };
  return Activity.from(rec);
}

/** A digest by hand, for history tests that don't need a recording. */
function digest(
  id: string,
  localStart: string,
  over: Partial<ActivityDigest> = {},
): ActivityDigest {
  return {
    version: 1,
    id,
    name: id,
    sport: 'run',
    sportType: 'Run',
    startedAt: `${localStart}Z`,
    localStart,
    device: null,
    time: { elapsed: 3600, moving: 3500 },
    distance: 10000,
    ascent: 100,
    heartRate: null,
    power: null,
    pace: [],
    ...over,
  };
}

describe('activity.digest()', () => {
  it('keeps clocks, distance, ascent, heart rate and pace bests', () => {
    const a = steady({
      id: 'r1',
      start: '2026-03-02T07:00:00Z',
      local: '2026-03-02T08:00:00',
      secs: 1800,
      speed: 3,
      hr: 150,
      climb: 0.1,
    });
    const d = a.digest();
    expect(d.version).toBe(1);
    expect(d.id).toBe('r1');
    expect(d.sport).toBe('run');
    expect(d.localStart).toBe('2026-03-02T08:00:00');
    expect(d.time.elapsed).toBe(1800);
    expect(d.distance).toBe(5400);
    expect(d.ascent).toBeCloseTo(180, 0);
    expect(d.heartRate!.average).toBe(150);
    expect(d.heartRate!.histogram.start).toBe(150);
    expect(d.heartRate!.histogram.seconds).toEqual([1800]);
    expect(d.power).toBeNull();
    // 400 m to 5 km fit in 5.4 km; 10 km and up don't.
    expect(d.pace.map((p) => p.metres)).toEqual([
      400, 804.672, 1000, 1609.344, 3218.688, 5000,
    ]);
    const fiveK = d.pace.find((p) => p.metres === 5000)!;
    expect(fiveK.seconds).toBeCloseTo(5000 / 3, 0);
    expect(fiveK.to - fiveK.from).toBeCloseTo(5000 / 3, 0);
  });

  it('keeps the power curve with where each point was', () => {
    const d = steady({
      id: 'b1',
      start: '2026-03-02T07:00:00Z',
      sportType: 'Ride',
      secs: 1200,
      speed: 8,
      watts: 200,
    }).digest();
    expect(d.sport).toBe('ride');
    expect(d.power!.average).toBe(200);
    const durations = d.power!.curve.map((p) => p.seconds);
    expect(durations[0]).toBe(1);
    expect(durations[durations.length - 1]).toBe(1200);
    for (const p of d.power!.curve) expect(p.watts).toBe(200);
    expect(d.heartRate).toBeNull();
  });

  it('is plain JSON', () => {
    const d = steady({
      id: 'r2',
      start: '2026-03-02T07:00:00Z',
      secs: 600,
      speed: 3,
      hr: 140,
    }).digest();
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

describe('TrainingHistory', () => {
  it('orders by start and mixes activities with digests', () => {
    const a = steady({
      id: 'late',
      start: '2026-03-05T07:00:00Z',
      secs: 600,
      speed: 3,
    });
    const h = TrainingHistory.of([a, digest('early', '2026-03-01T08:00:00')]);
    expect(h.digests.map((d) => d.id)).toEqual(['early', 'late']);
    expect(h.activity('late')).toBe(a);
    expect(h.activity('early')).toBeNull();
    expect(h.covers).toEqual({ from: '2026-03-01', to: '2026-03-05' });
  });

  it('refuses the same id twice and digests of another version', () => {
    const d = digest('x', '2026-03-01T08:00:00');
    expect(() => TrainingHistory.of([d, d])).toThrow(/twice/);
    expect(() =>
      TrainingHistory.of([{ ...d, version: 2 } as unknown as ActivityDigest]),
    ).toThrow(/version 2/);
  });

  it('counts the local day, not the UTC one', () => {
    // 23:30 local in Madrid is 22:30 UTC on the same day; 00:30 local on the
    // 2nd is still the 1st in UTC.
    const d = digest('night', '2026-03-02T00:30:00', {
      startedAt: '2026-03-01T23:30:00Z',
    });
    expect(dayOf(d)).toBe('2026-03-02');
    expect(dayOf({ ...d, localStart: null })).toBe('2026-03-01');
  });

  it('between() narrows the activities and covers', () => {
    const h = TrainingHistory.of(
      [
        digest('a', '2026-01-10T08:00:00'),
        digest('b', '2026-02-10T08:00:00'),
        digest('c', '2026-03-10T08:00:00'),
      ],
      { covers: { from: '2026-01-01', to: '2026-03-31' } },
    );
    const feb = h.between({ from: '2026-02-01', to: '2026-02-28' });
    expect(feb.digests.map((d) => d.id)).toEqual(['b']);
    expect(feb.covers).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(
      h.between({ from: '2025-01-01', to: '2025-12-31' }).covers,
    ).toBeNull();
    expect(() => h.between({ from: '2026-03-01', to: '2026-02-01' })).toThrow();
    expect(() => h.between({ from: '1 Feb', to: '2026-02-01' })).toThrow(
      /date like/,
    );
  });

  it('sports() keeps covers, so other sports leave rest days', () => {
    const h = TrainingHistory.of([
      digest('run', '2026-03-02T08:00:00'),
      digest('ride', '2026-03-08T08:00:00', {
        sport: 'ride',
        sportType: 'Ride',
      }),
    ]);
    const runs = h.sports(['run']);
    expect(runs.length).toBe(1);
    expect(runs.covers).toEqual({ from: '2026-03-02', to: '2026-03-08' });
  });
});

describe('history.volume.weekly()', () => {
  const h = TrainingHistory.of(
    [
      digest('mon', '2026-03-02T08:00:00'), // Monday
      digest('sun', '2026-03-08T08:00:00', {
        distance: 21000,
        time: { elapsed: 7200, moving: 7000 },
      }),
      digest('ride', '2026-03-04T08:00:00', {
        sport: 'ride',
        sportType: 'Ride',
        distance: 40000,
        time: { elapsed: 5400, moving: null },
        ascent: null,
      }),
      digest('later', '2026-03-17T08:00:00'), // two weeks on, a Tuesday
    ],
    { covers: { from: '2026-03-01', to: '2026-03-20' } },
  );

  it('totals each week, empty weeks kept, with coverage', () => {
    const weeks = h.volume.weekly();
    expect(weeks.map((w) => [w.week, w.to, w.count, w.coverage])).toEqual([
      ['2026-02-23', '2026-03-01', 0, 'partial'],
      ['2026-03-02', '2026-03-08', 3, 'full'],
      ['2026-03-09', '2026-03-15', 0, 'full'],
      ['2026-03-16', '2026-03-22', 1, 'partial'],
    ]);
    const w = weeks[1]!;
    expect(w.distance.meters).toBe(71000);
    expect(w.elapsed.seconds).toBe(3600 + 7200 + 5400);
    // The ride has no moving time; it adds nothing there.
    expect(w.moving.seconds).toBe(3500 + 7000);
    expect(w.ascent.meters).toBe(200);
    expect(w.longest!.id).toBe('ride');
    expect(w.bySport.run!.count).toBe(2);
    expect(w.bySport.run!.distance.meters).toBe(31000);
    expect(w.bySport.ride!.count).toBe(1);
    expect(weeks[2]!.longest).toBeNull();
  });

  it('can start weeks on Sunday', () => {
    const weeks = h.volume.weekly({ weekStart: 'sunday' });
    expect(weeks[0]!.week).toBe('2026-03-01');
    // Sunday the 8th starts a new week.
    expect(weeks[0]!.count).toBe(2);
    expect(weeks[1]!.week).toBe('2026-03-08');
  });

  it('marks weeks outside covers as gaps', () => {
    const weeks = TrainingHistory.of(
      [digest('a', '2026-03-02T08:00:00'), digest('b', '2026-03-30T08:00:00')],
      { covers: { from: '2026-03-23', to: '2026-04-05' } },
    ).volume.weekly();
    expect(weeks.map((w) => w.coverage)).toEqual([
      'gap',
      'gap',
      'gap',
      'full',
      'full',
    ]);
    expect(weeks[0]!.count).toBe(1);
  });

  it('is empty for an empty history', () => {
    expect(TrainingHistory.of([]).volume.weekly()).toEqual([]);
  });
});
