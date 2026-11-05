/**
 * series, route, edit(), explain() and the views (RFC §8–§10, §17).
 */
import { describe, expect, it } from 'vitest';
import { Activity } from '../src/activity/index.js';
import { chartData, mapData } from '../src/views/index.js';
import { meters, minutes, seconds } from '../src/quantities.js';
import type { ActivityStreams, ImportedActivity, Lap } from '../src/types.js';

const START = '2024-06-01T08:00:00Z';
const META = {
  id: 'test:1',
  source: 'manual' as const,
  externalId: '1',
  name: 'Test',
  startTimeUtc: START,
  distanceMeters: 0,
  movingTimeSeconds: 0,
  elapsedTimeSeconds: 0,
  elevationGainMeters: 0,
  sportType: 'Run',
};
const rec = (
  streams: Partial<ActivityStreams>,
  extra: Partial<ImportedActivity> = {},
): ImportedActivity => ({
  activity: META,
  streams: { latlng: [], ...streams },
  ...extra,
});

// ten samples, 10 s apart, 30 m apart, heading north; HR with one gap
const n = 10;
const run = rec({
  timeSeconds: Array.from({ length: n }, (_, i) => i * 10),
  latlng: Array.from(
    { length: n },
    (_, i) => [40 + i * 0.00027, -3] as [number, number],
  ),
  heartrate: Array.from({ length: n }, (_, i) => (i === 4 ? NaN : 140 + i)),
  altitudeMeters: Array.from({ length: n }, (_, i) => 600 + i),
});

describe('series', () => {
  const a = Activity.from(run);

  it('gives each recorded channel on the activity clock, gaps as null', () => {
    const hr = a.series.heartRate!;
    expect(hr.length).toBe(n);
    expect(hr.unit).toBe('bpm');
    expect(hr.at(0)!.elapsed.seconds).toBe(0);
    expect(hr.at(0)!.value!.bpm).toBe(140);
    expect(hr.at(4)!.value).toBeNull();
    expect(hr.at(-1)!.elapsed.seconds).toBe(90);
    expect(Number.isNaN(hr.values()[4]!)).toBe(true);
    expect(a.series.power).toBeNull();
    expect(a.series.elevation!.at(2)!.value!.meters).toBe(602);
  });

  it('a section holds only its own samples', () => {
    const s = a.section({ elapsed: { from: seconds(15), to: seconds(45) } });
    expect([...s.series.heartRate!].map((p) => p.elapsed.seconds)).toEqual([
      20, 30, 40,
    ]);
  });

  it('turns into a pond series explicitly, gaps as missing cells', () => {
    const ts = a.series.heartRate!.toTimeSeries();
    expect(ts.length).toBe(n);
    expect(ts.at(0)!.key().begin()).toBe(Date.parse(START));
    expect(ts.at(4)!.get('value')).toBeUndefined();
  });

  it('is empty without timestamps', () => {
    const b = Activity.from(rec({ heartrate: [150, 151] }));
    expect(b.series.heartRate).toBeNull();
  });
});

describe('route', () => {
  it('is the line and its bounds', () => {
    const r = Activity.from(run).route!;
    expect(r.points.length).toBe(n);
    expect(r.cleaned).toBe(false);
    expect(r.bounds.southWest[0]).toBe(40);
    expect(r.bounds.northEast[0]).toBeCloseTo(40 + 9 * 0.00027, 9);
  });
  it('is null with no GPS', () => {
    expect(
      Activity.from(rec({ timeSeconds: [0, 10], distanceMeters: [0, 30] }))
        .route,
    ).toBeNull();
  });
});

