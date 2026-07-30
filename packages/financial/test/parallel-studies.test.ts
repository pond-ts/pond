import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TimeSeries } from 'pond-ts';
import { bollinger, sma, zScore } from '../src/index.js';

/**
 * [PND-SCANKERN] — `withWorkers`, the per-ingest opt-in.
 *
 * **Loaded from `dist/`**: a worker is a real Node thread and cannot
 * execute TypeScript, so the entry point resolves its worker relative to
 * its own built module. `npm test` builds first via `test:type`.
 *
 * Two questions decide whether this is shippable, and both are here:
 *
 * 1. **Does opting in change the answer more than documented?** Every
 *    assertion compares against the sequential study, per study, at the
 *    tolerance that study's docs claim — not a blanket one. `zScore` is
 *    allowed its 5.3e-6 tail and `bollinger` is not.
 * 2. **Does *not* opting in change anything at all?** The default has to
 *    be untouched, so that is asserted directly rather than assumed.
 */

const DIST = new URL('../dist/parallel/index.js', import.meta.url);
type Parallel = typeof import('../src/parallel/index.js');

async function load(): Promise<Parallel> {
  if (!existsSync(fileURLToPath(DIST))) {
    throw new Error('needs dist/ — run `npm run build` first (npm test does)');
  }
  return (await import(DIST.href)) as Parallel;
}

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
] as const;

