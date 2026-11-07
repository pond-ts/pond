import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readActivity } from '../src/files/index.js';
import { Activity } from '../src/activity/index.js';
import { Profile, type AthleteProfileJson } from '../src/profile/index.js';
import { km, meters, minutes, seconds, Distance } from '../src/quantities.js';
import type { ActivityStreams, ImportedActivity } from '../src/types.js';

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
  sportType: 'Ride',
};

/** A GPS-less session at 1 Hz from per-second speeds (m/s); the distance
 *  stream is their running total. */
function fromSpeeds(
  speeds: number[],
  extra: Partial<ActivityStreams> = {},
  sportType = 'Ride',
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
  };
}

/** One hour at 10 m/s: 200 W, except 300 W from 20 to 40 minutes;
 *  heart rate 140 throughout. */
function ride(): Activity {
  const n = 3601;
  const watts = Array.from({ length: n }, (_, i) =>
    i > 1200 && i <= 2400 ? 300 : 200,
  );
  return Activity.from(
    fromSpeeds(Array(n).fill(10), { watts, heartrate: Array(n).fill(140) }),
  );
}

const FTP_250 = Profile.of({ ftpWatts: 250 });

describe('analyze', () => {
  it('reads power against FTP', () => {
    const a = ride().analyze({ athlete: FTP_250 });
    const np = a.power.normalized!.watts;
    const avg = a.power.average!.watts;
    expect(avg).toBeCloseTo((2400 * 200 + 1200 * 300) / 3600, 0);
    expect(np).toBeGreaterThan(avg);
    expect(a.power.intensityFactor).toBeCloseTo(np / 250, 12);
    expect(a.power.variabilityIndex).toBeCloseTo(np / avg, 12);
    expect(a.load).toEqual({
      model: 'cycling-tss',
      value: expect.closeTo(((3600 * np * (np / 250)) / (250 * 3600)) * 100, 9),
    });
    expect(a.athlete).toBe(FTP_250);
  });

  it('leaves only the FTP results out when there is no FTP', () => {
    const a = ride().analyze({ athlete: Profile.of({}) });
    expect(a.power.normalized).not.toBeNull();
    expect(a.power.average).not.toBeNull();
    expect(a.power.variabilityIndex).not.toBeNull();
    expect(a.power.intensityFactor).toBeNull();
    expect(a.load).toBeNull();
    expect(a.zones.power).toBeNull();
  });

  it('gives no power results for a recording with no power', () => {
    const run = Activity.from(fromSpeeds(Array(600).fill(3), {}, 'Run'));
    const a = run.analyze({ athlete: FTP_250 });
    expect(a.power).toEqual({
      average: null,
      normalized: null,
      intensityFactor: null,
      variabilityIndex: null,
    });
    expect(a.load).toBeNull();
    expect(a.zones.power).toBeNull();
  });

  it('resolves a stored profile to the activity date', () => {
    const json: AthleteProfileJson = {
      ftpWatts: [
        { at: '2024-01-01', value: 200 },
        { at: '2024-05-01', value: 250 },
        { at: '2024-07-01', value: 300 },
      ],
    };
    const a = ride().analyze({ athlete: json });
    expect(a.athlete.ftpWatts).toBe(250);
    expect(a.athlete.asOfDate).toBe(META.startTimeUtc);
  });

  it('puts time in power, heart-rate and pace zones', () => {
    const json: AthleteProfileJson = {
      ftpWatts: [{ at: '2024-01-01', value: 250 }],
      hrZone: [{ at: '2024-01-01', maxHr: 200 }],
      paceThreshold: [{ at: '2024-01-01', fiveKSeconds: 1200 }],
    };
    const { zones } = ride().analyze({ athlete: json });
    // 200 W is 0.8 of FTP (Tempo, Z3); 300 W is 1.2 (Z5, its top edge)
    const power = zones.power!;
    expect(power[2]!.seconds).toBeCloseTo(2400, -1);
    expect(power[4]!.seconds).toBeCloseTo(1200, -1);
    // 140 bpm with max 200: Endurance (Z2, 130–162)
    expect(zones.heartRate![1]!.seconds).toBeCloseTo(3600, -1);
    // pace zones from a 5 km time are for running, not riding
    expect(zones.pace).toBeNull();
    const run = Activity.from(fromSpeeds(Array(601).fill(4), {}, 'Run'));
    const pace = run.analyze({ athlete: json }).zones.pace!;
    // 4 m/s against a 20:00 5 km (4.17 m/s): Tempo (Z3, 3.62–4.05 m/s)
    expect(pace[2]!.seconds).toBeCloseTo(600, -1);
    expect(pace.reduce((t, z) => t + z.seconds, 0)).toBeCloseTo(600, -1);
  });

  it('gives cycling load to rides only', () => {
    const n = 601;
    const watts = Array(n).fill(250);
    const run = Activity.from(fromSpeeds(Array(n).fill(4), { watts }, 'Run'));
    const a = run.analyze({ athlete: FTP_250 });
    expect(a.power.intensityFactor).toBeCloseTo(1, 9);
    expect(a.load).toBeNull();
    const swim = Activity.from(fromSpeeds(Array(n).fill(1), {}, 'Swim'));
    const json: AthleteProfileJson = {
      paceThreshold: [{ at: '2024-01-01', fiveKSeconds: 1200 }],
    };
    expect(swim.analyze({ athlete: json }).zones.pace).toBeNull();
  });

  it('has no zones the athlete has no settings for', () => {
    const { zones } = ride().analyze({ athlete: FTP_250 });
    expect(zones.power).not.toBeNull();
    expect(zones.heartRate).toBeNull();
    expect(zones.pace).toBeNull();
  });

  it('has no pace zones without a distance', () => {
    const n = 600;
    const rec: ImportedActivity = {
      activity: META,
      streams: {
        latlng: [],
        timeSeconds: Array.from({ length: n }, (_, i) => i),
        heartrate: Array(n).fill(140),
      },
    };
    const json: AthleteProfileJson = {
      hrZone: [{ at: '2024-01-01', maxHr: 200 }],
      paceThreshold: [{ at: '2024-01-01', fiveKSeconds: 1200 }],
    };
    const { zones } = Activity.from(rec).analyze({ athlete: json });
    expect(zones.pace).toBeNull();
    expect(zones.heartRate).not.toBeNull();
  });

  it('analyses a section on its own samples', () => {
    const hard = ride().section({
      elapsed: { from: minutes(21), to: minutes(39) },
    });
    const a = hard.analyze({ athlete: FTP_250 });
    expect(a.power.average!.watts).toBe(300);
    expect(a.power.intensityFactor).toBeCloseTo(1.2, 9);
    expect(a.load!.value).toBeCloseTo(((18 * 60 * 1.2 * 1.2) / 3600) * 100, 6);
  });
});

