import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  bind,
  BuilderError,
  createRegistry,
  int,
  num,
  plan,
  run,
  type OpDef,
  type Registry,
} from '../src/index.js';

const values = (ctx: Parameters<OpDef['run']>[0], role: string) => {
  const col = ctx.series.column(ctx.inputs[role]!) as unknown as {
    length: number;
    at(i: number): number | undefined;
  };
  const out = new Array<number | undefined>(col.length);
  for (let i = 0; i < col.length; i += 1) out[i] = col.at(i);
  return out;
};

function makeRegistry(): Registry {
  return createRegistry()
    .define({
      name: 'sma',
      family: 'trend',
      summary: 'Rolling mean.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        const v = values(ctx, 'source');
        const period = ctx.params['period'] as number;
        return v.map((_, i) => {
          if (i < period - 1) return undefined;
          let s = 0;
          for (let k = i - period + 1; k <= i; k += 1) s += v[k]!;
          return s / period;
        });
      },
    })
    .define({
      name: 'scale',
      family: 'transform',
      summary: 'Multiply.',
      params: { by: num({ default: 2 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) =>
        values(ctx, 'source').map((x) =>
          x === undefined ? undefined : x * (ctx.params['by'] as number),
        ),
    });
}

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'px', kind: 'number' },
] as const;

const series = (n: number) =>
  TimeSeries.fromJSON({
    name: 'px',
    schema,
    rows: Array.from({ length: n }, (_, i) => [
      Date.UTC(2026, 0, 1) + i * 86_400_000,
      10 + i,
    ]),
  });

const units = { px: '%' };

describe('the builder emits a plan, it does not replace one', () => {
  it('lands on the same nodes as the equivalent composed JSON', () => {
    // The contract, and the reason the builder holds no resolution logic:
    // one path, one cache. A graph built in code and one a model composed
    // must be indistinguishable to the resolver.
    const registry = makeRegistry();
    const graph = bind(series(20), { registry, units });

    const g = plan('ACME_5m').as('doubled_avg');
    const avg = g.add('avg', 'sma', { period: 3 }, ['px']);
    const outer = g.add('outer', 'scale', { by: 2 }, [avg]);
    g.expose('latest', outer.last());
    const built = g.toJSON();

    const byHand = {
      nodes: {
        avg: { op: 'sma', params: { period: 3 }, in: ['px'] },
        outer: { op: 'scale', params: { by: 2 }, in: ['avg'] },
      },
      outputs: { latest: { on: 'outer', reduce: 'last' as const } },
    };

    expect(built.nodes).toEqual(byHand.nodes);
    expect(built.outputs).toEqual(byHand.outputs);
    expect(built.from).toBe('ACME_5m');
    expect(built.as).toBe('doubled_avg');

    const fromBuilt = run(graph, built);
    const fromHand = run(graph, byHand);
    expect(fromBuilt.nodes.map((n) => n.id)).toEqual(
      fromHand.nodes.map((n) => n.id),
    );
    expect(fromBuilt.facts[0]).toEqual(fromHand.facts[0]);
  });

  it('emits plain JSON, so nothing of the builder survives the wire', () => {
    const g = plan('ACME_5m');
    const avg = g.add('avg', 'sma', { period: 3 }, ['px']);
    g.expose('latest', avg.last());
    const round = JSON.parse(JSON.stringify(g.toJSON()));
    expect(round).toEqual(g.toJSON());
  });

  it('passes a handle rather than a name, so a typo cannot resolve', () => {
    // The compile-time half is not testable at runtime; what is testable
    // is that a handle carries the slot it was created under.
    const g = plan('ACME_5m');
    const avg = g.add('avg', 'sma', { period: 3 }, ['px']);
    const outer = g.add('outer', 'scale', undefined, [avg]);
    expect(avg.slot).toBe('avg');
    expect(g.toJSON().nodes['outer']!.in).toEqual(['avg']);
    expect(outer.columns()).toEqual({ on: 'outer', columns: true });
  });

  it('builds every reduction the response knows how to answer', () => {
    const g = plan('ACME_5m');
    const n = g.add('n', 'sma', { period: 3 }, ['px']);
    expect(n.last({ output: 'Upper' })).toEqual({
      on: 'n',
      reduce: 'last',
      output: 'Upper',
    });
    expect(n.extremes()).toEqual({ on: 'n', reduce: 'extremes' });
    expect(n.percentileRank()).toEqual({ on: 'n', reduce: 'percentileRank' });
    expect(n.shape({ points: 40 })).toEqual({
      on: 'n',
      reduce: 'shape',
      points: 40,
    });
  });

  it('refuses a duplicate slot before the request is ever sent', () => {
    const g = plan('ACME_5m');
    g.add('avg', 'sma', { period: 3 }, ['px']);
    expect(() => g.add('avg', 'scale', undefined, ['px'])).toThrow(
      BuilderError,
    );
    expect(() => g.add('avg', 'scale', undefined, ['px'])).toThrow(
      /already used by a 'sma' node/,
    );
  });

  it('refuses a duplicate output name', () => {
    const g = plan('ACME_5m');
    const n = g.add('n', 'sma', { period: 3 }, ['px']);
    g.expose('latest', n.last());
    expect(() => g.expose('latest', n.extremes())).toThrow(
      /'latest' is already exposed/,
    );
  });
});
