import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import * as exports from '../src/index.js';
import {
  bind,
  createRegistry,
  int,
  num,
  run,
  ParamError,
  ProcessError,
  specId,
  UnitError,
  UnknownColumnError,
  type OpDef,
  type Registry,
  type Spec,
  type ParamValue,
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

/**
 * A fold node over a spec — what a `reduce` selector used to be.
 *
 * Written out here rather than hidden in a helper file because the shape
 * is the point: a reduction is now an ordinary `{op, params, inputs}`
 * spec, which is why it gets an id, a cache entry and a badge like
 * everything else ([PND-PROCFOLD]).
 */
const fold = (
  op: string,
  on: Spec,
  params?: Record<string, ParamValue>,
  output?: string,
): Spec => ({
  op,
  ...(params !== undefined && { params }),
  inputs: [output === undefined ? on : { from: on, output }],
});

describe('run — resolution', () => {
  it('resolves a plan that arrived as a JSON string', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const plan = JSON.parse(
      '[{"op":"sma","params":{"period":3},"inputs":["px"]}]',
    ) as never;
    const res = run(graph, { plan, select: [{ on: fold('last', sma3) }] });
    expect(res.facts[0]).toMatchObject({
      op: 'last',
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
      select: [{ on: fold('last', sma3) }],
    });
    // Three plan entries' worth of specs, two distinct study nodes —
    // plus the fold, which is a node like any other now.
    expect(graph.ids).toHaveLength(3);
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
      select: [{ on: fold('last', sma3) }],
    });
    expect(res.nodes.map((n) => [n.id, n.pulled])).toEqual([
      [specId(registry, sma3), true],
      [specId(registry, fold('last', sma3)), true],
      [specId(registry, sma5), false],
    ]);
    // Reporting it costs nothing: the unselected op never ran.
    expect(ran['sma']).toBe(1);
    expect(res.nodes[2]).toMatchObject({ ms: 0, cached: false });
  });

  it('resolves a 2-input op across two branches', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const spread = { op: 'spread', inputs: [sma3, sma5] };
    const res = run(graph, {
      plan: [spread],
      select: [{ on: fold('last', spread) }],
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
      select: [{ on: 'p1:nope(px;)' }],
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

describe('run — a raw input must name a column of the bound series', () => {
  // The consumer case: a persisted plan cites a column the feed no longer
  // carries. Nothing checked it at compile OR at pull — the op simply ran
  // against an un-widened series, and an op that does not defend its own
  // inputs appended a plausible column of garbage under the spec's id,
  // with `skipped` empty and `onError` never engaged (Tidal,
  // `docs/notes/tidal-process-adoption-friction-2026-08.md`).

  /** An op that answers even when its input column is absent. */
  function lenientRegistry(): { registry: Registry; ran: () => number } {
    let runs = 0;
    const registry = makeRegistry().registry.define({
      name: 'filler',
      family: 'test',
      summary: 'Returns a constant for every row, reading nothing.',
      params: {},
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        runs += 1;
        return new Array<number>(ctx.series.length).fill(42);
      },
    });
    return { registry, ran: () => runs };
  }

  it('throws at compile, naming the input, the column and what is available', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    expect(() => graph.compile({ op: 'sma', inputs: ['nope'] })).toThrow(
      UnknownColumnError,
    );
    expect(() => graph.compile({ op: 'sma', inputs: ['nope'] })).toThrow(
      /'sma' names 'nope' for input 'source', which is not a column of the bound series — columns are 'px'/,
    );
  });

  it('routes into `skipped` rather than appending a garbage column', () => {
    const { registry, ran } = lenientRegistry();
    const graph = bind(series(10), { registry, units });
    const spec = { op: 'filler', inputs: ['nope'] };
    const res = run(graph, {
      plan: [spec],
      select: [{ on: spec }],
      onError: 'skip',
      assemble: false,
    });
    // Twice, as any unresolvable-but-selected spec is reported: once by
    // the plan pass, once by the selector that also named it.
    expect(res.skipped).toHaveLength(2);
    for (const entry of res.skipped) {
      expect(entry.reason).toMatch(/not a column of the bound series/);
    }
    // Echoed with its inputs, so a caller holding two specs of one op
    // knows which to fix — the resolution-failure shape, not a selector's.
    expect(res.skipped[0]!.spec?.inputs).toEqual(['nope']);
    expect(res.skipped[1]!.select).toBeDefined();
    expect(res.columns).toBeUndefined();
    expect(res.outputs).toEqual({});
    expect(ran()).toBe(0);
  });

  it('is caught before the unit check, whose answer would be misleading', () => {
    // `annualise` demands a 'variance' input. Reporting an absent column
    // as 'unitless' names the wrong problem.
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [{ op: 'annualise', inputs: ['nope'] }],
      onError: 'collect',
    });
    expect(res.skipped[0]!.reason).toMatch(/not a column of the bound series/);
    expect(res.skipped[0]!.reason).not.toMatch(/unitless/);
  });

  it('catches it inside a nested input, not just at the top level', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [
        {
          op: 'scale',
          inputs: [{ op: 'sma', params: { period: 3 }, inputs: ['nope'] }],
        },
      ],
      onError: 'collect',
    });
    expect(res.skipped[0]!.reason).toMatch(/'sma' names 'nope'/);
    expect(res.nodes).toHaveLength(0);
  });

  it('does not accept the key column, which is not readable as a value', () => {
    // `series.column('time')` is undefined at runtime and rejected at the
    // type level, so a plan naming it is broken either way — and
    // `expandSlots` already excludes it from the column list.
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    expect(() => graph.compile({ op: 'sma', inputs: ['time'] })).toThrow(
      UnknownColumnError,
    );
  });

  it('re-checks a WARM node after the schema drifts under it', () => {
    // The original bug surviving through the memo: `compile` returned the
    // cached node before looking at the current schema, and `setSource`
    // replacing the data under compiled nodes is a supported lifecycle
    // (`Host.add`, an async source refresh). Codex reproduced a column of
    // 42s with `skipped: []` after swapping the source (PR #667).
    const { registry, ran } = lenientRegistry();
    const graph = bind(series(10), { registry, units });
    const spec = { op: 'filler', inputs: ['px'] };
    run(graph, { plan: [spec], select: [{ on: spec }], assemble: false });
    expect(ran()).toBe(1);

    graph.setSource(
      TimeSeries.fromJSON({
        name: 'other',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'other', kind: 'number' },
        ] as const,
        rows: [[0, 1]],
      }) as never,
    );
    const res = run(graph, {
      plan: [spec],
      select: [{ on: spec }],
      onError: 'skip',
      assemble: false,
    });
    expect(res.skipped[0]!.code).toBe('UnknownColumnError');
    expect(res.columns).toBeUndefined();
    expect(ran()).toBe(1);
  });

  it('names the missing column even under a TYPED parent', () => {
    // The typed-unit pass resolves a nested input's unit before recursion
    // reaches the nested spec, so this surfaced as `UnitError` —
    // "is 'unitless'", which is true and names the wrong problem, and
    // misses the one class a consumer branches on (Codex, PR #667).
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    expect(() =>
      graph.compile({
        op: 'annualise',
        inputs: [{ op: 'sma', params: { period: 3 }, inputs: ['nope'] }],
      }),
    ).toThrow(UnknownColumnError);
  });

  it('gives the nested plan form the answer the slot form already gave', () => {
    // The asymmetry was the bug: one of two request forms caught this.
    const { registry } = lenientRegistry();
    const nested = run(bind(series(10), { registry, units }), {
      plan: [{ op: 'filler', inputs: ['nope'] }],
      onError: 'skip',
    });
    const slots = run(bind(series(10), { registry, units }), {
      nodes: { a: { op: 'filler', in: ['nope'] } },
      onError: 'skip',
    });
    expect(nested.skipped).toHaveLength(1);
    expect(slots.skipped).toHaveLength(1);
    for (const res of [nested, slots]) {
      expect(res.skipped[0]!.reason).toMatch(/'nope'/);
      expect(res.columns).toBeUndefined();
    }
  });
});

