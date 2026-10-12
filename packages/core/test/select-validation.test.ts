import { describe, expect, it } from 'vitest';
import { Event, LiveSeries, Sequence, Time, TimeSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* select(...keys) argument validation.                                        */
/*                                                                             */
/* select used to silently drop any key that wasn't a payload column, so a     */
/* typo or an array argument (`select(['a', 'b'])`) produced an empty-payload  */
/* series with no error. Every schema-aware select now throws instead:         */
/*   - array argument  → TypeError telling the caller to spread it            */
/*   - unknown column  → RangeError naming the key + listing valid columns     */
/* Duplicate keys stay allowed and select the column once.                     */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function makeSeries() {
  return new TimeSeries({
    name: 'src',
    schema,
    rows: [
      [0, 10, 'a'],
      [1000, 20, 'b'],
    ],
  });
}

function makeLive() {
  return new LiveSeries({ name: 'live', schema });
}

const UNKNOWN = /select: unknown column 'nope'; valid columns: 'value', 'host'/;
const ARRAY =
  /got an array \['value', 'host'\]; spread it: select\(\.\.\.names\)/;

// Each surface, as a factory returning a `select` bound to it. Typed loosely
// on purpose: the misuse under test is exactly what the types reject, so
// these calls model untyped / `any`-typed callers.
type AnySelect = (...keys: unknown[]) => unknown;
const surfaces: Array<[string, () => AnySelect]> = [
  [
    'TimeSeries',
    () => {
      const s = makeSeries() as any;
      return (...k) => s.select(...k);
    },
  ],
  [
    'LiveSeries',
    () => {
      const l = makeLive() as any;
      return (...k) => l.select(...k);
    },
  ],
  [
    'LiveView',
    () => {
      const v = makeLive().filter(() => true) as any;
      return (...k) => v.select(...k);
    },
  ],
  [
    'LiveAggregation',
    () => {
      const a = makeLive().aggregate(Sequence.every('1m'), {
        value: 'avg',
        host: 'first',
      }) as any;
      return (...k) => a.select(...k);
    },
  ],
  [
    'LiveRollingAggregation',
    () => {
      const r = makeLive().rolling(2, {
        value: 'avg',
        host: 'last',
      }) as any;
      return (...k) => r.select(...k);
    },
  ],
];

describe.each(surfaces)('%s.select validation', (_name, make) => {
  it('throws RangeError naming the unknown key and listing valid columns', () => {
    const select = make();
    expect(() => select('nope')).toThrow(RangeError);
    expect(() => select('nope')).toThrow(UNKNOWN);
  });

  it('throws even when the unknown key is mixed with valid ones', () => {
    expect(() => make()('value', 'nope')).toThrow(UNKNOWN);
  });

  it('rejects the key column itself (not a payload column)', () => {
    expect(() => make()('time')).toThrow(/unknown column 'time'/);
  });

  it('throws TypeError for an array argument, telling the caller to spread', () => {
    const select = make();
    expect(() => select(['value', 'host'])).toThrow(TypeError);
    expect(() => select(['value', 'host'])).toThrow(ARRAY);
  });

  it('accepts duplicate keys, selecting the column once', () => {
    const out = make()('value', 'value') as {
      schema: readonly { name: string }[];
    };
    expect(out.schema.map((c) => c.name).slice(1)).toEqual(['value']);
  });

  it('still accepts zero keys (key-only result)', () => {
    const out = make()() as { schema: readonly { name: string }[] };
    expect(out.schema.length).toBe(1);
  });
});

describe('TimeSeries.select duplicates / order', () => {
  it('duplicate keys produce a single column with the right data', () => {
    const r = makeSeries().select('value', 'value');
    expect(r.schema.map((c) => c.name)).toEqual(['time', 'value']);
    expect(r.at(1)!.data()).toEqual({ value: 20 });
  });

  it('output keeps schema order, not argument order', () => {
    const r = makeSeries().select('host', 'value');
    expect(r.schema.map((c) => c.name)).toEqual(['time', 'value', 'host']);
  });

  it('lists "(none)" when the series has no payload columns', () => {
    const keyOnly = makeSeries().select();
    expect(() => (keyOnly as any).select('value')).toThrow(
      /unknown column 'value'; valid columns: \(none\)/,
    );
  });
});

describe('Event.select validation', () => {
  it('throws TypeError for an array argument', () => {
    const e = new Event(new Time(0), { value: 1, host: 'a' });
    expect(() => (e as any).select(['value', 'host'])).toThrow(TypeError);
    expect(() => (e as any).select(['value', 'host'])).toThrow(
      /spread it: select\(\.\.\.names\)/,
    );
  });

  it('still tolerates a key absent from the payload (optional fields)', () => {
    const e = new Event(new Time(0), { value: 1 } as {
      value: number;
      host?: string;
    });
    expect(e.select('value', 'host').data()).toEqual({
      value: 1,
      host: undefined,
    });
  });
});