function bars(n: number, gapEvery = 0) {
  const time = new Float64Array(n);
  const close = new Array<number | null>(n);
  let price = 100;
  let seed = 0x5eed;
  for (let i = 0; i < n; i += 1) {
    seed = (seed + 0x6d2b79f5) >>> 0;
    const r = ((seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    price = Math.max(1, price + (r - 0.5) * 0.4);
    time[i] = i * 60_000;
    close[i] = gapEvery > 0 && i % gapEvery === 0 ? null : price;
  }
  return TimeSeries.fromColumns({
    name: 'bars',
    schema: SCHEMA,
    columns: { time, close },
  });
}

type Cells = (number | undefined)[];
const cells = (
  s: { length: number; column: (n: never) => unknown },
  name: string,
): Cells => {
  const col = s.column(name as never) as { at(i: number): number | undefined };
  return Array.from({ length: s.length }, (_, i) => col.at(i));
};

function compare(a: Cells, b: Cells) {
  let worst = 0;
  let mismatchedGaps = 0;
  let over = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    // A gap on one side only is a correctness bug, never a rounding
    // difference — counted apart so no tolerance can absorb it.
    if ((x === undefined) !== (y === undefined)) {
      mismatchedGaps += 1;
      continue;
    }
    if (x === undefined || y === undefined) continue;
    const rel = Math.abs(x - y) / Math.max(1e-300, Math.abs(y));
    if (rel > worst) worst = rel;
    if (rel > 1e-9) over += 1;
  }
  return { worst, mismatchedGaps, over };
}

const N = 200_000;
const P = 20;

describe('[PND-SCANKERN] withWorkers', () => {
  afterEach(async () => {
    const { shutdownWorkers } = await load();
    shutdownWorkers();
  });

  it('leaves studies untouched when nobody opts in', async () => {
    // The default. Importing the entry point must not change a thing —
    // only calling `withWorkers` may.
    await load();
    const series = bars(N);
    const before = cells(bollinger(series, { period: P }) as never, 'bbMiddle');
    const after = cells(bollinger(series, { period: P }) as never, 'bbMiddle');
    expect(after).toEqual(before);
  });

  it('bollinger: every cell within 1e-9 of the sequential study', async () => {
    const { withWorkers } = await load();
    const series = bars(N);
    const expected = bollinger(series, { period: P });
    const actual = bollinger(withWorkers(series, { workers: 4 }), {
      period: P,
    });
    for (const band of ['bbMiddle', 'bbUpper', 'bbLower']) {
      const { worst, mismatchedGaps, over } = compare(
        cells(actual as never, band),
        cells(expected as never, band),
      );
      expect(mismatchedGaps, `${band}: gaps`).toBe(0);
      expect(over, `${band}: cells beyond 1e-9`).toBe(0);
      expect(worst).toBeLessThan(1e-9);
    }
  });

  it('sma: every cell within 1e-9', async () => {
    const { withWorkers } = await load();
    const series = bars(N);
    const expected = sma(series, { period: P });
    const actual = sma(withWorkers(series, { workers: 4 }), { period: P });
    const { mismatchedGaps, over } = compare(
      cells(actual as never, 'sma'),
      cells(expected as never, 'sma'),
    );
    expect(mismatchedGaps).toBe(0);
    expect(over).toBe(0);
  });

  it('zScore: agrees except for the documented amplified tail', async () => {
    // The study this opt-in is documented as risky for. It divides by a
    // near-zero rolling sigma, so last-ulp differences amplify. Pinned
    // at the documented bound, and the tail is asserted to be a small
    // FRACTION rather than merely "some cells" — if it grew, the
    // documentation would be wrong.
    const { withWorkers } = await load();
    const series = bars(N);
    const expected = zScore(series, { period: P });
    const actual = zScore(withWorkers(series, { workers: 4 }), { period: P });
    const { worst, mismatchedGaps, over } = compare(
      cells(actual as never, 'zscore'),
      cells(expected as never, 'zscore'),
    );
    expect(mismatchedGaps, 'gaps must still line up exactly').toBe(0);
    expect(worst, 'documented as ~5e-6').toBeLessThan(1e-4);
    expect(over / N, 'documented as ~1% of cells').toBeLessThan(0.05);
  });

  it('a gapped column agrees gap for gap', async () => {
    const { withWorkers } = await load();
    const series = bars(N, 37);
    const expected = bollinger(series, { period: P });
    const actual = bollinger(withWorkers(series, { workers: 4 }), {
      period: P,
    });
    for (const band of ['bbMiddle', 'bbUpper', 'bbLower']) {
      const { mismatchedGaps, over } = compare(
        cells(actual as never, band),
        cells(expected as never, band),
      );
      expect(mismatchedGaps, `${band}: gap placement`).toBe(0);
      expect(over, `${band}: beyond 1e-9`).toBe(0);
    }
  });

  it('derived series stay accelerated, so chains do not silently fall back', async () => {
    // Registration is keyed on the key buffer precisely so this holds.
    // If it regressed, the second study would quietly run sequentially —
    // correct, but not what the caller asked for.
    const { withWorkers } = await load();
    const series = withWorkers(bars(N), { workers: 4 });
    const once = sma(series, { period: P });
    const twice = bollinger(once, { period: P });
    const expected = bollinger(sma(bars(N), { period: P }), { period: P });
    const { mismatchedGaps, over } = compare(
      cells(twice as never, 'bbMiddle'),
      cells(expected as never, 'bbMiddle'),
    );
    expect(mismatchedGaps).toBe(0);
    expect(over).toBe(0);
  });

  it('runs sequentially below MIN_ROWS, bit-identical', async () => {
    const { withWorkers, MIN_ROWS } = await load();
    const series = bars(1_000);
    expect(series.length).toBeLessThan(MIN_ROWS);
    const expected = bollinger(series, { period: P });
    const actual = bollinger(withWorkers(series, { workers: 4 }), {
      period: P,
    });
    for (const band of ['bbMiddle', 'bbUpper', 'bbLower']) {
      expect(cells(actual as never, band)).toEqual(
        cells(expected as never, band),
      );
    }
  });

  it('shutdownWorkers restores the sequential path exactly', async () => {
    const { withWorkers, shutdownWorkers } = await load();
    const series = bars(N);
    const expected = bollinger(series, { period: P });
    bollinger(withWorkers(series, { workers: 4 }), { period: P });
    shutdownWorkers();
    const after = bollinger(series, { period: P });
    for (const band of ['bbMiddle', 'bbUpper', 'bbLower']) {
      expect(cells(after as never, band)).toEqual(
        cells(expected as never, band),
      );
    }
  });

  it('one worker still partitions, and still agrees', async () => {
    const { withWorkers } = await load();
    const series = bars(N);
    const expected = bollinger(series, { period: P });
    const actual = bollinger(withWorkers(series, { workers: 1 }), {
      period: P,
    });
    const { over } = compare(
      cells(actual as never, 'bbMiddle'),
      cells(expected as never, 'bbMiddle'),
    );
    expect(over).toBe(0);
  });
});
