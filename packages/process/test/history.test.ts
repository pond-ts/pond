import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  int,
  requiredHistory,
  type Input,
  type OpDef,
  type Registry,
  type Spec,
} from '../src/index.js';

/**
 * [PND-PROCHIST] — `requiredHistory(plan)`.
 *
 * The hot leading edge is the design's worst cliff: 765 ms/tick for an
 * 8-study stack over 500k rows, against 5.4 ms/tick over a 5,000-row
 * tail. A consumer watching a live edge should slice; this is what says
 * where, so it stops being a guess in either direction.
 */
describe('[PND-PROCHIST] requiredHistory', () => {
  const passthrough: Pick<
    OpDef,
    'family' | 'summary' | 'inputs' | 'outputs' | 'run'
  > = {
    family: 'test',
    summary: 'x',
    inputs: [{ role: 'source' }],
    outputs: [{ id: '', unit: 'inherit' }],
    run: () => [],
  };

  function registry(): Registry {
    return createRegistry()
      .define({
        ...passthrough,
        name: 'sma',
        params: { period: int({ min: 2, default: 20 }) },
        lookback: (p) => (p['period'] as number) - 1,
      })
      .define({
        ...passthrough,
        name: 'ema',
        params: { period: int({ min: 2, default: 20 }) },
        lookback: (p) => 4 * (p['period'] as number),
      })
      .define({
        ...passthrough,
        name: 'negate',
        params: {},
        // Element-wise: genuinely needs nothing, and says so.
        lookback: () => 0,
      })
      .define({ ...passthrough, name: 'mystery', params: {} })
      .define({
        ...passthrough,
        name: 'spread',
        params: {},
        inputs: [{ role: 'a' }, { role: 'b' }],
        lookback: () => 0,
      });
  }

  const sma = (period: number, input: Input = 'px'): Spec => ({
    op: 'sma',
    params: { period },
    inputs: [input],
  });

  it('is period - 1 for a single count-window study', () => {
    const out = requiredHistory(registry(), [sma(20)]);
    expect(out).toMatchObject({ known: true, rows: 19 });
  });

  it('applies param defaults rather than reading the spec raw', () => {
    // `sma` with no period still has one. Reading `spec.params` directly
    // would hand the lookback an `undefined` to subtract from.
    const out = requiredHistory(registry(), [{ op: 'sma', inputs: ['px'] }]);
    expect(out).toMatchObject({ known: true, rows: 19 });
  });

  it('SUMS along a nested chain — the whole point', () => {
    // `sma(20)` over `sma(50)` needs 49 rows for the inner study to
    // produce anything, and then 19 rows of THAT OUTPUT before the outer
    // one does. A max would say 49 and under-provision by 19 — and the
    // resulting bug is subtle rather than loud, because the answer is
    // still defined, still plausible, and computed from a short window.
    const out = requiredHistory(registry(), [sma(20, sma(50))]);
    expect(out).toMatchObject({ known: true, rows: 68 });
    expect(out.rows).not.toBe(49);
  });

  it('maxes across independent specs in one plan', () => {
    const out = requiredHistory(registry(), [sma(20), sma(200), sma(5)]);
    expect(out).toMatchObject({ known: true, rows: 199 });
  });

  it('maxes across sibling inputs, then adds its own', () => {
    // A two-input op waits for whichever branch arrives latest.
    const out = requiredHistory(registry(), [
      { op: 'sma', params: { period: 10 }, inputs: [sma(30), sma(80)] },
    ]);
    expect(out).toMatchObject({ known: true, rows: 79 + 9 });
  });

  it('lets an IIR op declare its own approximation', () => {
    // An EMA has no exact finite warm-up. 4x period is an engineering
    // answer, and it belongs to the op rather than the folder because
    // the multiplier is a claim about acceptable error.
    expect(
      requiredHistory(registry(), [
        { op: 'ema', params: { period: 20 }, inputs: ['px'] },
      ]),
    ).toMatchObject({
      known: true,
      rows: 80,
    });
  });

  it('treats a source column as needing nothing', () => {
    expect(
      requiredHistory(registry(), [{ op: 'negate', inputs: ['px'] }]),
    ).toMatchObject({
      known: true,
      rows: 0,
    });
  });

  it('reports UNKNOWN rather than zero for an undeclared op', () => {
    // The failure this exists to prevent: a missing declaration and a
    // genuinely element-wise op are the same value and opposite
    // meanings. Defaulting to zero would hand back a confidently wrong
    // slice, and the caller would never know to check.
    const out = requiredHistory(registry(), [
      sma(20, { op: 'mystery', inputs: ['px'] }),
    ]);
    expect(out.known).toBe(false);
    expect(out.rows).toBeUndefined();
    expect(out.undeclared).toEqual(['mystery']);
  });

  it('names every undeclared op once, in encounter order', () => {
    const reg = registry().define({
      ...passthrough,
      name: 'other',
      params: {},
    });
    const out = requiredHistory(reg, [
      { op: 'mystery', inputs: ['px'] },
      { op: 'other', inputs: ['px'] },
      { op: 'mystery', inputs: ['py'] },
    ]);
    expect(out.undeclared).toEqual(['mystery', 'other']);
  });

  it('rejects a lookback that is not a usable row count', () => {
    const reg = createRegistry().define({
      ...passthrough,
      name: 'bad',
      params: {},
      lookback: () => Number.POSITIVE_INFINITY,
    });
    expect(() => requiredHistory(reg, [{ op: 'bad', inputs: ['px'] }])).toThrow(
      /non-negative finite/,
    );
    const negative = createRegistry().define({
      ...passthrough,
      name: 'bad',
      params: {},
      lookback: () => -5,
    });
    expect(() =>
      requiredHistory(negative, [{ op: 'bad', inputs: ['px'] }]),
    ).toThrow(/non-negative finite/);
  });

  it('rounds a fractional lookback up', () => {
    const reg = createRegistry().define({
      ...passthrough,
      name: 'half',
      params: {},
      lookback: () => 2.1,
    });
    expect(
      requiredHistory(reg, [{ op: 'half', inputs: ['px'] }]),
    ).toMatchObject({
      rows: 3,
    });
  });

  it('visits a shared subtree once', () => {
    // A plan is a DAG, not a tree: two specs reading one upstream must
    // not double-count it, and a deep diamond must not go exponential.
    let calls = 0;
    const reg = createRegistry().define({
      ...passthrough,
      name: 'counted',
      params: { period: int({ min: 1, default: 2 }) },
      lookback: (p) => {
        calls += 1;
        return (p['period'] as number) - 1;
      },
    });
    const shared = { op: 'counted', params: { period: 10 }, inputs: ['px'] };
    const out = requiredHistory(reg, [
      { op: 'counted', params: { period: 3 }, inputs: [shared] },
      { op: 'counted', params: { period: 4 }, inputs: [shared] },
    ]);
    expect(out).toMatchObject({ rows: 9 + 3 });
    expect(calls, 'the shared spec must be folded once').toBe(3);
  });

  it('is the TIGHT tail: one row short truncates, exactly', () => {
    // The acceptance bar. `requiredHistory` is arithmetic until slicing by
    // it is shown to change no answer — and until one row less is shown to
    // change one. A bound that is merely safe would pass the first half
    // and quietly hand back the performance cliff.
    const N = 400;
    const PERIOD = 20;
    const DISPLAY = 50;
    const px = Array.from({ length: N }, (_, i) => 100 + Math.sin(i / 5) * 10);

    /** SMA over a plain array, with an undefined warm-up head. */
    const smaOf = (v: readonly number[], period: number) =>
      v.map((_, i) => {
        if (i < period - 1) return undefined;
        let sum = 0;
        for (let k = i - period + 1; k <= i; k += 1) sum += v[k]!;
        return sum / period;
      });

    const reg = registry();
    const spec = { op: 'sma', params: { period: PERIOD }, inputs: ['px'] };
    const need = requiredHistory(reg, [spec]);
    expect(need).toMatchObject({ known: true, rows: PERIOD - 1 });

    const whole = smaOf(px, PERIOD);
    const displayFrom = N - DISPLAY;

    const truncatedCells = (history: number) => {
      const from = Math.max(0, displayFrom - history);
      const sliced = smaOf(px.slice(from, N), PERIOD);
      let missing = 0;
      for (let i = displayFrom; i < N; i += 1) {
        const full = whole[i];
        const tail = sliced[i - from];
        if (full !== undefined && tail === undefined) missing += 1;
      }
      return missing;
    };

    expect(
      truncatedCells(need.rows!),
      'the derived tail must lose nothing',
    ).toBe(0);
    expect(
      truncatedCells(need.rows! - 1),
      'one row short must lose exactly one cell — the bound is tight',
    ).toBe(1);
  });

  it('adds nothing for a fold', () => {
    // A fold reads a whole column and emits a fact; it has no warm-up of
    // its own. Whether a truncated tail changes its ANSWER is a
    // windowing question, and a different one.
    const reg = registry();
    const out = requiredHistory(reg, [{ op: 'last', inputs: [sma(20)] }]);
    expect(out).toMatchObject({ known: true, rows: 19 });
  });
});
