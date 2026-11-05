/**
 * Sparse and partly recorded activities: real zeros stay zero, unknowns
 * stay null, and nothing depends on the order things are listed in.
 */
import { describe, expect, it } from 'vitest';
import { Activity } from '../src/activity/index.js';
import { activityFormat, parseGpx, readActivity } from '../src/files/index.js';
import { editRecording } from '../src/edit/index.js';
import { summarizeLaps } from '../src/laps/groups.js';
import { prepareActivity } from '../src/summary/index.js';
import { sectionGroupStats } from '../src/stats/index.js';
import type { ActivityStreams, ImportedActivity } from '../src/types.js';
import { km, seconds } from '../src/quantities.js';

const META = {
  id: 'test:1',
  source: 'manual' as const,
  externalId: '1',
  name: 'Test',
  startTimeUtc: '2024-06-01T08:00:00Z',
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

describe('known zeros and unknowns', () => {
  it('a known standstill has a speed of 0 and no pace', () => {
    const st = Activity.from(
      rec({ timeSeconds: [0, 10], distanceMeters: [0, 0] }),
    ).stats();
    expect(st.speed.average?.metersPerSecond).toBe(0);
    expect(st.speed.max?.metersPerSecond).toBe(0);
    expect(st.pace.average).toBeNull();
  });

  it('rest is unknown without an elapsed clock', () => {
    const swim = Activity.from({
      activity: { ...META, sportType: 'Swim' },
      streams: { latlng: [] },
      swim: { movingSeconds: 1500, lengths: [] },
    });
    const t = swim.stats().time;
    expect(t.elapsed).toBeNull();
    expect(t.swimming?.seconds).toBe(1500);
    expect(t.rest).toBeNull();
  });

  it('a two-sample moving section keeps its maximum speed', () => {
    const st = Activity.from(
      rec({ timeSeconds: [0, 1], distanceMeters: [0, 3] }),
    ).stats({ time: 'moving' });
    expect(st.time.moving?.seconds).toBe(1);
    expect(st.speed.average?.metersPerSecond).toBe(3);
    expect(st.speed.max?.metersPerSecond).toBe(3);
  });
});

describe('group moving averages', () => {
  it('do not depend on the order of the sections', () => {
    const prep = prepareActivity(
      rec({
        timeSeconds: [0, 1, 2, 3],
        distanceMeters: [0, 0, 3, 6],
        heartrate: [80, 100, 160, 180],
      }),
    );
    const a = { fromSeconds: 0, toSeconds: 1 };
    const b = { fromSeconds: 1, toSeconds: 3 };
    const fwd = sectionGroupStats(prep, [a, b]).channels.hr!;
    const rev = sectionGroupStats(prep, [b, a]).channels.hr!;
    expect(fwd.avgMoving).toBe(rev.avgMoving);
    expect(fwd.avg).toBe(rev.avg);
    // all four samples once; moving: 100 (moving in the second section),
    // 160, 180
    expect(fwd.avg).toBe((80 + 100 + 160 + 180) / 4);
    expect(fwd.avgMoving).toBeCloseTo((100 + 160 + 180) / 3, 9);
  });
});

describe('lap summaries', () => {
  it('keep a coasting lap at 0 W', () => {
    const s = summarizeLaps([
      { seconds: 60, avgWatts: 0, npWatts: 0 },
      { seconds: 60, avgWatts: 200, npWatts: 200 },
    ]);
    expect(s.avgWatts).toBe(100);
    expect(s.npWatts).toBeCloseTo((200 ** 4 / 2) ** 0.25, 6); // ≈ 168.18
  });

  it('count a lap that stood still in the speed', () => {
    const s = summarizeLaps([
      { meters: 100, seconds: 10 },
      { meters: 0, seconds: 10 },
    ]);
    expect(s.speedMps).toBe(5);
  });

  it('give no speed when no lap has any distance', () => {
    const s = summarizeLaps([
      { meters: 0, seconds: 10 },
      { meters: 0, seconds: 10 },
    ]);
    expect(s.speedMps).toBeUndefined();
  });
});

describe('namespaced XML', () => {
  const gpx = `<?xml version="1.0"?>
<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1" version="1.1" creator="test">
  <g:trk><g:name>Prefixed</g:name><g:trkseg>
    <g:trkpt lat="37.0" lon="-122.0"><g:time>2024-06-01T08:00:00Z</g:time></g:trkpt>
    <g:trkpt lat="37.001" lon="-122.0"><g:time>2024-06-01T08:00:30Z</g:time></g:trkpt>
  </g:trkseg></g:trk>
</g:gpx>`;

  it('is told apart by the root element', () => {
    expect(activityFormat(gpx)).toBe('gpx');
    expect(
      activityFormat(
        '<t:TrainingCenterDatabase xmlns:t="x"></t:TrainingCenterDatabase>',
      ),
    ).toBe('tcx');
  });

  it('reads the same as parseGpx', () => {
    const a = readActivity(gpx);
    expect(a.record.streams.latlng).toEqual(parseGpx(gpx).streams.latlng);
    expect(a.hasRoute).toBe(true);
  });
});

describe('cropping the finish', () => {
  const recovery = { atStopBpm: 150, after: [{ sec: 120, bpm: 125 }] };
  const twenty = () =>
    rec(
      {
        timeSeconds: Array.from({ length: 21 }, (_, i) => i),
        distanceMeters: Array.from({ length: 21 }, (_, i) => i * 3),
      },
      { recovery },
    );

  it('drops heart rate recovery when the finish is cut off', () => {
    expect(editRecording(twenty(), { to: 10 }).recovery).toBeUndefined();
    expect(
      editRecording(twenty(), { to: 10 }, { keepClock: true }).recovery,
    ).toBeUndefined();
  });

  it('keeps it when only the start is cut', () => {
    expect(editRecording(twenty(), { from: 5 }).recovery).toEqual(recovery);
  });
});

describe('pool swims', () => {
  const start = Date.parse(META.startTimeUtc);
  const at = (sec: number) => new Date(start + sec * 1000).toISOString();
  const swimRec = (
    streams: Partial<ActivityStreams>,
    lengths: [number, number, boolean][],
    movingSeconds = 60,
  ): ImportedActivity => ({
    activity: { ...META, sportType: 'Swim' },
    streams: { latlng: [], ...streams },
    swim: {
      movingSeconds,
      pool: { lengthMeters: 25, unit: 'm' },
      lengths: lengths.map(([from, seconds, active]) => ({
        startTimeUtc: at(from),
        seconds,
        active,
      })),
    },
  });

  it('count swimming time by overlap with the lengths, not per sample gap', () => {
    // samples a minute apart; swum 0–30 and 90–120, rest between
    const swim = Activity.from(
      swimRec({ timeSeconds: [0, 60, 120], distanceMeters: [0, 25, 50] }, [
        [0, 30, true],
        [30, 60, false],
        [90, 30, true],
      ]),
    );
    const t = swim.stats().time;
    expect(t.elapsed?.seconds).toBe(120);
    expect(t.swimming?.seconds).toBe(60);
    expect(t.rest?.seconds).toBe(60);
  });

  it('give each length its distance from the pool length', () => {
    const swim = Activity.from(
      swimRec(
        { timeSeconds: [0, 30, 60, 90], heartrate: [120, 130, 125, 140] },
        [
          [0, 30, true],
          [30, 30, false],
          [60, 30, true],
        ],
      ),
    );
    if (!swim.isPoolSwim()) throw new Error('not a pool swim');
    const first = swim.lengths.at(0)!;
    expect(first.distance?.meters).toBe(25);
    expect(first.stats().distance?.meters).toBe(25);
    expect(
      first.stats({ time: 'swimming' }).pace.average?.secondsPerKm,
    ).toBeCloseTo(1200, 9); // 30 s per 25 m
    expect(swim.stats().distance?.meters).toBe(50);
    expect(swim.lengths.stats().distance?.meters).toBe(50);
    // half a length counts half
    const half = swim.section({
      elapsed: { from: seconds(0), to: seconds(15) },
    });
    expect(half.stats().distance?.meters).toBeCloseTo(12.5, 9);
  });

  it('put lengths and samples on one clock when the first sample is late', () => {
    // the watch's first sample comes 30 s after the start
    const swim = Activity.from(
      swimRec(
        { timeSeconds: [30, 60, 90, 120], distanceMeters: [25, 25, 50, 75] },
        [
          [0, 30, true],
          [30, 30, false],
          [60, 30, true],
          [90, 30, true],
        ],
        90,
      ),
    );
    if (!swim.isPoolSwim()) throw new Error('not a pool swim');
    const [l1, rest, l2, l3] = swim.segments;
    expect(l1!.stats().distance?.meters).toBe(25);
    expect(l1!.stats().time.elapsed?.seconds).toBe(30);
    expect(rest!.stats().distance?.meters).toBe(0);
    expect(l2!.stats().time.swimming?.seconds).toBe(30);
    expect(l3!.stats().time.swimming?.seconds).toBe(30);
    expect(swim.stats().time.elapsed?.seconds).toBe(120);
    expect(swim.stats().time.swimming?.seconds).toBe(90);
  });
});

describe('splits', () => {
  it('measure their own bounds, not the samples around them', () => {
    // a sample a minute at 10 m/s
    const run = Activity.from(
      rec({
        timeSeconds: [0, 60, 120, 180, 240],
        distanceMeters: [0, 600, 1200, 1800, 2400],
      }),
    );
    const splits = run.splits(km(1)).map((s) => s.stats());
    expect(splits.map((s) => s.distance?.meters)).toEqual([1000, 1000, 400]);
    expect(splits.map((s) => s.time.elapsed?.seconds)).toEqual([100, 100, 40]);
    expect(splits.map((s) => s.time.moving?.seconds)).toEqual([100, 100, 40]);
    // the whole is the sum of its parts
    expect(run.splits(km(1)).stats().distance?.meters).toBe(2400);
    expect(run.splits(km(1)).stats().time.elapsed?.seconds).toBe(240);
  });
});
