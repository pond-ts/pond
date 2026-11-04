import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Activity, PoolSwim } from '../src/activity/index.js';
import { readActivity } from '../src/files/index.js';
import { swimMovingSeconds } from '../src/swim.js';
import { computeActivitySummary } from '../src/summary/index.js';
import { Duration } from '../src/quantities.js';
import type { ImportedActivity, Lap, SwimLength } from '../src/types.js';

const META = {
  id: 'test:swim',
  source: 'manual' as const,
  externalId: 'swim',
  name: 'Pool swim',
  startTimeUtc: '2020-01-01T00:00:00Z',
  distanceMeters: 0,
  movingTimeSeconds: 0,
  elapsedTimeSeconds: 0,
  elevationGainMeters: 0,
  sportType: 'Swim',
};

const lap = (
  index: number,
  distanceMeters: number,
  movingSeconds: number,
): Lap => ({
  index,
  startDistanceMeters: 0,
  distanceMeters,
  elapsedSeconds: movingSeconds,
  movingSeconds,
});

/** The summary pipeline (what Estela's totals use today) still takes the
 *  swim watch's swim time over the samples. */
function poolRecord(swim?: ImportedActivity['swim']): ImportedActivity {
  const n = 41; // 40 lengths, 1,000 m, one sample per 60 s
  return {
    activity: META,
    streams: {
      latlng: [],
      timeSeconds: Array.from({ length: n }, (_, i) => i * 60),
      distanceMeters: Array.from({ length: n }, (_, i) => i * 25),
    },
    ...(swim ? { swim } : {}),
  };
}

const at = (sec: number) =>
  new Date(Date.parse(META.startTimeUtc) + sec * 1000).toISOString();

/** 8 lengths of 25 m in 30 s each, a 60 s rest after the fourth, one
 *  sample at the end of each length and of the rest. Heart rate 150 while
 *  swimming, 100 for the reading that ends the rest. */
function lengthsSwim(): ImportedActivity {
  const timeSeconds = [0];
  const distanceMeters = [0];
  const heartrate = [150];
  const lengths: SwimLength[] = [];
  let t = 0;
  let d = 0;
  for (let k = 0; k < 8; k++) {
    if (k === 4) {
      lengths.push({ startTimeUtc: at(t), seconds: 60, active: false });
      t += 60;
      timeSeconds.push(t);
      distanceMeters.push(d);
      heartrate.push(100);
    }
    lengths.push({
      startTimeUtc: at(t),
      seconds: 30,
      active: true,
      strokes: 18,
      stroke: 'freestyle',
    });
    t += 30;
    d += 25;
    timeSeconds.push(t);
    distanceMeters.push(d);
    heartrate.push(150);
  }
  return {
    activity: META,
    streams: { latlng: [], timeSeconds, distanceMeters, heartrate },
    swim: {
      movingSeconds: 240,
      pool: { lengthMeters: 25, unit: 'm' },
      lengths,
    },
  };
}

describe('the summary’s swim time', () => {
  it('the swim watch’s swim time is the summary’s moving time', () => {
    expect(computeActivitySummary(poolRecord()).movingTimeSeconds).toBe(0);
    const s = computeActivitySummary(poolRecord({ movingSeconds: 1600 }));
    expect(s.movingTimeSeconds).toBe(1600);
    expect(s.elapsedTimeSeconds).toBe(2400);
  });

  it('a zero, missing or too long swim time', () => {
    const m = (v: number) =>
      computeActivitySummary(poolRecord({ movingSeconds: v }))
        .movingTimeSeconds;
    expect(m(0)).toBe(0);
    expect(m(NaN)).toBe(0);
    expect(m(9999)).toBe(2400);
  });

  it('a swim with no samples still reports the swim time', () => {
    const s = computeActivitySummary({
      activity: META,
      streams: { latlng: [] },
      swim: { movingSeconds: 1500 },
    });
    expect(s.movingTimeSeconds).toBe(1500);
  });
});

describe('pool swim clocks', () => {
  const a = Activity.from(lengthsSwim());

  it('moves only during its lengths: the swimming clock', () => {
    expect(a.prepared().movingRule).toBe('pool-lengths');
    const st = a.stats();
    expect(st.time.elapsed!.seconds).toBe(300);
    expect(st.time.moving!.seconds).toBe(240);
    expect(st.time.swimming!.seconds).toBe(240);
    expect(st.time.rest!.seconds).toBe(60);
    expect(st.distance!.meters).toBe(200);
  });

  it('every number on the swimming basis leaves the rest out', () => {
    const sw = a.stats({ time: 'swimming' });
    expect(sw.basis).toBe('swimming');
    expect(sw.pace.average!.secondsPerKm).toBeCloseTo(1200, 6);
    expect(sw.heartRate.min!.bpm).toBe(150);
    expect(a.stats().heartRate.min!.bpm).toBe(100);
    expect(sw.speed.max!.metersPerSecond).toBeCloseTo(25 / 30, 9);
  });

  it('a section inside the swim uses the same clock', () => {
    const second = a.section({
      elapsed: { from: Duration.seconds(120), to: Duration.seconds(300) },
    });
    const st = second.stats();
    expect(st.time.swimming!.seconds).toBe(120);
    expect(st.time.rest!.seconds).toBe(60);
  });

  it('without length records, the laps that covered distance', () => {
    const r = lengthsSwim();
    delete r.swim!.lengths;
    r.laps = [lap(1, 100, 120), lap(2, 0, 60), lap(3, 100, 120)];
    const b = Activity.from(r);
    expect(b.prepared().movingRule).toBe('pool-laps');
    expect(b.stats().time.swimming!.seconds).toBe(240);
  });

  it('only the watch’s swim time: known for the whole swim, not its parts', () => {
    // no pool, no lengths, no laps: just the total
    const b = Activity.from(poolRecord({ movingSeconds: 1600 }));
    expect(b.prepared().movingRule).toBe('swim-time');
    const st = b.stats();
    expect(st.time.moving!.seconds).toBe(1600);
    expect(st.time.swimming!.seconds).toBe(1600);
    expect(st.time.rest!.seconds).toBe(800);
    const sw = b.stats({ time: 'swimming' });
    expect(sw.pace.average!.secondsPerKm).toBe(1600);
    // which samples were swimming isn't known
    expect(sw.speed.max).toBeNull();
    const part = b.section({
      elapsed: { from: Duration.seconds(0), to: Duration.seconds(600) },
    });
    expect(part.stats().time.swimming).toBeNull();
    expect(part.stats({ time: 'swimming' }).pace.average).toBeNull();
  });

  it('open water and other sports keep the speed rule', () => {
    const r = lengthsSwim();
    r.streams.openWater = true;
    expect(Activity.from(r).prepared().movingRule).toBe('speed');
    const run = lengthsSwim();
    run.activity = { ...META, sportType: 'Run' };
    const b = Activity.from(run);
    expect(b.prepared().movingRule).toBe('speed');
    // no swimming clock off the water
    expect(b.stats().time.swimming).toBeNull();
    expect(b.stats().time.rest).toBeNull();
    expect(b.stats({ time: 'swimming' }).pace.average).toBeNull();
  });
});

