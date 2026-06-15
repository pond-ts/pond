/**
 * Tests for `TimeSeries.rolling` with the `AggregateOutputMap` form
 * (the `{ output: { from, using, kind? } }` shape already accepted by
 * `aggregate`). Added in v0.5.4 to close the feature-parity gap.
 */
import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries, ValidationError } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function makeSeries() {
  return new TimeSeries({
    name: 'metrics',
    schema,
    rows: [
      [0, 10, 'api-1'],
      [1000, 20, 'api-1'],
      [2000, 30, 'api-2'],
      [3000, 40, 'api-2'],
      [4000, 50, 'api-3'],
    ],
  });
}

describe('rolling (AggregateOutputMap, event-driven)', () => {
  it('computes multiple reducers over the same source column in one pass', () => {
    const rolled = makeSeries().rolling('3s', {
      avg: { from: 'cpu', using: 'avg' },
      sd: { from: 'cpu', using: 'stdev' },
    });

    const avgCol = rolled.schema.find((c) => c.name === 'avg');
    const sdCol = rolled.schema.find((c) => c.name === 'sd');
    expect(avgCol?.kind).toBe('number');
    expect(sdCol?.kind).toBe('number');

    // At t=4000, trailing 3s window contains t=[2000, 3000, 4000] -> cpu [30,40,50]
    const at4 = rolled.at(4)!;

    // Narrow return types — no `as number | undefined` casts needed
    // (was `ColumnValue | undefined` pre-v0.5.5).
    const avg: number | undefined = at4.get('avg');
    const sd: number | undefined = at4.get('sd');
    expect(avg).toBe(40);
    // stdev population = sqrt(((30-40)^2 + (40-40)^2 + (50-40)^2) / 3)
    //                  = sqrt(200/3) = ~8.1650
    expect(sd!).toBeCloseTo(8.165, 3);
  });

  it('narrows unique / top / first / last through the output spec', () => {
    const rolled = makeSeries().rolling('3s', {
      hostsSeen: { from: 'host', using: 'unique' },
      topHost: { from: 'host', using: 'top1' },
      firstHost: { from: 'host', using: 'first' },
    });

    const at4 = rolled.at(4)!;

    // Source-preserving reducers narrow to the source column's element
    // type — first/last/keep on a string column → string | undefined.
    const firstHost: string | undefined = at4.get('firstHost');

    // Array-producing reducers (unique / top${N}) narrow to ArrayValue
    // (kind-level). Further narrowing to ReadonlyArray<string>
    // specifically requires bypassing the schema pipeline and is only
    // available on `reduce(...)` today. Worked example kept loose here.
    const hostsSeen: ReadonlyArray<string | number | boolean> | undefined =
      at4.get('hostsSeen');
    const topHost: ReadonlyArray<string | number | boolean> | undefined =
      at4.get('topHost');

    // At t=4000, trailing 3s window: events at t∈(1000, 4000] -> hosts
    // api-2, api-2, api-3
    expect(hostsSeen).toEqual(['api-2', 'api-3']);
    expect(topHost?.length).toBe(1);
    expect(topHost![0]).toBe('api-2'); // api-2 x2 > api-3 x1
    expect(firstHost).toBe('api-2');
  });

  it("preserves the source's first-column kind (Time, not the union)", () => {
    const rolled = makeSeries().rolling('3s', {
      avg: { from: 'cpu', using: 'avg' },
    });

    // `.key()` should return `Time` (not the `Time | TimeRange | Interval`
    // union that the erased-schema overload used to produce).
    const key = rolled.at(0)!.key();
    expect(typeof key.begin()).toBe('number');
    // Using a Time-only method confirms the type at compile time —
    // `.toDate()` exists on Time specifically.
    expect(key.toDate()).toBeInstanceOf(Date);
  });

  it('respects an explicit `kind` override on the output spec', () => {
    const rolled = makeSeries().rolling('3s', {
      // Explicit kind should win over reducer inference
      customField: {
        from: 'cpu',
        using: (values) =>
          values.filter((v): v is number => typeof v === 'number').length,
        kind: 'number',
      },
    });

    const col = rolled.schema.find((c) => c.name === 'customField');
    expect(col?.kind).toBe('number');
    const n: number | undefined = rolled.at(4)!.get('customField');
    expect(n).toBeGreaterThan(0);
  });

  it('renames output columns independently from source columns', () => {
    const rolled = makeSeries().rolling('3s', {
      cpuAvg: { from: 'cpu', using: 'avg' },
      cpuMax: { from: 'cpu', using: 'max' },
    });

    // Source 'cpu' column is gone; output columns 'cpuAvg' + 'cpuMax' appear.
    expect(rolled.schema.map((c) => c.name)).toEqual([
      'time',
      'cpuAvg',
      'cpuMax',
    ]);
    expect(rolled.at(4)!.get('cpuAvg')).toBe(40);
    expect(rolled.at(4)!.get('cpuMax')).toBe(50);
  });

  it('mixes per-source-column and AggregateOutputSpec in the same call', () => {
    const rolled = makeSeries().rolling('3s', {
      // AggregateOutputSpec entries
      avg: { from: 'cpu', using: 'avg' },
      hi: { from: 'cpu', using: 'max' },
    });
    expect(rolled.at(4)!.get('avg')).toBe(40);
    expect(rolled.at(4)!.get('hi')).toBe(50);
  });

  it('accepts an explicit kind override on AggregateOutputSpec', () => {
    const rolled = makeSeries().rolling('3s', {
      host_kept: { from: 'host', using: 'keep', kind: 'string' },
    });
    const col = rolled.schema.find((c) => c.name === 'host_kept');
    expect(col?.kind).toBe('string');
  });

  it('preserves existing AggregateMap behavior unchanged', () => {
    const rolled = makeSeries().rolling('3s', { cpu: 'avg' });
    expect(rolled.schema.map((c) => c.name)).toEqual(['time', 'cpu']);
    expect(rolled.at(4)!.get('cpu')).toBe(40);
  });

  it('throws when an output spec references an unknown source column', () => {
    expect(() =>
      makeSeries().rolling('3s', {
        avg: { from: 'nonexistent' as 'cpu', using: 'avg' },
      }),
    ).toThrow(/unknown source column/);
  });
});

