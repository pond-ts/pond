import { describe, expect, it } from 'vitest';
import {
  CycleError,
  Graph,
  MissingOutputError,
  UnconnectedInputError,
  UnsetSourceError,
  defineNode,
  derive,
  port,
  source,
} from '../src/index.js';

const Add = defineNode({
  kind: 'add',
  inputs: { a: port<number>(), b: port<number>() },
  outputs: { sum: port<number>() },
  compute: ({ a, b }) => ({ sum: a + b }),
});

describe('type safety', () => {
  it('rejects mismatched port types at compile time', () => {
    const text = source<string>({ initial: 'hello' });
    const add = Add();

    // @ts-expect-error string outlet cannot feed a number inlet
    text.out.value.connect(add.in.a);
    // @ts-expect-error same mismatch, asserted from the inlet side
    add.in.b.connect(text.out.value);

    // The runtime is unguarded by design — the compiler is the gate.
    expect(add.in.a.connected).toBe(true);
  });

  it('rejects an unknown port name at compile time', () => {
    const add = Add();
    // @ts-expect-error 'nope' is not a declared input
    expect(add.in.nope).toBeUndefined();
    // @ts-expect-error 'total' is not a declared output
    expect(add.out.total).toBeUndefined();
  });

  it('accepts matching types', () => {
    const a = source<number>({ initial: 2 });
    const b = source<number>({ initial: 3 });
    const add = Add();

    a.out.value.connect(add.in.a);
    b.out.value.connect(add.in.b);

    expect(add.out.sum.get()).toBe(5);
  });
});

describe('connection management', () => {
  it('replaces an existing connection when an inlet is rewired', () => {
    const a = source<number>({ initial: 1 });
    const b = source<number>({ initial: 100 });
    const double = derive({ x: a.out.value }, ({ x }) => x * 2);

    expect(double.out.value.get()).toBe(2);

    b.out.value.connect(double.in.x);
    expect(double.out.value.get()).toBe(200);
    expect(a.out.value.connections).toHaveLength(0);
    expect(b.out.value.connections).toHaveLength(1);

    // Both outlets sit at the same version here, which is the case that
    // makes rewiring invisible to a pure version check — hence the
    // structural `invalidate()` in `link()`. Pin the coincidence so a
    // future refactor back to `markDirty()` fails loudly.
    expect(a.out.value.version).toBe(b.out.value.version);
  });

  it('is idempotent when the same edge is connected twice', () => {
    const a = source<number>({ initial: 1 });
    const add = Add();
    a.out.value.connect(add.in.a);
    a.out.value.connect(add.in.a);

    expect(a.out.value.connections).toHaveLength(1);
  });

  it('throws when pulling through an unconnected input', () => {
    const add = Add();
    expect(() => add.out.sum.get()).toThrow(UnconnectedInputError);
    expect(() => add.out.sum.get()).toThrow(/'a' of node 'add'/);
  });

  it('falls back to a declared default when unconnected', () => {
    const WithDefault = defineNode({
      kind: 'scale',
      inputs: { x: port<number>(), factor: port<number>({ defaultValue: 2 }) },
      outputs: { value: port<number>() },
      compute: ({ x, factor }) => ({ value: x * factor }),
    });
    const a = source<number>({ initial: 5 });
    const scale = WithDefault();
    a.out.value.connect(scale.in.x);

    expect(scale.out.value.get()).toBe(10);

    const factor = source<number>({ initial: 10 });
    factor.out.value.connect(scale.in.factor);
    expect(scale.out.value.get()).toBe(50);

    scale.in.factor.disconnect();
    expect(scale.out.value.get()).toBe(10);
  });

  it('recomputes after a disconnect', () => {
    const a = source<number>({ initial: 1 });
    const add = Add();
    const b = source<number>({ initial: 2 });
    a.out.value.connect(add.in.a);
    b.out.value.connect(add.in.b);
    expect(add.out.sum.get()).toBe(3);

    add.in.b.disconnect();
    expect(() => add.out.sum.get()).toThrow(UnconnectedInputError);
  });
});

describe('cycle rejection', () => {
  it('rejects a self-loop', () => {
    const passthrough = defineNode({
      kind: 'passthrough',
      inputs: { x: port<number>() },
      outputs: { value: port<number>() },
      compute: ({ x }) => ({ value: x }),
    })();

    expect(() => passthrough.out.value.connect(passthrough.in.x)).toThrow(
      CycleError,
    );
  });

  it('rejects a longer cycle at the connecting call, not at evaluation', () => {
    const a = source<number>({ initial: 1 });
    const b = derive({ x: a.out.value }, ({ x }) => x + 1);
    const c = derive({ x: b.out.value }, ({ x }) => x + 1);

    expect(() => c.out.value.connect(b.in.x)).toThrow(CycleError);
    expect(() => c.out.value.connect(b.in.x)).toThrow(/would create a cycle/);

    // The graph is untouched and still evaluates.
    expect(c.out.value.get()).toBe(3);
  });

  it('allows a diamond, which is not a cycle', () => {
    const root = source<number>({ initial: 1 });
    const left = derive({ x: root.out.value }, ({ x }) => x + 1);
    const right = derive({ x: root.out.value }, ({ x }) => x * 2);
    const add = Add();

    expect(() => {
      left.out.value.connect(add.in.a);
      right.out.value.connect(add.in.b);
    }).not.toThrow();
    expect(add.out.sum.get()).toBe(4);
  });
});

