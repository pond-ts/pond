import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  bind,
  createRegistry,
  int,
  run,
  ProcessError,
  UnitError,
  UnknownColumnError,
  type OpDef,
  type Registry,
  type Spec,
} from '../src/index.js';

// [PND-PROCJOIN] — n sources, one join node, one aligned column set.

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
] as const;

const make = (name: string, rows: [number, number][]) =>
  TimeSeries.fromJSON({ name, schema, rows });

// AAPL trades every day; MSFT misses sessions 3 and 7 — the normal case,
// and exactly the one where index-wise pairing silently goes wrong.
const aaplRows: [number, number][] = Array.from({ length: 12 }, (_, i) => [
  T0 + i * DAY,
  100 + i,
]);
const msftRows: [number, number][] = Array.from({ length: 12 }, (_, i) => [
  T0 + i * DAY,
  200 + i * 2,
]).filter((_, i) => i !== 3 && i !== 7) as [number, number][];
const aapl = make('AAPL', aaplRows);
const msft = make('MSFT', msftRows);

const values = (ctx: Parameters<OpDef['run']>[0], role: string) => {
  const col = ctx.series.column(ctx.inputs[role]!) as unknown as {
    length: number;
    at(i: number): number | undefined;
  };
  return Array.from({ length: col.length }, (_, i) => col.at(i));
};

function makeRegistry(): { registry: Registry; ran: Record<string, number> } {
  const ran: Record<string, number> = {};
  const count = (k: string) => (ran[k] = (ran[k] ?? 0) + 1);
  const registry = createRegistry()
    .define({
      name: 'sma',
      family: 'trend',
      summary: 'Rolling mean.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        count(`sma:${ctx.inputs['source']}`);
        const v = values(ctx, 'source');
        const p = ctx.params['period'] as number;
        return v.map((_, i) => {
          if (i < p - 1) return undefined;
          let s = 0;
          for (let k = i - p + 1; k <= i; k += 1) {
            if (v[k] === undefined) return undefined;
            s += v[k]!;
          }
          return s / p;
        });
      },
    })
    .define({
      name: 'ratio',
      family: 'pair',
      summary: 'a / b, row by row.',
      params: {},
      inputs: [{ role: 'a' }, { role: 'b' }],
      outputs: [{ id: '', unit: '' }],
      run: (ctx) => {
        count('ratio');
        const a = values(ctx, 'a');
        const b = values(ctx, 'b');
        return a.map((x, i) =>
          x === undefined || b[i] === undefined ? undefined : x / b[i]!,
        );
      },
    })
    .define({
      name: 'usd',
      family: 'typed',
      summary: 'Demands a USD input.',
      params: {},
      inputs: [{ role: 'source', unit: 'USD' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => values(ctx, 'source'),
    });
  return { registry, ran };
}

const ratio: Spec = { op: 'ratio', inputs: ['AAPL:close', 'MSFT:close'] };
const smaA: Spec = { op: 'sma', inputs: ['AAPL:close'] };
const smaM: Spec = { op: 'sma', inputs: ['MSFT:close'] };

const cells = (graph: ReturnType<typeof bind>, spec: Spec) => {
  const col = graph.columnOf(graph.compile(spec), '') as unknown as {
    length: number;
    at(i: number): number | undefined;
  };
  return Array.from({ length: col.length }, (_, i) => col.at(i));
};
const keys = (graph: ReturnType<typeof bind>) => {
  const kc = graph.series.keyColumn() as unknown as { at(i: number): number };
  return Array.from({ length: graph.series.length }, (_, i) => kc.at(i));
};

describe('joined binding — alignment', () => {
  it('inner keeps only shared timestamps, and pairs the same dates', () => {
    const { registry } = makeRegistry();
    const graph = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, join: { how: 'inner' } },
    );
    expect(graph.series.length).toBe(10);
    expect(keys(graph)).toEqual(msftRows.map(([t]) => t));
    const got = cells(graph, ratio);
    // Every row pairs AAPL and MSFT of the SAME day — index-wise pairing
    // would have read AAPL day 3 against MSFT day 4 from row 3 on.
    msftRows.forEach(([t, m], i) => {
      const day = (t - T0) / DAY;
      expect(got[i]).toBeCloseTo((100 + day) / m);
    });
  });

  it('as-of keeps every base row and carries the other leg forward', () => {
    const { registry } = makeRegistry();
    const graph = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, join: { how: 'asof', base: 'AAPL' } },
    );
    expect(graph.series.length).toBe(12);
    const got = cells(graph, ratio);
    expect(got[3]).toBeCloseTo(103 / 204); // MSFT day 2 carried into day 3
    expect(got[7]).toBeCloseTo(107 / 212); // day 6 carried into day 7
    expect(got[8]).toBeCloseTo(108 / 216);
  });

  it('as-of leaves a leg missing before its first row', () => {
    const { registry } = makeRegistry();
    const late = make('MSFT', msftRows.slice(2));
    const graph = bind(
      { AAPL: aapl, MSFT: late },
      { registry, join: { how: 'asof', base: 'AAPL' } },
    );
    const got = cells(graph, ratio);
    expect(got.slice(0, 2)).toEqual([undefined, undefined]);
    expect(got[2]).toBeCloseTo(102 / 204);
  });

  it('the two policies answer differently, so neither is a default', () => {
    const { registry } = makeRegistry();
    const inner = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, join: { how: 'inner' } },
    );
    const asof = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, join: { how: 'asof', base: 'AAPL' } },
    );
    expect(cells(inner, ratio)).not.toEqual(cells(asof, ratio));
    expect(() =>
      bind({ AAPL: aapl, MSFT: msft }, {
        registry,
        join: {},
      } as never),
    ).toThrow(/explicit policy/);
  });
});

