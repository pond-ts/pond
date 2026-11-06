import { describe, expect, it, vi } from 'vitest';

// [PND-COLOUT] A series with only `'columns'` listeners builds no `Event`
// on the chunked backing. Counts calls to the two builders the push path
// uses (whole chunk, and a partition's slice).

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/live/live-chunked-storage.js', async (importOriginal) => {
  const mod =
    await importOriginal<
      typeof import('../src/live/live-chunked-storage.js')
    >();
  return {
    ...mod,
    materializeEventsFromStore: (...args: unknown[]) => {
      calls.n += 1;
      return (mod.materializeEventsFromStore as any)(...args);
    },
    materializeEventsFromStoreAt: (...args: unknown[]) => {
      calls.n += 1;
      return (mod.materializeEventsFromStoreAt as any)(...args);
    },
  };
});

const { LiveSeries } = await import('../src/index.js');

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;
const rows = (start: number, n: number) =>
  Array.from({ length: n }, (_, j) => [
    (start + j) * 1000,
    j * 1.5,
    `h${(start + j) % 3}`,
  ]);

describe("'columns' builds no Event [PND-COLOUT]", () => {
  it('top-level series and partition sub-series', () => {
    const live = new LiveSeries({
      name: 'n',
      schema,
      retention: { maxEvents: 50 },
    });
    const parts = live.partitionBy('host', { groups: ['h0', 'h1', 'h2'] });
    let seen = 0;
    live.on('columns', (b) => (seen += b.length));
    for (const p of parts.toMap().values()) {
      (p as any).on('columns', (b: any) => (seen += b.length));
    }
    calls.n = 0;
    for (let k = 0; k < 5; k += 1) live.pushMany(rows(k * 40, 40) as never);
    expect(seen).toBe(400);
    expect(calls.n).toBe(0);

    // The counter does see the builders: a 'batch' listener uses them.
    live.on('batch', () => {});
    live.pushMany(rows(200, 3) as never);
    expect(calls.n).toBeGreaterThan(0);
  });
});
