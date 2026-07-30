import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  createHost,
  createRegistry,
  int,
  specId,
  toWire,
  UnknownDatasetError,
  type OpDef,
  type Registry,
  type Spec,
} from '../src/index.js';

/** A fold node over a spec — what a `reduce` selector used to be. */
const fold = (op: string, on: Spec, output?: string): Spec => ({
  op,
  inputs: [output === undefined ? on : { from: on, output }],
});

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'px', kind: 'number' },
] as const;

const series = (n: number, base = 10) =>
  TimeSeries.fromJSON({
    name: 'px',
    schema,
    rows: Array.from({ length: n }, (_, i) => [
      Date.UTC(2026, 0, 1) + i * 86_400_000,
      base + i,
    ]),
  });

const values = (ctx: Parameters<OpDef['run']>[0], role: string) => {
  const col = ctx.series.column(ctx.inputs[role]!) as unknown as {
    length: number;
    at(i: number): number | undefined;
  };
  const out = new Array<number | undefined>(col.length);
  for (let i = 0; i < col.length; i += 1) out[i] = col.at(i);
  return out;
};

function makeRegistry(): { registry: Registry; ran: { n: number } } {
  const ran = { n: 0 };
  const registry = createRegistry()
    .define({
      name: 'sma',
      family: 'trend',
      summary: 'Rolling mean.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        ran.n += 1;
        const v = values(ctx, 'source');
        const p = ctx.params['period'] as number;
        return v.map((_, i) => {
          if (i < p - 1) return undefined;
          let s = 0;
          for (let k = i - p + 1; k <= i; k += 1) s += v[k]!;
          return s / p;
        });
      },
    })
    .define({
      name: 'scale',
      family: 'transform',
      summary: 'Multiply.',
      params: { by: int({ default: 2 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) =>
        values(ctx, 'source').map((x) =>
          x === undefined ? undefined : x * (ctx.params['by'] as number),
        ),
    });
  return { registry, ran };
}

const sma3 = { op: 'sma', params: { period: 3 }, inputs: ['px'] };
const units = { px: '%' };

describe('Host — the graph outlives requests', () => {
  it('serves a repeated envelope warm', () => {
    const { registry, ran } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(500));
    const envelope = {
      from: 'prices',
      process: [sma3],
      select: [{ on: fold('last', sma3) }],
    };

    const first = host.run(envelope);
    const second = host.run(envelope);

    // The M1 gate: same plan twice, every node cached the second time.
    expect(first.nodes.every((n) => !n.cached)).toBe(true);
    expect(second.nodes.every((n) => n.cached)).toBe(true);
    expect(ran.n).toBe(1);
  });

  it('keeps two datasets disjoint under identical ids', () => {
    const { registry } = makeRegistry();
    const host = createHost({ registry, units })
      .add('a', series(10, 10))
      .add('b', series(10, 1000));
    const envelope = (from: string) => ({
      from,
      process: [sma3],
      select: [{ on: fold('last', sma3) }],
    });
    // Same specId in both, different data — v1's cross-series cache bug.
    expect(host.run(envelope('a')).facts[0]).toMatchObject({ value: 18 });
    expect(host.run(envelope('b')).facts[0]).toMatchObject({ value: 1008 });
  });

  it('keeps the cache when a dataset is refreshed', () => {
    const { registry } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(10));
    const envelope = {
      from: 'prices',
      process: [sma3],
      select: [{ on: fold('last', sma3) }],
    };
    host.run(envelope);
    const nodesBefore = host.datasets[0]!.nodes;

    // Rebinding updates in place. Dropping the graph would throw away
    // the cache on every refresh, which is what this class exists to
    // avoid — the node stays, dirty marking does the rest.
    host.add('prices', series(20));
    const after = host.run(envelope);
    expect(after.facts[0]).toMatchObject({ value: 28 });
    expect(host.datasets[0]!.nodes).toBe(nodesBefore);
    expect(after.nodes.every((n) => !n.cached)).toBe(true);
  });

  it('names the datasets it has when one is unknown', () => {
    const { registry } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(10));
    expect(() => host.run({ from: 'nope', process: [sma3] })).toThrow(
      UnknownDatasetError,
    );
    expect(() => host.run({ from: 'nope', process: [sma3] })).toThrow(
      /'prices'/,
    );
  });

  it('builds a graph lazily, so seeding many datasets is cheap', () => {
    const { registry } = makeRegistry();
    const host = createHost({ registry, units })
      .add('a', series(10))
      .add('b', series(10));
    expect(host.datasets.map((d) => d.nodes)).toEqual([0, 0]);
    host.run({ from: 'a', process: [sma3] });
    expect(host.datasets.map((d) => d.nodes)).toEqual([1, 0]);
  });

  it('reports what a caller can pick from', () => {
    const { registry } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(42));
    expect(host.datasets).toEqual([
      { id: 'prices', rows: 42, columns: ['px'], nodes: 0 },
    ]);
  });
});

