import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TimeSeries } from 'pond-ts';
import { bollinger } from '../src/index.js';
import type { StudyPool as StudyPoolType } from '../src/parallel/index.js';

/**
 * [PND-SCANKERN] — `bollinger` partitioned across worker threads.
 *
 * **Loaded from `dist/`**: a worker is a real Node thread and cannot
 * execute TypeScript, so the pool resolves its worker entry relative to
 * its own built module. (It says so with a named error rather than
 * hanging; pinned below.) `npm test` builds first via `test:type` →
 * `build`.
 *
 * The whole question this file answers is **does the parallel study
 * agree with the sequential one**. It is not enough for the numbers to
 * look plausible: the sequential study is oracle-pinned against pandas,
 * so the parallel one has to track it closely enough that the oracle
 * would still hold. The tolerance asserted here (1e-9 relative, and no
 * cell worse) is the one measured in `spikes/parallel-rolling/`, not a
 * number chosen to make the test pass.
 */

const DIST = new URL('../dist/parallel/index.js', import.meta.url);

async function loadPool(): Promise<typeof StudyPoolType> {
  const m = (await import(DIST.href)) as { StudyPool: typeof StudyPoolType };
  return m.StudyPool;
}

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
] as const;

/** A random walk — flat stretches and all — sized to clear MIN_ROWS. */
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
function cells(
  series: { length: number; column: (n: never) => unknown },
  name: string,
): Cells {
  const col = series.column(name as never) as {
    at(i: number): number | undefined;
  };
  return Array.from({ length: series.length }, (_, i) => col.at(i));
}

/** Worst relative difference, and how many cells exceed a threshold. */
function compare(a: Cells, b: Cells, threshold: number) {
  let worst = 0;
  let over = 0;
  let mismatchedGaps = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    // A gap on one side and a value on the other is a correctness bug,
    // not a rounding difference — counted separately so a tolerance can
    // never absorb it.
    if ((x === undefined) !== (y === undefined)) {
      mismatchedGaps += 1;
      continue;
    }
    if (x === undefined || y === undefined) continue;
    const rel = Math.abs(x - y) / Math.max(1e-300, Math.abs(y));
    if (rel > worst) worst = rel;
    if (rel > threshold) over += 1;
  }
  return { worst, over, mismatchedGaps };
}

const N = 200_000;
const PERIOD = 20;
const BANDS = ['bbMiddle', 'bbUpper', 'bbLower'] as const;

describe('[PND-SCANKERN] parallel bollinger', () => {
  let StudyPool: typeof StudyPoolType;
  let pool: StudyPoolType;

  beforeAll(async () => {
    if (!existsSync(fileURLToPath(DIST))) {
      throw new Error(
        'needs dist/ — run `npm run build` first (npm test does)',
      );
    }
    StudyPool = await loadPool();
    pool = await StudyPool.start({ size: 4 });
  });

  afterAll(async () => {
    await pool?.close();
  });

  it('tracks the sequential study within 1e-9 on every cell', async () => {
    const series = bars(N);
    const expected = bollinger(series, { period: PERIOD });
    const actual = await pool.bollinger(series, { period: PERIOD });

    for (const band of BANDS) {
      const { worst, over, mismatchedGaps } = compare(
        cells(actual as never, band),
        cells(expected as never, band),
        1e-9,
      );
      expect(mismatchedGaps, `${band}: gaps must line up exactly`).toBe(0);
      expect(over, `${band}: cells beyond 1e-9 relative`).toBe(0);
      expect(worst).toBeLessThan(1e-9);
    }
  });

  it('places the warm-up head exactly where the sequential study does', async () => {
    const series = bars(N);
    const expected = cells(
      bollinger(series, { period: PERIOD }) as never,
      'bbMiddle',
    );
    const actual = cells(
      (await pool.bollinger(series, { period: PERIOD })) as never,
      'bbMiddle',
    );
    // First PERIOD-1 rows are warm-up on both sides, and nothing after.
    for (let i = 0; i < PERIOD - 1; i += 1) expect(actual[i]).toBeUndefined();
    expect(actual[PERIOD - 1]).toBeTypeOf('number');
    expect(actual.findIndex((v) => v !== undefined)).toBe(
      expected.findIndex((v) => v !== undefined),
    );
  });

  it('agrees on a gapped column, gap for gap', async () => {
    // Missing cells arrive NaN-as-missing, and a window short of
    // `minSamples` contributors must emit missing — the case where a
    // chunk boundary landing inside a gap run could diverge.
    const series = bars(N, 37);
    const expected = bollinger(series, { period: PERIOD });
    const actual = await pool.bollinger(series, { period: PERIOD });
    for (const band of BANDS) {
      const { over, mismatchedGaps } = compare(
        cells(actual as never, band),
        cells(expected as never, band),
        1e-9,
      );
      expect(mismatchedGaps, `${band}: gap placement`).toBe(0);
      expect(over, `${band}: cells beyond 1e-9`).toBe(0);
    }
  });

  it('honours stdDev and prefix like the sequential study', async () => {
    const series = bars(N);
    const expected = bollinger(series, {
      period: PERIOD,
      stdDev: 1.5,
      prefix: 'band',
    });
    const actual = await pool.bollinger(series, {
      period: PERIOD,
      stdDev: 1.5,
      prefix: 'band',
    });
    expect(actual.schema.map((c) => c.name)).toEqual(
      expected.schema.map((c) => c.name),
    );
    const { over } = compare(
      cells(actual as never, 'bandUpper'),
      cells(expected as never, 'bandUpper'),
      1e-9,
    );
    expect(over).toBe(0);
  });

  it('falls back below MIN_ROWS, and is then bit-identical', async () => {
    // Dispatch costs more than the work at this size, so the pool runs
    // the ordinary study — which means the answer must match exactly,
    // not approximately.
    const series = bars(1_000);
    expect(series.length).toBeLessThan(StudyPool.MIN_ROWS);
    const expected = bollinger(series, { period: PERIOD });
    const actual = await pool.bollinger(series, { period: PERIOD });
    for (const band of BANDS) {
      expect(cells(actual as never, band)).toEqual(
        cells(expected as never, band),
      );
    }
  });

  it('rejects a bad period and a bad stdDev, like the study', async () => {
    const series = bars(1_000);
    await expect(pool.bollinger(series, { period: 0 })).rejects.toThrow();
    await expect(
      pool.bollinger(series, { period: PERIOD, stdDev: 0 }),
    ).rejects.toThrow(/stdDev/);
  });

  it('rejects work after close', async () => {
    const doomed = await StudyPool.start({ size: 1 });
    await doomed.close();
    await expect(
      doomed.bollinger(bars(1_000), { period: PERIOD }),
    ).rejects.toThrow(/closed/);
  });
});

describe('[PND-SCANKERN] loaded from source', () => {
  it('names the problem instead of hanging', async () => {
    const { StudyPool: FromSource } = await import('../src/parallel/index.js');
    await expect(FromSource.start({ size: 1 })).rejects.toThrow(
      /worker entry not found/,
    );
  });
});
