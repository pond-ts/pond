import { describe, expect, it } from 'vitest';
import { Activity } from '../src/activity/index.js';
import { Duration } from '../src/quantities.js';
import {
  CLIMB_THRESHOLD_METERS,
  MOVING_SPEED_MPS,
  movingTimeSeconds,
} from '../src/geo/index.js';
import type { ActivityStreams, ImportedActivity, Lap } from '../src/types.js';

const META = {
  id: 'test:stats',
  source: 'manual' as const,
  externalId: 'stats',
  name: 'Stats',
  startTimeUtc: '2020-01-01T00:00:00Z',
  distanceMeters: 0,
  movingTimeSeconds: 0,
  elapsedTimeSeconds: 0,
  elevationGainMeters: 0,
  sportType: 'Run',
};

/** A GPS-less recording from per-second speeds (m/s): the distance stream is
 *  their running total, so sample i's speed is `speeds[i]` (the first sample
 *  has none). Extra channels merged in. */
function fromSpeeds(
  speeds: number[],
  extra: Partial<ActivityStreams> = {},
  laps?: Lap[],
  timeSeconds = speeds.map((_, i) => i),
): Activity {
  const distanceMeters: number[] = [];
  let at = 0;
  speeds.forEach((v, i) => {
    if (i > 0) at += v * (timeSeconds[i]! - timeSeconds[i - 1]!);
    distanceMeters.push(at);
  });
  const imported: ImportedActivity = {
    activity: META,
    streams: { latlng: [], timeSeconds, distanceMeters, ...extra },
    ...(laps ? { laps } : {}),
  };
  return Activity.fromStreams(imported);
}

const span = (fromSeconds: number, toSeconds: number) => ({
  fromSeconds,
  toSeconds,
});

describe('the public rules', () => {
  it('moving and climb thresholds are the defaults the totals use', () => {
    expect(MOVING_SPEED_MPS).toBe(0.5);
    expect(CLIMB_THRESHOLD_METERS).toBe(3);
    // 0.5 m/s counts as moving, just under it doesn't
    const t = Float64Array.from([0, 1, 2]);
    expect(movingTimeSeconds(Float64Array.from([0, 0.5, 0.49]), t)).toBe(1);
  });
});

