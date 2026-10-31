import { describe, expect, it } from 'vitest';

import { Sequence, TimeSeries } from '../src/index.js';
import {
  rollingDifferenceDeques,
  rollingDifferenceSorted,
} from '../src/reducers/difference.js';

/* -------------------------------------------------------------------------- */
/* [PND-ROLLDIFF] Rolling `difference` runs on two monotone deques (the ones  */
/* `min` / `max` use) instead of a sorted array, so a row costs the same      */
/* whatever the window size. These tests pin that the answers are what the   */
/* sorted array gave, bit for bit, `-0` included.                             */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
] as const;

type Row = [number, number | undefined];

function series(rows: Row[]) {
  return new TimeSeries({ name: 's', schema: SCHEMA, rows });
}

function values(s: TimeSeries<typeof SCHEMA>) {
  return s.toArray().map((e) => e.get('v'));
}

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

// Pseudo-random rows with zeros of both signs, repeats and gaps.
function randomRows(n: number, seed: number, zerosOnly: boolean): Row[] {
  const rand = rng(seed);
  const pool = [0, -0, 1, -1, 2.5, -2.5, 3, 1e300, -1e300, undefined];
  let t = 0;
  return Array.from({ length: n }, () => {
    t += 1000 * (1 + Math.floor(rand() * 3));
    const v = zerosOnly
      ? [0, -0, undefined][Math.floor(rand() * 3)]
      : pool[Math.floor(rand() * pool.length)];
    return [t, v] as Row;
  });
}

describe('[PND-ROLLDIFF] rolling difference', () => {
  it('gives the sorted-array answer bit for bit under any sliding sweep', () => {
    // Drive the new state and the old one with the same adds and removes
    // (oldest first, as every arrival-order source does) and compare with
    // `Object.is`, so a `-0` against a `0` fails.
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = rng(seed);
      const rows = randomRows(120, seed, seed % 3 === 0);
      const fresh = rollingDifferenceDeques();
      const old = rollingDifferenceSorted();
      let head = 0;
      for (let i = 0; i < rows.length; i += 1) {
        fresh.add(i, rows[i]![1]);
        old.add(i, rows[i]![1]);
        // Shrink the window by a random amount, sometimes to nothing.
        const keep = Math.floor(rand() * 12);
        while (i + 1 - head > keep) {
          fresh.remove(head, rows[head]![1]);
          old.remove(head, rows[head]![1]);
          head += 1;
        }
        expect(Object.is(fresh.snapshot(), old.snapshot())).toBe(true);
      }
    }
  });

  it('stays exact when the deques compact (windows past 1,024 rows)', () => {
    // Rising values keep every row in the smallest-value deque, falling
    // ones in the largest, so both grow past the compaction size.
    for (const sign of [1, -1]) {
      const fresh = rollingDifferenceDeques();
      const old = rollingDifferenceSorted();
      const v = (i: number) => sign * (i + (i % 7) * 0.5);
      let head = 0;
      for (let i = 0; i < 8000; i += 1) {
        fresh.add(i, v(i));
        old.add(i, v(i));
        const keep = i < 5000 ? 3000 : 1500; // shrink part-way through
        while (i + 1 - head > keep) {
          fresh.remove(head, v(head));
          old.remove(head, v(head));
          head += 1;
        }
        expect(fresh.snapshot()).toBe(old.snapshot());
      }
    }
  });

  it('is largest minus smallest on trailing time windows', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rows = randomRows(80, seed, false);
      const got = values(series(rows).rolling(5000, { v: 'difference' }));
      rows.forEach(([t], i) => {
        const present = rows
          .filter(([u, v]) => u > t - 5000 && u <= t && v !== undefined)
          .map(([, v]) => v!);
        const want =
          present.length === 0
            ? undefined
            : Math.max(...present) - Math.min(...present);
        // `==` on purpose: the sign of a zero answer is pinned above.
        expect(got[i] === want || (got[i] === 0 && want === 0)).toBe(true);
      });
    }
  });

  it('is largest minus smallest on count windows, every alignment', () => {
    const rows = randomRows(60, 9, false);
    for (const alignment of ['trailing', 'leading', 'centered'] as const) {
      for (const count of [1, 2, 5, 8]) {
        const got = values(
          series(rows).rolling({ count }, { v: 'difference' }, { alignment }),
        );
        const left =
          alignment === 'trailing'
            ? count - 1
            : alignment === 'leading'
              ? 0
              : Math.floor((count - 1) / 2);
        rows.forEach((_, i) => {
          const present = rows
            .slice(Math.max(0, i - left), Math.max(0, i - left + count))
            .map(([, v]) => v)
            .filter((v): v is number => v !== undefined);
          const want =
            present.length === 0
              ? undefined
              : Math.max(...present) - Math.min(...present);
          expect(got[i]).toEqual(want);
        });
      }
    }
  });

  it('keeps the -0 the sorted array gave for some all-zero windows', () => {
    // The sorted array kept its zeros last in, first out at the front of
    // their run: -0 then +0 enters in front → [+0, -0] → -0 - +0 = -0.
    const r = values(
      series([
        [1000, -0],
        [2000, 0],
        [3000, 5],
      ]).rolling(10_000, { v: 'difference' }),
    );
    expect(Object.is(r[0], 0)).toBe(true);
    expect(Object.is(r[1], -0)).toBe(true);
    expect(r[2]).toBe(5);
  });

  it('is undefined for a window with no values, over a sequence', () => {
    const s = series([
      [0, 4],
      [1000, undefined],
      [10_000, 1],
    ]);
    const r = values(
      s.rolling(Sequence.every(2000), 1500, { v: 'difference' }),
    );
    // Windows (t-1500, t]: only t=0 and t=10s hold a value.
    expect(r).toEqual([0, undefined, undefined, undefined, undefined, 0]);
  });
});
