import { describe, expect, it } from 'vitest';

import { ChunkedColumnarLiveStorage } from '../../src/live/live-chunked-storage.js';
import { ColumnarStore } from '../../src/columnar/store.js';
import { validateAndNormalizeColumnar } from '../../src/batch/validate.js';
import type { RowForSchema, SeriesSchema } from '../../src/schema/index.js';

/* -------------------------------------------------------------------------- */
/* ChunkedColumnarLiveStorage — isolated storage-mechanics tests.              */
/*                                                                             */
/* The novel/risky parts: boundary-slice EXACT retention, at(i) across chunk   */
/* boundaries, lazy materialization + cache remap on eviction, snapshot        */
/* independence. Tested standalone before LiveSeries wiring.                   */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

type S = typeof SCHEMA;

function make() {
  return new ChunkedColumnarLiveStorage<S>(SCHEMA as unknown as S);
}

// A batch of `n` rows starting at `base` (begin = base + i, value = base + i).
function batch(base: number, n: number): RowForSchema<S>[] {
  const rows: RowForSchema<S>[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    rows[i] = [base + i, base + i, `h${(base + i) % 3}`] as RowForSchema<S>;
  }
  return rows;
}

function srcStore(rows: RowForSchema<S>[]): ColumnarStore<S> {
  const { keys, columns } = validateAndNormalizeColumnar<S>({
    name: 'src',
    schema: SCHEMA as unknown as S,
    rows,
  });
  return ColumnarStore.fromTrustedStore(SCHEMA as unknown as S, keys, columns);
}

function staged(threshold: number) {
  return new ChunkedColumnarLiveStorage<S>(SCHEMA as unknown as S, threshold);
}

describe('ChunkedColumnarLiveStorage — staging tier (coalescing)', () => {
  it('stages rows readable in the pending tier, flushes one chunk at threshold', () => {
    const s = staged(2);
    const src = srcStore(batch(0, 4)); // begins/values 0..3
    s.stageRows(src, [0]);
    expect(s.length).toBe(1);
    expect(s.committedChunkCount).toBe(0);
    expect(s.pendingCount).toBe(1);
    expect(s.at(0)!.get('value')).toBe(0); // readable while pending
    s.stageRows(src, [1]); // crosses threshold 2 → flush
    expect(s.committedChunkCount).toBe(1);
    expect(s.pendingCount).toBe(0);
    expect(s.length).toBe(2);
    expect(s.at(0)!.get('value')).toBe(0);
    expect(s.at(1)!.get('value')).toBe(1);
  });

  it('reads span committed + pending tiers', () => {
    const s = staged(2);
    const src = srcStore(batch(0, 5));
    for (let i = 0; i < 5; i += 1) s.stageRows(src, [i]); // 2 chunks + 1 pending
    expect(s.committedChunkCount).toBe(2);
    expect(s.pendingCount).toBe(1);
    expect(s.length).toBe(5);
    for (let i = 0; i < 5; i += 1) expect(s.at(i)!.get('value')).toBe(i);
    expect(s.beginAt(4)).toBe(4);
    expect(s.last()!.get('value')).toBe(4);
  });

  it('retention evicts across the chunk→pending boundary', () => {
    const s = staged(2);
    const src = srcStore(batch(0, 5));
    for (let i = 0; i < 5; i += 1) s.stageRows(src, [i]); // chunks [0,1] [2,3] + pending [4]
    s.dropPrefix(3); // drop chunk [0,1] + boundary-slice 2 → leaves 3, 4 (pending survives)
    expect(s.length).toBe(2);
    expect(s.at(0)!.get('value')).toBe(3);
    expect(s.at(1)!.get('value')).toBe(4);
  });

  it('evicts into the pending tier when retention exceeds committed rows', () => {
    const s = staged(10); // never flushes for this input → all pending
    const src = srcStore(batch(0, 4));
    for (let i = 0; i < 4; i += 1) s.stageRows(src, [i]);
    expect(s.committedChunkCount).toBe(0);
    expect(s.pendingCount).toBe(4);
    s.dropPrefix(3); // evict 3 from pending
    expect(s.length).toBe(1);
    expect(s.at(0)!.get('value')).toBe(3);
  });

  it('appendStore flushes pending first to keep committed order', () => {
    const s = staged(10);
    const src = srcStore(batch(0, 6));
    s.stageRows(src, [0]);
    s.stageRows(src, [1]); // pending [0,1]
    s.appendStore(srcStore(batch(2, 2))); // direct chunk (begins 2,3) — flush pending first
    expect(s.committedChunkCount).toBe(2); // flushed-pending chunk + direct chunk
    expect(s.pendingCount).toBe(0);
    expect(s.length).toBe(4);
    for (let i = 0; i < 4; i += 1) expect(s.at(i)!.get('value')).toBe(i);
  });
});

