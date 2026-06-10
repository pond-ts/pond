import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* Step 4 — column-native rename() edges + the (improving) behavior changes.   */
/*                                                                             */
/* rename() now relabels the store's columns directly (withColumnsRenamed +    */
/* #fromTrustedStore) instead of materializing this.events. withColumnsRenamed */
/* is stricter than the old event path: it rejects key renames + target-name  */
/* collisions (the old path silently built a duplicate-named schema), and the  */
/* result-schema build now uses hasOwnProperty so a column named `toString`    */
/* isn't corrupted by a prototype member.                                      */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
  { name: 'opt', kind: 'number', required: false },
] as const;

function make() {
  return new TimeSeries({
    name: 'src',
    schema,
    rows: [
      [0, 10, 'a', 1],
      [1000, 20, 'b', undefined], // opt gap
      [2000, 30, 'c', 3],
    ] as any,
  });
}

describe('column-native rename()', () => {
  it('relabels value columns, preserves values + key', () => {
    const r = make().rename({ cpu: 'usage' });
    expect(r.schema.map((c) => c.name)).toEqual([
      'time',
      'usage',
      'host',
      'opt',
    ]);
    expect(r.at(0)!.get('usage')).toBe(10);
    expect(r.at(0)!.get('host')).toBe('a');
    expect(Array.from(r.keyColumn().begin)).toEqual([0, 1000, 2000]);
  });

  it('preserves validity through the relabel', () => {
    const r = make().rename({ opt: 'o' });
    expect(r.at(0)!.get('o')).toBe(1);
    expect(r.at(1)!.get('o')).toBeUndefined(); // gap survives
    expect(r.at(2)!.get('o')).toBe(3);
  });

  it('preserves the `required` flag on the renamed column', () => {
    const r = make().rename({ opt: 'o' });
    const def = r.schema.find((c) => c.name === 'o')!;
    expect((def as { required?: boolean }).required).toBe(false);
  });

  it('events rematerialize with the new names (only renamed columns)', () => {
    const r = make().rename({ cpu: 'usage' });
    const e = r.events[0]!;
    expect(e.get('usage')).toBe(10);
    expect(e.get('cpu' as never)).toBeUndefined(); // old name is gone
    expect(r.events).toBe(r.events); // identity-stable
  });

  it('leaves the parent untouched', () => {
    const src = make();
    const r = src.rename({ cpu: 'usage' });
    expect(src.schema.map((c) => c.name)).toContain('cpu');
    expect(src.at(0)!.get('cpu')).toBe(10);
    expect(r.schema.map((c) => c.name)).toContain('usage');
  });

  it('throws on a target-name collision (old path silently dup-named)', () => {
    // rename cpu → host where host already exists.
    expect(() => make().rename({ cpu: 'host' } as never)).toThrow(/collide/i);
  });

  it('does not corrupt a column named `toString` (prototype safety)', () => {
    const protoSchema = [
      { name: 'time', kind: 'time' },
      { name: 'toString', kind: 'number' },
    ] as const;
    const s = new TimeSeries({
      name: 'p',
      schema: protoSchema,
      rows: [
        [0, 1],
        [1000, 2],
      ] as any,
    });
    // empty rename: 'toString' must stay 'toString', not become a function.
    const r = s.rename({});
    expect(r.schema.map((c) => c.name)).toEqual(['time', 'toString']);
    expect(r.at(0)!.get('toString')).toBe(1);
  });

  it('round-trips through reduce (column-native consumer)', () => {
    const r = make().rename({ cpu: 'usage' });
    expect(r.reduce('usage', 'sum')).toBe(60);
  });
});