describe('compute errors', () => {
  it('caches the error and rethrows without recomputing', () => {
    let calls = 0;
    const a = source<number>({ initial: 1 });
    const boom = derive({ x: a.out.value }, () => {
      calls += 1;
      throw new Error('boom');
    });

    expect(() => boom.out.value.get()).toThrow('boom');
    expect(() => boom.out.value.get()).toThrow('boom');
    expect(calls).toBe(1);
    expect(boom.error).toBeInstanceOf(Error);

    a.set(2);
    expect(() => boom.out.value.get()).toThrow('boom');
    expect(calls).toBe(2);
  });

  it('clears the error once compute succeeds again', () => {
    const a = source<number>({ initial: 0 });
    const guarded = derive({ x: a.out.value }, ({ x }) => {
      if (x === 0) throw new Error('divide by zero');
      return 100 / x;
    });

    expect(() => guarded.out.value.get()).toThrow('divide by zero');
    a.set(4);
    expect(guarded.out.value.get()).toBe(25);
    expect(guarded.error).toBeUndefined();
  });

  it('propagates an upstream error through downstream nodes', () => {
    const a = source<number>({ initial: 1 });
    const broken = derive({ x: a.out.value }, (): number => {
      throw new Error('upstream failed');
    });
    const downstream = derive({ x: broken.out.value }, ({ x }) => x);

    expect(() => downstream.out.value.get()).toThrow('upstream failed');
  });

  it('reports a compute that omits a declared output', () => {
    const Bad = defineNode({
      kind: 'bad',
      inputs: {},
      outputs: { a: port<number>(), b: port<number>() },
      // Deliberately incomplete — the runtime guard is the subject here.
      compute: () => ({ a: 1 }) as { a: number; b: number },
    });
    const bad = Bad();
    expect(() => bad.out.b.get()).toThrow(MissingOutputError);
    expect(() => bad.out.b.get()).toThrow(/did not return output 'b'/);
  });
});

describe('sources', () => {
  it('throws a named error when pulled before a value is set', () => {
    const unset = source<number>();
    expect(() => unset.out.value.get()).toThrow(UnsetSourceError);
    expect(() => unset.out.value.get()).toThrow(/call set\(\)/);

    unset.set(7);
    expect(unset.out.value.get()).toBe(7);
  });

  it('exposes the current value without evaluating', () => {
    const a = source<number>();
    expect(a.value).toBeUndefined();
    a.set(3);
    expect(a.value).toBe(3);
    expect(a.out.value.peek()).toBeUndefined(); // not pulled yet
  });

  it('treats an explicit initial value as set', () => {
    const a = source<number>({ initial: 0 });
    expect(a.out.value.get()).toBe(0);
  });
});

describe('graph inspection', () => {
  it('discovers every reachable node from any starting point', () => {
    const a = source<number>({ initial: 1, kind: 'a' });
    const b = source<number>({ initial: 2, kind: 'b' });
    const add = Add();
    a.out.value.connect(add.in.a);
    b.out.value.connect(add.in.b);
    const scaled = derive({ x: add.out.sum }, ({ x }) => x * 10, {
      kind: 'scale',
    });

    // Starting from the middle still finds sources and sinks.
    const graph = Graph.from(add);
    expect(graph.nodes).toHaveLength(4);
    expect(new Set(graph.nodes.map((n) => n.kind))).toEqual(
      new Set(['a', 'b', 'add', 'scale']),
    );
    expect(graph.edges()).toHaveLength(3);
    expect(scaled.out.value.get()).toBe(30);
  });

  it('sorts only the nodes it was given, ignoring outside dependencies', () => {
    const a = source<number>({ initial: 1, kind: 'a' });
    const b = derive({ x: a.out.value }, ({ x }) => x + 1, { kind: 'b' });

    // `b` alone: its dependency `a` is outside this graph and must not be
    // pulled into the ordering.
    const order = new Graph([b]).order();
    expect(order).toEqual([b]);
  });

  it('orders nodes so dependencies come first', () => {
    const a = source<number>({ initial: 1, kind: 'a' });
    const b = derive({ x: a.out.value }, ({ x }) => x + 1, { kind: 'b' });
    const c = derive({ x: b.out.value }, ({ x }) => x + 1, { kind: 'c' });

    const order = Graph.from(c).order();
    const kinds = order.map((node) => node.kind);
    expect(kinds.indexOf('a')).toBeLessThan(kinds.indexOf('b'));
    expect(kinds.indexOf('b')).toBeLessThan(kinds.indexOf('c'));
  });

  it('dumps structure as JSON', () => {
    const a = source<number>({ initial: 1, kind: 'input' });
    const doubled = derive({ x: a.out.value }, ({ x }) => x * 2, {
      kind: 'double',
    });

    const json = Graph.from(doubled).toJSON();
    expect(json.nodes).toEqual([
      { id: a.id, kind: 'input', inputs: [], outputs: ['value'] },
      { id: doubled.id, kind: 'double', inputs: ['x'], outputs: ['value'] },
    ]);
    expect(json.edges).toEqual([
      {
        from: { node: a.id, port: 'value' },
        to: { node: doubled.id, port: 'x' },
      },
    ]);
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});
