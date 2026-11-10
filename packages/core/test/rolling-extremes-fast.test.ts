/**
 * The rolling sweep's own `max` / `min` deque (`sweepRollingColumn`) against
 * the reducer state it replaced (`rollingMonotoneDeque`, still what the
 * generic sweep runs).
 *
 * Appending a custom-function column sends the whole call down the generic
 * sweep, so the same mapping run with and without it compares the two
 * deques cell for cell. `Object.is`, not `toEqual`: on a window holding both
 * `0` and `-0` the two deques must keep the same one.
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
] as const;

const customCount = {
  from: 'v',
  using: (vals: ReadonlyArray<number | undefined>) => vals.length,
} as const;

const mapping = {
  hi: { from: 'v', using: 'max' },
  lo: { from: 'v', using: 'min' },
} as const;

let seed = 0x2545f491;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

/** Small values so windows are full of ties; signed zeros, gaps, ±Infinity. */
function cell(shape: number, i: number, n: number): number | undefined {
  switch (shape) {
    case 0:
      return Math.floor(rnd() * 4);
    case 1:
      return rnd() < 0.5 ? 0 : -0;
    case 2:
      return rnd() < 0.3 ? undefined : Math.floor(rnd() * 5) - 2;
    case 3:
      return i; // rising: every add pops nothing (max) / everything (min)
    case 4:
      return n - i; // falling
    default: {
      const r = rnd();
      return r < 0.1
        ? Infinity
        : r < 0.2
          ? -Infinity
          : r < 0.3
            ? undefined
            : rnd() * 10 - 5;
    }
  }
}

function build(shape: number, n: number, sameKeys: boolean) {
  const time = new Float64Array(n);
  const v = new Float64Array(n);
  let t = 0;
  for (let i = 0; i < n; i += 1) {
    // Repeated keys exercise a duration window's shared-window rows.
    if (!sameKeys || rnd() < 0.7) t += 1_000;
    time[i] = t;
    // A typed column reads NaN and ±Infinity as missing ([PND-NANREP]).
    v[i] = cell(shape, i, n) ?? NaN;
  }
  return TimeSeries.fromColumns({
    name: 'v',
    schema,
    columns: { time, v },
  });
}

function column(series: TimeSeries<never>, name: string): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < series.length; i += 1) {
    out.push(series.at(i)!.get(name as never));
  }
  return out;
}

function expectSame(fast: unknown[], generic: unknown[], label: string) {
  expect(fast.length, label).toBe(generic.length);
  for (let i = 0; i < fast.length; i += 1) {
    if (!Object.is(fast[i], generic[i])) {
      expect.fail(`${label} row ${i}: ${fast[i]} vs ${generic[i]}`);
    }
  }
}

describe('rolling max / min sweep deque matches the reducer state', () => {
  const alignments = ['trailing', 'leading', 'centered'] as const;

  it('count windows: every shape, alignment, size and minSamples', () => {
    let compared = 0;
    for (let shape = 0; shape < 6; shape += 1) {
      for (const alignment of alignments) {
        for (const count of [1, 2, 3, 5, 8, 40]) {
          const s = build(shape, 37, false);
          for (const minSamples of [0, count]) {
            const fast = s.rolling({ count }, mapping, {
              alignment,
              minSamples,
            });
            const generic = s.rolling(
              { count },
              { ...mapping, n: customCount },
              { alignment, minSamples },
            );
            for (const name of ['hi', 'lo']) {
              expectSame(
                column(fast as never, name),
                column(generic as never, name),
                `shape ${shape} ${alignment} count ${count} min ${minSamples} ${name}`,
              );
              compared += 1;
            }
          }
        }
      }
    }
    expect(compared).toBe(6 * 3 * 6 * 2 * 2);
  });

  it('duration windows, with repeated keys: every shape and alignment', () => {
    for (let shape = 0; shape < 6; shape += 1) {
      for (const alignment of alignments) {
        for (const window of ['1s', '3s', '7s'] as const) {
          const s = build(shape, 41, true);
          const fast = s.rolling(window, mapping, { alignment });
          const generic = s.rolling(
            window,
            { ...mapping, n: customCount },
            { alignment },
          );
          for (const name of ['hi', 'lo']) {
            expectSame(
              column(fast as never, name),
              column(generic as never, name),
              `shape ${shape} ${alignment} ${window} ${name}`,
            );
          }
        }
      }
    }
  });

  it("huge values (the sums' overflow lanes) take the same deque, same answers", () => {
    const n = 30;
    const time = new Float64Array(n);
    const v = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      time[i] = i * 1_000;
      v[i] = i % 7 === 0 ? NaN : (rnd() - 0.5) * 1e300;
    }
    const s = TimeSeries.fromColumns({
      name: 'v',
      schema,
      columns: { time, v },
    });
    for (const window of [{ count: 4 }, '4s'] as const) {
      const fast = s.rolling(window as never, mapping);
      const generic = s.rolling(window as never, {
        ...mapping,
        n: customCount,
      });
      for (const name of ['hi', 'lo']) {
        expectSame(
          column(fast as never, name),
          column(generic as never, name),
          `huge ${JSON.stringify(window)} ${name}`,
        );
      }
    }
  });

  it('a window of only missing cells is missing, then recovers', () => {
    const s = new TimeSeries({
      name: 'v',
      schema,
      rows: [
        [0, 3],
        [1_000, undefined],
        [2_000, undefined],
        [3_000, 1],
      ],
    });
    const r = s.rolling({ count: 2 }, mapping);
    expect(column(r as never, 'hi')).toEqual([3, 3, undefined, 1]);
    expect(column(r as never, 'lo')).toEqual([3, 3, undefined, 1]);
  });
});