describe('Activity.stats', () => {
  // 0–10 s at 4 m/s, 10–20 s stopped, 20–30 s at 5 m/s
  const speeds = [
    0,
    ...Array(10).fill(4),
    ...Array(10).fill(0),
    ...Array(10).fill(5),
  ];
  const heartrate = speeds.map((_, i) => 100 + i);
  const act = fromSpeeds(speeds, { heartrate });

  it('times: elapsed is the span, moving leaves out the stop', () => {
    const st = act.stats(span(0, 30));
    expect(st.timeBegin).toBe(0);
    expect(st.timeEnd).toBe(30);
    expect(st.timeElapsed).toBe(30);
    expect(st.timeMoving).toBe(20);
    expect(st.distanceMeters).toBe(90);
  });

  it('moving time matches the activity’s own moving time', () => {
    expect(act.stats(span(0, 30)).timeMoving).toBe(act.movingTime().seconds);
  });

  it('speed: avg over elapsed, avg moving over moving time, min/max from samples', () => {
    const sp = act.stats(span(0, 30)).channels.speed!;
    expect(sp.avg).toBe(3);
    expect(sp.avgMoving).toBe(4.5);
    expect(sp.min).toBe(0);
    expect(sp.max).toBe(5);
    expect(sp.first).toBe(4);
    expect(sp.last).toBe(5);
  });

  it('a channel: first, last, min, max, mean, and the mean while moving', () => {
    const h = act.stats(span(0, 30)).channels.hr!;
    expect(h).toMatchObject({ first: 100, last: 130, min: 100, max: 130 });
    expect(h.avg).toBe(115);
    // moving samples: 0 (goes by the next second), 1–10 and 21–30
    const moving = [
      0,
      ...Array.from({ length: 10 }, (_, i) => i + 1),
      ...Array.from({ length: 10 }, (_, i) => i + 21),
    ];
    const mean = moving.reduce((a, i) => a + 100 + i, 0) / moving.length;
    expect(h.avgMoving).toBeCloseTo(mean, 9);
  });

  it('moving min and max leave out the stop', () => {
    const st = act.stats(span(0, 30));
    expect(st.channels.speed!.minMoving).toBe(4);
    expect(st.channels.speed!.maxMoving).toBe(5);
    expect(st.channels.hr!.minMoving).toBe(100);
    expect(st.channels.hr!.maxMoving).toBe(130);
  });

  it('a one-second GPS jump doesn’t become the max speed', () => {
    const sp = Array(30).fill(5);
    sp[12] = 84; // one fix landed wide
    expect(fromSpeeds(sp).stats(span(0, 29)).channels.speed!.max).toBe(5);
  });

  it('leaves out channels with no samples, and missing values', () => {
    const st = fromSpeeds([0, 3, 3, 3], {
      heartrate: [NaN, 150, NaN, 160],
    }).stats(span(0, 3));
    expect(st.channels.power).toBeUndefined();
    expect(st.channels.hr).toMatchObject({ first: 150, last: 160, avg: 155 });
  });

  it('elevation: ends, lowest and highest, climb by the 3 m rule', () => {
    const st = fromSpeeds(Array(6).fill(3), {
      altitudeMeters: [10, 12, 14, 20, 18, 16],
    }).stats(span(0, 5));
    expect(st.channels.elevation).toMatchObject({
      first: 10,
      last: 16,
      min: 10,
      max: 20,
      gain: 10,
      loss: 4,
    });
    expect(st.channels.elevation!.avg).toBeCloseTo(15, 9);
  });

  it('NP: steady power is its own NP; moving NP leaves out the stop', () => {
    const steady = fromSpeeds(Array(120).fill(4), {
      watts: Array(120).fill(200),
    });
    expect(steady.stats(span(0, 119)).channels.power!.movingNp).toBeCloseTo(
      200,
      6,
    );
    const sp = [
      ...Array(60).fill(4),
      ...Array(60).fill(0),
      ...Array(60).fill(4),
    ];
    const watts = sp.map((v) => (v > 0 ? 200 : 0));
    const p = fromSpeeds(sp, { watts }).stats(span(0, 179)).channels.power!;
    expect(p.avg).toBeLessThan(150);
    expect(p.avgMoving).toBeCloseTo(200, 0);
    expect(p.movingNp).toBeCloseTo(200, 0);
    expect(p.np!).toBeLessThan(p.movingNp! - 10);
  });

  it('no movement: no moving numbers', () => {
    const st = fromSpeeds(Array(10).fill(0), {
      heartrate: Array(10).fill(90),
    }).stats(span(0, 9));
    expect(st.timeMoving).toBe(0);
    expect(st.channels.hr!.avgMoving).toBeUndefined();
    expect(st.channels.speed?.avgMoving).toBeUndefined();
  });

  it('a Section fits as the span, and agrees with range()', () => {
    const sec = act.range(Duration.seconds(5), Duration.seconds(25));
    const st = act.stats(sec);
    expect(st.timeMoving).toBe(sec.movingTime().seconds);
    expect(st.distanceMeters).toBe(sec.distance().meters);
    expect(st.channels.hr!.avg).toBeCloseTo(sec.avgHeartRate()!.bpm, 9);
  });
});

describe('Activity.groupStats', () => {
  // three 10 s reps at 4, 5 and 3 m/s, each followed by 10 s of walking
  const speeds = [
    0,
    ...Array(10).fill(4),
    ...Array(10).fill(1),
    ...Array(10).fill(5),
    ...Array(10).fill(1),
    ...Array(10).fill(3),
  ];
  const act = fromSpeeds(speeds, {
    heartrate: speeds.map((v) => 100 + v * 10),
  });
  const reps = [span(0, 10), span(20, 30), span(40, 50)];

  it('times add up inside the sections only', () => {
    const g = act.groupStats(reps);
    expect(g.count).toBe(3);
    expect(g.timeElapsed).toBe(30);
    expect(g.timeMoving).toBe(30);
    expect(g.distanceMeters).toBe(40 + 50 + 30);
    expect(g.sections).toHaveLength(3);
  });

  it('highest and lowest are the reps’ own averages, with which rep', () => {
    const sp = act.groupStats(reps).channels.speed!;
    expect(sp).toMatchObject({
      highest: 5,
      highestAt: 1,
      lowest: 3,
      lowestAt: 2,
      highestMoving: 5,
      avg: 4,
    });
  });

  it('touching sections count their shared sample once', () => {
    const t = fromSpeeds(Array(5).fill(2), {
      heartrate: [100, 100, 200, 100, 100],
    });
    expect(t.groupStats([span(0, 2), span(2, 4)]).channels.hr!.avg).toBe(120);
  });

  it('min, max and avg come from the samples in the reps (not the gaps)', () => {
    const g = act.groupStats(reps);
    const h = g.channels.hr!;
    expect(h.max).toBe(150);
    expect(h.min).toBe(100);
    const own = g.sections.map((x) => x.channels.hr!.avg!);
    expect(h.highest).toBe(Math.max(...own));
    expect(h.lowest).toBe(Math.min(...own));
  });
});

