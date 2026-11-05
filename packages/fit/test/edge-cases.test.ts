/**
 * Sparse and partly recorded activities: real zeros stay zero, unknowns
 * stay null, and nothing depends on the order things are listed in.
 */
import { describe, expect, it } from 'vitest';
import { Activity } from '../src/activity/index.js';
import { activityFormat, parseGpx, readActivity } from '../src/files/index.js';
import { editRecording } from '../src/edit/index.js';
import { summarizeLaps } from '../src/laps/groups.js';
import {
  computeActivitySummary,
  prepareActivity,
} from '../src/summary/index.js';
import type { ActivityStreams, ImportedActivity } from '../src/types.js';
import { km, meters, seconds } from '../src/quantities.js';
import { movingClock, sectionGroupStats } from '../src/stats/index.js';

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
    expect(s.highestLapWatts).toBe(200);
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

describe('one distance axis for a pool swim', () => {
  const start = Date.parse(META.startTimeUtc);
  const at = (sec: number) => new Date(start + sec * 1000).toISOString();
  const swim = (timeSeconds: number[], lengths: [number, number][]) =>
    Activity.from({
      activity: { ...META, sportType: 'Swim' },
      streams: { latlng: [], timeSeconds },
      swim: {
        movingSeconds: 60,
        pool: { lengthMeters: 25, unit: 'm' },
        lengths: lengths.map(([from, secs]) => ({
          startTimeUtc: at(from),
          seconds: secs,
          active: true,
        })),
      },
    });

  it('every distance query reads the lengths', () => {
    const a = swim(
      [0, 30, 60],
      [
        [0, 30],
        [30, 30],
      ],
    );
    expect(a.stats().distance?.meters).toBe(50);
    expect(a.bounds.distance.to.meters).toBe(50);
    expect(a.splits(meters(25)).map((s) => s.stats().distance?.meters)).toEqual(
      [25, 25],
    );
    const first = a.section({
      distance: { from: meters(0), to: meters(25) },
    });
    expect(first.stats().distance?.meters).toBe(25);
    expect(a.pace.bestEffort(meters(25))?.time.seconds).toBe(30);
    expect(a.stats().speed.average?.metersPerSecond).toBeCloseTo(50 / 60, 9);
    expect(a.stats().speed.max?.metersPerSecond).toBeCloseTo(25 / 30, 9);
  });

  it('keeps a length recorded after the last sample', () => {
    const a = swim(
      [0, 30],
      [
        [0, 30],
        [90, 30],
      ],
    );
    if (!a.isPoolSwim()) throw new Error('not a pool swim');
    const second = a.lengths.at(1)!.stats({ time: 'swimming' });
    expect(second.distance?.meters).toBe(25);
    expect(second.time.elapsed?.seconds).toBe(30);
    expect(second.time.swimming?.seconds).toBe(30);
    const both = a.lengths.stats();
    expect(both.distance?.meters).toBe(50);
    expect(both.time.elapsed?.seconds).toBe(60);
    expect(both.time.swimming?.seconds).toBe(60);
    expect(a.stats().time.elapsed?.seconds).toBe(120);
  });

  it('runs the moving clock on the same stretches', () => {
    const a = swim(
      [0, 60, 120],
      [
        [0, 30],
        [90, 30],
      ],
    );
    const clock = movingClock(a.prepared());
    expect(clock.upTo(120)).toBe(60);
    expect(clock.at(60)).toBeNull();
    expect(clock.at(100)).toBe(40);
  });
});

