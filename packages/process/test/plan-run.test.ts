import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  bind,
  createRegistry,
  int,
  num,
  run,
  specId,
  type OpDef,
  type Registry,
} from '../src/index.js';

// ── a registry of hand-rolled ops ────────────────────────────
// Deliberately not the financial corpus: this suite is about the plan
// layer, and hand-rolled ops let a test assert exact values.

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
  const ran: Record<string, number> = { sma: 0, scale: 0, band: 0, spread: 0 };
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
          for (let k = i - period + 1; k <= i; k += 1) {
            const x = v[k];
            if (x === undefined) return undefined;
            s += x;
          }
          return s / period;
        });
      },
    })
    .define({
      name: 'scale',
      family: 'transform',
      summary: 'Multiply by a factor.',
      params: { by: num({ default: 2 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        ran['scale'] = (ran['scale'] ?? 0) + 1;
        const by = ctx.params['by'] as number;
        return values(ctx, 'source').map((x) =>
          x === undefined ? undefined : x * by,
        );
      },
    })
    .define({
      name: 'band',
      family: 'bands',
      summary: 'Mid, plus and minus a width.',
      params: { width: num({ default: 1 }) },
      inputs: [{ role: 'source' }],
      outputs: [
        { id: 'Upper', unit: 'inherit', dependsOn: ['width'] },
        { id: 'Middle', unit: 'inherit', dependsOn: [] },
        { id: 'Lower', unit: 'inherit', dependsOn: ['width'] },
      ],
      label: (p, i) => `Band(±${p['width']}) of ${i}`,
      run: (ctx) => {
        ran['band'] = (ran['band'] ?? 0) + 1;
        const v = values(ctx, 'source');
        const w = ctx.params['width'] as number;
        return [
          v.map((x) => (x === undefined ? undefined : x + w)),
          v,
          v.map((x) => (x === undefined ? undefined : x - w)),
        ];
      },
    })
    .define({
      name: 'spread',
      family: 'compare',
      summary: 'a minus b — the 2-input case.',
      params: {},
      inputs: [{ role: 'a' }, { role: 'b' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        ran['spread'] = (ran['spread'] ?? 0) + 1;
        const a = values(ctx, 'a');
        const b = values(ctx, 'b');
        return a.map((x, i) =>
          x === undefined || b[i] === undefined ? undefined : x - b[i]!,
        );
      },
    })
    .define({
      name: 'annualise',
      family: 'volatility',
      summary: 'Needs a variance input.',
      params: {},
      inputs: [{ role: 'source', unit: 'variance' }],
      outputs: [{ id: '', unit: '%' }],
      run: (ctx) =>
        values(ctx, 'source').map((x) =>
          x === undefined ? undefined : x * 100,
        ),
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

const sma3 = { op: 'sma', params: { period: 3 }, inputs: ['px'] };
const sma5 = { op: 'sma', params: { period: 5 }, inputs: ['px'] };
const units = { px: '%' };

describe('run — resolution', () => {
  it('resolves a plan that arrived as a JSON string', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const plan = JSON.parse(
      '[{"op":"sma","params":{"period":3},"inputs":["px"]}]',
    ) as never;
    const res = run(graph, { plan, select: [{ on: sma3, reduce: 'last' }] });
    expect(res.facts[0]).toMatchObject({
      reduce: 'last',
      unit: '%',
      value: 18,
    });
  });

  it('deduplicates a nested spec against its standalone twin', () => {
    const { registry, ran } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const emaOfSma = { op: 'scale', params: { by: 2 }, inputs: [sma3] };
    run(graph, {
      plan: [emaOfSma, sma3],
      select: [{ on: sma3, reduce: 'last' }],
    });
    // Three plan entries' worth of specs, two distinct nodes.
    expect(graph.ids).toHaveLength(2);
    expect(ran['sma']).toBe(1);
  });

  it('carries lineage on every response, folded not hand-built', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const nested = { op: 'scale', params: { by: 2 }, inputs: [sma3] };
    const res = run(graph, { plan: [nested] });
    // The whole closure, not just the plan's top level — a nested spec is
    // a node in `nodes` and needs a label there too.
    expect(Object.values(res.explain).sort()).toEqual([
      'SMA(3) of px',
      'scale(by=2) of SMA(3) of px',
    ]);
  });

  it('reports resolved nodes nothing selected, marked not pulled', () => {
    // A plan may carry a branch no selector reaches. It is still part of
    // the pipeline, and leaving it out of `nodes` drew a graph with a
    // whole branch missing (found in M4).
    const { registry, ran } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [sma3, sma5],
      select: [{ on: sma3, reduce: 'last' }],
    });
    expect(res.nodes.map((n) => [n.id, n.pulled])).toEqual([
      [specId(registry, sma3), true],
      [specId(registry, sma5), false],
    ]);
    // Reporting it costs nothing: the unselected op never ran.
    expect(ran['sma']).toBe(1);
    expect(res.nodes[1]).toMatchObject({ ms: 0, cached: false });
  });

  it('resolves a 2-input op across two branches', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const spread = { op: 'spread', inputs: [sma3, sma5] };
    const res = run(graph, {
      plan: [spread],
      select: [{ on: spread, reduce: 'last' }],
    });
    // last sma3 = mean(17,18,19)=18; last sma5 = mean(15..19)=17
    expect(res.facts[0]).toMatchObject({ value: 1 });
  });
});

