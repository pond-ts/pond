import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  bind,
  createRegistry,
  int,
  num,
  run,
  specId,
  SlotError,
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

function makeRegistry(): { registry: Registry; ran: Record<string, number> } {
  const ran: Record<string, number> = {};
  const registry = createRegistry()
    .define({
      name: 'sma',
      family: 'trend',
      summary: 'Rolling mean.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      label: (p, i) => `SMA(${p['period']}) of ${i}`,
      run: (ctx) => {
        ran['sma'] = (ran['sma'] ?? 0) + 1;
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
    })
    .define({
      name: 'band',
      family: 'bands',
      summary: 'Mid ± width.',
      params: { width: num({ default: 1 }) },
      inputs: [{ role: 'source' }],
      outputs: [
        { id: 'Upper', unit: 'inherit' },
        { id: 'Lower', unit: 'inherit' },
      ],
      run: (ctx) => {
        const v = values(ctx, 'source');
        const w = ctx.params['width'] as number;
        return [
          v.map((x) => (x === undefined ? undefined : x + w)),
          v.map((x) => (x === undefined ? undefined : x - w)),
        ];
      },
    });
  return { registry, ran };
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

describe('slots — an alias layer over content-addressed ids', () => {
  it('resolves to the same ids as the equivalent nested plan', () => {
    // The contract. Slots are a naming layer, so the cache a nested plan
    // built is the cache a slot plan hits — across requests, sessions and
    // callers, where one caller's `outer` means nothing to another's.
    const { registry, ran } = makeRegistry();
    const graph = bind(series(20), { registry, units });
    const nested = {
      op: 'scale',
      params: { by: 2 },
      inputs: [{ op: 'sma', params: { period: 3 }, inputs: ['px'] }],
    };

    const viaPlan = run(graph, {
      plan: [nested],
      select: [{ on: nested, reduce: 'last' }],
    });
    const viaSlots = run(graph, {
      nodes: {
        avg: { op: 'sma', params: { period: 3 }, in: ['px'] },
        outer: { op: 'scale', params: { by: 2 }, in: ['avg'] },
      },
      outputs: { doubled: { on: 'outer', reduce: 'last' } },
    });

    expect(viaSlots.nodes.map((n) => n.id).sort()).toEqual(
      viaPlan.nodes.map((n) => n.id).sort(),
    );
    expect(viaSlots.facts[0]!['value']).toBe(viaPlan.facts[0]!['value']);
    // The second request was a straight cache hit: no op ran twice.
    expect(ran['sma']).toBe(1);
    expect(viaSlots.nodes.every((n) => n.cached)).toBe(true);
  });

  it('keeps the slot when a param edit changes the id', () => {
    // The whole reason slots exist: params are in the id but do not
    // change the topology, so a consumer keying its UI on the id sees a
    // different graph when only a value moved.
    const { registry } = makeRegistry();
    const graph = bind(series(20), { registry, units });
    const at = (period: number) =>
      run(graph, {
        nodes: { avg: { op: 'sma', params: { period }, in: ['px'] } },
        outputs: { latest: { on: 'avg', reduce: 'last' } },
      }).nodes[0]!;

    const before = at(3);
    const after = at(5);
    expect(before.slot).toBe('avg');
    expect(after.slot).toBe('avg');
    expect(after.id).not.toBe(before.id);
  });

  it('reports a slot nothing selected, so the graph is whole', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(20), { registry, units });
    const res = run(graph, {
      nodes: {
        a: { op: 'sma', params: { period: 3 }, in: ['px'] },
        b: { op: 'sma', params: { period: 5 }, in: ['px'] },
      },
      outputs: { only_a: { on: 'a', reduce: 'last' } },
    });
    expect(res.nodes.map((n) => [n.slot, n.pulled]).sort()).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });

  it('names facts and columns with the caller’s own key', () => {
    // A card is a named output: it keeps its identity across a refresh
    // instead of being re-keyed when a derived id moves.
    const { registry } = makeRegistry();
    const graph = bind(series(20), { registry, units });
    const res = run(graph, {
      nodes: { bb: { op: 'band', params: { width: 2 }, in: ['px'] } },
      outputs: {
        top: { on: 'bb', output: 'Upper', reduce: 'last' },
        drawable: { on: 'bb', columns: true },
      },
    });
    expect(res.facts[0]).toMatchObject({ name: 'top', reduce: 'last' });
    const id = specId(registry, {
      op: 'band',
      params: { width: 2 },
      inputs: ['px'],
    });
    expect(res.outputs[id]!.every((o) => o.name === 'drawable')).toBe(true);
  });

  it('still accepts an id string, so a follow-up can cite a response', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(20), { registry, units });
    const first = run(graph, {
      nodes: { avg: { op: 'sma', params: { period: 3 }, in: ['px'] } },
      outputs: { latest: { on: 'avg', reduce: 'last' } },
    });
    const id = first.nodes[0]!.id;
    const second = run(graph, {
      nodes: { avg: { op: 'sma', params: { period: 3 }, in: ['px'] } },
      outputs: { latest: { on: id, reduce: 'last' } },
    });
    expect(second.facts[0]!['value']).toBe(first.facts[0]!['value']);
  });
});

describe('slots — the errors a caller has to read', () => {
  it('rejects a slot named after a source column', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(20), { registry, units });
    expect(() =>
      run(graph, {
        nodes: { px: { op: 'sma', params: { period: 3 }, in: ['px'] } },
        outputs: {},
      }),
    ).toThrow(SlotError);
    expect(() =>
      run(graph, {
        nodes: { px: { op: 'sma', params: { period: 3 }, in: ['px'] } },
      }),
    ).toThrow(/collides with a source column/);
  });

  it('names both lists when a reference resolves to neither', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(20), { registry, units });
    expect(() =>
      run(graph, {
        nodes: { avg: { op: 'sma', params: { period: 3 }, in: ['close'] } },
      }),
    ).toThrow(/neither a slot nor a column.*'avg'.*'px'/s);
  });

  it('reports a cycle as a path rather than a stack overflow', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(20), { registry, units });
    expect(() =>
      run(graph, {
        nodes: {
          a: { op: 'scale', in: ['b'] },
          b: { op: 'scale', in: ['a'] },
        },
      }),
    ).toThrow(/slot cycle: a → b → a/);
  });
});