describe('a section reads only the samples inside it', () => {
  const ride = () =>
    Activity.from(
      rec(
        {
          timeSeconds: [0, 10, 20],
          distanceMeters: [0, 30, 60],
          watts: [100, 100, 1000],
        },
        {},
      ),
    );

  it('leaves out the sample after its end', () => {
    const s = ride().section({
      elapsed: { from: seconds(0), to: seconds(15) },
    });
    const st = s.stats();
    expect(st.time.elapsed?.seconds).toBe(15);
    expect(st.distance?.meters).toBe(45);
    expect(st.power.max?.watts).toBe(100);
    expect(st.power.average?.watts).toBe(100);
  });

  it('keeps best efforts inside it', () => {
    const s = ride().section({
      elapsed: { from: seconds(0), to: seconds(15) },
    });
    expect(s.power.bestEffort(seconds(20))).toBeNull();
    expect(s.pace.bestEffort(meters(60))).toBeNull();
    const e = s.power.bestEffort(seconds(10))!;
    expect(e.section.toSeconds).toBeLessThanOrEqual(15);
  });

  it('has no channel numbers between two samples, but keeps its time', () => {
    const st = ride()
      .section({ elapsed: { from: seconds(1), to: seconds(2) } })
      .stats();
    expect(st.power.average).toBeNull();
    expect(st.power.max).toBeNull();
    expect(st.time.elapsed?.seconds).toBe(1);
    expect(st.distance?.meters).toBeCloseTo(3, 9);
  });
});

describe('prefixed TCX', () => {
  const tcx = (p: string) => `<?xml version="1.0"?>
<${p}TrainingCenterDatabase xmlns${p ? ':' + p.slice(0, -1) : ''}="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
 <${p}Activities><${p}Activity Sport="Running"><${p}Id>2024-05-01T09:00:00Z</${p}Id>
  <${p}Lap StartTime="2024-05-01T09:00:00Z"><${p}TotalTimeSeconds>10</${p}TotalTimeSeconds><${p}DistanceMeters>100</${p}DistanceMeters>
   <${p}Track>
    <${p}Trackpoint><${p}Time>2024-05-01T09:00:00Z</${p}Time><${p}DistanceMeters>0</${p}DistanceMeters></${p}Trackpoint>
    <${p}Trackpoint><${p}Time>2024-05-01T09:00:10Z</${p}Time><${p}DistanceMeters>100</${p}DistanceMeters></${p}Trackpoint>
   </${p}Track>
  </${p}Lap>
 </${p}Activity></${p}Activities>
</${p}TrainingCenterDatabase>`;

  it('reads the same as the plain one', () => {
    const plain = readActivity(tcx(''));
    const prefixed = readActivity(tcx('t:'));
    expect(prefixed.startedAt.toISOString()).toBe('2024-05-01T09:00:00.000Z');
    expect(prefixed.stats().distance?.meters).toBe(100);
    expect(prefixed.stats().time.elapsed?.seconds).toBe(10);
    expect(prefixed.laps.length).toBe(1);
    expect(prefixed.record.streams).toEqual(plain.record.streams);
  });
});

describe('a section holding one sample', () => {
  const run = Activity.from(
    rec({
      timeSeconds: [0, 10, 20],
      distanceMeters: [0, 30, 60],
      heartrate: [150, 150, 150],
      watts: [200, 200, 200],
    }),
  );

  it('keeps its moving readings when it starts inside the gap before it', () => {
    const s = run.section({ elapsed: { from: seconds(5), to: seconds(15) } });
    const moving = s.stats({ time: 'moving' });
    expect(moving.time.moving?.seconds).toBe(10);
    expect(moving.heartRate.average?.bpm).toBe(150);
    expect(moving.power.average?.watts).toBe(200);
    expect(moving.power.normalized?.watts).toBe(200);
    expect(moving.speed.max?.metersPerSecond).toBe(3);
    expect(s.stats().speed.max?.metersPerSecond).toBe(3);
  });

  it('short splits keep what the whole activity has', () => {
    const splits = run.splits(meters(15)).stats({ time: 'moving' });
    const whole = run.stats({ time: 'moving' });
    expect(splits.distance?.meters).toBeCloseTo(60, 9);
    expect(splits.time.moving?.seconds).toBeCloseTo(20, 9);
    expect(splits.heartRate.average?.bpm).toBe(whole.heartRate.average?.bpm);
    expect(splits.power.average?.watts).toBe(200);
    expect(splits.speed.max?.metersPerSecond).toBe(3);
  });
});