describe('power best efforts', () => {
  it('finds the best 20 minutes', () => {
    const e = ride().power.bestEffort(minutes(20))!;
    expect(e.duration.seconds).toBe(1200);
    expect(e.power.watts).toBe(300);
    expect(e.section.kind).toBe('effort');
    expect(e.section.label).toBe('Best 20:00');
    expect(e.section.fromSeconds).toBe(1200);
    expect(e.section.toSeconds).toBe(2400);
  });

  it('gives a curve shortest first that never rises', () => {
    const curve = ride().power.curve([
      minutes(30),
      seconds(5),
      minutes(20),
      minutes(90),
    ]);
    expect(curve.map((e) => e.duration.seconds)).toEqual([5, 1200, 1800]);
    expect(curve.map((e) => e.power.watts)).toEqual([
      300,
      300,
      expect.closeTo((1200 * 300 + 600 * 200) / 1800, 9),
    ]);
  });

  it('spreads the default curve over the section', () => {
    const curve = ride().power.curve();
    expect(curve[0]!.duration.seconds).toBe(1);
    expect(curve.at(-1)!.duration.seconds).toBe(3600);
    for (let i = 1; i < curve.length; i++)
      expect(curve[i]!.power.watts).toBeLessThanOrEqual(
        curve[i - 1]!.power.watts,
      );
  });

  it('searches only inside a section', () => {
    const early = ride().section({
      elapsed: { from: minutes(0), to: minutes(15) },
    });
    expect(early.power.bestEffort(minutes(5))!.power.watts).toBe(200);
    expect(early.power.bestEffort(minutes(20))).toBeNull();
  });

  it('reports where the effort was when every reading is 0 W', () => {
    const n = 601;
    const flat = Activity.from(
      fromSpeeds(Array(n).fill(5), { watts: Array(n).fill(0) }),
    );
    const e = flat.power.bestEffort(minutes(1))!;
    expect(e.power.watts).toBe(0);
    expect(e.section.toSeconds - e.section.fromSeconds).toBe(60);
  });

  it('counts a pause as 10 s, so the stretch can outlast the duration', () => {
    // 300 W for 30 s, a 60 s pause with no samples, 300 W for 30 s more
    const t = [
      ...Array.from({ length: 31 }, (_, i) => i),
      ...Array.from({ length: 31 }, (_, i) => 90 + i),
    ];
    const rec: ImportedActivity = {
      activity: META,
      streams: {
        latlng: [],
        timeSeconds: t,
        distanceMeters: t.map((s) => s * 10),
        watts: t.map(() => 300),
      },
    };
    const e = Activity.from(rec).power.bestEffort(seconds(70))!;
    expect(e.power.watts).toBe(300);
    expect(e.section.toSeconds - e.section.fromSeconds).toBeGreaterThan(70);
  });

  it('is null with no power and rejects a bad duration', () => {
    const run = Activity.from(fromSpeeds(Array(600).fill(3), {}, 'Run'));
    expect(run.power.bestEffort(minutes(1))).toBeNull();
    expect(run.power.curve()).toEqual([]);
    expect(() => ride().power.curve([seconds(0)])).toThrow(RangeError);
  });
});

