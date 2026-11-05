import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  Activity,
  LapSection,
  Section,
  Sections,
  sportOf,
} from '../src/activity/index.js';
import { km, minutes, seconds, meters } from '../src/quantities.js';
import { sectionStats } from '../src/stats/index.js';
import { summaryFromPrepared } from '../src/summary/index.js';
import { readActivity, activityFormat } from '../src/files/index.js';
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

/** A GPS-less session at 1 Hz from per-second speeds (m/s): the distance
 *  stream is their running total. Extra channels merged in. */
function fromSpeeds(
  speeds: number[],
  extra: Partial<ActivityStreams> = {},
  laps?: Lap[],
  sportType = 'Run',
): ImportedActivity {
  const distanceMeters: number[] = [];
  let at = 0;
  speeds.forEach((v, i) => {
    if (i > 0) at += v;
    distanceMeters.push(at);
  });
  return {
    activity: { ...META, sportType },
    streams: {
      latlng: [],
      timeSeconds: speeds.map((_, i) => i),
      distanceMeters,
      ...extra,
    },
    ...(laps ? { laps } : {}),
  };
}

const lapAt = (
  index: number,
  from: number,
  secs: number,
  extra: Partial<Lap> = {},
): Lap => ({
  index,
  startTimeUtc: new Date(
    Date.parse(META.startTimeUtc) + from * 1000,
  ).toISOString(),
  startDistanceMeters: 0,
  distanceMeters: 0,
  elapsedSeconds: secs,
  movingSeconds: secs,
  ...extra,
});

/** 6 x (60 s at 5 m/s, 60 s at 2 m/s), heart rate 160 hard / 120 easy. */
function intervals(withTimer = true): ImportedActivity {
  const speeds = [0];
  const hr = [120];
  const laps: Lap[] = [];
  for (let r = 0; r < 6; r++) {
    for (const [v, h] of [
      [5, 160],
      [2, 120],
    ] as const) {
      const from = speeds.length - 1;
      for (let i = 0; i < 60; i++) {
        speeds.push(v);
        hr.push(h);
      }
      laps.push(
        lapAt(laps.length + 1, from, 60, {
          ...(withTimer ? { timerSeconds: 60 } : {}),
        }),
      );
    }
  }
  return fromSpeeds(speeds, { heartrate: hr }, laps);
}

/** Your own labels for the laps, by id (as an app keeps them). */
const kind = (l: LapSection) => (l.id % 2 ? 'hard' : 'easy');