describe('edit()', () => {
  const laps: Lap[] = [0, 30, 60].map((s, i) => ({
    index: i + 1,
    startTimeUtc: new Date(Date.parse(START) + s * 1000).toISOString(),
    startDistanceMeters: s * 3,
    distanceMeters: 90,
    elapsedSeconds: 30,
    movingSeconds: 30,
  }));
  const a = Activity.from({ ...run, laps });

  it('crops, keeping the original and the edit', () => {
    const e = a.edit({ crop: { from: seconds(20), to: seconds(70) } });
    expect(e.stats().time.elapsed?.seconds).toBe(50);
    expect(e.original).toBe(a);
    expect(e.appliedEdit?.crop?.from?.seconds).toBe(20);
    expect(e.changes.map((c) => [c.kind, c.at.seconds])).toEqual([
      ['crop-start', 20],
      ['crop-end', 70],
    ]);
    expect(a.original).toBe(a);
    expect(a.changes).toEqual([]);
    expect(e.explain('distance').edits.length).toBe(2);
  });

  it('positions stay on the original: editing an edit starts again', () => {
    const once = a.edit({ crop: { from: seconds(20) } });
    const twice = once.edit({ crop: { from: seconds(20) } });
    expect(twice.stats().time.elapsed?.seconds).toBe(
      once.stats().time.elapsed?.seconds,
    );
    expect(twice.original).toBe(a);
  });

  it('splits and joins laps in durations', () => {
    expect(a.edit({ laps: { splitAt: [seconds(45)] } }).laps.length).toBe(4);
    expect(
      a.edit({ laps: { removeBoundaryAt: [seconds(30)] } }).laps.length,
    ).toBe(2);
  });

  it('splits into parts, each its own activity', () => {
    const e = a.edit({ parts: { splitAt: [seconds(50)] } });
    expect(e.parts.length).toBe(2);
    expect(e.parts[0]).toBe(e);
    expect(e.parts[0]!.stats().time.elapsed?.seconds).toBe(50);
    expect(e.parts[1]!.stats().time.elapsed?.seconds).toBe(40);
    expect(e.parts[1]!.parts).toBe(e.parts);
  });

  it('maps stretches between the edited clock and the original', () => {
    const e = a.edit({ crop: { from: seconds(20) } });
    const back = e.toOriginal({ fromSeconds: 10, toSeconds: 20 });
    expect([back.fromSeconds, back.toSeconds]).toEqual([30, 40]);
    const fwd = e.fromOriginal({ from: seconds(30), to: seconds(40) })!;
    expect([fwd.fromSeconds, fwd.toSeconds]).toEqual([10, 20]);
    // half cropped off: cut to what was kept
    const cut = e.fromOriginal({ from: seconds(10), to: seconds(30) })!;
    expect([cut.fromSeconds, cut.toSeconds]).toEqual([0, 10]);
    expect(e.fromOriginal({ from: seconds(0), to: seconds(10) })).toBeNull();
    const second = a.edit({ parts: { splitAt: [seconds(50)] } }).parts[1]!;
    expect(
      second.fromOriginal({ from: seconds(0), to: seconds(40) }),
    ).toBeNull();
    expect(
      second.fromOriginal({ from: seconds(60), to: seconds(70) })!.fromSeconds,
    ).toBe(10);
  });

  it('lists only the changes that took effect, per part', () => {
    const kinds = (x: Activity) =>
      x.changes.map((c) => `${c.kind}@${c.at.seconds}`);
    // a crop past the end cuts nothing; a split outside the crop does nothing;
    // a join where no lap starts does nothing
    const e = a.edit({
      crop: { from: seconds(20), to: seconds(9999) },
      laps: {
        splitAt: [seconds(5), seconds(45)],
        removeBoundaryAt: [seconds(50)],
      },
    });
    expect(kinds(e)).toEqual(['crop-start@20', 'lap-split@45']);
    const p = a.edit({
      laps: { splitAt: [seconds(70)], removeBoundaryAt: [seconds(30)] },
      parts: { splitAt: [seconds(50)] },
    });
    expect(kinds(p.parts[0]!)).toEqual(['lap-join@30', 'part-split@50']);
    expect(kinds(p.parts[1]!)).toEqual(['part-split@50', 'lap-split@70']);
  });

  it('a stretch that only touches a part boundary is not in that part', () => {
    const p = a.edit({ parts: { splitAt: [seconds(50)] } });
    expect(
      p.parts[1]!.fromOriginal({ from: seconds(40), to: seconds(50) }),
    ).toBeNull();
    expect(
      p.parts[0]!.fromOriginal({ from: seconds(50), to: seconds(60) }),
    ).toBeNull();
    // a point on the boundary is still a point
    expect(
      p.parts[1]!.fromOriginal({ from: seconds(50), to: seconds(50) })
        ?.fromSeconds,
    ).toBe(0);
  });

  it('toOriginal holds the stretch to the edited activity', () => {
    const e = a.edit({ crop: { from: seconds(20), to: seconds(60) } });
    const s = e.toOriginal({ fromSeconds: 30, toSeconds: 500 });
    expect([s.fromSeconds, s.toSeconds]).toEqual([50, 60]);
    expect(() => e.toOriginal({ fromSeconds: 100, toSeconds: 200 })).toThrow(
      RangeError,
    );
  });

  it('an untimed recording can have its laps edited, not be cropped', () => {
    const start = Date.parse(START);
    const swim = Activity.from({
      activity: { ...META, sportType: 'Swim', elapsedTimeSeconds: 90 },
      streams: { latlng: [] },
      laps,
      swim: {
        movingSeconds: 60,
        pool: { lengthMeters: 25, unit: 'm' },
        lengths: [0, 30].map((s) => ({
          startTimeUtc: new Date(start + s * 1000).toISOString(),
          seconds: 30,
          active: true,
        })),
      },
    });
    expect(() => swim.edit({ parts: { splitAt: [seconds(30)] } })).toThrow(
      /laps edited, but not be cropped/,
    );
    expect(swim.edit({ laps: { splitAt: [seconds(45)] } }).laps.length).toBe(4);
  });

  it('refuses a crop that keeps nothing and a part outside it', () => {
    expect(() => a.edit({ crop: { from: minutes(5) } })).toThrow(RangeError);
    expect(() =>
      a.edit({
        crop: { to: seconds(40) },
        parts: { splitAt: [seconds(60)] },
      }),
    ).toThrow(RangeError);
  });

  it('an empty edit is the original', () => {
    expect(a.edit({})).toBe(a);
  });
});