describe('pace best efforts', () => {
  /** 25 minutes at 3 m/s, then 25 at 4 m/s. */
  const run = () =>
    Activity.from(
      fromSpeeds(
        Array.from({ length: 3001 }, (_, i) => (i <= 1500 ? 3 : 4)),
        {},
        'Run',
      ),
    );

  it('finds the fastest 5 km', () => {
    const e = run().pace.bestEffort(km(5))!;
    expect(e.distance.meters).toBe(5000);
    expect(e.time.seconds).toBe(1250);
    expect(e.pace.secondsPerKm).toBe(250);
    expect(e.section.label).toBe('Best 5 km');
    expect(e.section.fromSeconds).toBeGreaterThanOrEqual(1500);
    expect(e.section.toSeconds - e.section.fromSeconds).toBe(1250);
  });

  it('lists the standard distances that fit, shortest first', () => {
    const efforts = run().pace.bestEfforts();
    expect(efforts.map((e) => e.section.label)).toEqual([
      'Best 400 m',
      'Best 0.5 mi',
      'Best 1 km',
      'Best 1 mi',
      'Best 2 mi',
      'Best 5 km',
      'Best 10 km',
    ]);
  });

  it('sorts the distances asked for and leaves out ones too long', () => {
    const efforts = run().pace.bestEfforts([
      km(5),
      meters(400),
      Distance.km(50),
    ]);
    expect(efforts.map((e) => e.distance.meters)).toEqual([400, 5000]);
  });

  it('is null with no distance or no timestamps', () => {
    const n = 600;
    const noDistance = Activity.from({
      activity: META,
      streams: {
        latlng: [],
        timeSeconds: Array.from({ length: n }, (_, i) => i),
        heartrate: Array(n).fill(140),
      },
    });
    expect(noDistance.pace.bestEffort(meters(400))).toBeNull();
    const noTime = Activity.from({
      activity: META,
      streams: {
        latlng: [],
        distanceMeters: Array.from({ length: n }, (_, i) => i * 3),
      },
    });
    expect(noTime.pace.bestEffort(meters(400))).toBeNull();
  });
});

