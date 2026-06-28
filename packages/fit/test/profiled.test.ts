import { describe, it, expect } from 'vitest';
import {
  Activity,
  ProfiledActivity,
  ProfiledSection,
} from '../src/activity/index.js';
import { Profile, type AthleteProfileJson } from '../src/profile/index.js';
import { Distance, Duration } from '../src/quantities.js';
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

/** A steady ride: n samples at 1 Hz, ~10 m/step east, constant watts + HR. */
function steadyRide(
  n: number,
  watts: number,
  heartRate: number,
): ImportedActivity {
  const dLng = 10 / 111320;
  const latlng: [number, number][] = [];
  const timeSeconds: number[] = [];
  const wattsArr: number[] = [];
  const heartrate: number[] = [];
  for (let i = 0; i < n; i++) {
    latlng.push([0, i * dLng]);
    timeSeconds.push(i);
    wattsArr.push(watts);
    heartrate.push(heartRate);
  }
  const streams: ActivityStreams = {
    latlng,
    timeSeconds,
    watts: wattsArr,
    heartrate,
  };
  return { activity: { ...META }, streams };
}

// FTP 250, weight 70 kg, max HR 200 → Z2/Z3 power edge = 187.5/225 W; HR Z1/Z2
// edge = 130 bpm, Z2/Z3 = 162 bpm.
const ATHLETE: AthleteProfileJson = {
  ftpWatts: [{ at: '2026-01-01', value: 250 }],
  weightKg: [{ at: '2026-01-01', value: 70 }],
  hrZone: [{ at: '2026-01-01', maxHr: 200 }],
};

describe('Profile', () => {
  it('resolves FTP / weight as of the activity date and derives power zones', () => {
    const bob = Profile.asOf(ATHLETE, META.startTimeUtc);
    expect(bob.ftpWatts).toBe(250);
    expect(bob.weightKg).toBe(70);
    const pz = bob.powerZones!;
    expect(pz.labels.length).toBe(7);
    expect(pz.edges[2]).toBeCloseTo(187.5, 6); // 0.75 × 250
    expect(pz.edges[3]).toBeCloseTo(225, 6); // 0.90 × 250
  });

  it('powerZones is undefined without an FTP', () => {
    const noFtp = Profile.asOf(
      { weightKg: [{ at: '2026-01-01', value: 70 }] },
      META.startTimeUtc,
    );
    expect(noFtp.powerZones).toBeUndefined();
    expect(noFtp.ftpWatts).toBeUndefined();
    expect(noFtp.weightKg).toBe(70);
  });
});

describe('ProfiledActivity', () => {
  const act = Activity.fromStreams(steadyRide(600, 200, 150));
  const view = act.usingProfile(Profile.asOf(ATHLETE, META.startTimeUtc));

  it('usingProfile returns a ProfiledActivity', () => {
    expect(view).toBeInstanceOf(ProfiledActivity);
  });

  it('power(): NP ≈ 200 W, IF ≈ 0.8 at FTP 250', () => {
    const p = view.power()!;
    expect(p.normalizedWatts).toBeCloseTo(200, 0);
    expect(p.intensityFactor).toBeCloseTo(0.8, 2);
    expect(p.ftp).toBe(250);
  });

  it('byPowerZone(): 7 zones, all time in Z3 (200 W ÷ 250 FTP = 0.8 → Tempo)', () => {
    const zones = view.byPowerZone();
    expect(zones.length).toBe(7);
    const occupied = zones.filter((z) => z.seconds > 0);
    expect(occupied.length).toBe(1);
    expect(occupied[0]!.zone).toBe(3);
  });

  it('byHeartRateZone(): all time in Z2 (150 bpm, max HR 200)', () => {
    const occupied = view.byHeartRateZone().filter((z) => z.seconds > 0);
    expect(occupied.length).toBe(1);
    expect(occupied[0]!.zone).toBe(2);
  });

  it('bestEfforts(): carries W/kg from the profile body weight', () => {
    const efforts = view.bestEfforts();
    expect(efforts.length).toBeGreaterThan(0);
    expect(efforts[0]!.wattsPerKg).toBeCloseTo(200 / 70, 1);
  });
});

describe('turtles — the profile flows into the slices', () => {
  const act = Activity.fromStreams(steadyRide(600, 200, 150));
  const view = act.usingProfile(Profile.asOf(ATHLETE, META.startTimeUtc));

  it('splits() return ProfiledSections with delegated metrics + by…Zone()', () => {
    const splits = view.splits(Distance.meters(1000));
    expect(splits.length).toBeGreaterThan(0);
    const s = splits[0]!;
    expect(s).toBeInstanceOf(ProfiledSection);
    expect(s.distance().meters).toBeGreaterThan(0); // delegated to Section
    const occupied = s.byPowerZone().filter((z) => z.seconds > 0);
    expect(occupied[0]!.zone).toBe(3);
  });

  it('a full-activity range matches the whole-activity HR distribution', () => {
    const total = act.elapsedTime().seconds;
    const whole = view.byHeartRateZone().find((z) => z.seconds > 0)!;
    const ranged = view
      .range(Duration.seconds(0), Duration.seconds(total))
      .byHeartRateZone()
      .find((z) => z.seconds > 0)!;
    expect(ranged.zone).toBe(whole.zone);
    expect(ranged.seconds).toBeCloseTo(whole.seconds, 0);
  });
});

describe('graceful absence', () => {
  it('no FTP → power() undefined, byPowerZone() []; no HR zones → byHeartRateZone() []', () => {
    const act = Activity.fromStreams(steadyRide(120, 200, 150));
    const view = act.usingProfile(Profile.asOf({}, META.startTimeUtc));
    expect(view.power()).toBeUndefined();
    expect(view.byPowerZone()).toEqual([]);
    expect(view.byHeartRateZone()).toEqual([]);
  });
});
