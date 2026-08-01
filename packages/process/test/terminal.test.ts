import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import { bind, createRegistry, int, run, type Registry } from '../src/index.js';

/**
 * [PND-PROCTERM] — assemble only when asked.
 *
 * Two `TimeSeries` constructions used to happen whether a caller wanted a
 * series or not. The terminal built one so a reduction had a column to
 * read, and — the larger of the two — **every node's `compute` widened
 * the source with `appendColumn` for each nested input**, so an op could
 * call the corpus normally. A fold needs neither: the column it reads is
 * already in its inputs.
 *
 * The cost was not incidental. `appendColumn` boxes a **gapped** column
 * on the way in, because core's `withColumn` takes values rather than a
 * column — 22.4 ms per column at 1M rows. Every rolling study is gapped,
 * so the expensive path was the ordinary one.
 */
describe('[PND-PROCTERM] a facts-only request builds no series', () => {
  const N = 60;

  function bars(): TimeSeries<never> {
    const time = new Float64Array(N);
    const px = new Float64Array(N);
    for (let i = 0; i < N; i += 1) {
      time[i] = i * 60_000;
      px[i] = 100 + Math.sin(i / 5) * 10;
    }
    return TimeSeries.fromColumns({
      name: 'bars',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'px', kind: 'number' },
      ],
      columns: { time, px },
    }) as never;
  }

  /** A study with a warm-up head, so its output column is genuinely gapped. */
  function registry(): Registry {
    return createRegistry().define({
      name: 'sma',
      family: 'trend',
      summary: 'Rolling mean with an undefined warm-up.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        const col = ctx.series.column(ctx.inputs['source']!) as unknown as {
          length: number;
          at(i: number): number | undefined;
        };
        const period = ctx.params['period'] as number;
        const out = new Array<number | undefined>(col.length).fill(undefined);
        for (let i = period - 1; i < col.length; i += 1) {
          let sum = 0;
          for (let k = i - period + 1; k <= i; k += 1) sum += col.at(k)!;
          out[i] = sum / period;
        }
        return out;
      },
    });
  }

  const sma = { op: 'sma', params: { period: 4 }, inputs: ['px'] };
  const fold = { op: 'last', inputs: [sma] };

  it('returns no assembled series, and a real fact', () => {
    const graph = bind(bars(), { registry: registry() });
    const out = run(graph, { plan: [fold], select: [{ on: fold }] });
    expect(out.series).toBeUndefined();
    // The trap the plan flagged: an earlier prototype resolved only the
    // column-selectors, so a fact over an unselected spec came back with
    // no value — silently, which is worse than throwing. The upstream
    // column resolves through the node graph rather than through the
    // terminal's `needed` set, so it cannot go missing.
    expect(out.facts?.[0]).toMatchObject({ value: expect.any(Number) });
  });

  it('gives the same fact whether or not the column is also selected', () => {
    // The safety property for removing the widening: a fold reading its
    // input column directly must agree with one reading it back off an
    // assembled series.
    const factOnly = run(bind(bars(), { registry: registry() }), {
      plan: [fold],
      select: [{ on: fold }],
    });
    const withColumn = run(bind(bars(), { registry: registry() }), {
      plan: [fold],
      select: [{ on: fold }, { on: sma }],
    });
    expect(withColumn.series).toBeDefined();
    expect(factOnly.facts?.[0]).toEqual(withColumn.facts?.[0]);
  });

  it('assembles exactly the closure a mixed request needs', () => {
    const other = { op: 'sma', params: { period: 8 }, inputs: ['px'] };
    const out = run(bind(bars(), { registry: registry() }), {
      plan: [fold, other],
      // A fact over one study, a column off another: only the second is
      // a column selector, so only its column may be assembled.
      select: [{ on: fold }, { on: other }],
    });
    expect(out.facts).toHaveLength(1);
    expect(Object.keys(out.columns ?? {})).toHaveLength(1);
    expect(out.series).toBeDefined();
  });

  it('skips assembly when the caller opts out, keeping the columns', () => {
    const out = run(bind(bars(), { registry: registry() }), {
      plan: [sma],
      select: [{ on: sma }],
      assemble: false,
    });
    expect(out.series).toBeUndefined();
    // The wire shape: columns by name, which the far side rebuilds with
    // `TimeSeries.fromColumns` for free. A `TimeSeries` cannot cross a
    // wire, so a producer that builds one has done work its consumer
    // can never use.
    expect(Object.keys(out.columns ?? {})).toHaveLength(1);
  });

  it('reads a source column directly, with no nested input at all', () => {
    // The other branch of the fold's column lookup: a role bound to a
    // source column rather than to an upstream node.
    const direct = { op: 'last', inputs: ['px'] };
    const out = run(bind(bars(), { registry: registry() }), {
      plan: [direct],
      select: [{ on: direct }],
    });
    expect(out.series).toBeUndefined();
    expect(out.facts?.[0]).toMatchObject({ value: expect.any(Number) });
  });
});
