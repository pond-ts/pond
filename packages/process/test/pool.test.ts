import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bind, run } from '../src/index.js';
import type { RunResult } from '../src/index.js';
import type { HostPool as HostPoolType } from '../src/pool/index.js';

/**
 * [PND-PROCPAR] — `HostPool`, whole requests across resident workers.
 *
 * **The pool under test is loaded from `dist/`, deliberately.** A worker
 * is a real Node thread and cannot load TypeScript, so the pool locates
 * its worker entry relative to its own module — and imported from
 * `src/`, that resolves to a `.ts` file no worker can execute. (The pool
 * now says so with a named error rather than hanging; that behaviour is
 * itself pinned below.) `npm test` builds before `test:runtime` via
 * `test:dts`, so the artifact is always present.
 *
 * The reference answer, by contrast, is computed from `src/` in this
 * isolate — so the identity assertion compares the built worker path
 * against the source path, which is the comparison worth making.
 *
 * The load-bearing assertion is **identity**: an answer routed through a
 * worker must equal the answer computed in-process, cell for cell. A
 * pool that returns *nearly* the right column is worse than no pool.
 */

const SETUP = new URL('./fixtures/pool-setup.mjs', import.meta.url);
const DIST = new URL('../dist/pool/index.js', import.meta.url);

/** The built pool — see the note above on why this is not `src/`. */
async function loadPool(): Promise<typeof HostPoolType> {
  const module = (await import(DIST.href)) as {
    HostPool: typeof HostPoolType;
  };
  return module.HostPool;
}

const ROWS = 64;
const PLAN = [
  { op: 'sma', params: { period: 3 }, inputs: ['px'] },
  { op: 'band', params: { width: 2 }, inputs: ['px'] },
];
const SELECT = [{ on: { op: 'sma', params: { period: 3 }, inputs: ['px'] } }];

/** The same request, computed in this isolate, as the reference answer. */
async function inProcess(): Promise<RunResult> {
  const fixture = (await import(SETUP.href)) as {
    default: (o?: unknown) => { registry: never };
    makeSeries: (n: number) => never;
  };
  const { registry } = fixture.default({ rows: ROWS });
  const graph = bind(fixture.makeSeries(ROWS), { registry });
  return run(graph, { plan: PLAN, select: SELECT, assemble: false });
}

function cells(result: RunResult, name: string): (number | undefined)[] {
  const column = result.columns?.[name];
  if (column === undefined) {
    throw new Error(
      `no column '${name}' in ${Object.keys(result.columns ?? {}).join(', ')}`,
    );
  }
  const at = column as unknown as { at(i: number): number | undefined };
  return Array.from({ length: column.length }, (_, i) => at.at(i));
}

