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

  /**
   * How many inlets are still attached to the bound source's outlet.
   *
   * The honest measure of eviction: a node is gone only once nothing
   * references it, and `graph.ids` cannot tell you that — it is the
   * lookup, not the graph. Reached through a live node's own `src`
   * inlet, which is the public path every node is wired through.
   */
  function downstreamCount(graph: ReturnType<typeof bind>): number {
    const anyId = graph.ids[0];
    if (anyId === undefined) return 0;
    const node = graph.get(anyId)!.node as unknown as {
      in: Record<string, { source?: { connections: readonly unknown[] } }>;
    };
    const outlet = node.in['src']?.source;
    if (outlet === undefined) {
      throw new Error('no source outlet reachable — this probe is broken');
    }
    return outlet.connections.length;
  }

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

  it('never leaves a live node with an evicted upstream', () => {
    // The invariant, stated correctly. Being depended-on does not make a
    // node permanent — it protects it only while its dependent survives,
    // and once that is evicted the input is fair game. What must never
    // happen is the reverse order, leaving a retained node whose upstream
    // lookup is gone. Checked across the whole graph rather than on one
    // pair, because the eviction loop now repeats and any pass could
    // break it.
    const reg = registry();
    const inner = sma(50);
    const outer = { op: 'sma', params: { period: 3 }, inputs: [inner] };
    const graph = bind(bars(), { registry: reg, budgetBytes: 3 * N * 8 });
    run(graph, { plan: [outer], select: [{ on: outer }], assemble: false });
    sweep(graph, [7, 8, 9, 10, 11, 12]);
    expect(graph.evictions).toBeGreaterThan(0);

    const live = new Set(graph.ids);
    for (const id of live) {
      for (const up of graph.get(id)!.upstream) {
        expect(
          live.has(up),
          `${id} kept, but its upstream ${up} was dropped`,
        ).toBe(true);
      }
    }
  });

  it('keeps evicting after unpinning, rather than stopping at one pass', () => {
    // Evicting a consumer unpins its inputs, but a single pass over a
    // snapshot of the LRU has already walked past them. A two-node chain
    // under a 1-byte budget therefore kept 8,000 bytes and reported
    // success (found by a Codex pass on PR #571). The bound must hold
    // after `enforceBudget` returns, not after some later call.
    const reg = registry();
    const inner = sma(50);
    const outer = { op: 'sma', params: { period: 3 }, inputs: [inner] };
    const graph = bind(bars(), { registry: reg, budgetBytes: 1 });
    run(graph, { plan: [outer], select: [{ on: outer }], assemble: false });
    expect(graph.retainedBytes).toBeLessThanOrEqual(1);
    // And it still answers, by recompiling.
    const again = run(graph, {
      plan: [outer],
      select: [{ on: outer }],
      assemble: false,
    });
    expect(Object.keys(again.columns ?? {})).toHaveLength(1);
  });

  it('counts bytes materialized outside the run path', () => {
    // Byte accounting used to be written in `columnOf`, so pulling a
    // value through the compiled node directly materialized a column the
    // budget could not see: `retainedBytes` read 0 while the memory was
    // real (Codex, PR #571). Reading the ports with `peek()` closes it.
    const reg = registry();
    const graph = bind(bars(), { registry: reg });
    const compiled = graph.compile(sma(20));
    expect(graph.retainedBytes).toBe(0); // compiled, not computed
    const outlet = Object.values(compiled.outlets)[0]!;
    (compiled.node.out[outlet] as { get(): unknown }).get();
    expect(graph.retainedBytes).toBeGreaterThan(0);
  });

  it('actually disconnects an evicted node from the source', () => {
    // THE test this suite was missing. Every other assertion here reads
    // the graph's own bookkeeping — `retainedBytes`, `ids`, `evictions` —
    // and all of them passed while eviction freed nothing at all.
    // `Outlet.#downstream` is a strong Set and `Inlet.node` points back,
    // so a node whose lookup was deleted but whose inlets stayed
    // connected remained reachable from the source forever. Found by a
    // Layer 2 review of PR #571. This asserts on the graph structure,
    // which is what "freed" actually means.
    const reg = registry();
    const budgeted = bind(bars(), { registry: reg, budgetBytes: 3 * N * 8 });
    sweep(
      budgeted,
      Array.from({ length: 30 }, (_, i) => 5 + i),
    );
    expect(budgeted.evictions).toBeGreaterThan(20);
    expect(
      downstreamCount(budgeted),
      'evicted nodes must not remain attached to the source',
    ).toBeLessThanOrEqual(budgeted.ids.length);
  });

  it('does not grow when an evicted spec is re-asked repeatedly', () => {
    // The leak's sharpest form: evict-then-re-ask used to compile a
    // SECOND node onto the same source, so churn grew memory without
    // bound while `ids.length` stayed flat — worse than no budget.
    const reg = registry();
    const graph = bind(bars(), { registry: reg, budgetBytes: 2 * N * 8 });
    const cycle = [5, 6, 7, 8, 9, 10, 11, 12];
    sweep(graph, cycle);
    const afterFirst = downstreamCount(graph);
    for (let round = 0; round < 6; round += 1) sweep(graph, cycle);
    expect(
      downstreamCount(graph),
      'repeated churn must not accumulate attached nodes',
    ).toBeLessThanOrEqual(afterFirst);
  });

  it('is unbounded by default, so no existing caller changes behaviour', () => {
    const graph = bind(bars(), { registry: registry() });
    sweep(graph, [5, 6, 7]);
    expect(graph.evictions).toBe(0);
    expect(graph.ids).toHaveLength(3);
  });
});

describe('[PND-PROCCACHE] a Compiled handle across an eviction', () => {
  it('re-compiling after eviction gives a working node', () => {
    // The sharp edge the disconnect introduced, disclosed by the second
    // Layer 2 pass on PR #571. Eviction severs a node's inlets, so a
    // handle held across a run can throw `UnconnectedInputError` — which
    // names the input, not the budget that took it. `run` re-resolves and
    // never hits it; this pins the documented recovery for a caller that
    // holds its own handle.
    const N = 4_000;
    const time = new Float64Array(N);
    const px = new Float64Array(N);
    for (let i = 0; i < N; i += 1) {
      time[i] = i * 60_000;
      px[i] = 100 + Math.sin(i / 5) * 10;
    }
    const series = TimeSeries.fromColumns({
      name: 'bars',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'px', kind: 'number' },
      ],
      columns: { time, px },
    });
    const reg = createRegistry().define({
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

    const graph = bind(series as never, {
      registry: reg,
      budgetBytes: 2 * N * 8,
    });
    const first = { op: 'sma', params: { period: 5 }, inputs: ['px'] };
    run(graph, { plan: [first], select: [{ on: first }], assemble: false });

    // Evict it by asking for enough other work.
    for (const period of [11, 12, 13, 14, 15, 16]) {
      const other = { op: 'sma', params: { period }, inputs: ['px'] };
      run(graph, { plan: [other], select: [{ on: other }], assemble: false });
    }
    expect(graph.evictions).toBeGreaterThan(0);

    // The documented recovery: re-compile rather than reuse the handle.
    const again = run(graph, {
      plan: [first],
      select: [{ on: first }],
      assemble: false,
    });
    const col = Object.values(again.columns ?? {})[0] as unknown as {
      at(i: number): number | undefined;
    };
    expect(typeof col.at(N - 1)).toBe('number');
  });
});