describe('run — a skip carries the failure kind, not just prose', () => {
  // `onError: 'skip' | 'collect'` throws nothing, so `instanceof` — the
  // right discriminator when a consumer catches — never reaches the
  // consumer that reads `skipped`. A UI branching on the kind (a dropped
  // feed column is a dimmed, removable chip; a bad persisted param is a
  // broken one) was left matching on the reason's prose (Tidal,
  // `docs/notes/tidal-process-adoption-friction-2026-08.md`).

  it('distinguishes a missing column from a bad param', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [
        { op: 'sma', inputs: ['nope'] },
        { op: 'sma', params: { period: 1 }, inputs: ['px'] },
      ],
      onError: 'collect',
    });
    expect(res.skipped.map((s) => s.code)).toEqual([
      'UnknownColumnError',
      'ParamError',
    ]);
  });

  it('names the kind for an unknown op, a bad unit and a bad slot alike', () => {
    const { registry } = makeRegistry();
    const codeFor = (request: Parameters<typeof run>[1]) =>
      run(bind(series(10), { registry, units }), request).skipped[0]?.code;
    expect(
      codeFor({ plan: [{ op: 'nope', inputs: ['px'] }], onError: 'skip' }),
    ).toBe('UnknownOpError');
    expect(
      codeFor({ plan: [{ op: 'annualise', inputs: ['px'] }], onError: 'skip' }),
    ).toBe('UnitError');
    expect(
      codeFor({
        nodes: { a: { op: 'sma', in: ['b'] } },
        onError: 'skip',
      }),
    ).toBe('SlotError');
  });

  it('reports the base kind for a plan-layer rejection with no class', () => {
    // Built rather than caught — a selector naming an output the node
    // does not declare. It is still the plan layer refusing, so it
    // carries a code like every other entry.
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: sma3, output: 'Upper' }],
      onError: 'collect',
    });
    expect(res.skipped[0]).toMatchObject({ code: 'ProcessError' });
  });

  it('leaves the code absent when op code threw, which is the signal', () => {
    // Not a plan-layer failure: the op itself blew up. A consumer
    // branching on kind should not see one of the library's own.
    const registry = makeRegistry().registry.define({
      name: 'boom',
      family: 'test',
      summary: 'Throws.',
      params: {},
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: () => {
        throw new TypeError('op exploded');
      },
    });
    const graph = bind(series(10), { registry, units });
    const spec = { op: 'boom', inputs: ['px'] };
    const res = run(graph, {
      plan: [spec],
      select: [{ on: spec }],
      onError: 'collect',
    });
    expect(res.skipped[0]!.reason).toBe('op exploded');
    expect(res.skipped[0]!.code).toBeUndefined();
  });

  it('throws the original class under the default policy', () => {
    // `fail` used to rebuild the error as a base `ProcessError` from its
    // message, so `run` erased exactly the class a consumer catches on —
    // while the docs claimed `code` matches what a throw would carry
    // (Codex, PR #667).
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    expect(() =>
      run(graph, { plan: [{ op: 'sma', inputs: ['nope'] }] }),
    ).toThrow(UnknownColumnError);
    expect(() =>
      run(graph, {
        plan: [{ op: 'sma', params: { period: 1 }, inputs: ['px'] }],
      }),
    ).toThrow(ParamError);
    expect(() =>
      run(graph, { plan: [{ op: 'annualise', inputs: ['px'] }] }),
    ).toThrow(UnitError);
  });

  it('is a literal per class, so a minifier cannot rename it', () => {
    // `constructor.name` would be `'t'` in a consumer's production
    // build — silently, which is the bug this string exists to avoid.
    expect(UnknownColumnError.code).toBe('UnknownColumnError');
    expect(new UnknownColumnError('x').code).toBe('UnknownColumnError');
    expect(new ProcessError('x').code).toBe('ProcessError');
  });

  it('is declared by EVERY exported error class, not inherited', () => {
    // A subclass that forgets silently reports its parent's code, so a
    // consumer's branch quietly lands on the wrong arm. Nothing can force
    // the declaration at the type level — this is the guard (raised by
    // the Layer 2 review of PR #667).
    const classes = Object.entries(exports as Record<string, unknown>).filter(
      (entry): entry is [string, typeof ProcessError] =>
        typeof entry[1] === 'function' &&
        entry[1].prototype instanceof ProcessError,
    );
    expect(classes.length).toBeGreaterThan(8);
    for (const [name, cls] of classes) {
      expect([name, cls.code]).toEqual([name, name]);
      expect(new cls('x').code).toBe(name);
    }
  });
});