describe('aerobic', () => {
  const NONE = Profile.of({});

  /** One hour, 1 Hz. Heart rate 140 for the first half hour, then rising
   *  steadily to 154 at the end. */
  function drifting(
    sportType: string,
    extra: (i: number) => Partial<Record<'watts', number>> = () => ({}),
    speed = (_i: number) => 10,
  ): Activity {
    const n = 3601;
    const hr = Array.from({ length: n }, (_, i) =>
      i <= 1800 ? 140 : 140 + (14 * (i - 1800)) / 1800,
    );
    const watts = Array.from({ length: n }, (_, i) => extra(i).watts ?? 200);
    return Activity.from(
      fromSpeeds(
        Array.from({ length: n }, (_, i) => speed(i)),
        { heartrate: hr, watts },
        sportType,
      ),
    );
  }

  it('measures a ride on power per heartbeat', () => {
    const a = drifting('Ride').analyze({ athlete: NONE }).aerobic;
    const e = a.efficiency()!;
    expect(e.output).toBe('power');
    const np = drifting('Ride').stats().power.normalized!.watts;
    const hr = drifting('Ride').stats().heartRate.average!.bpm;
    expect(e.value).toBeCloseTo(np / hr, 9);
    expect(e.coverage).toBeCloseTo(1, 9);
    expect(a.efficiencyFactor).toBe(e.value);
  });

  it('measures a run on metres per heartbeat', () => {
    const run = drifting(
      'Run',
      () => ({}),
      () => 3,
    );
    const e = run.analyze({ athlete: NONE }).aerobic.efficiency()!;
    expect(e.output).toBe('speed');
    const hr = run.stats({ time: 'moving' }).heartRate.average!.bpm;
    expect(e.value).toBeCloseTo(180 / hr, 6);
  });

  it('finds heart-rate drift as positive decoupling', () => {
    const d = drifting('Ride').analyze({ athlete: NONE }).aerobic.decoupling()!;
    expect(d.method).toBe('halves');
    // first half: 200 W at 140; second: 200 W at an average of 147
    expect(d.firstHalf.value).toBeCloseTo(200 / 140, 2);
    expect(d.secondHalf.value).toBeCloseTo(200 / 147, 2);
    expect(d.change).toBeCloseTo(1 - 140 / 147, 2);
    expect(d.suitable).toBe(true);
    expect(d.cautions).toEqual([]);
  });

  it('splits the halves by moving time, so a stop does not move them', () => {
    // stopped for the first 600 s, then 3000 s at 3 m/s: the moving midpoint
    // is at 2100 s elapsed. Heart rate steps from 140 to 160 exactly there.
    const n = 3601;
    const run = Activity.from(
      fromSpeeds(
        Array.from({ length: n }, (_, i) => (i <= 600 ? 0 : 3)),
        {
          heartrate: Array.from({ length: n }, (_, i) =>
            i <= 2100 ? 140 : 160,
          ),
        },
        'Run',
      ),
    );
    const d = run.analyze({ athlete: NONE }).aerobic.decoupling()!;
    expect(d.firstHalf.value).toBeCloseTo(180 / 140, 6);
    expect(d.secondHalf.value).toBeCloseTo(180 / 160, 6);
    expect(d.change).toBeCloseTo(1 - 140 / 160, 6);
  });

  it('flags a short, gappy or uneven section', () => {
    const short = drifting('Ride')
      .section({ elapsed: { from: minutes(0), to: minutes(10) } })
      .analyze({ athlete: NONE })
      .aerobic.decoupling()!;
    expect(short.cautions).toContain('short');
    expect(short.suitable).toBe(false);

    const intervals = drifting('Ride', (i) => ({
      watts: Math.floor(i / 60) % 2 ? 400 : 100,
    }))
      .analyze({ athlete: NONE })
      .aerobic.decoupling()!;
    expect(intervals.cautions).toContain('variable');

    const n = 3601;
    const gappy = Activity.from(
      fromSpeeds(Array(n).fill(10), {
        watts: Array(n).fill(200),
        heartrate: Array.from({ length: n }, (_, i) =>
          i % 4 === 0 ? NaN : 140,
        ),
      }),
    )
      .analyze({ athlete: NONE })
      .aerobic.decoupling()!;
    expect(gappy.coverage).toBeCloseTo(0.75, 2);
    expect(gappy.cautions).toContain('low-coverage');
  });

  it('is null without heart rate', () => {
    const n = 600;
    const noHr = Activity.from(fromSpeeds(Array(n).fill(10)));
    const a = noHr.analyze({ athlete: NONE }).aerobic;
    expect(a.efficiency()).toBeNull();
    expect(a.decoupling()).toBeNull();
    expect(a.efficiencyFactor).toBeNull();
  });

  it('measures speed when asked, even on a ride with power', () => {
    const e = drifting('Ride')
      .analyze({ athlete: NONE })
      .aerobic.efficiency({ output: 'speed' })!;
    expect(e.output).toBe('speed');
  });

  it('measures power on moving time, so a café stop does not hide drift', () => {
    // 200 W throughout while moving; heart rate 140 in the first half and
    // 150 in the second. A 20-minute stop (0 W, 0 m/s, HR 90) sits in the
    // second half; on elapsed time it would pull that half's HR down.
    const n = 4801;
    const stop = (i: number) => i > 3000 && i <= 4200;
    const ride = Activity.from(
      fromSpeeds(
        Array.from({ length: n }, (_, i) => (stop(i) ? 0 : 10)),
        {
          watts: Array.from({ length: n }, (_, i) => (stop(i) ? 0 : 200)),
          heartrate: Array.from({ length: n }, (_, i) =>
            stop(i) ? 90 : i <= 1800 ? 140 : 150,
          ),
        },
      ),
    );
    const d = ride.analyze({ athlete: NONE }).aerobic.decoupling()!;
    expect(d.secondHalf.value).toBeCloseTo(200 / 150, 1);
    expect(d.change).toBeGreaterThan(0.05);
    expect(d.coverage).toBeCloseTo(1, 6);
  });

  it('reads a negative change when the second half is more efficient', () => {
    const n = 3601;
    const ride = Activity.from(
      fromSpeeds(Array(n).fill(10), {
        watts: Array(n).fill(200),
        heartrate: Array.from({ length: n }, (_, i) => (i <= 1800 ? 150 : 140)),
      }),
    );
    const d = ride.analyze({ athlete: NONE }).aerobic.decoupling()!;
    expect(d.change).toBeCloseTo(1 - 150 / 140, 2);
  });

  it('is null with no timestamps, and decoupling is null on a pool swim', () => {
    const n = 600;
    const noTime = Activity.from({
      activity: META,
      streams: {
        latlng: [],
        distanceMeters: Array.from({ length: n }, (_, i) => i * 10),
        heartrate: Array(n).fill(140),
        watts: Array(n).fill(200),
      },
    });
    const a = noTime.analyze({ athlete: NONE }).aerobic;
    expect(a.efficiency()).toBeNull();
    expect(a.decoupling()).toBeNull();

    const pool = readActivity(
      gunzipSync(
        readFileSync(
          fileURLToPath(
            new URL('./fixtures/pool-swim.fit.gz', import.meta.url),
          ),
        ),
      ),
    );
    expect(pool.analyze({ athlete: NONE }).aerobic.decoupling()).toBeNull();
  });
});

