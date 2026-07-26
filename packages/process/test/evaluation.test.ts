import { describe, expect, it, vi } from 'vitest';
import { derive, port, defineNode, source } from '../src/index.js';

describe('pull evaluation', () => {
  it('computes on demand and caches until an input changes', () => {
    const a = source<number>();
    const b = source<number>();
    const compute = vi.fn(({ x, y }: { x: number; y: number }) => x + y);
    const sum = derive({ x: a.out.value, y: b.out.value }, compute);

    a.set(2);
    b.set(3);

    expect(sum.out.value.get()).toBe(5);
    expect(compute).toHaveBeenCalledTimes(1);

    // Repeated pulls are cache hits.
    expect(sum.out.value.get()).toBe(5);
    expect(sum.out.value.get()).toBe(5);
    expect(compute).toHaveBeenCalledTimes(1);

    a.set(10);
    expect(sum.out.value.get()).toBe(13);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('does not compute anything until something is pulled', () => {
    const a = source<number>({ initial: 1 });
    const compute = vi.fn((v: { x: number }) => v.x * 2);
    derive({ x: a.out.value }, compute);

    a.set(5);
    expect(compute).not.toHaveBeenCalled();
  });

  it('evaluates a diamond once per node, not once per path', () => {
    const root = source<number>({ initial: 1 });
    const leftFn = vi.fn(({ x }: { x: number }) => x + 1);
    const rightFn = vi.fn(({ x }: { x: number }) => x * 2);
    const joinFn = vi.fn(({ l, r }: { l: number; r: number }) => l + r);

    const left = derive({ x: root.out.value }, leftFn);
    const right = derive({ x: root.out.value }, rightFn);
    const joined = derive({ l: left.out.value, r: right.out.value }, joinFn);

    expect(joined.out.value.get()).toBe(4); // (1+1) + (1*2)
    expect(leftFn).toHaveBeenCalledTimes(1);
    expect(rightFn).toHaveBeenCalledTimes(1);
    expect(joinFn).toHaveBeenCalledTimes(1);

    root.set(3);
    expect(joined.out.value.get()).toBe(10); // (3+1) + (3*2)
    expect(leftFn).toHaveBeenCalledTimes(2);
    expect(rightFn).toHaveBeenCalledTimes(2);
    expect(joinFn).toHaveBeenCalledTimes(2);
  });

  it('supports multi-output nodes, computing once for all outputs', () => {
    const compute = vi.fn(({ values }: { values: readonly number[] }) => ({
      min: Math.min(...values),
      max: Math.max(...values),
    }));
    const Extent = defineNode({
      kind: 'extent',
      inputs: { values: port<readonly number[]>() },
      outputs: { min: port<number>(), max: port<number>() },
      compute,
    });

    const data = source<readonly number[]>({ initial: [3, 1, 4] });
    const extent = Extent();
    data.out.value.connect(extent.in.values);

    expect(extent.out.min.get()).toBe(1);
    expect(extent.out.max.get()).toBe(4);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

describe('change cutoff', () => {
  it('stops the cascade when a recomputed value is unchanged', () => {
    const raw = source<number>();
    // Bucket to the nearest ten: distinct inputs collapse to one output.
    const bucket = derive({ x: raw.out.value }, ({ x }) => Math.floor(x / 10), {
      equals: (a, b) => a === b,
    });
    const expensiveFn = vi.fn(({ b }: { b: number }) => b * 100);
    const expensive = derive({ b: bucket.out.value }, expensiveFn);

    raw.set(11);
    expect(expensive.out.value.get()).toBe(100);
    expect(expensiveFn).toHaveBeenCalledTimes(1);

    // Different source value, same bucket — downstream must not rerun.
    raw.set(13);
    expect(expensive.out.value.get()).toBe(100);
    expect(expensiveFn).toHaveBeenCalledTimes(1);

    raw.set(25);
    expect(expensive.out.value.get()).toBe(200);
    expect(expensiveFn).toHaveBeenCalledTimes(2);
  });

  it('treats an identical set() on a source as no change', () => {
    const a = source<number>({ equals: (x, y) => x === y });
    const fn = vi.fn(({ x }: { x: number }) => x * 2);
    const doubled = derive({ x: a.out.value }, fn);

    a.set(4);
    expect(doubled.out.value.get()).toBe(8);
    expect(fn).toHaveBeenCalledTimes(1);

    a.set(4);
    expect(doubled.out.value.get()).toBe(8);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses Object.is by default, so identical object references cut off', () => {
    const shared = { n: 1 };
    const a = source<{ n: number }>();
    const passthrough = derive({ x: a.out.value }, ({ x }) => x);
    const fn = vi.fn(({ x }: { x: { n: number } }) => x.n);
    const consumer = derive({ x: passthrough.out.value }, fn);

    a.set(shared);
    expect(consumer.out.value.get()).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);

    // A new source generation carrying the same reference through.
    a.invalidate();
    expect(consumer.out.value.get()).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('bumps the outlet version only on real changes', () => {
    const a = source<number>({ equals: (x, y) => x === y });
    a.set(1);
    a.out.value.get();
    const first = a.out.value.version;

    a.set(1);
    a.out.value.get();
    expect(a.out.value.version).toBe(first);

    a.set(2);
    a.out.value.get();
    expect(a.out.value.version).toBe(first + 1);
  });
});

describe('dirty marking', () => {
  it('marks transitively downstream and clears on pull', () => {
    const a = source<number>({ initial: 1 });
    const b = derive({ x: a.out.value }, ({ x }) => x + 1);
    const c = derive({ x: b.out.value }, ({ x }) => x + 1);

    c.out.value.get();
    expect(b.dirty).toBe(false);
    expect(c.dirty).toBe(false);

    a.set(5);
    expect(b.dirty).toBe(true);
    expect(c.dirty).toBe(true);

    c.out.value.get();
    expect(c.dirty).toBe(false);
  });

  it('peek() reads the cache without evaluating', () => {
    const a = source<number>({ initial: 2 });
    const fn = vi.fn(({ x }: { x: number }) => x * 3);
    const b = derive({ x: a.out.value }, fn);

    expect(b.out.value.peek()).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();

    expect(b.out.value.get()).toBe(6);
    expect(b.out.value.peek()).toBe(6);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
