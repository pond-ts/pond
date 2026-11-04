import { describe, expect, it } from 'vitest';
import { Activity } from '../src/activity/index.js';
import { swimMovingSeconds } from '../src/swim.js';
import type { ImportedActivity, Lap } from '../src/types.js';

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

/** A pool swim as a watch logs it: one sample per 25 m length. Each length
 *  is logged 60 s after the last (40 s swimming, 20 s on the wall), so the
 *  speed between samples, 25 m / 60 s, is under the 0.5 m/s moving rule. */
function poolSwim(swim?: ImportedActivity['swim']): Activity {
  const n = 41; // 40 lengths, 1,000 m
  return Activity.fromStreams({
    activity: META,
    streams: {
      latlng: [],
      timeSeconds: Array.from({ length: n }, (_, i) => i * 60),
      distanceMeters: Array.from({ length: n }, (_, i) => i * 25),
    },
    laps: [lap(1, 500, 800), lap(2, 0, 120), lap(3, 500, 800)],
    ...(swim ? { swim } : {}),
  });
}

describe('swims', () => {
  it('from the samples alone a pool swim reads as standing still', () => {
    expect(poolSwim().movingTime().seconds).toBe(0);
  });

  it('the swim watch’s swim time is the moving time', () => {
    const act = poolSwim({
      movingSeconds: 1600,
      pool: { lengthMeters: 25, unit: 'm' },
    });
    expect(act.movingTime().seconds).toBe(1600);
    expect(act.summary().movingTimeSeconds).toBe(1600);
    expect(act.swim?.pool).toEqual({ lengthMeters: 25, unit: 'm' });
    // elapsed and distance still come from the samples
    expect(act.elapsedTime().seconds).toBe(2400);
    expect(act.distance().meters).toBe(1000);
  });

  it('a zero or missing swim time falls back to the samples', () => {
    expect(poolSwim({ movingSeconds: 0 }).movingTime().seconds).toBe(0);
    expect(poolSwim({ movingSeconds: NaN }).movingTime().seconds).toBe(0);
  });

  it('swimMovingSeconds adds up the laps that covered distance', () => {
    expect(
      swimMovingSeconds([lap(1, 500, 800), lap(2, 0, 120), lap(3, 500, 790)]),
    ).toBe(1590);
    expect(swimMovingSeconds([lap(1, 0, 120)])).toBeUndefined();
    expect(swimMovingSeconds([])).toBeUndefined();
  });
});
