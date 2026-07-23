/**
 * Tests for the **columnar fast path** on `TimeSeries.smooth(..., 'ema')` —
 * the packed-numeric-source path that runs the EMA recurrence straight off
 * the typed buffer and assembles the result via trusted construction (no
 * event materialization, no full-series intake re-pack).
 *
 * The recurrence semantics themselves (span/alpha, warmup, minSamples,
 * missing head cells) are pinned by the existing smooth suites, which now
 * run through this path. This file pins what is *specific* to the fast
 * path: gap-carrying on interior holes, zero-copy sharing of the key and
 * untouched columns, and Float64Array-built (`fromColumns`) sources.
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'other', kind: 'number' },
] as const;

function holedSeries() {
  const values: Array<number | undefined> = [8, undefined, 4, undefined, 2];
  return new TimeSeries({
    name: 'v',
    schema,
    rows: values.map(
      (v, i) => [i * 1_000, v, i] as [number, number | undefined, number],
    ),
  });
}

describe('smooth ema columnar fast path', () => {
  it('carries the recurrence across interior gaps (missing in, missing out)', () => {
    // alpha 0.5: 8 → gap → 0.5·4 + 0.5·8 = 6 → gap → 0.5·2 + 0.5·6 = 4.
    const r = holedSeries().smooth('v', 'ema', { alpha: 0.5 });
    expect(r.at(0)!.get('v')).toBe(8);
    expect(r.at(1)!.get('v')).toBeUndefined();
    expect(r.at(2)!.get('v')).toBe(6);
    expect(r.at(3)!.get('v')).toBeUndefined();
    expect(r.at(4)!.get('v')).toBe(4);
  });

  it('shares the key column and untouched value columns (zero-copy)', () => {
    const s = holedSeries();
    const appended = s.smooth('v', 'ema', { alpha: 0.5, output: 'e' });
    expect(appended.keyColumn()).toBe(s.keyColumn());
    expect(appended.column('other')).toBe(s.column('other'));
    expect(appended.column('v')).toBe(s.column('v'));
    // Replace mode: only the target column changes.
    const replaced = s.smooth('v', 'ema', { alpha: 0.5 });
    expect(replaced.keyColumn()).toBe(s.keyColumn());
    expect(replaced.column('other')).toBe(s.column('other'));
    expect(replaced.column('v')).not.toBe(s.column('v'));
  });

  it('output === target column behaves as replace (no collision throw)', () => {
    const r = holedSeries().smooth('v', 'ema', { alpha: 0.5, output: 'v' });
    expect(r.schema.map((c) => c.name)).toEqual(['time', 'v', 'other']);
    expect(r.at(2)!.get('v')).toBe(6);
  });

  it('runs off a Float64Array-built series (fromColumns source)', () => {
    const n = 64;
    const times = new Float64Array(n);
    const close = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      times[i] = i * 60_000;
      close[i] = 100 + i;
    }
    const s = TimeSeries.fromColumns({
      name: 'bars',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'close', kind: 'number' },
      ] as const,
      columns: { time: times, close },
    });
    const r = s.smooth('close', 'ema', { span: 3, minSamples: 3, output: 'e' });
    // Hand recurrence, alpha = 0.5: masked until 3 present values seen.
    let prev: number | undefined;
    for (let i = 0; i < n; i += 1) {
      prev = prev === undefined ? close[i]! : 0.5 * close[i]! + 0.5 * prev;
      const got = r.at(i)!.get('e');
      if (i < 2) expect(got).toBeUndefined();
      else expect(got).toBeCloseTo(prev, 12);
    }
  });

  it('warmup drops rows off the front but keeps the converged tail', () => {
    const s = holedSeries();
    const dropped = s.smooth('v', 'ema', { alpha: 0.5, warmup: 2 });
    expect(dropped.length).toBe(3);
    // Row 2 of the source (value 6 post-smooth) is now row 0.
    expect(dropped.at(0)!.get('v')).toBe(6);
    expect(dropped.at(0)!.get('other')).toBe(2);
    expect(dropped.at(2)!.get('v')).toBe(4);
    // Key axis sliced in step with the values.
    expect(dropped.at(0)!.begin()).toBe(2_000);
  });
});

describe('smooth ema event-path fallback', () => {
  // The fast path gates on a packed 'number' source column. The one
  // runtime-reachable input that misses the gate today is a non-numeric
  // source (type-forbidden, hence the casts, but runtime-tolerated): every
  // cell reads as not-a-number, so the event path emits an all-undefined
  // column while preserving length and shape. Pinning it keeps the fallback
  // executable — a chunked NUMERIC source would also route here, but a
  // chunked-column TimeSeries is not constructible today (all public and
  // internal construction paths pack; the trusted-store sentinel is
  // module-private), so this lane is the fallback's only live coverage.
  const mixedSchema = [
    { name: 'time', kind: 'time' },
    { name: 'host', kind: 'string' },
    { name: 'v', kind: 'number' },
  ] as const;
  const mixed = new TimeSeries({
    name: 'm',
    schema: mixedSchema,
    rows: [
      [0, 'a', 1],
      [1_000, 'b', 2],
      [2_000, 'c', 3],
    ] as Array<[number, string, number]>,
  });

  it('a non-numeric source takes the event path: all-undefined, length kept', () => {
    const appended = mixed.smooth('host' as never, 'ema', {
      alpha: 0.5,
      output: 'e',
    });
    expect(appended.length).toBe(3);
    expect(appended.schema.map((c) => c.name)).toEqual([
      'time',
      'host',
      'v',
      'e',
    ]);
    for (let i = 0; i < 3; i += 1) {
      expect(appended.at(i)!.get('e')).toBeUndefined();
      expect(appended.at(i)!.get('host')).toBe(['a', 'b', 'c'][i]);
    }
    const replaced = mixed.smooth('host' as never, 'ema', { alpha: 0.5 });
    expect(replaced.length).toBe(3);
    for (let i = 0; i < 3; i += 1) {
      expect(replaced.at(i)!.get('host')).toBeUndefined();
    }
  });
});