describe('per-node timing — the badge', () => {
  it('reports every touched node in dependency order', () => {
    const { registry } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(200));
    const nested = { op: 'scale', params: { by: 2 }, inputs: [sma3] };
    const res = host.run({
      from: 'prices',
      process: [nested],
      select: [{ on: fold('last', nested) }],
    });
    // Inputs first: the inner sma before the scale that consumes it,
    // and the fold that reads the scale last of all.
    expect(res.nodes.map((n) => n.id)).toEqual([
      specId(registry, sma3),
      specId(registry, nested),
      specId(registry, fold('last', nested)),
    ]);
  });

  it('explains every node it reports, including nested ones', () => {
    // The badge row renders `explain[id]`. Populating it only for the
    // plan's top level left a nested node labelled with its raw id —
    // found in M2, and the same labels feed M4's pipeline view.
    const { registry } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(50));
    const nested = { op: 'scale', params: { by: 2 }, inputs: [sma3] };
    const res = host.run({
      from: 'prices',
      process: [nested],
      select: [{ on: fold('last', nested) }],
    });
    expect(res.nodes.length).toBe(3);
    for (const n of res.nodes) expect(res.explain[n.id]).toBeTruthy();
    expect(res.explain[specId(registry, sma3)]).toContain('sma');
  });

  it('names each node’s upstream ids, so the response is a graph', () => {
    // Without this a caller has the nodes but not the edges, and cannot
    // derive them: turning a spec into an id means reimplementing
    // `specId`'s canonicalization. M4's pipeline view reads this.
    const { registry } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(50));
    const nested = { op: 'scale', params: { by: 2 }, inputs: [sma3] };
    const res = host.run({
      from: 'prices',
      process: [nested],
      select: [{ on: fold('last', nested) }],
    });
    const smaId = specId(registry, sma3);
    expect(res.nodes.map((n) => [n.id, n.inputs])).toEqual([
      // A raw source column is named by column, not by node id.
      [smaId, ['px']],
      [specId(registry, nested), [smaId]],
      // The fold's edge too: it is in the graph, so it is in the graph's
      // shape, and a pipeline view draws it like any other node.
      [specId(registry, fold('last', nested)), [specId(registry, nested)]],
    ]);
    // Every non-column input resolves to a node in the same response.
    const ids = new Set(res.nodes.map((n) => n.id));
    for (const n of res.nodes) {
      for (const input of n.inputs) {
        expect(ids.has(input) || input === 'px').toBe(true);
      }
    }
  });

  it('attributes time to the node that spent it, not its consumer', () => {
    // Pulling a leaf without warming its inputs first would charge the
    // whole subtree to the leaf, and the badge would lie. Two designs
    // flaked before this one: comparing `scale` to `sma` flipped on the
    // nested input's `appendColumn` cost (see the note below), and a
    // fixed 3M-iteration spin flipped on a loaded CI runner, where the
    // spin came to ~13ms while the consumer's incidental first-call
    // overhead reached ~6.6ms — inside that version's 2× ratio. So the
    // slow op now spins until a wall-clock deadline: the producer's
    // timed window contains the whole spin by construction, on any
    // machine, and both sides are compared against that known duration
    // rather than against each other's jitter.
    const SPIN_MS = 30;
    const { registry, ran } = makeRegistry();
    registry.define({
      name: 'slow',
      family: 'test',
      summary: 'Deliberately expensive.',
      params: { ms: int({ min: 1, default: SPIN_MS }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        ran.n += 1;
        const until = performance.now() + (ctx.params['ms'] as number);
        let acc = 0;
        for (let i = 0; performance.now() < until; i += 1) acc += Math.sqrt(i);
        void acc;
        return values(ctx, 'source');
      },
    });
    const host = createHost({ registry, units }).add('prices', series(200));
    const slowInner = { op: 'slow', inputs: ['px'] };
    const fastOuter = { op: 'scale', params: { by: 2 }, inputs: [slowInner] };
    const res = host.run({
      from: 'prices',
      process: [fastOuter],
      select: [{ on: fold('last', fastOuter) }],
    });
    const [inner, outer] = res.nodes;
    expect(inner!.id).toBe(specId(registry, slowInner));
    // The producer's clock contains its own spin; the consumer's does
    // not. Mischarge the subtree and the spin lands on a consumer's
    // clock while the producer reads near zero — whichever side it
    // lands on, a bound catches it, and each bound has the full
    // SPIN_MS of headroom against jitter.
    expect(inner!.ms).toBeGreaterThanOrEqual(SPIN_MS);
    expect(outer!.ms).toBeLessThan(SPIN_MS);
  });

  it('charges a nested input its materialization, which is real cost', () => {
    // A nested input is appended onto the source before `run` is called,
    // so the studies can take (series, { column }). For a gapped column
    // that is a boxing pass ([PND-PROCCOL]'s documented fallback), and it
    // lands on the consumer's clock rather than the producer's. Worth
    // pinning so the badge is read correctly.
    const { registry } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(50_000));
    const nested = { op: 'scale', params: { by: 2 }, inputs: [sma3] };
    const res = host.run({
      from: 'prices',
      process: [nested],
      select: [{ on: fold('last', nested) }],
    });
    // Both do O(rows) work; neither is negligible.
    for (const n of res.nodes) expect(n.ms).toBeGreaterThan(0);
  });

  it('flips cached to true once warm, with a visible time difference', () => {
    const { registry } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(50_000));
    const req = {
      from: 'prices',
      process: [sma3],
      select: [{ on: fold('last', sma3) }],
    };
    const cold = host.run(req).nodes[0]!;
    // A warm pull's window is microseconds wide, so a single GC pause
    // landing inside it can outweigh the whole cold compute. Judging by
    // the fastest of five pulls makes that a five-way coincidence.
    const warms = Array.from({ length: 5 }, () => host.run(req).nodes[0]!);
    expect(cold.cached).toBe(false);
    for (const warm of warms) expect(warm.cached).toBe(true);
    expect(Math.min(...warms.map((w) => w.ms))).toBeLessThan(cold.ms);
  });
});

