import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'v', kind: 'number', required: false },
] as const;

function makeSeries() {
  return new TimeSeries({
    name: 'm',
    schema,
    rows: [
      [0, 'a', 1],
      [1000, 'b', 4],
      [2000, 'a', undefined],
      [3000, 'b', 10],
      [4000, 'a', 7],
    ],
  });
}

function col(s: TimeSeries<any>, name: string): unknown[] {
  return s.events.map((e) => (e.data() as Record<string, unknown>)[name]);
}

describe('rolling { append: true }', () => {
  it('keeps every source column and adds the outputs after them', () => {
    const s = makeSeries();
    const mapping = {
      vAvg: { from: 'v', using: 'avg' },
      vMax: { from: 'v', using: 'max' },
    } as const;
    const plain = s.rolling('2s', mapping);
    const appended = s.rolling('2s', mapping, { append: true });
    expect(appended.schema.map((c) => c.name)).toEqual([
      'time',
      'host',
      'v',
      'vAvg',
      'vMax',
    ]);
    expect(appended.name).toBe('m');
    expect(col(appended, 'host')).toEqual(col(s, 'host'));
    expect(col(appended, 'v')).toEqual(col(s, 'v'));
    expect(col(appended, 'vAvg')).toEqual(col(plain, 'vAvg'));
    expect(col(appended, 'vMax')).toEqual(col(plain, 'vMax'));
    expect(appended.length).toBe(s.length);
  });

  it('works with count windows, alignment and minSamples', () => {
    const s = makeSeries();
    const mapping = { vSum: { from: 'v', using: 'sum' } } as const;
    for (const [window, options] of [
      [{ count: 2 }, { minSamples: 2 }],
      ['3s', { alignment: 'centered' }],
      ['3s', { alignment: 'leading', minSamples: 2 }],
    ] as const) {
      const plain = s.rolling(window, mapping, options);
      const appended = s.rolling(window, mapping, {
        ...options,
        append: true,
      });
      expect(col(appended, 'vSum')).toEqual(col(plain, 'vSum'));
      expect(col(appended, 'v')).toEqual(col(s, 'v'));
    }
  });

  it('refuses an output that takes an existing name', () => {
    const s = makeSeries();
    expect(() => s.rolling('2s', { v: 'avg' }, { append: true })).toThrow(
      /output column 'v' already exists/,
    );
    expect(() =>
      s.rolling('2s', { host: { from: 'v', using: 'avg' } }, { append: true }),
    ).toThrow(/output column 'host' already exists/);
  });

  it('refuses append with a sequence', () => {
    const s = makeSeries();
    expect(() =>
      (s.rolling as any)(
        Sequence.every('1s'),
        '2s',
        { vAvg: { from: 'v', using: 'avg' } },
        { append: true },
      ),
    ).toThrow(/append is not supported with a sequence/);
  });

  it('refuses an output named after the key', () => {
    const s = makeSeries();
    expect(() =>
      s.rolling('2s', { time: { from: 'v', using: 'avg' } }, { append: true }),
    ).toThrow();
    expect(() => s.diff('v', { output: 'time' })).toThrow(
      /output column 'time' already exists/,
    );
  });

  it('an empty series gives an empty series with every column', () => {
    const empty = new TimeSeries({ name: 'e', schema, rows: [] });
    const rolled = empty.rolling(
      '2s',
      { vAvg: { from: 'v', using: 'avg' } },
      { append: true },
    );
    expect(rolled.length).toBe(0);
    expect(rolled.schema.map((c) => c.name)).toEqual([
      'time',
      'host',
      'v',
      'vAvg',
    ]);
    const changed = empty.diff('v', { output: 'dv', drop: true });
    expect(changed.length).toBe(0);
    expect(changed.schema.map((c) => c.name)).toEqual([
      'time',
      'host',
      'v',
      'dv',
    ]);
  });

  it('append: false is the usual result', () => {
    const s = makeSeries();
    const out = s.rolling(
      '2s',
      { vAvg: { from: 'v', using: 'avg' } },
      { append: false },
    );
    expect(out.schema.map((c) => c.name)).toEqual(['time', 'vAvg']);
  });

  it('per partition, keeps partition and source columns', () => {
    const s = makeSeries();
    const mapping = { vAvg: { from: 'v', using: 'avg' } } as const;
    const plain = s.partitionBy('host').rolling('3s', mapping).collect();
    const appended = s
      .partitionBy('host')
      .rolling('3s', mapping, { append: true })
      .collect();
    expect(appended.schema.map((c) => c.name)).toEqual([
      'time',
      'host',
      'v',
      'vAvg',
    ]);
    expect(col(appended, 'vAvg')).toEqual(col(plain, 'vAvg'));
    expect(col(appended, 'host')).toEqual(col(plain, 'host'));
  });
});

describe('diff / rate / pctChange { output }', () => {
  for (const op of ['diff', 'rate', 'pctChange'] as const) {
    it(`${op}: new column holds the in-place result, source kept`, () => {
      const s = makeSeries();
      const inPlace = s[op]('v');
      const added = s[op]('v', { output: 'dv' });
      expect(added.schema.map((c) => c.name)).toEqual([
        'time',
        'host',
        'v',
        'dv',
      ]);
      expect(added.schema[3]).toEqual({
        name: 'dv',
        kind: 'number',
        required: false,
      });
      expect(col(added, 'dv')).toEqual(col(inPlace, 'v'));
      expect(col(added, 'v')).toEqual(col(s, 'v'));
    });

    it(`${op}: drop removes the first row from every column`, () => {
      const s = makeSeries();
      const added = s[op]('v', { output: 'dv', drop: true });
      expect(added.length).toBe(s.length - 1);
      expect(col(added, 'v')).toEqual(col(s, 'v').slice(1));
      expect(col(added, 'dv')).toEqual(col(s[op]('v', { drop: true }), 'v'));
    });

    it(`${op}: refuses a taken name or several sources`, () => {
      const s = makeSeries();
      expect(() => s[op]('v', { output: 'host' })).toThrow(
        /output column 'host' already exists/,
      );
      expect(() => (s[op] as any)(['v', 'v'], { output: 'dv' })).toThrow(
        /needs exactly one source column/,
      );
    });
  }

  it('per partition, matches the in-place partitioned result', () => {
    const s = makeSeries();
    const inPlace = s.partitionBy('host').diff('v').collect();
    const added = s.partitionBy('host').diff('v', { output: 'dv' }).collect();
    expect(col(added, 'dv')).toEqual(col(inPlace, 'v'));
    expect(col(added, 'v')).toEqual(col(s.partitionBy('host').collect(), 'v'));
  });

  it('a whole chain keeps every column it names', () => {
    const s = makeSeries();
    const out = s
      .fill({ v: 'linear' })
      .diff('v', { output: 'dv' })
      .rolling('2s', { dvAvg: { from: 'dv', using: 'avg' } }, { append: true })
      .tail('2s');
    expect(out.schema.map((c) => c.name)).toEqual([
      'time',
      'host',
      'v',
      'dv',
      'dvAvg',
    ]);
    expect(out.reduce('dvAvg', 'avg')).toBeTypeOf('number');
  });
});