describe('HostPool', () => {
  let HostPool: typeof HostPoolType;
  let pool: HostPoolType;

  beforeAll(async () => {
    if (!existsSync(fileURLToPath(DIST))) {
      throw new Error(
        'pool tests need dist/ — run `npm run build` first (npm test does)',
      );
    }
    HostPool = await loadPool();
    pool = await HostPool.start({
      setup: SETUP,
      size: 2,
      setupOptions: { rows: ROWS },
    });
  });

  afterAll(async () => {
    await pool?.close();
  });

  it('answers identically to running in-process', async () => {
    const expected = await inProcess();
    const actual = await pool.run({
      from: 'px',
      process: PLAN,
      select: SELECT,
    });

    const name = Object.keys(expected.columns ?? {})[0]!;
    expect(Object.keys(actual.columns ?? {})).toEqual([name]);
    // Cell for cell, including the `undefined` warm-up head.
    expect(cells(actual, name)).toEqual(cells(expected, name));
    expect(actual.outputs).toEqual(expected.outputs);
    expect(actual.explain).toEqual(expected.explain);
    expect(actual.skipped).toEqual([]);
  });

  it('round-trips a gapped column with its validity intact', async () => {
    // `sma(period: 3)` has a two-cell undefined warm-up, so this answer
    // travels as values + bitmap. A bitmap dropped in transit would show
    // up as `100`-ish numbers where `undefined` belongs.
    const result = await pool.run({
      from: 'px',
      process: PLAN,
      select: SELECT,
    });
    const values = cells(result, Object.keys(result.columns ?? {})[0]!);
    expect(values.slice(0, 2)).toEqual([undefined, undefined]);
    expect(values[2]).toBeTypeOf('number');
    expect(values).toHaveLength(ROWS);
  });

  it('carries every output of a multi-output node', async () => {
    const band = { op: 'band', params: { width: 2 }, inputs: ['px'] };
    const result = await pool.run({
      from: 'px',
      process: [band],
      select: [{ on: band }],
    });
    const names = Object.keys(result.columns ?? {});
    expect(names).toHaveLength(3);
    const [upper, middle, lower] = names.map((n) => cells(result, n));
    // Upper/lower straddle the middle by the width, which pins that the
    // three buffers did not get shuffled on the way back.
    expect(upper![10]! - middle![10]!).toBeCloseTo(2, 10);
    expect(middle![10]! - lower![10]!).toBeCloseTo(2, 10);
  });

  it('serves concurrent requests and reports them in flight', async () => {
    const requests = Array.from({ length: 6 }, () =>
      pool.run({ from: 'px', process: PLAN, select: SELECT }),
    );
    expect(pool.inFlight).toBe(6);
    const results = await Promise.all(requests);
    expect(pool.inFlight).toBe(0);
    // Every answer is the same answer — routing must not perturb it.
    const first = cells(
      results[0]!,
      Object.keys(results[0]!.columns ?? {})[0]!,
    );
    for (const result of results) {
      expect(cells(result, Object.keys(result.columns ?? {})[0]!)).toEqual(
        first,
      );
    }
  });

  it('keeps its hosts warm across requests', async () => {
    // The whole reason a worker holds a long-lived Host. Ask the same
    // question twice on a pinned worker: the second must report cached.
    const envelope = { from: 'px', process: PLAN, select: SELECT } as const;
    await pool.run(envelope, 'warm');
    const second = await pool.run(envelope, 'warm');
    const pulled = second.nodes.filter((n) => n.pulled);
    expect(pulled.length).toBeGreaterThan(0);
    expect(pulled.every((n) => n.cached)).toBe(true);
  });

  it('rejects with the op error, not a generic worker failure', async () => {
    await expect(
      pool.run({
        from: 'px',
        process: [{ op: 'boom', params: {}, inputs: ['px'] }],
        select: [{ on: { op: 'boom', params: {}, inputs: ['px'] } }],
      }),
    ).rejects.toThrow(/boom: this op always fails/);
  });

  it('surfaces a bad plan through the collectable error policy', async () => {
    const result = await pool.run({
      from: 'px',
      process: [{ op: 'nope', params: {}, inputs: ['px'] }],
      select: [{ on: { op: 'nope', params: {}, inputs: ['px'] } }],
      onError: 'collect',
    });
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.skipped)).toMatch(/nope/);
  });

  it('names an unknown dataset', async () => {
    await expect(
      pool.run({ from: 'missing', process: PLAN, select: SELECT }),
    ).rejects.toThrow(/missing/);
  });

  it('rejects work after close, and closing twice is safe', async () => {
    const doomed = await HostPool.start({
      setup: SETUP,
      size: 1,
      setupOptions: { rows: ROWS },
    });
    await doomed.close();
    await doomed.close();
    await expect(
      doomed.run({ from: 'px', process: PLAN, select: SELECT }),
    ).rejects.toThrow(/closed/);
  });
});

describe('HostPool — loaded from source', () => {
  it('names the problem instead of hanging', async () => {
    // A worker cannot load TypeScript, so a pool constructed from the
    // `src` build resolves a worker entry that does not exist. Node
    // reports that asynchronously, which previously left every request
    // waiting forever on workers that were already dead.
    const { HostPool: FromSource } = await import('../src/pool/index.js');
    await expect(FromSource.start({ setup: SETUP, size: 1 })).rejects.toThrow(
      /worker entry not found/,
    );
  });
});