describe('Activity: what the recording contains', () => {
  const a = Activity.from(intervals());

  it('identity and metadata are properties', () => {
    expect(a.id).toBe('test:1');
    expect(a.name).toBe('Test');
    expect(a.sport).toBe('run');
    expect(a.sportType).toBe('Run');
    expect(a.startedAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(a.device).toBeNull();
    expect(a.hasRoute).toBe(false);
    expect(a.kind).toBe('activity');
  });

  it('an activity is a section of itself', () => {
    expect(a).toBeInstanceOf(Section);
    expect(a.fromSeconds).toBe(0);
    expect(a.toSeconds).toBe(720);
    expect(a.bounds.distance.to.meters).toBe(6 * 60 * 7);
  });

  it('sport families from the file’s labels', () => {
    expect(sportOf('Run')).toBe('run');
    expect(sportOf('TrailRun')).toBe('run');
    expect(sportOf('VirtualRide')).toBe('ride');
    expect(sportOf('MountainBikeRide')).toBe('ride');
    expect(sportOf('cycling')).toBe('ride');
    expect(sportOf('Swim')).toBe('swim');
    expect(sportOf('Walk')).toBe('walk');
    expect(sportOf('Hike')).toBe('hike');
    expect(sportOf('Rowing')).toBe('other');
    expect(sportOf('')).toBe('other');
  });
});

describe('stats(): one contract', () => {
  const a = Activity.from(intervals());

  it('groups related answers, as quantities', () => {
    const st = a.stats();
    expect(st.basis).toBe('elapsed');
    expect(st.distance!.meters).toBe(2520);
    expect(st.time.elapsed!.seconds).toBe(720);
    expect(st.time.moving!.seconds).toBe(720);
    expect(st.time.timer!.seconds).toBe(720);
    expect(st.heartRate.max!.bpm).toBe(160);
    expect(st.heartRate.min!.bpm).toBe(120);
    expect(st.pace.average!.secondsPerKm).toBeCloseTo(720 / 2.52, 6);
    expect(st.speed.max!.metersPerSecond).toBe(5);
  });

  it('a channel that wasn’t recorded is null, not zero', () => {
    const st = a.stats();
    expect(st.power).toEqual({ average: null, max: null, normalized: null });
    expect(st.cadence).toEqual({ average: null, max: null });
    expect(st.elevation.gain).toBeNull();
  });

  it('agrees with the engine and with the summary totals', () => {
    const raw = sectionStats(a.prepared(), a);
    const sum = summaryFromPrepared(a.prepared());
    const st = a.stats();
    expect(st.distance!.meters).toBe(raw.distanceMeters);
    expect(st.distance!.meters).toBe(sum.distanceMeters);
    expect(st.time.moving!.seconds).toBe(sum.movingTimeSeconds);
    expect(st.time.elapsed!.seconds).toBe(sum.elapsedTimeSeconds);
    expect(st.heartRate.average!.bpm).toBeCloseTo(raw.channels.hr!.avg!, 9);
  });

  it('memoizes per basis', () => {
    expect(a.stats()).toBe(a.stats());
    expect(a.stats({ time: 'moving' })).not.toBe(a.stats());
  });
});

describe('clocks', () => {
  // 0–60 s moving at 4 m/s, 60–120 s stopped, 120–180 s at 4 m/s
  const speeds = [
    0,
    ...Array(60).fill(4),
    ...Array(60).fill(0),
    ...Array(60).fill(4),
  ];
  const hr = [150, ...Array(60).fill(150), ...Array(60).fill(90)];
  hr.push(...Array(60).fill(150));
  const a = Activity.from(fromSpeeds(speeds, { heartrate: hr }));

  it('elapsed by default; moving when asked, and the result says which', () => {
    const e = a.stats();
    const m = a.stats({ time: 'moving' });
    expect(e.basis).toBe('elapsed');
    expect(m.basis).toBe('moving');
    expect(e.time.elapsed!.seconds).toBe(180);
    expect(e.time.moving!.seconds).toBe(120);
    // the clocks are the same whatever the basis
    expect(m.time).toEqual(e.time);
    // pace on its basis's time
    expect(e.pace.average!.secondsPerKm).toBeCloseTo(180 / 0.48, 6);
    expect(m.pace.average!.secondsPerKm).toBeCloseTo(120 / 0.48, 6);
  });

  it('every number on a moving basis leaves the stop out', () => {
    expect(a.stats().heartRate.min!.bpm).toBe(90);
    expect(a.stats({ time: 'moving' }).heartRate.min!.bpm).toBe(150);
  });

  it('no timer data: timer time is null, never filled from elapsed', () => {
    expect(a.stats().time.timer).toBeNull();
    const t = a.stats({ time: 'timer' });
    expect(t.basis).toBe('timer');
    expect(t.time.timer).toBeNull();
    expect(t.pace.average).toBeNull();
    expect(t.speed.average).toBeNull();
    // numbers that don't need the clock are still there
    expect(t.distance!.meters).toBe(480);
    expect(t.heartRate.max!.bpm).toBe(150);
  });

  it('timer time from the laps, only when every lap has it', () => {
    const with_ = Activity.from(intervals(true));
    expect(with_.stats().time.timer!.seconds).toBe(720);
    expect(
      with_.stats({ time: 'timer' }).pace.average!.secondsPerKm,
    ).toBeCloseTo(720 / 2.52, 6);
    const r = intervals(true);
    delete r.laps![3]!.timerSeconds;
    expect(Activity.from(r).stats().time.timer).toBeNull();
    expect(Activity.from(intervals(false)).stats().time.timer).toBeNull();
  });

  it('no timestamps: no moving time, no pace', () => {
    const a = Activity.from({
      activity: META,
      streams: {
        latlng: [],
        distanceMeters: [0, 10, 20],
        heartrate: [1, 2, 3],
      },
    });
    const st = a.stats();
    expect(st.time.moving).toBeNull();
    expect(st.pace.average).toBeNull();
    expect(a.stats({ time: 'moving' }).pace.average).toBeNull();
    expect(st.distance!.meters).toBe(20);
    // no wall clock either: not a made-up zero
    expect(st.time.elapsed).toBeNull();
    expect(a.bounds.elapsed).toBeNull();
    expect(() =>
      a.section({ elapsed: { from: seconds(0), to: seconds(1) } }),
    ).toThrow(/no timestamps/);
    // distance still picks a stretch
    expect(
      a.section({ distance: { from: meters(0), to: meters(10) } }).stats()
        .distance!.meters,
    ).toBe(10);
  });
});

describe('section(): any stretch', () => {
  const a = Activity.from(intervals());

  it('by elapsed time', () => {
    const s = a.section({ elapsed: { from: minutes(2), to: minutes(3) } });
    expect(s.kind).toBe('section');
    expect(s.fromSeconds).toBe(120);
    expect(s.toSeconds).toBe(180);
    // samples at both ends count: the one at 120 s closes the easy minute
    expect(s.stats().heartRate.average!.bpm).toBeCloseTo(
      (120 + 60 * 160) / 61,
      9,
    );
    expect(s.stats().distance!.meters).toBeCloseTo(300, 6);
    // a picked stretch has no timer of its own
    expect(s.stats().time.timer).toBeNull();
  });

  it('by distance', () => {
    // the first rep is 0–300 m, its recovery 300–420 m
    const s = a.section({ distance: { from: meters(0), to: meters(300) } });
    expect(s.fromSeconds).toBe(0);
    expect(s.toSeconds).toBeCloseTo(60, 6);
    expect(s.bounds.distance.to.meters).toBeCloseTo(300, 6);
    const half = a.section({ distance: { from: meters(150), to: km(0.36) } });
    expect(half.fromSeconds).toBeCloseTo(30, 6);
    expect(half.toSeconds).toBeCloseTo(90, 6);
  });

  it('held to the recording; wholly outside is an error', () => {
    const s = a.section({ elapsed: { from: minutes(11), to: minutes(20) } });
    expect(s.fromSeconds).toBe(660);
    expect(s.toSeconds).toBe(720);
    expect(() =>
      a.section({ elapsed: { from: minutes(13), to: minutes(14) } }),
    ).toThrow(/outside the recording/);
  });

  it('an end before the start is an error', () => {
    expect(() =>
      a.section({ elapsed: { from: minutes(3), to: minutes(2) } }),
    ).toThrow(RangeError);
  });

  it('a section works as the engine’s span', () => {
    const s = a.section({ elapsed: { from: seconds(10), to: seconds(50) } });
    expect(sectionStats(a.prepared(), s).elapsedSeconds).toBe(40);
  });
});

describe('laps and splits: collections of sections', () => {
  const a = Activity.from(intervals());

  it('laps are sections with what the device kept', () => {
    expect(a.laps).toBeInstanceOf(Sections);
    expect(a.laps.length).toBe(12);
    const third = a.laps.at(2)!;
    expect(third).toBeInstanceOf(LapSection);
    expect(third.id).toBe(3);
    expect(third.label).toBe('Lap 3');
    expect(third.recorded.elapsedSeconds).toBe(60);
    expect(third.fromSeconds).toBe(120);
    expect(third.stats().time.timer!.seconds).toBe(60);
    expect(third.stats().heartRate.max!.bpm).toBe(160);
    expect(a.laps.at(-1)!.id).toBe(12);
    expect(a.laps).toBe(a.laps);
  });

  it('no laps recorded: an empty collection', () => {
    const plain = Activity.from(fromSpeeds([0, 3, 3]));
    expect(plain.laps.length).toBe(0);
    expect([...plain.laps]).toEqual([]);
  });

  it('a lap with no start time follows the one before', () => {
    const r = intervals();
    delete r.laps![1]!.startTimeUtc;
    expect(Activity.from(r).laps.at(1)!.fromSeconds).toBe(60);
  });

  it('groupBy: group stats cover the chosen laps only', () => {
    const groups = a.laps.groupBy((l) => kind(l));
    expect([...groups.keys()]).toEqual(['hard', 'easy']);
    const hard = groups.get('hard')!;
    expect(hard.length).toBe(6);
    const st = hard.stats();
    // not the recovery between (only each lap's opening sample, which
    // closes the minute before, comes from it)
    expect(st.heartRate.average!.bpm).toBeGreaterThan(159);
    expect(st.heartRate.max!.bpm).toBe(160);
    expect(st.time.elapsed!.seconds).toBe(360);
    expect(st.time.timer!.seconds).toBe(360);
    // pace is total distance over total time
    expect(st.distance!.meters).toBeCloseTo(1800, 6);
    expect(st.pace.average!.secondsPerKm).toBeCloseTo(200, 6);
  });

  it('filter and map', () => {
    const hard = a.laps.filter((l) => kind(l) === 'hard');
    expect(hard.map((l) => l.id)).toEqual([1, 3, 5, 7, 9, 11]);
    expect(hard.toArray()).toHaveLength(6);
  });

  it('group timer time is null unless every member has one', () => {
    const r = intervals();
    delete r.laps![0]!.timerSeconds;
    const hard = Activity.from(r).laps.filter((l) => kind(l) === 'hard');
    expect(hard.stats().time.timer).toBeNull();
  });

  it('splits by distance; the last may be short', () => {
    const sp = a.splits(km(1));
    expect(sp.length).toBe(3);
    expect(sp.at(0)!.kind).toBe('split');
    expect(sp.at(0)!.label).toBe('Split 1');
    expect(sp.at(0)!.stats().distance!.meters).toBeCloseTo(1000, 6);
    expect(sp.at(2)!.stats().distance!.meters).toBeCloseTo(520, 6);
    expect(sp.at(2)!.toSeconds).toBe(720);
    expect(a.splits(km(1))).toBe(sp);
    expect(() => a.splits(km(0))).toThrow(RangeError);
  });

  it('no empty split from rounding at the end', () => {
    const r = fromSpeeds([0, 500, 500.00001]);
    const sp = Activity.from(r).splits(km(1));
    expect(sp.length).toBe(1);
    expect(sp.at(0)!.stats().distance!.meters).toBeCloseTo(1000, 3);
  });

  it('a group on the timer basis uses the summed lap timers', () => {
    const hard = a.laps.filter((l) => kind(l) === 'hard');
    const t = hard.stats({ time: 'timer' });
    expect(t.basis).toBe('timer');
    expect(t.pace.average!.secondsPerKm).toBeCloseTo(200, 6);
  });

  it('no distance, no splits', () => {
    const hrOnly = Activity.from({
      activity: META,
      streams: { latlng: [], timeSeconds: [0, 1, 2], heartrate: [1, 2, 3] },
    });
    expect(hrOnly.splits(km(1)).length).toBe(0);
    expect(hrOnly.stats().distance).toBeNull();
  });
});

describe('power on a ride', () => {
  it('average, max and normalized; group NP combines as it is made', () => {
    const watts = [100, ...Array(60).fill(100), ...Array(60).fill(300)];
    const r = fromSpeeds(
      Array(121).fill(8),
      { watts },
      [lapAt(1, 0, 60), lapAt(2, 60, 60)],
      'Ride',
    );
    const a = Activity.from(r);
    expect(a.sport).toBe('ride');
    const st = a.stats();
    expect(st.power.max!.watts).toBe(300);
    expect(st.power.normalized!.watts).toBeGreaterThan(st.power.average!.watts);
    const both = a.laps.stats();
    const each = a.laps.map((l) => l.stats().power.normalized!.watts);
    expect(both.power.normalized!.watts).toBeCloseTo(
      ((each[0]! ** 4 + each[1]! ** 4) / 2) ** 0.25,
      6,
    );
  });
});

const fixture = (name: string) =>
  gunzipSync(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/${name}.fit.gz`, import.meta.url)),
    ),
  );

const GPX = `<?xml version="1.0"?>
<gpx creator="Test" version="1.1"><trk><name>Loop</name><trkseg>
<trkpt lat="0" lon="0"><time>2026-01-01T08:00:00Z</time></trkpt>
<trkpt lat="0" lon="0.001"><time>2026-01-01T08:00:30Z</time></trkpt>
</trkseg></trk></gpx>`;

describe('readActivity: bytes in, an Activity out', () => {
  it('FIT by its header', () => {
    const bytes = fixture('gps-lock-run');
    expect(activityFormat(bytes)).toBe('fit');
    const a = readActivity(bytes);
    expect(a).toBeInstanceOf(Activity);
    expect(a.id.startsWith('fit:')).toBe(true);
    expect(a.stats().distance!.meters).toBeGreaterThan(0);
  });

  it('the FIT reader keeps the lap timer as timer time', () => {
    const a = readActivity(fixture('pool-swim'));
    expect(a.laps.length).toBeGreaterThan(0);
    for (const l of a.laps)
      expect(l.recorded.timerSeconds).toBe(l.recorded.movingSeconds);
  });

  it('a FIT pool swim: session timer, swimming and rest from its lengths', () => {
    const a = readActivity(fixture('pool-swim'));
    expect(a.record.timerSeconds).toBe(210);
    const st = a.stats();
    expect(st.time.timer!.seconds).toBe(210);
    expect(st.time.elapsed!.seconds).toBe(210);
    expect(st.time.swimming!.seconds).toBe(180);
    expect(st.time.rest!.seconds).toBe(30);
    expect(a.laps.at(1)!.stats().time.swimming!.seconds).toBe(0);
  });

  it('GPX as text or bytes, with options', () => {
    expect(activityFormat(GPX)).toBe('gpx');
    const a = readActivity(GPX, { name: 'Mine' });
    expect(a.name).toBe('Mine');
    expect(a.hasRoute).toBe(true);
    expect(a.stats().time.elapsed!.seconds).toBe(30);
    // GPX has no timer
    expect(a.stats().time.timer).toBeNull();
    expect(readActivity(new TextEncoder().encode(GPX)).id).toBe(a.id);
  });

  it('TCX by its root element', () => {
    const tcx = `<?xml version="1.0"?><TrainingCenterDatabase xmlns="x"><Activities><Activity Sport="Running"><Id>2026-01-01T08:00:00Z</Id><Lap StartTime="2026-01-01T08:00:00Z"><TotalTimeSeconds>10</TotalTimeSeconds><DistanceMeters>30</DistanceMeters><Track>
<Trackpoint><Time>2026-01-01T08:00:00Z</Time><DistanceMeters>0</DistanceMeters></Trackpoint>
<Trackpoint><Time>2026-01-01T08:00:10Z</Time><DistanceMeters>30</DistanceMeters></Trackpoint>
</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    expect(activityFormat(tcx)).toBe('tcx');
    const a = readActivity(tcx);
    expect(a.sport).toBe('run');
    expect(a.stats().distance!.meters).toBe(30);
  });

  it('anything else is an error', () => {
    expect(activityFormat('hello')).toBeNull();
    expect(() => readActivity('hello')).toThrow(/not a FIT, GPX or TCX/);
    expect(() => readActivity(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