describe('run — failure policy covers selection too', () => {
  it('collects a bad param rather than throwing', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [{ op: 'sma', params: { period: 1 }, inputs: ['px'] }],
      onError: 'collect',
    });
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]!.reason).toMatch(/below minimum 2/);
  });

  it('collects a selector naming an id not in the plan', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: 'p1:nope(px;)', reduce: 'last' }],
      onError: 'collect',
    });
    expect(res.skipped[0]!.reason).toMatch(/not in this plan/);
    expect(res.facts).toHaveLength(0);
  });

  it('rejects a typed input whose unit does not match', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [{ op: 'annualise', inputs: ['px'] }],
      onError: 'collect',
    });
    expect(res.skipped[0]!.reason).toMatch(/needs a 'variance' input.*is '%'/);
  });

  it('echoes the failing spec back with its inputs', () => {
    // A plan may hold two specs of the same op. Reporting `{op, params}`
    // alone left a caller unable to tell which one it had to fix — found
    // in M2, where the caller retrying is an agent.
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [
        { op: 'sma', params: { period: 1 }, inputs: ['px'] },
        { op: 'sma', params: { period: 1 }, inputs: ['iv21'] },
      ],
      onError: 'collect',
    });
    expect(res.skipped.map((s) => s.spec?.inputs)).toEqual([['px'], ['iv21']]);
  });

  it('throws under the default policy', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    expect(() =>
      run(graph, {
        plan: [{ op: 'sma', params: { period: 1 }, inputs: ['px'] }],
      }),
    ).toThrow(/below minimum 2/);
  });
});

