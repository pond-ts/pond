import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Activity } from '../src/activity/index.js';
import { readActivity } from '../src/files/index.js';
import { minutes } from '../src/quantities.js';

const fit = (name: string) =>
  gunzipSync(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/${name}.fit.gz`, import.meta.url)),
    ),
  );

describe('running dynamics', () => {
  const run = readActivity(fit('run-dynamics'));

  it('reads fractional cadence into the recorded cadence', () => {
    expect(run.stats().cadence.average!.rpm).toBeCloseTo(85.5, 6);
  });

  it('gives cadence in steps per minute', () => {
    const d = run.dynamics;
    expect(d.cadence!.series.unit).toBe('spm');
    expect(d.cadence!.source).toBe('recorded');
    expect(d.stats().cadence!.rpm).toBeCloseTo(171, 6);
  });

  it('reads ground contact time and vertical oscillation', () => {
    const s = run.dynamics.stats();
    expect(s.groundContactTime!.seconds).toBeCloseTo(0.25, 6);
    expect(s.verticalOscillation!.meters).toBeCloseTo(0.085, 6);
    expect(run.dynamics.groundContactTime!.series.unit).toBe('ms');
  });

  it('works out step length and vertical ratio', () => {
    const d = run.dynamics;
    // 3 m/s at 171 steps per minute: 180 / 171 m per step
    expect(d.stepLength!.source).toBe('derived');
    expect(d.stats().stepLength!.meters).toBeCloseTo(180 / 171, 3);
    expect(d.stats().verticalRatio).toBeCloseTo((0.085 / (180 / 171)) * 100, 2);
  });

  it('keeps the channels on a part, and after a crop', () => {
    const part = run.section({ elapsed: { from: minutes(2), to: minutes(4) } });
    expect(part.dynamics.stats().cadence!.rpm).toBeCloseTo(171, 6);
    const cropped = run.edit({ crop: { from: minutes(1), to: minutes(9) } });
    expect(cropped.dynamics.stats().groundContactTime!.seconds).toBeCloseTo(
      0.25,
      6,
    );
  });

  it('is empty off foot, and without the channels', () => {
    const n = 300;
    const ride = Activity.from({
      activity: {
        id: 't:1',
        source: 'manual',
        externalId: '1',
        name: 'Ride',
        startTimeUtc: '2024-06-01T08:00:00Z',
        distanceMeters: 0,
        movingTimeSeconds: 0,
        elapsedTimeSeconds: 0,
        elevationGainMeters: 0,
        sportType: 'Ride',
      },
      streams: {
        latlng: [],
        timeSeconds: Array.from({ length: n }, (_, i) => i),
        distanceMeters: Array.from({ length: n }, (_, i) => i * 8),
        cadence: Array(n).fill(90),
        groundContactMs: Array(n).fill(250),
      },
    });
    const d = ride.dynamics;
    expect(d.cadence).toBeNull();
    expect(d.groundContactTime).toBeNull();
    expect(d.stats().cadence).toBeNull();

    const plainRun = readActivity(fit('gps-lock-run'));
    expect(plainRun.dynamics.cadence).not.toBeNull();
    expect(plainRun.dynamics.groundContactTime).toBeNull();
    expect(plainRun.dynamics.verticalRatio).toBeNull();
  });
});