describe('rolling (AggregateOutputMap, sequence-driven)', () => {
  it('works over sequence buckets with a trailing window', () => {
    const rolled = makeSeries().rolling(
      Sequence.every('1s'),
      '2s',
      {
        avg: { from: 'cpu', using: 'avg' },
        sd: { from: 'cpu', using: 'stdev' },
      },
      { sample: 'begin' },
    );

    // Output is interval-keyed over the sequence buckets. Schema:
    expect(rolled.schema.map((c) => c.name)).toEqual(['interval', 'avg', 'sd']);
    expect(rolled.length).toBeGreaterThan(0);

    // Verify the reducers ran independently — avg and sd both produce
    // numeric output from the same cpu source.
    for (let i = 0; i < rolled.length; i += 1) {
      const event = rolled.at(i)!;
      const avg = event.get('avg');
      const sd = event.get('sd');
      // Either both defined or both undefined — they see the same window
      expect(avg === undefined).toBe(sd === undefined);
    }
  });

  it('supports an explicit range argument alongside the output map', () => {
    const rolled = makeSeries().rolling(
      Sequence.every('1s'),
      '500ms',
      {
        avg: { from: 'cpu', using: 'avg' },
      },
      {
        sample: 'begin',
        range: { start: 0, end: 5000 },
      },
    );
    // With sample='begin' and a 500ms trailing window, each bucket's
    // aggregate is the event at that bucket's start.
    expect(rolled.at(0)!.get('avg')).toBe(10);
    expect(rolled.at(4)!.get('avg')).toBe(50);
  });
});

