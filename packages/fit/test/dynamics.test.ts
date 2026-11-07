import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Activity } from '../src/activity/index.js';
import { readActivity } from '../src/files/index.js';
import { minutes, seconds } from '../src/quantities.js';
import type { ImportedActivity } from '../src/types.js';

const META = {
  id: 't:run',
  source: 'manual' as const,
  externalId: 'run',
  name: 'Run',
  startTimeUtc: '2024-06-01T08:00:00Z',
  distanceMeters: 0,
  movingTimeSeconds: 0,
  elapsedTimeSeconds: 0,
  elevationGainMeters: 0,
  sportType: 'Run',
};

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
    expect(d.cadence!.source).toBe('derived');
    expect(d.stats().cadence!.stepsPerMinute).toBeCloseTo(171, 6);
    expect(d.stats().cadence!.format()).toBe('171 spm');
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
    expect(part.dynamics.stats().cadence!.stepsPerMinute).toBeCloseTo(171, 6);
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

  /** 1 Hz on foot at 3 m/s with ground contact 200 + s ms, standing still
   *  (speed 0) from 300 to 400 s. */
  function ramp(extra: Partial<ImportedActivity['streams']> = {}) {
    const n = 601;
    const distanceMeters: number[] = [];
    let d = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0 && !(i > 300 && i <= 400)) d += 3;
      distanceMeters.push(d);
    }
    return Activity.from({
      activity: { ...META, sportType: 'Run' },
      streams: {
        latlng: [],
        timeSeconds: Array.from({ length: n }, (_, i) => i),
        distanceMeters,
        cadence: Array(n).fill(90),
        groundContactMs: Array.from({ length: n }, (_, i) => 200 + i),
        verticalOscillationMm: Array.from({ length: n }, (_, i) =>
          i % 10 === 0 ? NaN : 80,
        ),
        ...extra,
      },
    });
  }

  it('lines up a part and a crop with the right samples', () => {
    const run = ramp();
    // 100 to 200 s: samples 101 … 200, ground contact 301 … 400 ms
    const part = run.section({
      elapsed: { from: seconds(100), to: seconds(200) },
    });
    expect(part.dynamics.stats().groundContactTime!.seconds).toBeCloseTo(
      0.3505,
      6,
    );
    const cropped = run.edit({
      crop: { from: seconds(100), to: seconds(200) },
    });
    expect(
      cropped.dynamics.groundContactTime!.series.at(0)!.value!.seconds,
    ).toBeCloseTo(0.3, 6);
    expect(cropped.dynamics.stats().groundContactTime!.seconds).toBeCloseTo(
      0.3505,
      6,
    );
  });

  it('averages over moving time only, and skips gaps', () => {
    const run = ramp();
    const s = run.dynamics.stats();
    // moving samples: 1-300 and 401-600; ground contact (200+i) averages
    // ((201+500)/2 · 300 + (601+800)/2 · 200) / 500
    const expected = (350.5 * 300 + 700.5 * 200) / 500 / 1000;
    expect(s.groundContactTime!.seconds).toBeCloseTo(expected, 6);
    expect(s.verticalOscillation!.meters).toBeCloseTo(0.08, 9);
    // standing: no step length there
    expect(run.dynamics.stepLength!.series.at(350)!.value).toBeNull();
    expect(s.stepLength!.meters).toBeCloseTo(180 / 180, 6);
  });

  it('does not double cadence already in steps', () => {
    expect(
      ramp({ cadenceUnit: 'steps' }).dynamics.stats().cadence!.stepsPerMinute,
    ).toBeCloseTo(90, 9);
    const high = ramp({ cadence: Array(601).fill(172) });
    expect(high.dynamics.cadence!.source).toBe('recorded');
    expect(high.dynamics.stats().cadence!.stepsPerMinute).toBeCloseTo(172, 9);
  });
});