describe('run — the terminal', () => {
  it('builds no series when only facts were asked for', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: sma3, reduce: 'last' }],
    });
    // [PND-PROCTERM]: assembly is requested, never assumed. 52x measured.
    expect(res.series).toBeUndefined();
    expect(res.facts).toHaveLength(1);
  });

  it('assembles every promised column when columns are asked for', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const band = { op: 'band', params: { width: 1 }, inputs: ['px'] };
    const res = run(graph, {
      plan: [sma3, band],
      select: [
        { on: sma3, columns: true },
        { on: band, columns: true },
      ],
    });
    const names = res.series!.schema.map((c) => c.name);
    const promised = Object.values(res.outputs)
      .flat()
      .map((o) => o.column);
    expect(promised).toHaveLength(4);
    // The forked-series defect: two sibling branches must coexist.
    for (const c of promised) expect(names).toContain(c);
  });

  it('assembles the closure a reduction needs, not just the column-selectors', () => {
    // Assembling only `columns: true` entries produced a fact with no
    // value rather than an error — silent, and worse than a throw.
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [sma3, sma5],
      select: [
        { on: sma3, columns: true },
        { on: sma5, reduce: 'last' },
      ],
    });
    expect(res.facts[0]).toMatchObject({ value: 17 });
    expect(res.outputs[specId(registry, sma5)]).toBeUndefined();
  });

  it('reports a band as one entry with three columns', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const band = { op: 'band', params: { width: 2 }, inputs: ['px'] };
    const res = run(graph, {
      plan: [band],
      select: [{ on: band, columns: true }],
    });
    const id = specId(registry, band);
    expect(res.outputs[id]!.map((o) => o.column)).toEqual([
      `${id}Upper`,
      `${id}Middle`,
      `${id}Lower`,
    ]);
    // One entry, so a renderer moves and deletes it as a unit.
    expect(Object.keys(res.outputs)).toHaveLength(1);
  });

  it('selects a named output of a multi-output op', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const band = { op: 'band', params: { width: 2 }, inputs: ['px'] };
    const res = run(graph, {
      plan: [band],
      select: [{ on: band, output: 'Upper', reduce: 'last' }],
    });
    expect(res.facts[0]).toMatchObject({ value: 21 }); // last px 19 + 2
  });

  it('accepts a selector citing an id string, which is all a JSON caller has', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const id = specId(registry, sma3);
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: id, reduce: 'last' }],
    });
    expect(res.facts[0]!.id).toBe(id);
  });
});

describe('run — reductions', () => {
  const setup = () => {
    const { registry } = makeRegistry();
    return { registry, graph: bind(series(10), { registry, units }) };
  };

  it('last, with a timestamp and a unit', () => {
    const { graph } = setup();
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: sma3, reduce: 'last' }],
    });
    expect(res.facts[0]).toMatchObject({
      value: 18,
      at: '2026-01-10',
      unit: '%',
    });
  });

  it('extremes, with when', () => {
    const { graph } = setup();
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: sma3, reduce: 'extremes' }],
    });
    expect(res.facts[0]).toMatchObject({
      min: { value: 11, at: '2026-01-03' },
      max: { value: 18, at: '2026-01-10' },
    });
  });

  it('shape returns a bounded envelope, not every point', () => {
    const { graph } = setup();
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: sma3, reduce: 'shape', points: 3 }],
    });
    expect(res.facts[0]!['points'] as number).toBeLessThanOrEqual(4);
  });

  it('a facts-only response is JSON-safe by construction', () => {
    const { graph } = setup();
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: sma3, reduce: 'extremes' }],
    });
    expect(res.series).toBeUndefined();
    expect(() => JSON.stringify(res)).not.toThrow();
  });
});

describe('run — the graph is the cache', () => {
  it('serves a repeated request warm', () => {
    const { registry, ran } = makeRegistry();
    const graph = bind(series(50), { registry, units });
    const req = {
      plan: [sma3],
      select: [{ on: sma3, reduce: 'last' as const }],
    };
    const first = run(graph, req);
    const second = run(graph, req);
    expect(first.nodes).toEqual([
      {
        id: specId(registry, sma3),
        pulled: true,
        cached: false,
        ms: expect.any(Number),
        inputs: ['px'],
      },
    ]);
    expect(second.nodes[0]).toMatchObject({ cached: true });
    expect(ran['sma']).toBe(1);
  });

  it('recomputes when the bound data changes', () => {
    const { registry, ran } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const req = {
      plan: [sma3],
      select: [{ on: sma3, reduce: 'last' as const }],
    };
    expect(run(graph, req).facts[0]).toMatchObject({ value: 18 });
    graph.setSource(series(20));
    expect(run(graph, req).facts[0]).toMatchObject({ value: 28 });
    expect(ran['sma']).toBe(2);
  });

  it('keeps two bindings disjoint under identical ids', () => {
    // The v1 cache bug: an id names the computation, not the data.
    const { registry } = makeRegistry();
    const a = bind(series(10), { registry, units });
    const b = bind(
      TimeSeries.fromJSON({
        name: 'px',
        schema,
        rows: Array.from({ length: 10 }, (_, i) => [
          Date.UTC(2026, 0, 1) + i * 86_400_000,
          1000 + i,
        ]),
      }),
      { registry, units },
    );
    const req = {
      plan: [sma3],
      select: [{ on: sma3, reduce: 'last' as const }],
    };
    expect(run(a, req).facts[0]).toMatchObject({ value: 18 });
    expect(run(b, req).facts[0]).toMatchObject({ value: 1008 });
  });
});