describe('joined binding — identity', () => {
  it('puts the policy in the join id, independent of record order', () => {
    const { registry } = makeRegistry();
    const a = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, join: { how: 'inner' } },
    );
    const b = bind(
      { MSFT: msft, AAPL: aapl },
      { registry, join: { how: 'inner' } },
    );
    const c = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, join: { how: 'asof', base: 'MSFT' } },
    );
    expect(a.join?.id).toBe('p1:join(AAPL+MSFT;how=inner)');
    expect(b.join?.id).toBe(a.join?.id);
    expect(c.join?.id).toBe('p1:join(AAPL+MSFT;base=MSFT,how=asof)');
    expect(a.join?.sources).toEqual(['AAPL', 'MSFT']);
    expect(bind(aapl, { registry }).join).toBeUndefined();
  });

  it('a cross-source spec resolves, caches and explains like any other', () => {
    const { registry, ran } = makeRegistry();
    const graph = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, join: { how: 'inner' } },
    );
    const res = run(graph, { plan: [ratio] });
    expect(res.skipped).toEqual([]);
    expect(res.nodes.map((n) => n.id)).toEqual([
      'p1:ratio(AAPL:close+MSFT:close;)',
    ]);
    expect(Object.values(res.explain)).toEqual([
      'ratio of AAPL:close, MSFT:close',
    ]);
    const select = [{ on: ratio }];
    run(graph, { plan: [ratio], select });
    run(graph, { plan: [ratio], select });
    expect(ran['ratio']).toBe(1);
  });

  it('assembles the aligned series with qualified column names', () => {
    const { registry } = makeRegistry();
    const graph = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, join: { how: 'inner' } },
    );
    expect(graph.series.schema.map((c) => c.name)).toEqual([
      'time',
      'AAPL:close',
      'MSFT:close',
    ]);
  });

  it('reads units by qualified name', () => {
    const { registry } = makeRegistry();
    const graph = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, units: { 'AAPL:close': 'USD' }, join: { how: 'inner' } },
    );
    expect(() =>
      graph.compile({ op: 'usd', inputs: ['AAPL:close'] }),
    ).not.toThrow();
    expect(() => graph.compile({ op: 'usd', inputs: ['MSFT:close'] })).toThrow(
      UnitError,
    );
  });

  it('rejects an unqualified or unknown column as UnknownColumnError', () => {
    const { registry } = makeRegistry();
    const graph = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, join: { how: 'inner' } },
    );
    expect(() => graph.compile({ op: 'sma', inputs: ['close'] })).toThrow(
      UnknownColumnError,
    );
    expect(() => graph.compile({ op: 'sma', inputs: ['SPY:close'] })).toThrow(
      UnknownColumnError,
    );
  });
});