describe('rolling: schema-order preservation for AggregateMap', () => {
  // When the AggregateMap keys are written in a different order than the
  // schema declares them, the runtime row layout must still match the
  // `RollingSchema<S, Mapping>` type's column ordering (schema order).
  it('orders columns by schema regardless of mapping key order', () => {
    const s = new TimeSeries({
      name: 'multi',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'a', kind: 'number' },
        { name: 'b', kind: 'number' },
        { name: 'c', kind: 'number' },
      ] as const,
      rows: [
        [0, 1, 10, 100],
        [1000, 2, 20, 200],
      ],
    });

    // Mapping keys in reversed order from the schema
    const rolled = s.rolling('2s', { c: 'avg', a: 'avg', b: 'avg' });

    // Schema order is (time, a, b, c) — not the mapping's (c, a, b)
    expect(rolled.schema.map((col) => col.name)).toEqual([
      'time',
      'a',
      'b',
      'c',
    ]);

    // Values still correct per source column
    const at1 = rolled.at(1)!;
    expect(at1.get('a')).toBe(1.5);
    expect(at1.get('b')).toBe(15);
    expect(at1.get('c')).toBe(150);
  });
});

// F1 (audit v2 §5): the runtime has always emitted every output column
// for a MIXED shorthand + `{ from, using }` mapping. The bug was purely
// in the *result type* (the mixed literal resolved to the shorthand
// overload, which dropped spec-keyed columns from the schema type while
// the runtime kept them). These tests lock the type/runtime parity: the
// emitted `.schema` and values must match what the unified result type
// now describes, so a future regression in either layer is caught.
describe('mixed shorthand + spec mapping (F1 type/runtime parity)', () => {
  it('aggregate: emits every output column with correct kinds + values', () => {
    const aggregated = makeSeries().aggregate(Sequence.every('5s'), {
      cpu: 'avg', // shorthand → number
      cpu_max: { from: 'cpu', using: 'max' }, // spec → number
      host_first: { from: 'host', using: 'first' }, // spec, string source → string
      hosts: { from: 'host', using: 'unique' }, // spec → array
    });

    // Every output column is present (the spec-keyed ones were the
    // columns F1 dropped from the type).
    expect(aggregated.schema.map((c) => c.name)).toEqual([
      'interval',
      'cpu',
      'cpu_max',
      'host_first',
      'hosts',
    ]);
    const kinds = Object.fromEntries(
      aggregated.schema.slice(1).map((c) => [c.name, c.kind]),
    );
    expect(kinds).toEqual({
      cpu: 'number',
      cpu_max: 'number',
      host_first: 'string',
      hosts: 'array',
    });

    // One 5s bucket over [0,5000): cpu [10,20,30,40,50], hosts api-1..3.
    const bucket = aggregated.at(0)!;
    expect(bucket.get('cpu')).toBe(30); // avg
    expect(bucket.get('cpu_max')).toBe(50); // max
    expect(bucket.get('host_first')).toBe('api-1'); // first
    expect(bucket.get('hosts')).toEqual(['api-1', 'api-2', 'api-3']); // unique
  });

  it('rolling (event-driven): emits every output column for a mixed mapping', () => {
    const rolled = makeSeries().rolling('3s', {
      cpu: 'avg', // shorthand → number
      cpu_sd: { from: 'cpu', using: 'stdev' }, // spec → number
      host_last: { from: 'host', using: 'last' }, // spec, string source → string
    });

    expect(rolled.schema.map((c) => c.name)).toEqual([
      'time',
      'cpu',
      'cpu_sd',
      'host_last',
    ]);

    // t=4000 trailing 3s window: t=[2000,3000,4000] -> cpu [30,40,50].
    const at4 = rolled.at(4)!;
    expect(at4.get('cpu')).toBe(40); // avg
    expect(at4.get('cpu_sd')).toBeCloseTo(Math.sqrt(200 / 3), 5); // stdev
    expect(at4.get('host_last')).toBe('api-3'); // last
  });

  it('reduce: emits every output key for a mixed mapping', () => {
    const reduced = makeSeries().reduce({
      cpu: 'avg', // shorthand → number
      cpu_max: { from: 'cpu', using: 'max' }, // spec → number
      host_first: { from: 'host', using: 'first' }, // spec, string source → string
      hosts: { from: 'host', using: 'unique' }, // spec → array
    });

    expect(Object.keys(reduced).sort()).toEqual(
      ['cpu', 'cpu_max', 'host_first', 'hosts'].sort(),
    );
    expect(reduced.cpu).toBe(30);
    expect(reduced.cpu_max).toBe(50);
    expect(reduced.host_first).toBe('api-1');
    expect(reduced.hosts).toEqual(['api-1', 'api-2', 'api-3']);
  });
});

