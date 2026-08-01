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
 * That canary used to be `zScore`: the parallel path shifted its values,
 * so a worst-difference of exactly zero proved the accelerator had never
 * engaged. [PND-SHIFTFRAME] removed the shift — `zScore` no longer goes
 * through the rolling kernel at all — and with it a canary that only
 * worked because the accelerated answer was worse. `parallelDispatches()`
 * replaced it: an explicit count of passes that ran on workers, which
 * does not depend on acceleration being detectably wrong.
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
    const { withWorkers, studies, parallelDispatches } = await load();
    const series = bars(N);
    const before = parallelDispatches();
    const expected = studies.zScore(series, { period: P });
    const actual = studies.zScore(withWorkers(series, { workers: 4 }), {
      period: P,
    });
    const { worst, mismatchedGaps, over } = compare(
      cells(actual as never, 'zscore'),
      cells(expected as never, 'zscore'),
    );
    expect(mismatchedGaps, 'gaps must still line up exactly').toBe(0);
    // BIT-IDENTICAL, where this once had a documented 2.6e-6 tail across
    // ~0.8% of cells. Not because the pool got more accurate: because
    // [PND-SHIFTFRAME] moved `zScore` off `rollingColumns` onto
    // `rollingDeviationSd`, and the accelerator only hooks the former.
    // The study opted itself out of parallelism by being fixed.
    expect(worst, 'zScore no longer has a parallel tail').toBe(0);
    expect(over, 'and therefore no cells over tolerance').toBe(0);
    // Which is asserted directly rather than inferred from the zero
    // above — zero difference is exactly what a silently-broken harness
    // produces too, and that is the bug this file already shipped once.
    expect(
      parallelDispatches(),
      'zScore must not dispatch to workers at all',
    ).toBe(before);
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
    const { withWorkers, studies, parallelDispatches } = await load();
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
    const before = parallelDispatches();
    const actual = chain(withWorkers(bars(N), { workers: 4 }));
    // `sma` is one pass and `bollinger` another; `zScore` is none, since
    // it no longer routes through the rolling kernel.
    expect(
      parallelDispatches() - before,
      'the chain must have dispatched to workers',
    ).toBe(2);

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
    // Every link agrees, `zscore` now included — the accelerated links
    // stay within rounding error and the unaccelerated one is exact.
    for (const column of ['sma', 'bbMiddle', 'zscore'] as const) {
      const { mismatchedGaps, over } = compare(
        cells(actual as never, column),
        cells(expected as never, column),
      );
      expect(mismatchedGaps, `${column}: gaps`).toBe(0);
      expect(over, `${column}: cells beyond 1e-9`).toBe(0);
    }
  });

  it('chains as a method, and takes effect from where it appears', async () => {
    // The calling style the docs lead with. `.withWorkers()` returns the
    // same series, so it reads as a no-op link — but it is only a no-op
    // for the studies BEFORE it, which is worth pinning rather than
    // leaving to the prose.
    const { studies, parallelDispatches } = await load();
    await import(new URL('../dist/fluent.js', import.meta.url).href);
    await import(new URL('../dist/parallel/index.js', import.meta.url).href);

    type Chainable = {
      withWorkers: (o?: { workers?: number }) => Chainable;
      sma: (o: unknown) => Chainable;
      zScore: (o: unknown) => Chainable;
      schema: { name: string }[];
    };

    const before = parallelDispatches();
    const first = (bars(N) as unknown as Chainable)
      .withWorkers({ workers: 4 })
      .sma({ period: P })
      .zScore({ period: P });
    // `sma` sits after the opt-in, so it dispatches; `zScore` never does.
    expect(
      parallelDispatches() - before,
      'the studies after .withWorkers() must have run on workers',
    ).toBe(1);

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
    const { withWorkers, studies, parallelDispatches } = await load();
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

    // `sma`, because it is a study the pool actually accelerates —
    // `zScore` would dispatch for neither series and prove nothing.
    const reference = cells(
      studies.sma(build(2, 3), { period: P }) as never,
      'sma',
    );
    withWorkers(optedIn, { workers: 4 });

    // `other` never opted in ⇒ no dispatch, and bit-identical output.
    const beforeOther = parallelDispatches();
    expect(cells(studies.sma(other, { period: P }) as never, 'sma')).toEqual(
      reference,
    );
    expect(
      parallelDispatches(),
      'the series that did not opt in must not dispatch',
    ).toBe(beforeOther);

    // …while the one that did opt in runs on workers. Asserted on the
    // dispatch count rather than on a numerical difference: `sma` is
    // bounded, so it may well come back bit-identical, and "identical"
    // must not be the same evidence as "never ran".
    const beforeIn = parallelDispatches();
    studies.sma(optedIn, { period: P });
    expect(
      parallelDispatches() - beforeIn,
      'the opted-in series must actually be accelerated',
    ).toBe(1);
  });

  it('zScore is NOT bounded on near-flat windows — the documented caveat', async () => {
    // Supplied by a Codex adversarial pass, and it invalidated the bound
    // this feature was originally documented with. A legal near-flat
    // series at large magnitude leaves the rolling sigma with almost no
    // significant digits, so a last-ulp difference between the
    // sequential and partitioned sweeps becomes an arbitrarily large
    // relative difference in `(v - mean) / sigma`.
    //
    // Asserted as a LOWER bound: this must stay visibly bad, because the
    // documentation now promises only that `sma`/`envelope`/`bollinger`
    // shift by rounding error — and warns that `zScore` does not.
    const { rollingMeanSd } = (await import(
      new URL('../dist/parallel/kernel.js', import.meta.url).href
    )) as typeof import('../src/parallel/kernel.js');

    const n = 200_000;
    const period = 20;
    const chunks = 4;
    const v = new Float64Array(n);
    for (let i = 0; i < n; i += 1) v[i] = 1e15 + ((i % 7) - 3);

    const seqM = new Float64Array(n);
    const seqS = new Float64Array(n);
    rollingMeanSd(v, period, 0, n, seqM, seqS);

    const parM = new Float64Array(n);
    const parS = new Float64Array(n);
    const step = Math.ceil(n / chunks);
    for (let c = 0; c < chunks; c += 1) {
      rollingMeanSd(
        v,
        period,
        c * step,
        Math.min(n, (c + 1) * step),
        parM,
        parS,
      );
    }

    let worst = 0;
    for (let i = period; i < n; i += 1) {
      const a = seqS[i] === 0 ? NaN : (v[i]! - seqM[i]!) / seqS[i]!;
      const b = parS[i] === 0 ? NaN : (v[i]! - parM[i]!) / parS[i]!;
      if (Number.isNaN(a) && Number.isNaN(b)) continue;
      const d = Math.abs((b - a) / (Math.abs(a) || 1));
      if (d > worst) worst = d;
    }
    // Measured at ~0.38. If this ever drops to rounding-error scale the
    // documentation has become too pessimistic and should be revisited —
    // which is a better failure than the reverse.
    expect(worst, 'zScore must remain visibly unbounded here').toBeGreaterThan(
      0.01,
    );
  });
});