describe('swimMovingSeconds', () => {
  it('adds up the laps that covered distance', () => {
    expect(
      swimMovingSeconds([lap(1, 500, 800), lap(2, 0, 120), lap(3, 500, 790)]),
    ).toBe(1590);
    expect(swimMovingSeconds([lap(1, 0, 120)])).toBeUndefined();
    expect(swimMovingSeconds([])).toBeUndefined();
  });
});

describe('pool swim model', () => {
  const fit = (name: string) =>
    gunzipSync(
      readFileSync(
        fileURLToPath(new URL(`./fixtures/${name}.fit.gz`, import.meta.url)),
      ),
    );
  const a = readActivity(fit('pool-swim'));

  it('narrows to a pool swim', () => {
    expect(a.environment).toBe('pool');
    expect(a.isPoolSwim()).toBe(true);
    expect(a).toBeInstanceOf(PoolSwim);
    const run = Activity.from({
      ...lengthsSwim(),
      activity: { ...META, sportType: 'Run' },
    });
    expect(run.isPoolSwim()).toBe(false);
    expect(run.environment).toBeNull();
  });

  it('the pool is a Distance with its course', () => {
    if (!a.isPoolSwim()) throw new Error('not a pool swim');
    expect(a.pool!.length.meters).toBe(25);
    expect(a.pool!.course).toBe('25m');
    const yd = lengthsSwim();
    yd.swim!.pool = { lengthMeters: 22.86, unit: 'yd' };
    const b = Activity.from(yd);
    if (!b.isPoolSwim()) throw new Error('not a pool swim');
    expect(b.pool!.course).toBe('25yd');
    expect(b.pool!.length.yards).toBeCloseTo(25, 9);
  });

  it('segments: lengths and rests, a rest is not a length', () => {
    if (!a.isPoolSwim()) throw new Error('not a pool swim');
    expect(a.segments.map((s) => s.kind)).toEqual([
      'length',
      'length',
      'length',
      'length',
      'rest',
      'length',
      'length',
    ]);
    expect(a.lengths.length).toBe(6);
    const first = a.lengths.at(0)!;
    expect(first.number).toBe(1);
    expect(first.stroke).toBe('freestyle');
    expect(first.strokeCount).toBe(18);
    expect(first.drill).toBe(false);
    expect(first.stats().time.elapsed!.seconds).toBe(30);
    expect(first.stats().distance!.meters).toBe(25);
    const rest = a.segments[4]!;
    if (rest.kind !== 'rest') throw new Error('expected a rest');
    expect(rest.duration.seconds).toBe(30);
    expect(rest.stats().time.swimming!.seconds).toBe(0);
  });

  it('repeats from the laps, each with its lengths and the rest after it', () => {
    if (!a.isPoolSwim()) throw new Error('not a pool swim');
    expect(a.repeats.length).toBe(2);
    const [r1, r2] = a.repeats;
    expect(r1!.source).toBe('laps');
    expect(r1!.lengths.length).toBe(4);
    expect(r1!.stats().distance!.meters).toBe(100);
    expect(r1!.recoveryAfter!.kind).toBe('recovery');
    expect(r1!.recoveryAfter!.stats().time.elapsed!.seconds).toBe(30);
    expect(r2!.lengths.length).toBe(2);
    expect(r2!.recoveryAfter).toBeNull();
    // the repeats' stats leave the recovery out
    expect(a.repeats.stats({ time: 'swimming' }).distance!.meters).toBe(150);
    expect(a.repeats.stats().time.swimming!.seconds).toBe(180);
  });

  it('no length records: no segments, repeats still from the laps', () => {
    const r = lengthsSwim();
    delete r.swim!.lengths;
    r.laps = [lap(1, 100, 120), lap(2, 0, 60), lap(3, 100, 120)];
    const b = Activity.from(r);
    if (!b.isPoolSwim()) throw new Error('not a pool swim');
    expect(b.segments).toEqual([]);
    expect(b.repeats.length).toBe(2);
    expect(b.repeats.at(0)!.recoveryAfter).not.toBeNull();
  });
});
