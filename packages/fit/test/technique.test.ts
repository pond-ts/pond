import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Activity } from '../src/activity/index.js';
import { readActivity } from '../src/files/index.js';
import { seconds } from '../src/quantities.js';
import type { ImportedActivity, SwimLength } from '../src/types.js';

const START = '2020-01-01T00:00:00Z';
const at = (sec: number) =>
  new Date(Date.parse(START) + sec * 1000).toISOString();

/** 25 m lengths: four freestyle in 30 s with 18 strokes, a 60 s rest, two
 *  breaststroke in 40 s with 12 strokes, one drill. */
function swim(manufacturer: string | null = 'garmin'): ImportedActivity {
  const lengths: SwimLength[] = [];
  const timeSeconds = [0];
  const distanceMeters = [0];
  let t = 0;
  let d = 0;
  const push = (l: Omit<SwimLength, 'startTimeUtc'>) => {
    lengths.push({ startTimeUtc: at(t), ...l });
    t += l.seconds;
    if (l.active) d += 25;
    timeSeconds.push(t);
    distanceMeters.push(d);
  };
  for (let k = 0; k < 4; k++)
    push({ seconds: 30, active: true, strokes: 18, stroke: 'freestyle' });
  push({ seconds: 60, active: false });
  for (let k = 0; k < 2; k++)
    push({ seconds: 40, active: true, strokes: 12, stroke: 'breaststroke' });
  push({ seconds: 50, active: true, strokes: 9, stroke: 'drill' });
  return {
    activity: {
      id: 't:swim',
      source: 'manual',
      externalId: 'swim',
      name: 'Pool swim',
      startTimeUtc: START,
      distanceMeters: 0,
      movingTimeSeconds: 0,
      elapsedTimeSeconds: 0,
      elevationGainMeters: 0,
      sportType: 'Swim',
    },
    streams: { latlng: [], timeSeconds, distanceMeters },
    swim: {
      movingSeconds: 250,
      pool: { lengthMeters: 25, unit: 'm' },
      lengths,
    },
    ...(manufacturer ? { creator: { manufacturer } } : {}),
  };
}

describe('technique', () => {
  it('reads one stroke over a repeat-sized part', () => {
    const a = Activity.from(swim());
    if (!a.isPoolSwim()) throw new Error('not a pool swim');
    const t = a.lengths.at(0)!.analyze().technique!;
    expect(t.lengths).toBe(1);
    expect(t.stroke).toBe('freestyle');
    expect(t.strokesPerLength).toBe(18);
    expect(t.strokeRate).toBeCloseTo(36, 9);
    expect(t.distancePerStroke!.meters).toBeCloseTo(25 / 18, 9);
    expect(t.swolf).toBeCloseTo(48, 9);
    expect(t.timePerLength.seconds).toBe(30);
    expect(t.convention).toEqual({ counts: 'arm-cycles', source: 'garmin' });
  });

  it('leaves drills out and says mixed over several strokes', () => {
    const t = Activity.from(swim()).analyze().technique!;
    expect(t.lengths).toBe(6);
    expect(t.stroke).toBe('mixed');
    expect(t.strokes).toBe(4 * 18 + 2 * 12);
    // 200 s swum over 6 lengths; rests and the drill left out
    expect(t.strokeRate).toBeCloseTo((96 / 200) * 60, 9);
    expect(t.swolf).toBeCloseTo(200 / 6 + 96 / 6, 9);
  });

  it('counts only lengths wholly inside the section', () => {
    const a = Activity.from(swim());
    // 0 to 45 s: the first length, and half of the second
    const part = a.section({ elapsed: { from: seconds(0), to: seconds(45) } });
    expect(part.analyze().technique!.lengths).toBe(1);
    // the second repeat's breaststroke lengths, 180 to 260 s
    const breast = a.section({
      elapsed: { from: seconds(180), to: seconds(260) },
    });
    expect(breast.analyze().technique!.stroke).toBe('breaststroke');
  });

  it('marks an unknown maker, and is null off the pool', () => {
    expect(Activity.from(swim(null)).analyze().technique!.convention).toEqual({
      counts: 'unknown',
      source: null,
    });
    const run = readActivity(
      gunzipSync(
        readFileSync(
          fileURLToPath(
            new URL('./fixtures/gps-lock-run.fit.gz', import.meta.url),
          ),
        ),
      ),
    );
    expect(run.analyze().technique).toBeNull();
  });

  it('reads the pool-swim fixture', () => {
    const pool = readActivity(
      gunzipSync(
        readFileSync(
          fileURLToPath(
            new URL('./fixtures/pool-swim.fit.gz', import.meta.url),
          ),
        ),
      ),
    );
    const t = pool.analyze().technique!;
    expect(t.lengths).toBeGreaterThan(0);
    expect(t.convention.counts).toBe('arm-cycles');
  });
});