describe('distribution', () => {
  const NONE = Profile.of({});

  it('spreads power over bins from 0, every bin kept', () => {
    const d = ride().analyze({ athlete: NONE }).distribution('power')!;
    expect(d.unit).toBe('W');
    expect(d.binWidth).toBe(25);
    expect(d.bins[0]!.start).toBe(0);
    const at = (w: number) => d.bins.find((b) => b.start === w)!.seconds;
    // 200 W for 40 minutes, 300 W for 20
    expect(at(200)).toBeCloseTo(2400, 0);
    expect(at(300)).toBeCloseTo(1200, 0);
    expect(at(100)).toBe(0);
    expect(d.seconds).toBeCloseTo(3600, 0);
  });

  it('starts heart rate at its lowest bin, with a width asked for', () => {
    const d = ride()
      .analyze({ athlete: NONE })
      .distribution('heartRate', { binWidth: 10 })!;
    expect(d.bins).toEqual([{ start: 140, end: 150, seconds: 3600 }]);
  });

  it('leaves stops out of pace, and out of anything on moving time', () => {
    const n = 1201;
    const run = Activity.from(
      fromSpeeds(
        Array.from({ length: n }, (_, i) => (i > 600 ? 0 : 4)),
        { heartrate: Array(n).fill(150) },
        'Run',
      ),
    );
    const a = run.analyze({ athlete: NONE });
    const pace = a.distribution('pace')!;
    // 4 m/s is 250 s/km, in the 240-255 bin
    expect(pace.bins).toEqual([{ start: 240, end: 255, seconds: 600 }]);
    expect(a.distribution('heartRate')!.seconds).toBeCloseTo(1200, 0);
    expect(
      a.distribution('heartRate', { time: 'moving' })!.seconds,
    ).toBeCloseTo(600, 0);
  });

  it('is null for a channel not recorded, and rejects a bad width', () => {
    const a = ride().analyze({ athlete: NONE });
    expect(a.distribution('cadence')).toBeNull();
    expect(() => a.distribution('power', { binWidth: 0 })).toThrow(RangeError);
  });

  it('measures coasting from cadence, else power', () => {
    const n = 3601;
    const cadence = Array.from({ length: n }, (_, i) =>
      i % 10 === 0 ? 0 : 90,
    );
    const withCadence = Activity.from(
      fromSpeeds(Array(n).fill(10), { cadence, watts: Array(n).fill(200) }),
    );
    const c = withCadence.analyze({ athlete: NONE }).coasting!;
    expect(c.source).toBe('cadence');
    expect(c.duration.seconds).toBeCloseTo(360, 0);
    expect(c.share).toBeCloseTo(0.1, 3);

    const watts = Array.from({ length: n }, (_, i) => (i <= 900 ? 0 : 200));
    const powerOnly = Activity.from(fromSpeeds(Array(n).fill(10), { watts }));
    const p = powerOnly.analyze({ athlete: NONE }).coasting!;
    expect(p.source).toBe('power');
    expect(p.share).toBeCloseTo(0.25, 2);
  });

  it('has no coasting off the bike', () => {
    const n = 600;
    const run = Activity.from(
      fromSpeeds(Array(n).fill(3), { cadence: Array(n).fill(0) }, 'Run'),
    );
    expect(run.analyze({ athlete: NONE }).coasting).toBeNull();
  });
});