describe('explain()', () => {
  it('names the source, method and coverage', () => {
    const a = Activity.from(run);
    const d = a.explain('distance');
    expect(d.source).toBe('gps');
    expect(d.coverage).toBe(1);
    expect(a.explain('heartRate').coverage).toBe(0.9);
    expect(a.explain('power').source).toBe('none');
    expect(a.explain('moving').source).toBe('speed');
    expect(a.explain('timer').source).toBe('none');
    expect(a.explain('elapsed').source).toBe('samples');
  });

  it('a device distance and a pool swim', () => {
    const dev = Activity.from(
      rec({ timeSeconds: [0, 10], distanceMeters: [0, 30] }),
    );
    expect(dev.explain('distance').source).toBe('device');
    const start = Date.parse(START);
    const swim = Activity.from({
      activity: { ...META, sportType: 'Swim' },
      streams: { latlng: [] },
      swim: {
        movingSeconds: 30,
        pool: { lengthMeters: 25, unit: 'm' },
        lengths: [
          {
            startTimeUtc: new Date(start).toISOString(),
            seconds: 30,
            active: true,
          },
        ],
      },
    });
    expect(swim.explain('distance').source).toBe('pool-lengths');
    expect(swim.explain('elapsed').source).toBe('pool-segments');
    expect(swim.explain('moving').source).toBe('pool-lengths');
  });
});

describe('views', () => {
  const a = Activity.from(run);

  it('chartData over time keeps gaps and fills only what was recorded', () => {
    const { series, metrics } = chartData(a);
    expect(metrics).toEqual(['heartRate', 'speed', 'pace', 'elevation']);
    expect(series.length).toBe(n);
    expect(series.at(0)!.get('heartRate')).toBe(140);
    expect(series.at(4)!.get('heartRate')).toBeUndefined();
    expect(series.at(0)!.get('power')).toBeUndefined();
    expect(series.at(1)!.get('pace')).toBeCloseTo(1000 / 3, 0);
  });

  it('chartData over distance keys by metres', () => {
    const { series } = chartData(a, { x: 'distance', metrics: ['heartRate'] });
    expect(series.length).toBe(n);
  });

  it('chartData leaves distance empty when there is none, never 0', () => {
    const b = Activity.from(rec({ timeSeconds: [0, 10], heartrate: [1, 2] }));
    const { series } = chartData(b);
    expect(series.at(0)!.get('distance')).toBeUndefined();
    expect(series.at(1)!.get('heartRate')).toBe(2);
  });

  it('chartData over distance is keyed by metres from the start', () => {
    const { series } = chartData(a, { x: 'distance', metrics: ['heartRate'] });
    expect(series.axisAt(0)).toBe(0);
    expect(series.axisAt(n - 1)).toBeCloseTo(
      a.series.distance!.values()[n - 1]!,
      9,
    );
  });

  it('chartData refuses distance with none', () => {
    const b = Activity.from(rec({ timeSeconds: [0, 10], heartrate: [1, 2] }));
    expect(() => chartData(b, { x: 'distance' })).toThrow(RangeError);
  });

  it('mapData simplifies for a thumbnail', () => {
    const route = a.route!;
    expect(mapData(route).points.length).toBe(n);
    // a straight line keeps only its ends
    expect(mapData(route, { detail: 'thumbnail' }).points.length).toBe(2);
    expect(mapData(route).bounds).toEqual(route.bounds);
  });
});
