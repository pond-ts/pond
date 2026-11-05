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
