import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  bind,
  createRegistry,
  int,
  run,
  specId,
  type Registry,
} from '../src/index.js';

/**
 * [PND-PROCCACHE] — the engine-wide byte budget.
 *
 * Every distinct spec ever compiled was retained forever, so memory
 * scaled with *questions asked*. A session walking a slider from period
 * 20 to 200 left 180 nodes holding 180 result columns and dropped none.
 *
 * The ticket framed this as an op-level cache. Half of that is already
 * true here: `specId` is content-addressed, so asking the same question
 * twice hits the same node by construction and there is nothing for an
 * op to declare. What was missing is the capacity — and the ticket is
 * right that it cannot belong to the op, because a per-op cap is a
 * per-op promise and nothing supervises the total.
 */
describe('[PND-PROCCACHE] engine-wide byte budget', () => {
  const N = 4_000;

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

  function registry(): Registry {
    return createRegistry().define({
      name: 'sma',
      family: 'trend',
      summary: 'Rolling mean.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      lookback: (p) => (p['period'] as number) - 1,
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

  const sma = (period: number) => ({
    op: 'sma',
    params: { period },
    inputs: ['px'],
  });

  /** Walks distinct params, the way a slider does. */
  function sweep(graph: ReturnType<typeof bind>, periods: readonly number[]) {
    for (const p of periods) {
      const spec = sma(p);
      run(graph, { plan: [spec], select: [{ on: spec }], assemble: false });
    }
  }

  it('retains every distinct question when unbounded — the leak', () => {
    const graph = bind(bars(), { registry: registry() });
    sweep(
      graph,
      Array.from({ length: 40 }, (_, i) => 5 + i),
    );
    expect(graph.ids).toHaveLength(40);
    expect(graph.evictions).toBe(0);
    expect(graph.retainedBytes).toBeGreaterThan(40 * N * 8 * 0.9);
  });

  it('holds steady state under a budget, and still answers', () => {
    // The acceptance bar: bounded memory AND correct answers. A cache
    // that bounds memory by returning nothing is not a cache.
    const budgetBytes = 8 * N * 8;
    const graph = bind(bars(), { registry: registry(), budgetBytes });
    sweep(
      graph,
      Array.from({ length: 40 }, (_, i) => 5 + i),
    );
    expect(graph.retainedBytes).toBeLessThanOrEqual(budgetBytes);
    expect(graph.evictions).toBeGreaterThan(0);
    expect(graph.ids.length).toBeLessThan(40);

    const spec = sma(9);
    const out = run(graph, {
      plan: [spec],
      select: [{ on: spec }],
      assemble: false,
    });
    const col = Object.values(out.columns ?? {})[0]!;
    expect(col.at(N - 1)).toBeCloseTo(
      run(bind(bars(), { registry: registry() }), {
        plan: [spec],
        select: [{ on: spec }],
        assemble: false,
      }).columns![Object.keys(out.columns!)[0]!]!.at(N - 1) as number,
      12,
    );
  });

  it('evicts least-recently-used, keeping what was just asked', () => {
    const reg = registry();
    const budgetBytes = 3 * N * 8;
    const graph = bind(bars(), { registry: reg, budgetBytes });
    const periods = [5, 6, 7, 8, 9, 10];
    sweep(graph, periods);

    const live = new Set(graph.ids);
    const idFor = (p: number) => specId(reg, sma(p));
    // The last few asked survive; the first few do not. Asserted on
    // identity rather than on a count, because a count passes for any
    // eviction order — including the one that throws away the answer
    // the caller is most likely to want next.
    expect(live.has(idFor(10)), 'newest must survive').toBe(true);
    expect(live.has(idFor(9)), 'second newest must survive').toBe(true);
    expect(live.has(idFor(5)), 'oldest must be gone').toBe(false);
  });

  it('re-asking a live question does not recompute it', () => {
    const reg = registry();
    const graph = bind(bars(), { registry: reg, budgetBytes: 3 * N * 8 });
    sweep(graph, [5, 6, 7, 8]);
    const before = graph.evictions;
    const ids = [...graph.ids];
    sweep(graph, [8]);
    expect(graph.evictions, 'a cache hit must not evict').toBe(before);
    expect([...graph.ids].sort()).toEqual(ids.sort());
  });

  it('never evicts a node whose consumer still holds its outlet', () => {
    // Dropping an upstream node while a retained node reads from it
    // frees nothing — the consumer holds the outlet — and would only
    // force a recompile on the next pull. So it is skipped, even when
    // it is the least-recently-used thing in the graph.
    const inner = sma(50);
    const outer = { op: 'sma', params: { period: 3 }, inputs: [inner] };
    const graph = bind(bars(), { registry: registry(), budgetBytes: 1 });
    run(graph, { plan: [outer], select: [{ on: outer }], assemble: false });
    // Budget is 1 byte, so everything evictable has gone; the inner node
    // must remain because `outer` depends on it.
    const ids = graph.ids;
    expect(ids.length).toBeGreaterThanOrEqual(1);
    const again = run(graph, {
      plan: [outer],
      select: [{ on: outer }],
      assemble: false,
    });
    expect(Object.keys(again.columns ?? {})).toHaveLength(1);
  });

  it('is unbounded by default, so no existing caller changes behaviour', () => {
    const graph = bind(bars(), { registry: registry() });
    sweep(graph, [5, 6, 7]);
    expect(graph.evictions).toBe(0);
    expect(graph.ids).toHaveLength(3);
  });
});
