import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Activity } from '../src/activity/index.js';
import { readActivity } from '../src/files/index.js';
import { Power, seconds, Speed } from '../src/quantities.js';
import type { ImportedActivity, Lap } from '../src/types.js';

const START = '2024-06-01T08:00:00Z';
const META = {
  id: 't:1',
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
const iso = (s: number) => new Date(Date.parse(START) + s * 1000).toISOString();

/** 1 Hz from a list of [seconds, speed m/s, extra per-second fields]
 *  blocks, each block one lap. */
function blocks(
  parts: { secs: number; speed: number; watts?: number; intensity?: string }[],
  sportType = 'Run',
): ImportedActivity {
  const timeSeconds = [0];
  const distanceMeters = [0];
  const watts = [parts[0]!.watts ?? 0];
  const heartrate = [140];
  const laps: Lap[] = [];
  let t = 0;
  let d = 0;
  parts.forEach((p, i) => {
    const from = t;
    const fromD = d;
    for (let k = 0; k < p.secs; k++) {
      t++;
      d += p.speed;
      timeSeconds.push(t);
      distanceMeters.push(d);
      watts.push(p.watts ?? 0);
      heartrate.push(p.speed > 3 ? 165 : 140);
    }
    laps.push({
      index: i + 1,
      startTimeUtc: iso(from),
      startDistanceMeters: fromD,
      distanceMeters: d - fromD,
      elapsedSeconds: p.secs,
      movingSeconds: p.secs,
      avgSpeedMps: p.speed,
      ...(p.watts !== undefined ? { avgWatts: p.watts } : {}),
      ...(p.intensity ? { intensity: p.intensity } : {}),
    });
  });
  return {
    activity: { ...META, sportType },
    streams: { latlng: [], timeSeconds, distanceMeters, watts, heartrate },
    laps,
  };
}

/** Warm-up, 6 × (400 m at 5 m/s, 200 m jog at 2.5 m/s), cool-down. */
function intervalRun(marked = false) {
  const parts: { secs: number; speed: number; intensity?: string }[] = [
    { secs: 600, speed: 3, ...(marked ? { intensity: 'warmup' } : {}) },
  ];
  for (let k = 0; k < 6; k++) {
    parts.push({
      secs: 80 + k,
      speed: 400 / (80 + k),
      ...(marked ? { intensity: 'active' } : {}),
    });
    parts.push({
      secs: 80,
      speed: 2.5,
      ...(marked ? { intensity: 'rest' } : {}),
    });
  }
  parts.push({
    secs: 300,
    speed: 3,
    ...(marked ? { intensity: 'cooldown' } : {}),
  });
  return Activity.from(blocks(parts));
}

describe('efforts from laps', () => {
  it('splits unmarked laps into faster and slower', () => {
    const e = intervalRun().analyze().efforts.fromLaps();
    expect(e.source).toBe('lap-output');
    expect(e.length).toBe(6);
    expect(e.at(0)!.section.fromSeconds).toBe(600);
    expect(
      e.at(0)!.recoveryAfter!.toSeconds - e.at(0)!.recoveryAfter!.fromSeconds,
    ).toBe(80);
    expect(e.warmUp!.toSeconds).toBe(600);
    // the last jog is the last effort's recovery; the cool-down lap, as
    // fast as the warm-up, sits outside the alternation
    expect(e.coolDown).not.toBeNull();
    expect(e.at(-1)!.recoveryAfter!.toSeconds).toBe(e.coolDown!.fromSeconds);
  });

  it('uses the device’s work and rest marks when it made them', () => {
    const e = intervalRun(true).analyze().efforts.fromLaps();
    expect(e.source).toBe('lap-intensity');
    expect(e.length).toBe(6);
    expect(e.warmUp!.toSeconds).toBe(600);
    expect(e.coolDown).not.toBeNull();
    expect(e.at(-1)!.recoveryAfter!.toSeconds).toBe(e.coolDown!.fromSeconds);
  });

  it('keeps a warm-up faster than the split as the warm-up', () => {
    // warm-up at 4 m/s is above the midpoint of 2 and 5 m/s
    const parts = [{ secs: 600, speed: 4 }];
    for (let k = 0; k < 4; k++)
      parts.push({ secs: 80, speed: 5 }, { secs: 80, speed: 2 });
    const e = Activity.from(blocks(parts)).analyze().efforts.fromLaps();
    expect(e.length).toBe(4);
    expect(e.warmUp!.toSeconds).toBe(600);
  });

  it('finds none in a steady run whose laps vary but don’t alternate', () => {
    const hills = Activity.from(
      blocks([
        { secs: 300, speed: 3.5 },
        { secs: 300, speed: 3.4 },
        { secs: 400, speed: 2.2 },
        { secs: 400, speed: 2.3 },
        { secs: 300, speed: 3.6 },
      ]),
    );
    expect(hills.analyze().efforts.fromLaps().length).toBe(0);
  });

  it('finds none in laps too alike to split', () => {
    const steady = Activity.from(
      blocks([
        { secs: 300, speed: 3 },
        { secs: 300, speed: 3.1 },
        { secs: 300, speed: 3.05 },
      ]),
    );
    expect(steady.analyze().efforts.fromLaps().length).toBe(0);
  });

  it('splits standing rests (an average of 0) from the efforts', () => {
    const parts = [{ secs: 300, speed: 3 }];
    for (let k = 0; k < 4; k++)
      parts.push({ secs: 60, speed: 5 }, { secs: 60, speed: 0 });
    const e = Activity.from(blocks(parts)).analyze().efforts.fromLaps();
    expect(e.length).toBe(4);
  });

  it('makes a slow last lap far longer than the rests the cool-down', () => {
    const parts = [{ secs: 300, speed: 3 }];
    for (let k = 0; k < 4; k++)
      parts.push({ secs: 60, speed: 5 }, { secs: 60, speed: 2 });
    parts.pop();
    parts.push({ secs: 600, speed: 2 });
    const e = Activity.from(blocks(parts)).analyze().efforts.fromLaps();
    expect(e.length).toBe(4);
    expect(e.at(-1)!.recoveryAfter).toBeNull();
    expect(e.coolDown!.fromSeconds).toBe(e.at(-1)!.section.toSeconds);
  });

  it('keeps efforts inside a smaller section', () => {
    const run = intervalRun();
    // from the middle of the first effort lap to the middle of the last
    const part = run.section({
      elapsed: { from: seconds(650), to: seconds(1500) },
    });
    const e = part.analyze().efforts.fromLaps();
    expect(e.length).toBeGreaterThan(0);
    for (const x of e) {
      expect(x.section.fromSeconds).toBeGreaterThanOrEqual(650);
      expect(x.section.toSeconds).toBeLessThanOrEqual(1500);
    }
  });

  it('finds none without laps', () => {
    const rec = blocks([{ secs: 300, speed: 3 }]);
    const e = Activity.from({ ...rec, laps: [] })
      .analyze()
      .efforts.fromLaps();
    expect(e.length).toBe(0);
  });

  it('takes a pool swim’s laps with distance as its efforts', () => {
    const pool = readActivity(
      gunzipSync(
        readFileSync(
          fileURLToPath(
            new URL('./fixtures/pool-swim.fit.gz', import.meta.url),
          ),
        ),
      ),
    );
    if (!pool.isPoolSwim()) throw new Error('not a pool swim');
    const e = pool.analyze().efforts.fromLaps();
    expect(e.source).toBe('pool-laps');
    expect(e.length).toBe(pool.repeats.length);
    const pace = e.compare(['pace']).metrics[0]!;
    expect(pace.unit).toBe('s/100m');
    expect(pace.typical!).toBeGreaterThan(60);
    expect(pace.typical!).toBeLessThan(200);
  });
});

describe('efforts by threshold', () => {
  /** 5 × (120 s at 350 W, 120 s at 150 W) after 300 s at 180 W, with a
   *  3 s dip to 250 W inside the second effort. */
  function intervals() {
    const parts: { secs: number; speed: number; watts: number }[] = [
      { secs: 300, speed: 8, watts: 180 },
    ];
    for (let k = 0; k < 5; k++) {
      parts.push({ secs: 120, speed: 10, watts: 350 });
      parts.push({ secs: 120, speed: 8, watts: 150 });
    }
    const rec = blocks(parts, 'Ride');
    const w = rec.streams.watts!;
    for (let i = 300 + 240 + 50; i < 300 + 240 + 53; i++) w[i] = 250;
    return Activity.from(rec);
  }

  it('finds the stretches above the threshold, merging short dips', () => {
    const e = intervals()
      .analyze()
      .efforts.detect({ powerAbove: Power.watts(300) });
    expect(e.source).toBe('threshold');
    expect(e.length).toBe(5);
    const first = e.at(0)!.section;
    expect(first.fromSeconds).toBe(300);
    expect(first.toSeconds).toBe(420);
    expect(e.at(1)!.section.toSeconds - e.at(1)!.section.fromSeconds).toBe(120);
    expect(e.warmUp!.toSeconds).toBe(300);
  });

  it('gives the last effort a typical recovery, then the cool-down', () => {
    const e = intervals()
      .analyze()
      .efforts.detect({
        powerAbove: Power.watts(300),
      });
    // the 120 s after the last effort is the typical recovery: no cool-down
    expect(e.coolDown).toBeNull();
    const rec = blocks(
      [
        { secs: 60, speed: 8, watts: 150 },
        { secs: 60, speed: 10, watts: 350 },
        { secs: 60, speed: 8, watts: 150 },
        { secs: 60, speed: 10, watts: 350 },
        { secs: 900, speed: 8, watts: 150 },
      ],
      'Ride',
    );
    const long = Activity.from(rec)
      .analyze()
      .efforts.detect({ powerAbove: Power.watts(300) });
    expect(long.length).toBe(2);
    expect(long.at(-1)!.recoveryAfter!.toSeconds).toBe(
      long.coolDown!.fromSeconds,
    );
    expect(
      long.at(-1)!.recoveryAfter!.toSeconds -
        long.at(-1)!.recoveryAfter!.fromSeconds,
    ).toBe(60);
  });

  it('keeps a stretch of exactly the minimum and merges dips under the gap', () => {
    const rec = blocks(
      [
        { secs: 60, speed: 8, watts: 150 },
        { secs: 30, speed: 10, watts: 350 },
        { secs: 60, speed: 8, watts: 150 },
        { secs: 40, speed: 10, watts: 350 },
        { secs: 5, speed: 8, watts: 150 },
        { secs: 40, speed: 10, watts: 350 },
        { secs: 60, speed: 8, watts: 150 },
      ],
      'Ride',
    );
    const e = Activity.from(rec)
      .analyze()
      .efforts.detect({ powerAbove: Power.watts(300) });
    // 30 s kept; a 5 s dip isn't under 5 s, so it splits the 40 s pair
    expect(e.length).toBe(3);
    expect(e.at(0)!.section.toSeconds - e.at(0)!.section.fromSeconds).toBe(30);
    const merged = Activity.from(rec)
      .analyze()
      .efforts.detect({
        powerAbove: Power.watts(300),
        mergeGapsUnder: seconds(6),
      });
    expect(merged.length).toBe(2);
  });

  it('drops stretches shorter than the minimum', () => {
    const e = intervals()
      .analyze()
      .efforts.detect({
        powerAbove: Power.watts(300),
        minimumDuration: seconds(200),
      });
    expect(e.length).toBe(0);
  });

  it('needs exactly one threshold', () => {
    const a = intervals().analyze();
    expect(() => a.efforts.detect({})).toThrow(RangeError);
    expect(() =>
      a.efforts.detect({
        powerAbove: Power.watts(300),
        speedAbove: Speed.metersPerSecond(9),
      }),
    ).toThrow(RangeError);
  });
});

describe('compare', () => {
  it('reads best, worst, typical, spread and first to last', () => {
    const c = intervalRun().analyze().efforts.fromLaps().compare();
    expect(c.count).toBe(6);
    const duration = c.metrics.find((m) => m.metric === 'duration')!;
    expect(duration.values).toEqual([80, 81, 82, 83, 84, 85]);
    // no plain better way for duration: highest and lowest only
    expect(duration.best).toBeNull();
    expect(duration.lowest).toEqual({ number: 1, value: 80 });
    expect(duration.highest).toEqual({ number: 6, value: 85 });
    expect(duration.typical).toBe(82.5);
    expect(duration.firstToLast).toBeCloseTo(5 / 80, 9);
    const pace = c.metrics.find((m) => m.metric === 'pace')!;
    expect(pace.best!.number).toBe(1);
    expect(pace.worst!.number).toBe(6);
    const hr = c.metrics.find((m) => m.metric === 'heartRate')!;
    expect(hr.typical).toBeCloseTo(165, 0);
    expect(hr.best).toBeNull();
    expect(c.recoveries.slice(0, 5)).toEqual([80, 80, 80, 80, 80]);
  });

  it('compares only the metrics asked for', () => {
    const c = intervalRun().analyze().efforts.fromLaps().compare(['pace']);
    expect(c.metrics.map((m) => m.metric)).toEqual(['pace']);
  });
});
