import { describe, it, expect } from 'vitest';
import {
  profileAsOf,
  hrZonesFrom,
  paceZonesFrom,
  type AthleteProfileJson,
} from '../src/profile/index.js';

const json: AthleteProfileJson = {
  weightKg: [
    { at: '2026-01-01', value: 70 },
    { at: '2026-06-01', value: 72 },
  ],
  ftpWatts: [{ at: '2026-03-01', value: 250 }],
  hrZone: [{ at: '2026-01-01', maxHr: 198 }],
  paceThreshold: [{ at: '2026-01-01', fiveKSeconds: 1680 }],
};

describe('profileAsOf (pond atOrBefore resolution)', () => {
  it('returns nothing before the first entry of each series', () => {
    const r = profileAsOf(json, '2025-12-31');
    expect(r.weightKg).toBeUndefined();
    expect(r.ftpWatts).toBeUndefined();
    expect(r.hrZones).toBeUndefined();
    expect(r.paceZones).toBeUndefined();
  });

  it('resolves the entry in force on the activity date (most recent ≤ date)', () => {
    // Jan: weight 70, HR+pace present, but FTP not until March
    const jan = profileAsOf(json, '2026-01-15');
    expect(jan.weightKg).toBe(70);
    expect(jan.ftpWatts).toBeUndefined();
    expect(jan.hrZones).toBeDefined();
    expect(jan.paceZones).toBeDefined();
    // April: FTP now in force, weight still the Jan value
    const apr = profileAsOf(json, '2026-04-01');
    expect(apr.weightKg).toBe(70);
    expect(apr.ftpWatts).toBe(250);
    // July: the June weight supersedes
    expect(profileAsOf(json, '2026-07-01').weightKg).toBe(72);
  });

  it('resolves a date exactly on an entry to that entry (inclusive)', () => {
    expect(profileAsOf(json, '2026-06-01').weightKg).toBe(72);
    expect(profileAsOf(json, '2026-03-01').ftpWatts).toBe(250);
  });

  it('a same-day re-edit supersedes (last wins)', () => {
    const j: AthleteProfileJson = {
      weightKg: [
        { at: '2026-01-01', value: 70 },
        { at: '2026-01-01', value: 71 },
      ],
    };
    expect(profileAsOf(j, '2026-02-01').weightKg).toBe(71);
  });

  it('empty profile resolves to nothing', () => {
    expect(profileAsOf({}, '2026-01-01')).toEqual({});
  });
});

describe('hrZonesFrom', () => {
  it("derives Strava's max-HR boundaries (198 → 129/160/176/192)", () => {
    expect(hrZonesFrom({ maxHr: 198 }).edges).toEqual([
      0, 129, 160, 176, 192, 1e9,
    ]);
  });
  it('passes custom bounds straight through', () => {
    expect(hrZonesFrom({ bounds: [120, 150, 170, 185] }).edges).toEqual([
      0, 120, 150, 170, 185, 1e9,
    ]);
  });
  it('labels five zones Recovery → Anaerobic', () => {
    expect(hrZonesFrom({ maxHr: 200 }).labels).toEqual([
      'Recovery',
      'Endurance',
      'Tempo',
      'Threshold',
      'Anaerobic',
    ]);
  });
});

describe('paceZonesFrom', () => {
  it('builds ascending SPEED edges (Z1 slowest), six zones', () => {
    const z = paceZonesFrom(1680); // 5 k pace → speed 2.976 m/s
    expect(z.labels).toHaveLength(6);
    expect(z.edges).toHaveLength(7); // 6 zones + sentinel
    expect(z.edges[0]).toBe(0);
    expect(z.edges[z.edges.length - 1]).toBe(1e9);
    const interior = z.edges.slice(1, -1);
    for (let i = 1; i < interior.length; i++)
      expect(interior[i]!).toBeGreaterThan(interior[i - 1]!);
  });
});