describe('Activity.bestAveragePower', () => {
  // 0–200 s: 100 W, then 60 s at 300 W, a 60 s stop at 0 W, 60 s at 300 W
  const n = 381;
  const speeds = Array.from({ length: n }, (_, i) =>
    i > 260 && i <= 320 ? 0 : 3,
  );
  const watts = Array.from({ length: n }, (_, i) =>
    i <= 200 ? 100 : i <= 260 ? 300 : i <= 320 ? 0 : 300,
  );
  const act = fromSpeeds(speeds, { watts });

  it('the highest average held for the time', () => {
    const whole = [span(0, 380)];
    expect(act.bestAveragePower(whole, 60)).toBeCloseTo(300, 6);
    expect(act.bestAveragePower(whole, 300)!).toBeLessThan(300);
    expect(act.bestAveragePower(whole, 3600)).toBeUndefined();
  });

  it('moving: the stop is taken out, so the two 300 W stretches join', () => {
    const tail = [span(140, 380)];
    expect(act.bestAveragePower(tail, 120)!).toBeLessThan(300);
    expect(act.bestAveragePower(tail, 120, { moving: true })).toBeCloseTo(
      300,
      0,
    );
  });

  it('a gap counts as 0 W past 5 s: a spike after it is no minute', () => {
    const t = [...Array.from({ length: 121 }, (_, i) => i), 720];
    const gap = fromSpeeds(
      t.map(() => 3),
      { watts: t.map((x) => (x === 720 ? 900 : 100)) },
      undefined,
      t,
    );
    // the 900 W holds for 5 s of the minute: (5 · 900) / 60 = 75 < 100
    expect(gap.bestAveragePower([span(0, 720)], 60)).toBeCloseTo(100, 6);
  });

  it('a window never spans two sections', () => {
    const laps = [span(0, 200), span(200, 260)];
    expect(act.bestAveragePower(laps, 60)).toBeCloseTo(300, 0);
    expect(act.bestAveragePower([span(230, 290)], 120)).toBeUndefined();
    expect(fromSpeeds(speeds).bestAveragePower(laps, 60)).toBeUndefined();
  });
});

describe('Activity.movingClock', () => {
  // 0–10 s moving, 10–20 s stopped, 20–30 s moving
  const speeds = [
    0,
    ...Array(10).fill(4),
    ...Array(10).fill(0),
    ...Array(10).fill(5),
  ];
  const clock = fromSpeeds(speeds).movingClock();

  it('runs while moving and stands still inside a stop', () => {
    expect(clock.at(0)).toBe(0);
    expect(clock.at(5)).toBe(5);
    expect(clock.at(15)).toBeNull();
    expect(clock.at(25)).toBe(15);
    expect(clock.at(30)).toBe(20);
  });

  it('upTo: inside a stop, the moving time up to where it began', () => {
    expect(clock.upTo(15)).toBe(10);
    expect(clock.upTo(25)).toBe(15);
    expect(clock.upTo(99)).toBe(20);
  });
});

describe('recorded laps carry normalized power', () => {
  it('worked out over the lap’s time from the power samples', () => {
    const watts = Array.from({ length: 121 }, (_, i) => (i <= 60 ? 200 : 300));
    const lap = (index: number, from: number, secs: number): Lap => ({
      index,
      startTimeUtc: new Date(
        Date.parse(META.startTimeUtc) + from * 1000,
      ).toISOString(),
      elapsedSeconds: secs,
      movingSeconds: secs,
      distanceMeters: secs * 3,
      startDistanceMeters: from * 3,
    });
    const act = fromSpeeds(Array(121).fill(3), { watts }, [
      lap(1, 0, 60),
      lap(2, 60, 60),
    ]);
    const [a, b] = act.laps();
    expect(a!.normalizedPower()!.watts).toBeCloseTo(200, 0);
    expect(b!.normalizedPower()!.watts).toBeGreaterThan(290);
  });

  it('no power, no NP', () => {
    const act = fromSpeeds(Array(30).fill(3), {}, [
      {
        index: 1,
        elapsedSeconds: 29,
        movingSeconds: 29,
        distanceMeters: 87,
        startDistanceMeters: 0,
      },
    ]);
    expect(act.laps()[0]!.normalizedPower()).toBeUndefined();
  });
});
