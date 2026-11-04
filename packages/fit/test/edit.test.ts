import { describe, expect, it } from 'vitest';
import {
  editRecording,
  editedLapStarts,
  isEmptyEdit,
  lapStartSeconds,
  recordingSeconds,
  type ImportedActivity,
  type Lap,
} from '../src/index.js';

const START = '2026-10-20T07:00:00.000Z';
const at = (s: number) => new Date(Date.parse(START) + s * 1000).toISOString();

/** 101 samples a second apart, 3 m/s, heart rate 100 + t/2; laps at 0, 40
 *  and 70 s whose own distances are the device's (a little longer). */
function recording(): ImportedActivity {
  const t = Array.from({ length: 101 }, (_, i) => i);
  const lap = (index: number, a: number, b: number): Lap => ({
    index,
    startTimeUtc: at(a),
    startDistanceMeters: a * 3.1,
    distanceMeters: (b - a) * 3.1,
    elapsedSeconds: b - a,
    movingSeconds: b - a,
    avgHeartrate: 100 + (a + b) / 4,
    calories: b - a,
  });
  return {
    activity: {
      id: 'x',
      source: 'manual',
      externalId: 'x',
      name: 'Track',
      startTimeUtc: START,
      distanceMeters: 310,
      movingTimeSeconds: 100,
      elapsedTimeSeconds: 100,
      elevationGainMeters: 0,
      sportType: 'Run',
    },
    streams: {
      latlng: t.map((s) => [37 + s * 0.00003, -122] as [number, number]),
      timeSeconds: t,
      distanceMeters: t.map((s) => s * 3),
      heartrate: t.map((s) => 100 + s / 2),
    },
    laps: [lap(1, 0, 40), lap(2, 40, 70), lap(3, 70, 100)],
  };
}