describe('run — the terminal', () => {
  it('builds no series when only facts were asked for', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: fold('last', sma3) }],
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
      select: [{ on: sma3 }, { on: band }],
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
      select: [{ on: sma3 }, { on: fold('last', sma5) }],
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
      select: [{ on: band }],
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
      select: [{ on: fold('last', band, undefined, 'Upper') }],
    });
    expect(res.facts[0]).toMatchObject({ value: 21 }); // last px 19 + 2
  });

  it('accepts a selector citing an id string, which is all a JSON caller has', () => {
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const latest = fold('last', sma3);
    const id = specId(registry, latest);
    const res = run(graph, {
      plan: [latest],
      select: [{ on: id }],
    });
    // A fold's id is a citation like any other, so a follow-up can name
    // the fact the last response returned.
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
      select: [{ on: fold('last', sma3) }],
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
      select: [{ on: fold('extremes', sma3) }],
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
      select: [{ on: fold('shape', sma3, { points: 3 }) }],
    });
    expect(res.facts[0]!['points'] as number).toBeLessThanOrEqual(3);
  });

  it('shape holds its bound when the series is under 2× the request', () => {
    // The floor() stride rounded to 1 whenever length < 2·points, so a
    // 200-point request over 399 rows returned all 399 — the token bound
    // is the fold's whole purpose.
    const { registry } = makeRegistry();
    const graph = bind(series(399), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: fold('shape', sma3, { points: 200 }) }],
    });
    const points = res.facts[0]!['points'] as number;
    expect(points).toBeLessThanOrEqual(200);
    // Bounded, not starved: a stride of ceil(399/200)=2 still samples
    // the whole series.
    expect(points).toBeGreaterThan(150);
  });

  it('a facts-only response is JSON-safe by construction', () => {
    const { graph } = setup();
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: fold('extremes', sma3) }],
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
      select: [{ on: fold('last', sma3) }],
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
      {
        id: specId(registry, fold('last', sma3)),
        pulled: true,
        cached: false,
        ms: expect.any(Number),
        inputs: [specId(registry, sma3)],
      },
    ]);
    // Both warm on the repeat — including the fold, which is the whole
    // point of [PND-PROCFOLD]. The reduction used to rescan 150,000
    // values here and report nothing about having done so.
    expect(second.nodes.map((n) => n.cached)).toEqual([true, true]);
    expect(ran['sma']).toBe(1);
  });

  it('recomputes when the bound data changes', () => {
    const { registry, ran } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const req = {
      plan: [sma3],
      select: [{ on: fold('last', sma3) }],
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
      select: [{ on: fold('last', sma3) }],
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
      select: [{ on: sma3 }],
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
      select: [{ on: bb }],
    });
    const id = specId(registry, bb);
    expect(Object.keys(res.columns!).sort()).toEqual(
      [`${id}Lower`, `${id}Middle`, `${id}Upper`].sort(),
    );
  });

  it('reports several selectors on one node but materializes each column once', () => {
    const { registry, ran } = makeRegistry();
    const graph = bind(series(50), { registry, units });
    const bb = { op: 'band', params: { width: 2 }, inputs: ['px'] };
    const res = run(graph, {
      plan: [bb],
      select: [
        { on: bb, name: 'bands' },
        { on: bb, output: 'Upper', name: 'upper' },
      ],
    });
    const id = specId(registry, bb);

    expect(res.outputs[id]!.map((output) => output.name)).toEqual([
      'bands',
      'bands',
      'bands',
      'upper',
    ]);
    expect(Object.keys(res.columns!)).toHaveLength(3);
    expect(ran['band']).toBe(1);
    expect(res.nodes.filter((node) => node.id === id)).toHaveLength(1);
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
      select: [{ on: sma3 } as const],
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
      select: [{ on: fold('last', sma3) }],
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
      select: [{ on: fold('last', sma5) }],
      onError: 'collect',
    });
    expect(res.skipped).toEqual([]);
    expect(res.facts[0]).toMatchObject({
      id: specId(registry, fold('last', sma5)),
      value: 17,
    });
    // And it is a node like any other, so the badge row reports it —
    // both the study the selector implied and the fold over it.
    expect(res.nodes.map((n) => n.id)).toContain(specId(registry, sma5));
  });

  it('still refuses an id string naming nothing', () => {
    // A string cannot describe a computation, so there is nothing to
    // resolve — the reason has to stay.
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [{ on: 'p1:nope(px;)' }],
      onError: 'collect',
    });
    expect(res.skipped[0]!.reason).toMatch(/not in this plan/);
  });

  it('gives columns and a fact in one pass, from two selectors', () => {
    // The legend-chip case: a fact riding alongside the columns it
    // labels. It used to be one selector in two modes; it is two
    // selectors now, pointing at two nodes, which is what makes the
    // fact cacheable rather than recomputed beside the draw.
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [sma3],
      select: [
        { on: sma3, name: 'curve' },
        { on: fold('last', sma3), name: 'now' },
      ],
    });
    expect(res.columns).toBeDefined();
    expect(res.outputs[specId(registry, sma3)]).toHaveLength(1);
    expect(res.facts[0]).toMatchObject({
      name: 'now',
      op: 'last',
      value: 18,
    });
    // One pull of the study, shared by both.
    expect(
      res.nodes.filter((n) => n.id === specId(registry, sma3)),
    ).toHaveLength(1);
  });
});