describe('TimeSeries.rolling — non-finite / wrong-kind output is rejected', () => {
  // The columnar output path (3C) assembles result columns via trusted
  // construction, which skips the constructor's strict intake — AND the
  // `*FromArray` builders silently coerce a kind mismatch to a missing cell.
  // So a defined result that doesn't match the declared output kind (a
  // non-finite number, or a wrong-typed value from a custom reducer / `kind`
  // override) is rejected at write, preserving the throw the old event-based
  // path enforced via intake (matching `mapColumns`). Missing cells (the
  // minSamples warm-up) are unaffected. (Codex finding on #225.)
  const numSchema = [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number' },
  ] as const;

  it('throws when a window sum overflows to Infinity', () => {
    const s = new TimeSeries({
      name: 's',
      schema: numSchema,
      rows: [
        [0, 1e308],
        [1000, 1e308],
        [2000, 1e308],
      ],
    });
    // 3e308 overflows to Infinity inside the 10s window → rejected.
    expect(() => s.rolling('10s', { v: 'sum' })).toThrow(
      /not a valid 'number' value/,
    );
  });

  it('throws when a custom reducer returns a non-finite number', () => {
    const s = new TimeSeries({
      name: 's',
      schema: numSchema,
      rows: [
        [0, 1],
        [1000, 2],
      ],
    });
    expect(() =>
      s.rolling('10s', { v: { from: 'v', using: () => Infinity } }),
    ).toThrow(/not a valid 'number' value/);
  });

  it('throws on a wrong-kind result (number reducer, string kind override)', () => {
    const s = new TimeSeries({
      name: 's',
      schema: numSchema,
      rows: [
        [0, 1],
        [1000, 2],
      ],
    });
    // `sum` produces a number, but the output column is declared `string` —
    // the old intake path threw `ValidationError`; the columnar path must too
    // (same class, not a silent coercion to a missing cell).
    expect(() =>
      s.rolling('10s', { out: { from: 'v', using: 'sum', kind: 'string' } }),
    ).toThrow(/not a valid 'string' value/);
    expect(() =>
      s.rolling('10s', { out: { from: 'v', using: 'sum', kind: 'string' } }),
    ).toThrow(ValidationError); // class parity with intake (Codex round 3)
  });

  it('throws on a wrong-kind custom result (string into a number column)', () => {
    const s = new TimeSeries({
      name: 's',
      schema: numSchema,
      rows: [
        [0, 1],
        [1000, 2],
      ],
    });
    expect(() =>
      s.rolling('10s', {
        out: { from: 'v', using: () => 'oops', kind: 'number' },
      }),
    ).toThrow(/not a valid 'number' value/);
  });

  it('throws on a sparse array result (a hole is an invalid element)', () => {
    // `new Array(1)` is a one-hole sparse array. `.every` skips holes; the
    // validator must use an indexed scan (matching intake) so the `undefined`
    // slot is rejected rather than silently coerced to a missing cell.
    const s = new TimeSeries({
      name: 's',
      schema: numSchema,
      rows: [
        [0, 1],
        [1000, 2],
      ],
    });
    expect(() =>
      s.rolling('10s', {
        out: { from: 'v', using: () => new Array(1), kind: 'array' },
      }),
    ).toThrow(/not a valid 'array' value/);
  });
});
