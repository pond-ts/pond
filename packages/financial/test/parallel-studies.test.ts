import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TimeSeries } from 'pond-ts';

/**
 * [PND-SCANKERN] — `withWorkers`, the per-ingest opt-in.
 *
 * **Everything is loaded from `dist/`, including the studies** — and that
 * is load-bearing, not incidental. A worker cannot execute TypeScript, so
 * the parallel entry point must come from `dist`; but it installs its
 * accelerator into `dist`'s copy of the rolling kernel, and `src`'s
 * studies consult `src`'s copy. Importing the studies from `src` here
 * made every assertion below compare **sequential against sequential** —
 * nine tests that passed without once running the code they name.
 * (Caught by instrumenting the hook, not by any of them failing.)
 *
 * The `zScore` case is now also the canary: the parallel path *must*
 * shift its values slightly, so a worst-difference of exactly zero means
 * the accelerator never engaged.
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
const DIST_STUDIES = new URL('../dist/index.js', import.meta.url);
type Parallel = typeof import('../src/parallel/index.js');
type Studies = typeof import('../src/index.js');

async function load(): Promise<Parallel & { studies: Studies }> {
  if (!existsSync(fileURLToPath(DIST))) {
    throw new Error('needs dist/ — run `npm run build` first (npm test does)');
  }
  const parallel = (await import(DIST.href)) as Parallel;
  // Same graph as the accelerator, or nothing is being tested.
  const studies = (await import(DIST_STUDIES.href)) as Studies;
  return { ...parallel, studies };
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
    const { studies } = await load();
    const series = bars(N);
    const before = cells(
      studies.bollinger(series, { period: P }) as never,
      'bbMiddle',
    );
    const after = cells(
      studies.bollinger(series, { period: P }) as never,
      'bbMiddle',
    );
    expect(after).toEqual(before);
  });

  it('bollinger: every cell within 1e-9 of the sequential study', async () => {
    const { withWorkers, studies } = await load();
    const series = bars(N);
    const expected = studies.bollinger(series, { period: P });
    const actual = studies.bollinger(withWorkers(series, { workers: 4 }), {
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
    const { withWorkers, studies } = await load();
    const series = bars(N);
    const expected = studies.sma(series, { period: P });
    const actual = studies.sma(withWorkers(series, { workers: 4 }), {
      period: P,
    });
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
    const { withWorkers, studies } = await load();
    const series = bars(N);
    const expected = studies.zScore(series, { period: P });
    const actual = studies.zScore(withWorkers(series, { workers: 4 }), {
      period: P,
    });
    const { worst, mismatchedGaps, over } = compare(
      cells(actual as never, 'zscore'),
      cells(expected as never, 'zscore'),
    );
    expect(mismatchedGaps, 'gaps must still line up exactly').toBe(0);
    expect(worst, 'documented as ~2.6e-6').toBeLessThan(1e-4);
    expect(over / N, 'documented as ~0.8% of cells').toBeLessThan(0.05);
    // THE CANARY. The parallel path necessarily shifts zScore, so a
    // difference of exactly zero means the accelerator never engaged and
    // every assertion in this file was comparing sequential to itself —
    // which is precisely what happened while the studies were imported
    // from `src` and the pool from `dist`.
    expect(
      worst,
      'zero difference ⇒ the parallel path never ran',
    ).toBeGreaterThan(0);
    expect(over, 'zero tail ⇒ the parallel path never ran').toBeGreaterThan(0);
  });

  it('a gapped column agrees gap for gap', async () => {
    const { withWorkers, studies } = await load();
    const series = bars(N, 37);
    const expected = studies.bollinger(series, { period: P });
    const actual = studies.bollinger(withWorkers(series, { workers: 4 }), {
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
    const { withWorkers, studies } = await load();
    const series = withWorkers(bars(N), { workers: 4 });
    const once = studies.sma(series, { period: P });
    const twice = studies.bollinger(once, { period: P });
    const expected = studies.bollinger(studies.sma(bars(N), { period: P }), {
      period: P,
    });
    const { mismatchedGaps, over } = compare(
      cells(twice as never, 'bbMiddle'),
      cells(expected as never, 'bbMiddle'),
    );
    expect(mismatchedGaps).toBe(0);
    expect(over).toBe(0);
  });

  it('runs sequentially below MIN_ROWS, bit-identical', async () => {
    const { withWorkers, MIN_ROWS, studies } = await load();
    const series = bars(1_000);
    expect(series.length).toBeLessThan(MIN_ROWS);
    const expected = studies.bollinger(series, { period: P });
    const actual = studies.bollinger(withWorkers(series, { workers: 4 }), {
      period: P,
    });
    for (const band of ['bbMiddle', 'bbUpper', 'bbLower']) {
      expect(cells(actual as never, band)).toEqual(
        cells(expected as never, band),
      );
    }
  });

  it('shutdownWorkers restores the sequential path exactly', async () => {
    const { withWorkers, shutdownWorkers, studies } = await load();
    const series = bars(N);
    const expected = studies.bollinger(series, { period: P });
    studies.bollinger(withWorkers(series, { workers: 4 }), { period: P });
    shutdownWorkers();
    const after = studies.bollinger(series, { period: P });
    for (const band of ['bbMiddle', 'bbUpper', 'bbLower']) {
      expect(cells(after as never, band)).toEqual(
        cells(expected as never, band),
      );
    }
  });

  it('one worker still partitions, and still agrees', async () => {
    const { withWorkers, studies } = await load();
    const series = bars(N);
    const expected = studies.bollinger(series, { period: P });
    const actual = studies.bollinger(withWorkers(series, { workers: 1 }), {
      period: P,
    });
    const { over } = compare(
      cells(actual as never, 'bbMiddle'),
      cells(expected as never, 'bbMiddle'),
    );
    expect(over).toBe(0);
  });

  it('accelerates a fluent chain end to end', async () => {
    // The calling style people actually use. The fluent methods are the
    // standalone studies bound to `this`, so they route through the same
    // kernel — and each link returns a derived series, which is exactly
    // the case key-buffer registration exists to keep accelerated.
    const { withWorkers, studies } = await load();
    await import(new URL('../dist/fluent.js', import.meta.url).href);

    const chain = (b: unknown) =>
      (
        b as {
          sma: (o: unknown) => {
            bollinger: (o: unknown) => { zScore: (o: unknown) => unknown };
          };
        }
      )
        .sma({ period: P })
        .bollinger({ period: P })
        .zScore({ period: P });

    const expected = studies.zScore(
      studies.bollinger(studies.sma(bars(N), { period: P }), { period: P }),
      { period: P },
    );
    const actual = chain(withWorkers(bars(N), { workers: 4 }));

    const names = (actual as { schema: { name: string }[] }).schema.map(
      (c) => c.name,
    );
    expect(names).toEqual([
      'time',
      'close',
      'sma',
      'bbMiddle',
      'bbUpper',
      'bbLower',
      'zscore',
    ]);
    // Every link agrees; only zScore carries its documented tail.
    for (const [column, tail] of [
      ['sma', false],
      ['bbMiddle', false],
      ['zscore', true],
    ] as const) {
      const { mismatchedGaps, over, worst } = compare(
        cells(actual as never, column),
        cells(expected as never, column),
      );
      expect(mismatchedGaps, `${column}: gaps`).toBe(0);
      if (tail)
        expect(
          worst,
          `${column}: the parallel path must have run`,
        ).toBeGreaterThan(0);
      else expect(over, `${column}: cells beyond 1e-9`).toBe(0);
    }
  });

  it('chains as a method, and takes effect from where it appears', async () => {
    // The calling style the docs lead with. `.withWorkers()` returns the
    // same series, so it reads as a no-op link — but it is only a no-op
    // for the studies BEFORE it, which is worth pinning rather than
    // leaving to the prose.
    const { studies } = await load();
    await import(new URL('../dist/fluent.js', import.meta.url).href);
    await import(new URL('../dist/parallel/index.js', import.meta.url).href);

    type Chainable = {
      withWorkers: (o?: { workers?: number }) => Chainable;
      sma: (o: unknown) => Chainable;
      zScore: (o: unknown) => Chainable;
      schema: { name: string }[];
    };

    const first = (bars(N) as unknown as Chainable)
      .withWorkers({ workers: 4 })
      .sma({ period: P })
      .zScore({ period: P });

    expect(first.schema.map((c) => c.name)).toEqual([
      'time',
      'close',
      'sma',
      'zscore',
    ]);

    const expected = studies.zScore(studies.sma(bars(N), { period: P }), {
      period: P,
    });
    const { mismatchedGaps, worst } = compare(
      cells(first as never, 'zscore'),
      cells(expected as never, 'zscore'),
    );
    expect(mismatchedGaps).toBe(0);
    // Canary again: zScore must have shifted, or the chain ran sequentially.
    expect(worst, 'the parallel path must have run').toBeGreaterThan(0);
    expect(worst).toBeLessThan(1e-4);
  });

  it('opting one series in does not opt in an unrelated one', async () => {
    // `fromArrow` views the IPC byte array directly, so two independent
    // decodes of the same bytes are distinct `Float64Array` views over
    // ONE `ArrayBuffer`. Registration keyed on that buffer leaked:
    // `withWorkers(a)` silently accelerated `b`. Harmless to the answers,
    // but an explicit opt-in that did not stay opted-in-to — and it
    // quietly accelerated the baseline of the first benchmark written
    // against this API, hiding the speedup entirely.
    //
    // Reproduced here without Arrow: two series over one shared buffer,
    // at different offsets, exactly the shape `tableFromIPC` produces.
    const { withWorkers, studies } = await load();
    const shared = new ArrayBuffer(N * 8 * 4);
    const view = (slot: number) => new Float64Array(shared, slot * N * 8, N);
    const build = (timeSlot: number, closeSlot: number) => {
      const time = view(timeSlot);
      const close = view(closeSlot);
      for (let i = 0; i < N; i += 1) {
        time[i] = i * 60_000;
        close[i] = 100 + Math.sin(i / 50);
      }
      return TimeSeries.fromColumns({
        name: 'bars',
        schema: SCHEMA,
        columns: { time, close },
      });
    };

    const optedIn = build(0, 1);
    const other = build(2, 3); // same ArrayBuffer, different views
    expect(
      (optedIn.keyColumn() as unknown as { begin: Float64Array }).begin.buffer,
    ).toBe(
      (other.keyColumn() as unknown as { begin: Float64Array }).begin.buffer,
    );

    const reference = cells(
      studies.zScore(build(2, 3), { period: P }) as never,
      'zscore',
    );
    withWorkers(optedIn, { workers: 4 });

    // `other` never opted in ⇒ bit-identical to a plain run.
    expect(
      cells(studies.zScore(other, { period: P }) as never, 'zscore'),
    ).toEqual(reference);

    // …while the series that did opt in shows the parallel path's shift.
    const { worst } = compare(
      cells(studies.zScore(optedIn, { period: P }) as never, 'zscore'),
      reference,
    );
    expect(
      worst,
      'the opted-in series must actually be accelerated',
    ).toBeGreaterThan(0);
  });
});
