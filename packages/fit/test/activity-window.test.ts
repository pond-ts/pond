import { describe, it, expect } from 'vitest';
import { Activity } from '../src/activity/index.js';
import { windowChannels } from '../src/summary/index.js';
import type { ImportedActivity, ActivityStreams } from '../src/types.js';

const META = {
  id: 'strava:1',
  source: 'strava' as const,
  externalId: '1',
  name: 'Ride',
  startTimeUtc: '2026-03-15T08:00:00Z',
  distanceMeters: 0,
  movingTimeSeconds: 0,
  elapsedTimeSeconds: 0,
  elevationGainMeters: 0,
  sportType: 'Ride',
};

/** A ride with elevation + HR so there are channels to bucket. */
function ride(n: number): ImportedActivity {
  const dLng = 10 / 111320;
  const latlng: [number, number][] = [];
  const altitudeMeters: number[] = [];
  const timeSeconds: number[] = [];
  const heartrate: number[] = [];
  for (let i = 0; i < n; i++) {
    latlng.push([0, i * dLng]);
    altitudeMeters.push(100 + Math.sin(i / 5) * 10);
    timeSeconds.push(i);
    heartrate.push(150);
  }
  const streams: ActivityStreams = {
    latlng,
    altitudeMeters,
    timeSeconds,
    heartrate,
  };
  return { activity: { ...META }, streams };
}

describe('Activity.windowChannels', () => {
  const act = Activity.fromStreams(ride(300));
  const opts = { startMeters: 0, endMeters: act.distance().meters };

  it('delegates to the windowChannels operator (parity)', () => {
    const viaMethod = act.windowChannels(opts);
    const viaFn = windowChannels(act.prepared(), opts);
    expect(JSON.stringify(viaMethod)).toBe(JSON.stringify(viaFn));
  });

  it('returns channel profiles over the window', () => {
    const channels = act.windowChannels(opts);
    expect(channels.length).toBeGreaterThan(0);
  });
});
