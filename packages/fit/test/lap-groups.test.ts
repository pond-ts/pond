import { describe, expect, it } from 'vitest';
import {
  groupLaps,
  lapExtremes,
  lapSpeed,
  lapsGrouped,
  summarizeLaps,
  type GroupLap,
  type LapAverages,
} from '../src/index.js';

// Ported from Estela's lap summary tests.

type L = GroupLap & LapAverages;
// 2 × warm-up, 400s and 800s with 200 m jogs between, a cool-down
const session = (): L[] => [
  { type: 'warmup', meters: 400, seconds: 180 },
  { type: 'warmup', meters: 400, seconds: 170 },
  { type: 'active', name: '800m', meters: 800, seconds: 200, avgHr: 170 },
  { type: 'recovery', name: '200m', meters: 200, seconds: 90 },
  { type: 'active', name: '400m', meters: 400, seconds: 90, avgHr: 175 },
  { type: 'recovery', name: '200m', meters: 200, seconds: 100 },
  { type: 'active', name: '400m', meters: 400, seconds: 80, avgHr: 185 },
  { type: 'cooldown', meters: 800, seconds: 400 },
];

describe('groupLaps', () => {
  it('is null until a lap has a type or a name', () => {
    const plain = session().map(({ type: _t, name: _n, ...l }) => l);
    expect(lapsGrouped(plain)).toBe(false);
    expect(groupLaps(plain)).toBeNull();
    expect(lapsGrouped([{ name: 'Hill' }])).toBe(true);
    expect(lapsGrouped([{ name: '' }])).toBe(false);
  });

  it('groups by type in the order the session reaches them, then by name, shortest first', () => {
    const groups = groupLaps(session())!;
    expect(groups.map((g) => [g.key, g.depth, g.heading ?? false])).toEqual([
      ['warmup', 0, false],
      ['active', 0, true],
      ['active/400m', 1, false],
      ['active/800m', 1, false],
      ['recovery', 0, false],
      ['cooldown', 0, false],
    ]);
    // a type whose laps share one name keeps it on its one group
    expect(groups.find((g) => g.key === 'recovery')!.name).toBe('200m');
    expect(groups.find((g) => g.key === 'active/400m')!.laps).toEqual([4, 6]);
    expect(groups.find((g) => g.key === 'active')!.laps).toEqual([2, 4, 6]);
    expect(groups.find((g) => g.key === 'active')!.name).toBeUndefined();
  });

  it('lists laps with no type last, and keeps first-seen order when distances are missing', () => {
    const groups = groupLaps([
      { type: 'active', name: 'Long', seconds: 300 } as L,
      {},
      { type: 'active', name: 'Short', seconds: 60 } as L,
    ])!;
    expect(groups.map((g) => g.key)).toEqual([
      'active',
      'active/Long',
      'active/Short',
      'default',
    ]);
    expect(groups.at(-1)!.type).toBeUndefined();
    expect(groups.at(-1)!.laps).toEqual([1]);
  });

  it('uses the ids given', () => {
    const groups = groupLaps([
      { i: 10, type: 'active' },
      { i: 12, type: 'active' },
    ])!;
    expect(groups[0]!.laps).toEqual([10, 12]);
  });
});

describe('summarizeLaps', () => {
  it('works speed out from total distance over total time, and weights heart rate by time', () => {
    const v = summarizeLaps([
      { meters: 400, seconds: 100, avgHr: 160 },
      { meters: 800, seconds: 300, avgHr: 180 },
    ]);
    expect(v.speedMps).toBeCloseTo(1200 / 400);
    expect(v.avgHr).toBeCloseTo((160 * 100 + 180 * 300) / 400);
    expect(v.avgWatts).toBeUndefined();
  });

  it("takes the extremes from the laps' own averages, not peaks inside a lap", () => {
    const v = summarizeLaps([
      { meters: 400, seconds: 100, avgHr: 160 },
      { meters: 800, seconds: 300, avgHr: 180, speedMps: 2.5 },
      { meters: 400, seconds: 80, avgHr: 175 },
    ]);
    expect(v.slowestLapMps).toBe(2.5);
    expect(v.fastestLapMps).toBe(5);
    expect(v.highestLapHr).toBe(180);
    const one = summarizeLaps([{ meters: 400, seconds: 100, avgHr: 160 }]);
    expect(one.speedMps).toBe(4);
    expect(one.fastestLapMps).toBeUndefined();
    expect(one.highestLapHr).toBeUndefined();
  });

  it('combines power: time-weighted average, NP from each lap’s NP⁴, the highest lap average', () => {
    const v = summarizeLaps([
      { seconds: 60, avgWatts: 300, npWatts: 320 },
      { seconds: 180, avgWatts: 200, npWatts: 210 },
    ]);
    expect(v.avgWatts).toBeCloseTo((300 * 60 + 200 * 180) / 240);
    expect(v.npWatts).toBeCloseTo(
      ((320 ** 4 * 60 + 210 ** 4 * 180) / 240) ** 0.25,
    );
    expect(v.highestLapWatts).toBe(300);
  });

  it('is empty for no laps', () => {
    expect(summarizeLaps([])).toEqual({});
  });
});

describe('lapExtremes', () => {
  it('finds the fastest and slowest lap of a group, none with a single lap', () => {
    const laps = session();
    const groups = groupLaps(laps)!;
    const speed = (i: number) => lapSpeed(laps[i]!);
    expect(
      lapExtremes(groups.find((g) => g.key === 'active/400m')!.laps, speed),
    ).toEqual({ hi: { lap: 6, value: 5 }, lo: { lap: 4, value: 400 / 90 } });
    expect(
      lapExtremes(groups.find((g) => g.key === 'active/800m')!.laps, speed),
    ).toBeNull();
    expect(lapExtremes([0, 1], () => 3)).toBeNull();
  });
});