describe('run — typed inputs check the picked output, not output 0', () => {
  // A multi-output op whose first output does NOT carry the interesting
  // unit, so a check that always reads output 0 fails in both
  // directions from here.
  const setup = () => {
    const { registry } = makeRegistry();
    registry.define({
      name: 'stats',
      family: 'summary',
      summary: 'Average, and variance beside it.',
      params: {},
      inputs: [{ role: 'source' }],
      outputs: [
        { id: 'Avg', unit: 'inherit' },
        { id: 'Var', unit: 'variance' },
      ],
      run: (ctx) => {
        const v = values(ctx, 'source');
        return [v, v.map((x) => (x === undefined ? undefined : x * x))];
      },
    });
    return { registry, graph: bind(series(10), { registry, units }) };
  };
  const stats: Spec = { op: 'stats', inputs: ['px'] };

  it('accepts a picked output whose unit matches the demand', () => {
    // Used to be REJECTED: the check resolved output 0 ('Avg' → '%')
    // for an input that picked 'Var'.
    const { graph } = setup();
    const annualised: Spec = {
      op: 'annualise',
      inputs: [{ from: stats, output: 'Var' }],
    };
    const res = run(graph, {
      plan: [annualised],
      select: [{ on: fold('last', annualised) }],
    });
    expect(res.skipped).toHaveLength(0);
    expect(res.facts).toHaveLength(1);
  });

  it('rejects a picked output whose unit does not match', () => {
    // The silent direction, which is the worse one: an op demanding '%'
    // fed the 'Var' output used to pass — the check read 'Avg' — and the
    // computation ran on wrong-unit data.
    const { registry, graph } = setup();
    registry.define({
      name: 'pct',
      family: 'transform',
      summary: 'Demands a % input.',
      params: {},
      inputs: [{ role: 'source', unit: '%' }],
      outputs: [{ id: '', unit: '%' }],
      run: (ctx) => values(ctx, 'source'),
    });
    const res = run(graph, {
      plan: [{ op: 'pct', inputs: [{ from: stats, output: 'Var' }] }],
      onError: 'collect',
    });
    expect(res.skipped[0]!.reason).toMatch(/needs a '%' input/);
    expect(res.skipped[0]!.reason).toMatch(/#Var' is 'variance'/);
  });
});

describe('run — an op result must match the series length', () => {
  const short = (registry: Registry): Spec => {
    registry.define({
      name: 'halve',
      family: 'broken',
      summary: 'Returns half the rows it was given.',
      params: {},
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => values(ctx, 'source').slice(0, 5),
    });
    return { op: 'halve', inputs: ['px'] };
  };

  it('rejects a short output even when nothing assembles', () => {
    // Assembly's own length check used to be the only thing catching
    // this, so `assemble: false` — the wire path — returned the short
    // column as a success.
    const { registry } = makeRegistry();
    const spec = short(registry);
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [spec],
      select: [{ on: spec }],
      assemble: false,
      onError: 'collect',
    });
    expect(res.skipped[0]!.reason).toMatch(/returned 5 row\(s\)/);
    expect(res.skipped[0]!.reason).toMatch(/expected 10/);
    expect(res.columns).toEqual({});
  });

  it('throws it under the default policy', () => {
    const { registry } = makeRegistry();
    const spec = short(registry);
    const graph = bind(series(10), { registry, units });
    expect(() =>
      run(graph, { plan: [spec], select: [{ on: spec }], assemble: false }),
    ).toThrow(/expected 10/);
  });
});