describe('joined binding — per-source invalidation', () => {
  it('a tick in one leg leaves the other leg warm', () => {
    const { registry, ran } = makeRegistry();
    const graph = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, join: { how: 'asof', base: 'AAPL' } },
    );
    const plan = [smaA, smaM, { op: 'ratio', inputs: [smaA, smaM] }];
    const pull = () => plan.forEach((s) => cells(graph, s));
    pull();
    const heldA = graph.columnOf(graph.compile(smaA), '');
    expect(ran).toEqual({
      'sma:AAPL:close': 1,
      'sma:MSFT:close': 1,
      ratio: 1,
    });

    // MSFT fills in its missing session 7. The as-of base is AAPL, so the
    // key base does not move and nothing reading AAPL alone is owed work.
    const filled = make(
      'MSFT',
      [...msftRows, [T0 + 7 * DAY, 214] as [number, number]].sort(
        (x, y) => x[0] - y[0],
      ),
    );
    graph.setSource('MSFT', filled);
    pull();
    expect(ran).toEqual({
      'sma:AAPL:close': 1,
      'sma:MSFT:close': 2,
      ratio: 2,
    });
    // Not merely "not rerun": the very same column, so its consumers'
    // version checks skip too.
    expect(graph.columnOf(graph.compile(smaA), '')).toBe(heldA);
    expect(
      cells(graph, { op: 'ratio', inputs: ['AAPL:close', 'MSFT:close'] })[7],
    ).toBeCloseTo(107 / 214);
  });

  it('a tick that moves the key base recomputes both legs, correctly', () => {
    const { registry, ran } = makeRegistry();
    const graph = bind(
      { AAPL: aapl, MSFT: msft },
      { registry, join: { how: 'inner' } },
    );
    cells(graph, smaA);
    cells(graph, smaM);
    // MSFT gains session 3: an inner join now has one more shared row, so
    // AAPL's aligned column changed too even though AAPL did not.
    const filled = make(
      'MSFT',
      [...msftRows, [T0 + 3 * DAY, 206] as [number, number]].sort(
        (x, y) => x[0] - y[0],
      ),
    );
    graph.setSource('MSFT', filled);
    cells(graph, smaA);
    cells(graph, smaM);
    expect(ran['sma:AAPL:close']).toBe(2);
    const fresh = bind(
      { AAPL: aapl, MSFT: filled },
      { registry, join: { how: 'inner' } },
    );
    expect(cells(graph, smaA)).toEqual(cells(fresh, smaA));
    expect(cells(graph, ratio)).toEqual(cells(fresh, ratio));
  });

  it('a single-source binding keeps its one-argument setSource', () => {
    const { registry, ran } = makeRegistry();
    const graph = bind(aapl, { registry });
    graph.compile({ op: 'sma', inputs: ['close'] });
    cells(graph, { op: 'sma', inputs: ['close'] });
    graph.setSource(make('AAPL', aaplRows.slice(0, 6)));
    expect(cells(graph, { op: 'sma', inputs: ['close'] })).toHaveLength(6);
    expect(ran['sma:close']).toBe(2);
    expect(() => graph.setSource('AAPL', aapl)).toThrow(ProcessError);
  });
});

describe('joined binding — rejected shapes', () => {
  const { registry } = makeRegistry();
  const graph = () =>
    bind({ AAPL: aapl, MSFT: msft }, { registry, join: { how: 'inner' } });

  it('names the source on setSource, and refuses setSourceFrom', () => {
    expect(() => graph().setSource(aapl)).toThrow(/name the source/);
    expect(() => graph().setSource('SPY', aapl)).toThrow(/not a source/);
    expect(() => graph().setSourceFrom(aapl, 3)).toThrow(/joined binding/);
  });

  it('refuses an as-of base that is not a source', () => {
    expect(() =>
      bind(
        { AAPL: aapl, MSFT: msft },
        { registry, join: { how: 'asof', base: 'SPY' } },
      ),
    ).toThrow(/base 'SPY'/);
  });

  it('refuses a binding key the column grammar cannot carry', () => {
    expect(() =>
      bind({ 'A:B': aapl }, { registry, join: { how: 'inner' } }),
    ).toThrow(/binding key/);
  });

  it('refuses a repeated timestamp under inner', () => {
    const dup = make('MSFT', [
      [T0, 1],
      [T0, 2],
    ]);
    expect(
      () =>
        bind({ AAPL: aapl, MSFT: dup }, { registry, join: { how: 'inner' } })
          .series,
    ).toThrow(/repeats timestamp/);
  });
});