describe('run — columns are the wire shape, assembly is the convenience', () => {
  it('hands back the resolved columns a selector asked to draw', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(50), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: sma3, columns: true }],
    });
    const name = specId(registry, sma3);
    expect(Object.keys(res.columns!)).toEqual([name]);
    expect(res.columns![name]!.length).toBe(50);
  });

  it('names a multi-output op’s columns individually', () => {
    // One spec, three columns — the band case M3 draws.
    const { registry } = makeRegistry();
    const graph = bind(series(50), { registry, units });
    const bb = { op: 'band', params: { width: 2 }, inputs: ['px'] };
    const res = run(graph, {
      plan: [bb],
      select: [{ on: bb, columns: true }],
    });
    const id = specId(registry, bb);
    expect(Object.keys(res.columns!).sort()).toEqual(
      [`${id}Lower`, `${id}Middle`, `${id}Upper`].sort(),
    );
  });

  it('skips assembly when the consumer is across a wire', () => {
    // `assemble: false` is not an optimization flag — a `TimeSeries`
    // cannot be serialized, so building one for a wire consumer is pure
    // waste. The columns still come back; the receiving side rebuilds
    // with `TimeSeries.fromColumns`, which adopts buffers zero-copy.
    const { registry } = makeRegistry();
    const graph = bind(series(50), { registry, units });
    const req = {
      plan: [sma3],
      select: [{ on: sma3, columns: true } as const],
    };

    const wire = run(graph, { ...req, assemble: false });
    expect(wire.series).toBeUndefined();
    expect(wire.columns).toBeDefined();

    const inProcess = run(graph, req);
    expect(inProcess.series).toBeDefined();
    expect(inProcess.columns).toBeDefined();
  });

  it('leaves both undefined when nothing asked to be drawn', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(50), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: sma3, reduce: 'last' }],
    });
    expect(res.series).toBeUndefined();
    expect(res.columns).toBeUndefined();
  });
});

describe('run — a selector describes its own computation', () => {
  it('resolves an inline spec the plan did not also list', () => {
    // Requiring a spec to appear in both `process` and `select.on` was
    // bookkeeping no schema could express, so it lived in prose — and a
    // caller composing from the schema alone duly selected a spec it had
    // not listed, and got a skip instead of an answer (M5).
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: sma5, reduce: 'last' }],
      onError: 'collect',
    });
    expect(res.skipped).toEqual([]);
    expect(res.facts[0]).toMatchObject({
      id: specId(registry, sma5),
      value: 17,
    });
    // And it is a node like any other, so the badge row reports it.
    expect(res.nodes.map((n) => n.id)).toContain(specId(registry, sma5));
  });

  it('still refuses an id string naming nothing', () => {
    // A string cannot describe a computation, so there is nothing to
    // resolve — the reason has to stay.
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: 'p1:nope(px;)', reduce: 'last' }],
      onError: 'collect',
    });
    expect(res.skipped[0]!.reason).toMatch(/not in this plan/);
  });

  it('gives both when a selector asks for columns and a reduction', () => {
    // The legend-chip case: a fact riding alongside the columns it
    // labels, in one pass. Treating `columns` as a mode silently dropped
    // the reduction a caller had plainly asked for.
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: sma3, columns: true, reduce: 'last' } as never],
    });
    expect(res.columns).toBeDefined();
    expect(res.outputs[specId(registry, sma3)]).toHaveLength(1);
    expect(res.facts[0]).toMatchObject({ reduce: 'last', value: 18 });
  });
});