describe('pool lengths outside the samples', () => {
  const start = Date.parse(META.startTimeUtc);
  const at = (sec: number) => new Date(start + sec * 1000).toISOString();
  const pool = (
    streams: Partial<ActivityStreams>,
    lengths: [number, number][],
  ): ImportedActivity => ({
    activity: { ...META, sportType: 'Swim' },
    streams: { latlng: [], ...streams },
    swim: {
      movingSeconds: lengths.reduce((s, [, secs]) => s + secs, 0),
      pool: { lengthMeters: 25, unit: 'm' },
      lengths: lengths.map(([from, secs]) => ({
        startTimeUtc: at(from),
        seconds: secs,
        active: true,
      })),
    },
  });

  it('splits start at the first length, not the first sample', () => {
    // the first sample comes at the end of the first length
    const a = Activity.from(
      pool({ timeSeconds: [30, 60, 90] }, [
        [0, 30],
        [30, 30],
        [60, 30],
      ]),
    );
    expect(a.stats().distance?.meters).toBe(75);
    const splits = a.splits(meters(25));
    expect(splits.length).toBe(3);
    expect(splits.at(0)!.fromSeconds).toBe(0);
    expect(splits.stats().distance?.meters).toBe(75);
  });

  it('best efforts search the lengths', () => {
    const a = Activity.from(
      pool({ timeSeconds: [0, 30] }, [
        [0, 30],
        [30, 20],
      ]),
    );
    expect(a.stats().distance?.meters).toBe(50);
    expect(a.pace.bestEffort(meters(25))?.time.seconds).toBe(20);
    expect(a.pace.bestEffort(meters(50))?.time.seconds).toBe(50);
    // inside a section, only its own lengths
    const first = a.section({ elapsed: { from: seconds(0), to: seconds(30) } });
    expect(first.pace.bestEffort(meters(25))?.time.seconds).toBe(30);
    expect(first.pace.bestEffort(meters(50))).toBeNull();
  });

  it('the summary gives the same totals as stats()', () => {
    const r = pool({ timeSeconds: [0, 30] }, [
      [0, 30],
      [30, 20],
    ]);
    const st = Activity.from(r).stats();
    const sum = computeActivitySummary(r);
    expect(sum.distanceMeters).toBe(st.distance?.meters);
    expect(sum.elapsedTimeSeconds).toBe(st.time.elapsed?.seconds);
    expect(sum.movingTimeSeconds).toBe(st.time.swimming?.seconds);
    expect(sum.distanceMeters).toBe(50);
    expect(sum.elapsedTimeSeconds).toBe(50);
  });

  it('a swim with lengths and no samples keeps its distance and time', () => {
    const r = pool({}, [
      [0, 30],
      [30, 30],
    ]);
    const a = Activity.from(r);
    expect(a.bounds.distance.to.meters).toBe(50);
    const st = a.stats();
    expect(st.distance?.meters).toBe(50);
    expect(st.time.elapsed?.seconds).toBe(60);
    expect(st.time.swimming?.seconds).toBe(60);
    expect(st.heartRate.average).toBeNull();
    expect(a.splits(meters(25)).map((s) => s.stats().distance?.meters)).toEqual(
      [25, 25],
    );
    const sum = computeActivitySummary(r);
    expect(sum.distanceMeters).toBe(50);
    expect(sum.elapsedTimeSeconds).toBe(60);
  });
});

describe('the summary and stats() agree', () => {
  it('when the first sample comes after the start', () => {
    const r: ImportedActivity = rec({
      timeSeconds: [30, 40, 50],
      distanceMeters: [0, 30, 60],
    });
    const st = Activity.from(r).stats();
    const sum = computeActivitySummary(r);
    expect(sum.elapsedTimeSeconds).toBe(50);
    expect(sum.elapsedTimeSeconds).toBe(st.time.elapsed?.seconds);
    expect(sum.movingTimeSeconds).toBe(st.time.moving?.seconds);
    expect(sum.distanceMeters).toBe(st.distance?.meters);
  });
});