describe('editRecording', () => {
  it('reads the recording clock', () => {
    expect(recordingSeconds(recording())).toBe(100);
    expect(lapStartSeconds(recording())).toEqual([0, 40, 70]);
  });

  it('leaves the recording alone with no edit', () => {
    const r = recording();
    expect(editRecording(r, undefined)).toBe(r);
    expect(editRecording(r, {})).toBe(r);
    expect(isEmptyEdit({ splitLapsAt: [] })).toBe(true);
  });

  it('refuses an edit it cannot carry out', () => {
    const r = recording();
    expect(() => editRecording(r, { from: 50, to: 40 })).toThrow(RangeError);
    expect(() => editRecording(r, { from: 200, splitLapsAt: [30] })).toThrow(
      RangeError,
    );
    expect(() => editRecording(r, { to: NaN, splitLapsAt: [30] })).toThrow(
      RangeError,
    );
    const { timeSeconds: _, ...untimed } = r.streams;
    expect(() =>
      editRecording({ ...r, streams: untimed }, { from: 10 }),
    ).toThrow(RangeError);
    // non-finite lap edits are ignored
    expect(
      editRecording(r, { splitLapsAt: [NaN, 55] }).laps!.map(
        (l) => l.elapsedSeconds,
      ),
    ).toEqual([40, 15, 15, 30]);
    // a join that matches no lap changes nothing
    expect(
      editRecording(r, { joinLapsAt: [20] }).laps!.map((l) => l.elapsedSeconds),
    ).toEqual([40, 30, 30]);
  });

  it('drops a lap boundary within a second of either crop end', () => {
    const r = recording();
    expect(
      editRecording(r, { to: 70.5 }).laps!.map((l) => l.elapsedSeconds),
    ).toEqual([40, 30.5]);
    expect(
      editRecording(r, { from: 39.5 }).laps!.map((l) => l.elapsedSeconds),
    ).toEqual([30.5, 30]);
  });

  it('shares out work and climb by distance and averages power from the samples', () => {
    const r = recording();
    r.streams.watts = r.streams.timeSeconds!.map((t) => 200 + t);
    r.laps = r.laps!.map((l) => ({
      ...l,
      totalWorkKj: l.elapsedSeconds,
      elevationGainMeters: l.elapsedSeconds / 10,
    }));
    const v = editRecording(r, { splitLapsAt: [20] });
    expect(v.laps![0]!.totalWorkKj).toBeCloseTo(20, 5);
    expect(v.laps![1]!.elevationGainMeters).toBeCloseTo(2, 5);
    // samples 0 … 19: 200 … 219
    expect(v.laps![0]!.avgWatts).toBe(210);
    expect(v.laps![0]!.maxWatts).toBe(219);
  });

  it('crops the streams onto a clock that starts again at zero', () => {
    const v = editRecording(recording(), { from: 10, to: 90 });
    expect(v.streams.timeSeconds![0]).toBe(0);
    expect(v.streams.timeSeconds!.at(-1)).toBe(80);
    expect(v.streams.distanceMeters![0]).toBe(0);
    expect(v.streams.distanceMeters!.at(-1)).toBe(240);
    expect(v.streams.latlng).toHaveLength(81);
    expect(v.streams.heartrate![0]).toBe(105);
    expect(v.activity.startTimeUtc).toBe(at(10));
    expect(v.activity.elapsedTimeSeconds).toBe(80);
    expect(v.activity.movingTimeSeconds).toBe(80);
    // the recording's own total, shared out by distance covered
    expect(v.activity.distanceMeters).toBeCloseTo(248, 5);
  });

  it('does not change the recording it was given', () => {
    const r = recording();
    const copy = structuredClone(r);
    editRecording(r, { from: 10, to: 90, splitLapsAt: [50] });
    expect(r).toEqual(copy);
  });

  it('crops the edge laps and keeps the middle one as recorded', () => {
    const r = recording();
    const v = editRecording(r, { from: 10, to: 90 });
    expect(v.laps!.map((l) => l.elapsedSeconds)).toEqual([30, 30, 20]);
    expect(v.laps![1]).toEqual({
      ...r.laps![1]!,
      startDistanceMeters: 30 * 3.1,
      index: 2,
    });
    expect(v.laps![0]!.distanceMeters).toBeCloseTo(93, 5);
    expect(v.laps![0]!.startTimeUtc).toBe(at(10));
    expect(v.laps![0]!.calories).toBe(30);
    // heart rate averaged from its samples: 105 … 119.5
    expect(v.laps![0]!.avgHeartrate).toBe(112);
  });

  it('splits a lap and joins two, by second', () => {
    const r = recording();
    const v = editRecording(r, { splitLapsAt: [55], joinLapsAt: [70] });
    expect(
      v.laps!.map((l) => [l.index, l.startTimeUtc, l.elapsedSeconds]),
    ).toEqual([
      [1, at(0), 40],
      [2, at(40), 15],
      [3, at(55), 45],
    ]);
    expect(v.laps![2]!.distanceMeters).toBeCloseTo(15 * 3.1 + 30 * 3.1, 5);
    // laps only: the streams and totals are the recording's
    expect(v.streams).toBe(r.streams);
    expect(v.activity).toBe(r.activity);
    expect(v.laps![2]!.startDistanceMeters).toBeCloseTo(55 * 3.1, 5);
  });

  it('cuts an activity with no laps into laps', () => {
    const r: ImportedActivity = { ...recording(), laps: undefined };
    const v = editRecording(r, { splitLapsAt: [30] });
    expect(v.laps!.map((l) => l.elapsedSeconds)).toEqual([30, 70]);
    expect(v.laps![0]!.distanceMeters).toBeCloseTo(93, 5);
    // a crop alone gives no laps to one that had none
    expect(editRecording(r, { from: 10 }).laps).toBeUndefined();
  });

  it('keeps the whole recording on its clock for an editor', () => {
    const r = recording();
    const v = editRecording(
      r,
      { from: 10, splitLapsAt: [55] },
      { keepClock: true },
    );
    expect(v.streams).toBe(r.streams);
    expect(v.laps!.map((l) => l.elapsedSeconds)).toEqual([30, 15, 15, 30]);
    expect(v.laps![0]!.startDistanceMeters).toBe(30);
  });

  it('moves the local wall clock on, written as it was', () => {
    const r = recording();
    r.activity.startTimeLocal = '2026-10-20T09:00:00';
    expect(editRecording(r, { from: 90 }).activity.startTimeLocal).toBe(
      '2026-10-20T09:01:30',
    );
  });

  it('keeps an end lap as recorded when it runs past the samples and that end is not cropped', () => {
    const r = recording();
    // the device's last lap ends 2 s after the last sample, its first starts
    // 3 s before the first
    r.laps![2] = { ...r.laps![2]!, elapsedSeconds: 32 };
    r.laps![0] = { ...r.laps![0]!, startTimeUtc: at(-3), elapsedSeconds: 43 };
    const v = editRecording(r, { splitLapsAt: [55] });
    expect(v.laps).toHaveLength(4);
    expect(v.laps![0]).toEqual({
      ...r.laps![0],
      index: 1,
      startDistanceMeters: 0,
    });
    expect(v.laps![3]).toEqual({
      ...r.laps![2],
      index: 4,
      startDistanceMeters: v.laps![3]!.startDistanceMeters,
    });
  });

  it("crops a pool swim's lengths and works its swim time out again", () => {
    const r = recording();
    r.activity.sportType = 'Swim';
    // four 25 s lengths, the third a rest
    r.swim = {
      movingSeconds: 75,
      pool: { lengthMeters: 25, unit: 'm' },
      lengths: [0, 25, 50, 75].map((s, i) => ({
        startTimeUtc: at(s),
        seconds: 25,
        active: i !== 2,
      })),
    };
    r.laps = [
      { ...r.laps![0]!, elapsedSeconds: 50, movingSeconds: 50 },
      {
        ...r.laps![1]!,
        startTimeUtc: at(50),
        elapsedSeconds: 25,
        movingSeconds: 25,
        distanceMeters: 0,
      },
      {
        ...r.laps![2]!,
        startTimeUtc: at(75),
        elapsedSeconds: 25,
        movingSeconds: 25,
      },
    ];
    const v = editRecording(r, { from: 25 });
    expect(v.swim!.lengths!.map((l) => l.startTimeUtc)).toEqual([
      at(25),
      at(50),
      at(75),
    ]);
    expect(v.swim!.pool).toEqual({ lengthMeters: 25, unit: 'm' });
    // laps that covered distance: 25 s of the first, all of the last
    expect(v.swim!.movingSeconds).toBe(50);
    expect(v.activity.movingTimeSeconds).toBe(50);
  });
});

describe('a swim with no laps', () => {
  it('shares its swim time out by time, or by the lengths kept', () => {
    const r = recording();
    r.laps = undefined;
    r.swim = { movingSeconds: 60 };
    expect(editRecording(r, { to: 50 }).swim!.movingSeconds).toBe(30);
    r.swim = {
      movingSeconds: 75,
      lengths: [0, 25, 50, 75].map((s, i) => ({
        startTimeUtc: at(s),
        seconds: 25,
        active: i !== 2,
      })),
    };
    // lengths at 25 (swum) and 50 (rest) kept
    expect(editRecording(r, { from: 25, to: 75 }).swim!.movingSeconds).toBe(25);
  });
});

describe('editedLapStarts', () => {
  it('gives the lap lines an editor draws', () => {
    expect(
      editedLapStarts(
        [0, 40, 70],
        { from: 10, splitLapsAt: [55], joinLapsAt: [70] },
        100,
      ),
    ).toEqual([10, 40, 55]);
    expect(editedLapStarts([], { splitLapsAt: [30] }, 100)).toEqual([0, 30]);
    // two lines within a second of each other are one
    expect(editedLapStarts([0, 40], { splitLapsAt: [40.5] }, 100)).toEqual([
      0, 40,
    ]);
  });
});