describe('toWire', () => {
  it('is a no-op on a facts-only response — already JSON-safe', () => {
    const { registry } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(10));
    const res = host.run({
      from: 'prices',
      process: [sma3],
      select: [{ on: fold('last', sma3) }],
    });
    const wire = toWire(res, 'last_30m');
    expect(wire.hasSeries).toBe(false);
    expect(wire.as).toBe('last_30m');
    expect(() => JSON.stringify(wire)).not.toThrow();
    expect(JSON.parse(JSON.stringify(wire)).facts).toEqual(res.facts);
  });

  it('drops the in-process series when columns were asked for', () => {
    const { registry } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(10));
    const res = host.run({
      from: 'prices',
      process: [sma3],
      select: [{ on: sma3 }],
    });
    expect(res.series).toBeDefined();
    const wire = toWire(res);
    expect('series' in wire).toBe(false);
    expect(wire.hasSeries).toBe(true);
    // `outputs` still names the columns, so a caller knows what it would
    // get if it fetched them another way.
    expect(Object.keys(wire.outputs)).toHaveLength(1);
    expect(() => JSON.stringify(wire)).not.toThrow();
  });

  it('carries the timings, which is what a badge renders from', () => {
    const { registry } = makeRegistry();
    const host = createHost({ registry, units }).add('prices', series(10));
    const req = {
      from: 'prices',
      process: [sma3],
      select: [{ on: fold('last', sma3) }],
    };
    host.run(req);
    const wire = toWire(host.run(req));
    expect(wire.nodes[0]).toMatchObject({ cached: true });
    expect(typeof wire.nodes[0]!.ms).toBe('number');
  });
});
