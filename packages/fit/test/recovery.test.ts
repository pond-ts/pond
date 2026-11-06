import { describe, expect, it } from 'vitest';
import {
  recoveryAt,
  recoveryFromReadings,
  recoverySummary,
  twoMinuteDrop,
} from '../src/index.js';

// Ported from Estela's recovery tests (the Apple Watch record reading stays
// in Estela; its core is recoveryFromReadings).

describe('recoveryFromReadings', () => {
  it('splits the readings at the end: the last before it is the stop', () => {
    expect(
      recoveryFromReadings(
        [
          [975, 151],
          [990, 150],
          [1060, 128],
          [1120.4, 117],
          [1180, 110],
          [1400, 95], // more than 5 minutes after: left out
        ],
        1000,
      ),
    ).toEqual({
      atStopBpm: 150,
      after: [
        { sec: 60, bpm: 128 },
        { sec: 120, bpm: 117 },
        { sec: 180, bpm: 110 },
      ],
    });
  });

  it('sorts the readings and leaves out ones that cannot be a heart rate', () => {
    expect(
      recoveryFromReadings(
        [
          [120, 118],
          [60, 0],
          [90, 121],
        ],
        0,
      )?.after,
    ).toEqual([
      { sec: 90, bpm: 121 },
      { sec: 120, bpm: 118 },
    ]);
  });

  it('has no stop reading more than 30 s before the end', () => {
    expect(
      recoveryFromReadings(
        [
          [900, 150],
          [1060, 128],
        ],
        1000,
      ),
    ).toEqual({ after: [{ sec: 60, bpm: 128 }] });
  });

  it('is undefined with nothing after the stop', () => {
    expect(recoveryFromReadings([], 0)).toBeUndefined();
    expect(recoveryFromReadings([[90, 140]], 100)).toBeUndefined();
  });
});

describe('recoveryAt', () => {
  const r = {
    after: [
      { sec: 58, bpm: 128 },
      { sec: 121, bpm: 117 },
    ],
  };
  it('finds the reading nearest a moment, within ten seconds', () => {
    expect(recoveryAt(r, 60)).toEqual({ sec: 58, bpm: 128 });
    expect(recoveryAt(r, 120)).toEqual({ sec: 121, bpm: 117 });
    expect(recoveryAt(r, 180)).toBeUndefined();
    expect(recoveryAt(r, 180, 60)).toEqual({ sec: 121, bpm: 117 });
  });
});

describe('recoverySummary', () => {
  it('keeps the stop and the readings nearest 1, 2 and 3 minutes', () => {
    const after = Array.from({ length: 30 }, (_, i) => ({
      sec: (i + 1) * 10,
      bpm: 150 - i,
    }));
    const r = { atStopBpm: 152, after, source: 'watch' };
    expect(recoverySummary(r)).toEqual({
      atStopBpm: 152,
      after: [
        { sec: 60, bpm: 145 },
        { sec: 120, bpm: 139 },
        { sec: 180, bpm: 133 },
      ],
      source: 'watch',
    });
  });
});

describe('twoMinuteDrop', () => {
  it('is the fall from the stop to two minutes', () => {
    expect(
      twoMinuteDrop({ atStopBpm: 150, after: [{ sec: 118, bpm: 117 }] }),
    ).toEqual({ atStopBpm: 150, bpm: 117, dropBpm: 33 });
  });
  it('needs both readings', () => {
    expect(twoMinuteDrop({ after: [{ sec: 120, bpm: 117 }] })).toBeUndefined();
    expect(
      twoMinuteDrop({ atStopBpm: 150, after: [{ sec: 60, bpm: 130 }] }),
    ).toBeUndefined();
    expect(twoMinuteDrop(undefined)).toBeUndefined();
  });
});
