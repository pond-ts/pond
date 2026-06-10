import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* Step 4 — column-native select() edges.                                      */
/*                                                                             */
/* select() now reshapes the columnar store directly (withColumnsSelected +    */
/* #fromTrustedStore) instead of materializing this.events. These pin the      */
/* column-native specifics the existing select corpus doesn't stress: validity */
/* through the reshape, all four value kinds, lazy event rematerialization off  */
/* the reshaped store, and parent independence (zero-copy column sharing is     */
/* safe because columns are immutable).                                        */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'n', kind: 'number' },
  { name: 's', kind: 'string' },
  { name: 'b', kind: 'boolean' },
  { name: 'opt', kind: 'number', required: false },
] as const;

function make() {
  return new TimeSeries({
    name: 'src',
    schema,
    rows: [
      [0, 1, 'a', true, 10],
      [1000, 2, 'b', false, undefined], // opt missing → validity gap
      [2000, 3, 'c', true, 30],
    ] as any,
  });
}

describe('column-native select()', () => {
  it('projects the chosen value columns + always the key', () => {
    const r = make().select('n', 's');
    expect(r.schema.map((c) => c.name)).toEqual(['time', 'n', 's']);
    expect(r.length).toBe(3);
    expect(r.at(0)!.get('n')).toBe(1);
    expect(r.at(0)!.get('s')).toBe('a');
    // dropped columns are gone
    expect(r.at(0)!.get('b' as never)).toBeUndefined();
  });

  it('preserves the key axis (begins) exactly', () => {
    const r = make().select('n');
    expect(Array.from(r.keyColumn().begin)).toEqual([0, 1000, 2000]);
  });

  it('preserves validity (missing optional cell stays missing)', () => {
    const r = make().select('opt');
    expect(r.at(0)!.get('opt')).toBe(10);
    expect(r.at(1)!.get('opt')).toBeUndefined(); // the gap survives the reshape
    expect(r.at(2)!.get('opt')).toBe(30);
  });

  it('carries all four value kinds', () => {
    const arrSchema = [
      { name: 'time', kind: 'time' },
      { name: 'n', kind: 'number' },
      { name: 'arr', kind: 'array' },
      { name: 'b', kind: 'boolean' },
    ] as const;
    const s = new TimeSeries({
      name: 'k',
      schema: arrSchema,
      rows: [
        [0, 1, [1, 2], true],
        [1000, 2, [3], false],
      ] as any,
    });
    const r = s.select('arr', 'b');
    expect(r.at(0)!.get('arr')).toEqual([1, 2]);
    expect(r.at(1)!.get('b')).toBe(false);
  });

  it('events rematerialize from the reshaped store (only selected columns)', () => {
    const r = make().select('n');
    const events = r.events; // lazy build off the reshaped store
    expect(events.length).toBe(3);
    expect(events[0]!.get('n')).toBe(1);
    expect(events[0]!.data()).toEqual({ n: 1 }); // no dropped columns leak in
    expect(r.events).toBe(events); // identity-stable
  });

  it('leaves the parent series untouched (zero-copy column share is safe)', () => {
    const src = make();
    const r = src.select('n');
    // parent keeps all columns + values
    expect(src.schema.map((c) => c.name)).toEqual([
      'time',
      'n',
      's',
      'b',
      'opt',
    ]);
    expect(src.at(0)!.get('s')).toBe('a');
    expect(src.length).toBe(3);
    // selected child is correct + independent in shape
    expect(r.schema.map((c) => c.name)).toEqual(['time', 'n']);
  });

  it('round-trips through reduce/aggregate (column-native consumer)', () => {
    const r = make().select('n');
    expect(r.reduce('n', 'sum')).toBe(6);
  });
});