describe('run — the error policy covers column execution', () => {
  const boom = (registry: Registry): Spec => {
    registry.define({
      name: 'boom',
      family: 'broken',
      summary: 'Throws mid-kernel.',
      params: {},
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: () => {
        throw new Error('kernel exploded');
      },
    });
    return { op: 'boom', inputs: ['px'] };
  };

  it('collects an operator exception instead of escaping the policy', () => {
    // The fact loop honoured `onError`; the column loop did not, so the
    // same failing op was a `skipped` entry when surfaced as a fact and
    // an escaped throw when surfaced as columns.
    const { registry } = makeRegistry();
    const spec = boom(registry);
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      plan: [spec],
      select: [{ on: spec }],
      onError: 'collect',
    });
    expect(res.skipped[0]!.reason).toMatch(/kernel exploded/);
  });

  it('propagates the original error under the default policy', () => {
    const { registry } = makeRegistry();
    const spec = boom(registry);
    const graph = bind(series(10), { registry, units });
    expect(() => run(graph, { plan: [spec], select: [{ on: spec }] })).toThrow(
      'kernel exploded',
    );
  });

  it('reports a selector naming an output the node does not declare', () => {
    // This used to filter every declared output and surface NOTHING —
    // no columns, no error, no skipped entry.
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const band: Spec = { op: 'band', inputs: [sma3] };
    const res = run(graph, {
      plan: [band],
      select: [{ on: band, output: 'Nope' }],
      onError: 'collect',
    });
    expect(res.skipped[0]!.reason).toMatch(
      /has no output 'Nope' \(has 'Upper', 'Middle', 'Lower'\)/,
    );
  });
});