describe('ChunkedColumnarLiveStorage — append + read', () => {
  it('starts empty', () => {
    const s = make();
    expect(s.length).toBe(0);
    expect(s.at(0)).toBeUndefined();
    expect(s.last()).toBeUndefined();
    expect(s.beginAt(0)).toBeUndefined();
    expect(s.keyAt(0)).toBeUndefined();
  });

  it('appends batches as chunks and reads across boundaries', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 1000));
    s.appendChunkFromRows(batch(1000, 1000));
    s.appendChunkFromRows(batch(2000, 500));
    expect(s.length).toBe(2500);
    // First chunk
    expect(s.at(0)!.get('value')).toBe(0);
    expect(s.beginAt(0)).toBe(0);
    // Across into second chunk
    expect(s.at(1000)!.get('value')).toBe(1000);
    expect(s.beginAt(1500)).toBe(1500);
    // Into third chunk
    expect(s.at(2499)!.get('value')).toBe(2499);
    expect(s.last()!.get('value')).toBe(2499);
    expect(s.at(2500)).toBeUndefined();
  });

  it('empty batch is a no-op', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 10));
    s.appendChunkFromRows([]);
    expect(s.length).toBe(10);
  });

  it('materializes correct string + number cells', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 5));
    const e = s.at(3)!;
    expect(e.get('value')).toBe(3);
    expect(e.get('host')).toBe('h0'); // (0+3)%3 === 0
    expect(e.begin()).toBe(3);
  });
});

describe('ChunkedColumnarLiveStorage — reference stability', () => {
  it('at(i) === at(i)', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 1000));
    s.appendChunkFromRows(batch(1000, 1000));
    for (const i of [0, 999, 1000, 1999]) {
      expect(s.at(i)).toBe(s.at(i));
    }
  });

  it('at(i) === at(i) survives eviction (cache remap)', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 1000));
    s.appendChunkFromRows(batch(1000, 1000));
    const before = s.at(1500); // value 1500, cached at logical 1500
    s.dropPrefix(1000); // logical 1500 → 500
    const after = s.at(500);
    expect(after).toBe(before);
    expect(after!.get('value')).toBe(1500);
  });
});

describe('ChunkedColumnarLiveStorage — boundary-slice EXACT retention', () => {
  it('dropPrefix drops whole chunks then boundary-slices for exactness', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 1000)); // values 0..999
    s.appendChunkFromRows(batch(1000, 1000)); // values 1000..1999
    s.appendChunkFromRows(batch(2000, 1000)); // values 2000..2999
    // Drop 1500: whole chunk 0 (1000) + 500 sliced off chunk 1.
    s.dropPrefix(1500);
    expect(s.length).toBe(1500); // EXACT, not chunk-granular
    expect(s.at(0)!.get('value')).toBe(1500); // first survivor
    expect(s.beginAt(0)).toBe(1500);
    expect(s.last()!.get('value')).toBe(2999);
  });

  it('evictPrefix returns the exact evicted rows in order', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 1000));
    s.appendChunkFromRows(batch(1000, 1000));
    const evicted = s.evictPrefix(1200); // chunk0 (1000) + 200 of chunk1
    expect(evicted.length).toBe(1200);
    expect(evicted[0]!.get('value')).toBe(0);
    expect(evicted[1199]!.get('value')).toBe(1199);
    expect(s.length).toBe(800);
    expect(s.at(0)!.get('value')).toBe(1200);
  });

  it('reads correctly after a boundary slice (sliced chunk indexing)', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 100));
    s.dropPrefix(30); // slice 30 off the only chunk
    expect(s.length).toBe(70);
    expect(s.at(0)!.get('value')).toBe(30);
    expect(s.at(69)!.get('value')).toBe(99);
    // Append another chunk after a slice — offsets still correct.
    s.appendChunkFromRows(batch(100, 50));
    expect(s.length).toBe(120);
    expect(s.at(70)!.get('value')).toBe(100);
    expect(s.at(119)!.get('value')).toBe(149);
  });

  it('dropPrefix(0) and over-drop are handled', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 100));
    s.dropPrefix(0);
    expect(s.length).toBe(100);
    s.dropPrefix(100);
    expect(s.length).toBe(0);
    expect(s.at(0)).toBeUndefined();
  });
});

describe('ChunkedColumnarLiveStorage — clear + snapshot', () => {
  it('clear empties and returns all rows in order', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 500));
    s.appendChunkFromRows(batch(500, 500));
    const all = s.clear();
    expect(all.length).toBe(1000);
    expect(all[0]!.get('value')).toBe(0);
    expect(all[999]!.get('value')).toBe(999);
    expect(s.length).toBe(0);
  });

  it('snapshot is an independent TimeSeries in order', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 100));
    s.appendChunkFromRows(batch(100, 100));
    const ts = s.snapshot('snap');
    expect(ts.name).toBe('snap');
    expect(ts.length).toBe(200);
    expect(ts.at(0)!.get('value')).toBe(0);
    expect(ts.at(150)!.get('value')).toBe(150);
    // Independent of subsequent mutation.
    s.appendChunkFromRows(batch(200, 100));
    expect(ts.length).toBe(200);
  });

  it('snapshot reflects a boundary-sliced buffer correctly', () => {
    const s = make();
    s.appendChunkFromRows(batch(0, 100));
    s.dropPrefix(40);
    const ts = s.snapshot('sliced');
    expect(ts.length).toBe(60);
    expect(ts.at(0)!.get('value')).toBe(40);
    expect(ts.at(59)!.get('value')).toBe(99);
  });
});