describe('TCX text in CDATA', () => {
  it('is kept as written', () => {
    const a = readActivity(`<?xml version="1.0"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
 <Activities><Activity Sport="Running"><Id>2024-05-01T09:00:00Z</Id>
  <Lap StartTime="2024-05-01T09:00:00Z"><TotalTimeSeconds>10</TotalTimeSeconds><DistanceMeters>100</DistanceMeters>
   <Track>
    <Trackpoint><Time>2024-05-01T09:00:00Z</Time><DistanceMeters>0</DistanceMeters></Trackpoint>
    <Trackpoint><Time>2024-05-01T09:00:10Z</Time><DistanceMeters>100</DistanceMeters></Trackpoint>
   </Track>
  </Lap>
  <Notes><![CDATA[Use <hr:zone> for this interval]]></Notes>
  <Creator><Name><![CDATA[Tool <v:2>]]></Name></Creator>
 </Activity></Activities>
</TrainingCenterDatabase>`);
    expect(a.record.activity.name).toBe('Use <hr:zone> for this interval');
    expect(a.record.creator?.name).toBe('Tool <v:2>');
  });
});

describe('a pool swim keeps its clock from its timed lengths and rests', () => {
  const start = Date.parse(META.startTimeUtc);
  const at = (sec: number) => new Date(start + sec * 1000).toISOString();
  const swim = (
    streams: Partial<ActivityStreams>,
    lengths: [number, number, boolean][],
    poolMeters: number | null = 25,
  ): ImportedActivity => ({
    activity: { ...META, sportType: 'Swim' },
    streams: { latlng: [], ...streams },
    swim: {
      movingSeconds: lengths.reduce(
        (s, [, secs, on]) => s + (on ? secs : 0),
        0,
      ),
      ...(poolMeters
        ? { pool: { lengthMeters: poolMeters, unit: 'm' as const } }
        : {}),
      lengths: lengths.map(([from, seconds, active]) => ({
        startTimeUtc: at(from),
        seconds,
        active,
      })),
    },
  });

  it.each([
    ['no samples', {}],
    ['samples at 0 and 30 s', { timeSeconds: [0, 30] }],
  ])('a rest after the last length counts (%s)', (_, streams) => {
    const r = swim(streams, [
      [0, 30, true],
      [30, 90, false],
    ]);
    const a = Activity.from(r);
    const t = a.stats().time;
    expect(t.elapsed?.seconds).toBe(120);
    expect(t.swimming?.seconds).toBe(30);
    expect(t.rest?.seconds).toBe(90);
    expect(a.isPoolSwim()).toBe(true);
    if (!a.isPoolSwim()) return;
    const rest = a.segments.at(1)!;
    expect(rest.kind).toBe('rest');
    expect(rest.stats().time.elapsed?.seconds).toBe(90);
    expect(computeActivitySummary(r).elapsedTimeSeconds).toBe(120);
  });

  const two: [number, number, boolean][] = [
    [0, 30, true],
    [30, 30, true],
  ];

  it('an untimed sensor reading leaves the clock alone', () => {
    const r = swim({ heartrate: [150] }, two);
    const st = Activity.from(r).stats();
    expect(st.time.elapsed?.seconds).toBe(60);
    expect(st.time.swimming?.seconds).toBe(60);
    expect(st.distance?.meters).toBe(50);
    const sum = computeActivitySummary(r);
    expect(sum.elapsedTimeSeconds).toBe(60);
    expect(sum.movingTimeSeconds).toBe(60);
  });

  it('…and has no place inside a part of the swim', () => {
    const a = Activity.from(swim({ heartrate: [150] }, two));
    expect(a.stats().heartRate.average?.bpm).toBe(150);
    const first = a.section({ elapsed: { from: seconds(0), to: seconds(30) } });
    expect(first.stats().heartRate.average).toBeNull();
    expect(first.stats().time.elapsed?.seconds).toBe(30);
  });

  it('an unknown pool size leaves the time and takes only the distance', () => {
    const r = swim({}, two, null);
    const a = Activity.from(r);
    expect(a.isPoolSwim()).toBe(true);
    const st = a.stats();
    expect(st.time.elapsed?.seconds).toBe(60);
    expect(st.time.swimming?.seconds).toBe(60);
    expect(st.distance).toBeNull();
    const sum = computeActivitySummary(r);
    expect(sum.elapsedTimeSeconds).toBe(60);
    expect(sum.movingTimeSeconds).toBe(60);
  });
});