describe('run — slot attribution is declaration-order deterministic', () => {
  it('labels a computation with the first slot that names it', () => {
    // The registry-free builder cannot resolve defaults, so `shape()`
    // and `shape({points: 40})` arrive as two slots for ONE computation
    // (specId resolves defaults). Attribution used to depend on which
    // slot happened to be declared last.
    const { registry } = makeRegistry();
    const graph = bind(series(10), { registry, units });
    const res = run(graph, {
      nodes: {
        s: { op: 'sma', params: { period: 3 }, in: ['px'] },
        first: { op: 'shape', in: ['s'] },
        second: { op: 'shape', params: { points: 40 }, in: ['s'] },
      },
      outputs: { a: { on: 'first' }, b: { on: 'second' } },
    });
    const folds = res.nodes.filter((n) => n.id.includes('shape'));
    expect(folds).toHaveLength(1);
    expect(folds[0]!.slot).toBe('first');
    // Both caller names still answer, off the one node.
    expect(res.facts.map((f) => f.name).sort()).toEqual(['a', 'b']);
  });
});

describe('run — fact provenance wins over the fold body', () => {
  it('drops reserved keys a custom fold returns', () => {
    // `id`, `name`, `op` and `unit` are the graph's to state — a fold
    // body spread over them could masquerade as another node or forge a
    // unit, and `name` could claim a caller-name the caller never gave.
    const { registry } = makeRegistry();
    registry.define({
      kind: 'fold',
      name: 'impostor',
      family: 'read',
      summary: 'Returns forged provenance fields beside a real value.',
      params: {},
      inputs: [{ role: 'source' }],
      unit: 'inherit',
      fold: () => ({
        id: 'forged',
        name: 'forged',
        op: 'forged',
        unit: 'forged',
        value: 7,
      }),
    });
    const graph = bind(series(10), { registry, units });
    const sel = fold('impostor', sma3);
    const res = run(graph, { plan: [sma3], select: [{ on: sel }] });
    expect(res.facts[0]).toMatchObject({
      id: specId(registry, sel),
      op: 'impostor',
      unit: '%',
      value: 7,
    });
    expect(res.facts[0]!.name).toBeUndefined();
  });
});
