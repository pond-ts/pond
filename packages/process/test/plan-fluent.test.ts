import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  createHost,
  createRegistry,
  createSourceRegistry,
  defineSource,
  int,
  num,
  process,
  sourceId,
  type OpDef,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
] as const;

const series = (base = 10) =>
  TimeSeries.fromJSON({
    name: 'prices',
    schema,
    rows: Array.from({ length: 8 }, (_, i) => [
      Date.UTC(2026, 0, 1) + i * 300_000,
      base + i,
    ]),
  });

const values = (ctx: Parameters<OpDef['run']>[0], role: string) => {
  const column = ctx.series.column(ctx.inputs[role]!) as unknown as {
    length: number;
    at(index: number): number | undefined;
  };
  return Array.from({ length: column.length }, (_, i) => column.at(i));
};

function vocabulary(ran = { n: 0 }) {
  return createRegistry()
    .define({
      name: 'scale',
      family: 'transform',
      summary: 'Multiply one column.',
      params: { by: num({ default: 2 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        ran.n += 1;
        return values(ctx, 'source').map((value) =>
          value === undefined
            ? undefined
            : value * (ctx.params['by'] as number),
        );
      },
    })
    .define({
      name: 'bands',
      family: 'range',
      summary: 'Two lines around a source.',
      params: { width: num({ default: 1 }) },
      inputs: [{ role: 'source' }],
      outputs: [
        { id: 'Upper', unit: 'inherit' },
        { id: 'Lower', unit: 'inherit' },
      ],
      run: (ctx) => {
        const width = ctx.params['width'] as number;
        const source = values(ctx, 'source');
        return [
          source.map((value) =>
            value === undefined ? undefined : value + width,
          ),
          source.map((value) =>
            value === undefined ? undefined : value - width,
          ),
        ];
      },
    })
    .define({
      name: 'subtract',
      family: 'arithmetic',
      summary: 'Subtract a right column.',
      params: {},
      inputs: [{ role: 'left' }, { role: 'right' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        const left = values(ctx, 'left');
        const right = values(ctx, 'right');
        return left.map((value, i) =>
          value === undefined || right[i] === undefined
            ? undefined
            : value - right[i]!,
        );
      },
    });
}

describe('registry-bound fluent authoring', () => {
  it('compiles fluent branches, picked outputs and folds to one slot request', () => {
    const registry = vocabulary();
    const graph = process(registry, 'prices').as('band_stretch');
    const close = graph.column('close');
    const bands = close.bands({ as: 'bands', width: 2 });
    const width = bands.output('Upper').subtract({
      as: 'width',
      right: bands.output('Lower'),
    });

    const request = graph.outputs({
      bands: bands.columns(),
      upper: bands.output('Upper').columns(),
      latestWidth: width.last(),
    });

    expect(request).toEqual({
      from: 'prices',
      as: 'band_stretch',
      nodes: {
        bands: {
          op: 'bands',
          params: { width: 2 },
          in: ['close'],
        },
        width: {
          op: 'subtract',
          in: ['bands#Upper', 'bands#Lower'],
        },
        'width:last': {
          op: 'last',
          in: ['width'],
        },
      },
      outputs: {
        bands: { on: 'bands' },
        upper: { on: 'bands', output: 'Upper' },
        latestWidth: { on: 'width:last' },
      },
    });

    const host = createHost({ registry, units: { close: '$' } }).add(
      'prices',
      series(),
    );
    const result = host.run(request);
    expect(result.facts[0]).toMatchObject({
      name: 'latestWidth',
      value: 4,
    });
    expect(
      Object.values(result.outputs)
        .flat()
        .find((output) => output.name === 'upper'),
    ).toMatchObject({ name: 'upper' });
  });

  it('deduplicates a repeated fluent fold', () => {
    const graph = process(vocabulary(), 'prices');
    const scaled = graph.column('close').scale({ as: 'scaled', by: 3 });
    const latest = scaled.last();
    graph.outputs({ first: latest, second: scaled.last() });
    expect(Object.keys(graph.outputs({}).nodes)).toEqual([
      'scaled',
      'scaled:last',
    ]);
  });
});

describe('opaque asynchronous sources', () => {
  it('revalidates remotely while preserving the graph for equal revisions', async () => {
    const ran = { n: 0 };
    const registry = vocabulary(ran);
    let revision = 'r1';
    let base = 10;
    let loads = 0;

    const marketBars = defineSource({
      name: 'market.bars',
      async load(params: {
        readonly symbol: string;
        readonly interval: '5m' | '1h';
      }) {
        loads += 1;
        expect(params).toEqual({ symbol: 'ACME', interval: '5m' });
        return { value: series(base), revision };
      },
    });
    const sources = createSourceRegistry().define(marketBars);
    const host = createHost({
      registry,
      sources,
      units: { close: '$' },
    });

    const graph = process(
      registry,
      marketBars.ref({ symbol: 'ACME', interval: '5m' }),
    );
    const scaled = graph.column('close').scale({ as: 'scaled', by: 2 });
    const request = graph.outputs({ latest: scaled.last() });

    const cold = await host.runAsync(request);
    const warm = await host.runAsync(request);
    expect(cold.facts[0]).toMatchObject({ value: 34 });
    expect(warm.nodes.every((node) => node.cached)).toBe(true);
    expect(loads).toBe(2);
    expect(ran.n).toBe(1);

    revision = 'r2';
    base = 100;
    const refreshed = await host.runAsync(request);
    expect(refreshed.facts[0]).toMatchObject({ value: 214 });
    expect(refreshed.nodes.every((node) => !node.cached)).toBe(true);
    expect(ran.n).toBe(2);
  });

  it('keeps parameter order out of remote source identity', async () => {
    const remote = defineSource({
      name: 'market.bars',
      async load(params: { readonly symbol: string; readonly limit: number }) {
        return { value: series(), revision: JSON.stringify(params) };
      },
    });
    const a = remote.ref({ symbol: 'ACME', limit: 100 });
    const b = remote.ref({ limit: 100, symbol: 'ACME' });
    expect(sourceId(a)).toBe(sourceId(b));
    expect(sourceId(a)).not.toBe(
      sourceId({
        source: 'market.bars',
        params: { symbol: 'ACME', limit: '100' },
      }),
    );

    const registry = vocabulary();
    const sources = createSourceRegistry().define(remote);
    const host = createHost({ registry, sources });
    const make = (from: typeof a) => {
      const graph = process(registry, from);
      const scaled = graph.column('close').scale({ as: 'scaled', by: 2 });
      return graph.outputs({ latest: scaled.last() });
    };

    await host.runAsync(make(a));
    await host.runAsync(make(b));
    expect(host.datasets).toHaveLength(1);
  });
});
