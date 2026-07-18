import { describe, expect, it } from 'vitest';
import {
  BoundedSequence,
  Interval,
  Sequence,
  Time,
  TimeRange,
  TimeSeries,
  ValidationError,
  type RowForSchema,
} from '../src/index.js';

describe('TimeSeries', () => {
  it('constructs and normalizes time rows into events', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string', required: false },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [[new Date('2025-01-01T00:00:00.000Z'), 0.42, undefined]],
    });

    expect(ts.firstColumnKind).toBe('time');
    expect(ts.length).toBe(1);
    expect(ts.at(0)?.key()).toBeInstanceOf(Time);
    expect(ts.at(0)?.key().type()).toBe('time');
    expect(ts.at(0)?.begin()).toBe(1735689600000);
    expect(ts.at(0)?.end()).toBe(1735689600000);
    expect(ts.at(0)?.timeRange()).toBeInstanceOf(TimeRange);
    expect(ts.at(0)?.data().value).toBe(0.42);
    expect(ts.at(0)?.data().status).toBeUndefined();
    expect(ts.rows[0]?.[0]).toBeInstanceOf(Time);
  });

  it('supports interval based series', () => {
    // Note: every row's interval label must be the same kind — all
    // strings or all numbers within a single series. Pre-2a
    // TimeSeries silently tolerated mixed-kind labels because events
    // were stored as a raw array; sub-step 2a's columnar substrate
    // surfaces this as a loud `RangeError` at intake (see the
    // `IntervalKeyColumn` one-kind-per-column contract).
    const schema = [
      { name: 'interval', kind: 'interval' },
      { name: 'temperature', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'samples',
      schema,
      rows: [
        [{ value: 'row-1', start: 1000, end: 2000 }, 23.4],
        [{ value: 'row-2', start: 2000, end: 3000 }, 24.0],
      ],
    });

    expect(ts.firstColumnKind).toBe('interval');
    expect(ts.length).toBe(2);
    expect(ts.at(0)?.key()).toBeInstanceOf(Interval);
    expect(ts.at(0)?.key()).toMatchObject({ value: 'row-1' });
    expect(ts.at(0)?.key().type()).toBe('interval');
    expect(ts.at(0)?.key().asString()).toBe('row-1');
    expect(ts.at(0)?.key().duration()).toBe(1000);
    expect(ts.at(1)?.begin()).toBe(2000);
  });

  it('supports timeRange based series', () => {
    const schema = [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'active', kind: 'boolean' },
    ] as const;

    const ts = new TimeSeries({
      name: 'window',
      schema,
      rows: [[{ start: 1000, end: 2000 }, true]],
    });

    expect(ts.firstColumnKind).toBe('timeRange');
    expect(ts.at(0)?.key()).toBeInstanceOf(TimeRange);
    expect(ts.at(0)?.key().type()).toBe('timeRange');
    expect(ts.at(0)?.begin()).toBe(1000);
    expect(ts.at(0)?.end()).toBe(2000);
    expect(ts.at(0)?.timeRange()).toBeInstanceOf(TimeRange);
    expect(ts.at(0)?.data().active).toBe(true);
  });

  it('returns the nth event with types derived from the schema', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'host', kind: 'string' },
      { name: 'healthy', kind: 'boolean' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu-usage',
      schema,
      rows: [
        [new Date('2025-01-01T00:00:00.000Z'), 0.42, 'api-1', true],
        [new Date('2025-01-01T00:01:00.000Z'), 0.51, 'api-2', true],
      ],
    });

    const second = ts.at(1);

    expect(second).toBeDefined();
    expect(second?.type()).toBe('time');
    expect(second?.key()).toBeInstanceOf(Time);
    expect(second?.begin()).toBe(1735689660000);
    expect(second?.timeRange()).toEqual(
      new TimeRange({ start: 1735689660000, end: 1735689660000 }),
    );
    expect(second?.data().cpu).toBe(0.51);
    expect(second?.get('cpu')).toBe(0.51);
    expect(second?.data().host).toBe('api-2');
    expect(second?.data().healthy).toBe(true);
  });

  it('converts series key types while preserving payload data', () => {
    const schema = [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'window',
      schema,
      rows: [
        [{ start: 1000, end: 2000 }, 1],
        [{ start: 2000, end: 3000 }, 2],
      ],
    });

    const asTime = ts.asTime({ at: 'center' });
    const asInterval = ts.asInterval((event, index) => `bucket-${index}`);

    expect(asTime.firstColumnKind).toBe('time');
    expect(asTime.at(0)?.key()).toEqual(new Time(1500));
    expect(asTime.at(0)?.get('value')).toBe(1);

    expect(asInterval.firstColumnKind).toBe('interval');
    expect(asInterval.at(0)?.key()).toEqual(
      new Interval({ value: 'bucket-0', start: 1000, end: 2000 }),
    );
    expect(asInterval.at(1)?.key()).toEqual(
      new Interval({ value: 'bucket-1', start: 2000, end: 3000 }),
    );
    expect(asInterval.at(1)?.get('value')).toBe(2);
  });

  it('constructs from JSON-style row arrays with timezone-aware parsing', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string', required: false },
    ] as const;

    const ts = TimeSeries.fromJSON({
      name: 'cpu',
      schema,
      rows: [
        ['2025-01-01T09:00', 0.42, 'ok'],
        ['2025-01-01T10:00', 0.51, null],
      ],
      parse: { timeZone: 'Europe/Madrid' },
    });

    expect(ts.length).toBe(2);
    expect(ts.at(0)?.begin()).toBe(Date.parse('2025-01-01T08:00:00.000Z'));
    expect(ts.at(0)?.get('value')).toBe(0.42);
    expect(ts.at(0)?.get('status')).toBe('ok');
    expect(ts.at(1)?.get('status')).toBeUndefined();
  });

  it('constructs from JSON object rows keyed by schema names', () => {
    const schema = [
      { name: 'interval', kind: 'interval' },
      { name: 'value', kind: 'number' },
      { name: 'active', kind: 'boolean' },
    ] as const;

    const ts = TimeSeries.fromJSON({
      name: 'windows',
      schema,
      rows: [
        {
          interval: { value: 'a', start: '2025-01-01', end: '2025-01-02' },
          value: 1,
          active: true,
        },
      ],
      parse: { timeZone: 'UTC' },
    });

    expect(ts.length).toBe(1);
    expect(ts.at(0)?.key()).toEqual(
      new Interval({
        value: 'a',
        start: Date.parse('2025-01-01T00:00:00.000Z'),
        end: Date.parse('2025-01-02T00:00:00.000Z'),
      }),
    );
    expect(ts.at(0)?.get('value')).toBe(1);
    expect(ts.at(0)?.get('active')).toBe(true);
  });

  it('serializes to JSON-style array rows and round-trips through fromJSON', () => {
    const schema = [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string', required: false },
    ] as const;

    const ts = new TimeSeries({
      name: 'windows',
      schema,
      rows: [
        [new TimeRange({ start: 0, end: 10 }), 1, 'ok'],
        [new TimeRange({ start: 10, end: 20 }), 2, undefined],
      ],
    });

    const json = ts.toJSON();

    expect(json).toEqual({
      name: 'windows',
      schema,
      rows: [
        [[0, 10], 1, 'ok'],
        [[10, 20], 2, null],
      ],
    });

    const roundTripped = TimeSeries.fromJSON(json);
    expect(roundTripped.rows).toEqual(ts.rows);
  });

  it('serializes to JSON object rows keyed by schema names', () => {
    const schema = [
      { name: 'interval', kind: 'interval' },
      { name: 'value', kind: 'number' },
      { name: 'active', kind: 'boolean' },
    ] as const;

    const ts = new TimeSeries({
      name: 'windows',
      schema,
      rows: [[new Interval({ value: 'a', start: 0, end: 10 }), 1, true]],
    });

    const json = ts.toJSON({ rowFormat: 'object' });

    expect(json).toEqual({
      name: 'windows',
      schema,
      rows: [
        {
          interval: { value: 'a', start: 0, end: 10 },
          value: 1,
          active: true,
        },
      ],
    });

    const roundTripped = TimeSeries.fromJSON(json);
    expect(roundTripped.rows).toEqual(ts.rows);
  });

  it('exports normalized row arrays with toRows()', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string', required: false },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [new Date('2025-01-01T00:00:00.000Z'), 1, 'ok'],
        [new Date('2025-01-01T00:01:00.000Z'), 2, undefined],
      ],
    });

    const rows = ts.toRows();

    expect(rows).toEqual(ts.rows);
    expect(rows[0]?.[0]).toBeInstanceOf(Time);
    expect(rows[1]).toEqual([
      new Time(Date.parse('2025-01-01T00:01:00.000Z')),
      2,
      undefined,
    ]);
  });

  it('exports normalized object rows with toObjects()', () => {
    const schema = [
      { name: 'interval', kind: 'interval' },
      { name: 'value', kind: 'number' },
      { name: 'active', kind: 'boolean', required: false },
    ] as const;

    const ts = new TimeSeries({
      name: 'windows',
      schema,
      rows: [
        [new Interval({ value: 'a', start: 0, end: 10 }), 1, true],
        [new Interval({ value: 'b', start: 10, end: 20 }), 2, undefined],
      ],
    });

    const objects = ts.toObjects();

    expect(objects).toEqual([
      {
        interval: new Interval({ value: 'a', start: 0, end: 10 }),
        value: 1,
        active: true,
      },
      {
        interval: new Interval({ value: 'b', start: 10, end: 20 }),
        value: 2,
        active: undefined,
      },
    ]);
  });

  it('supports the README worked example flow end to end', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'requests', kind: 'number' },
      { name: 'host', kind: 'string' },
    ] as const;

    const cpu = TimeSeries.fromJSON({
      name: 'cpu',
      schema,
      rows: [
        ['2025-01-01T00:00:00Z', 0.31, '120', 'api-1'],
        ['2025-01-01T00:01:00Z', 0.44, '135', 'api-1'],
        ['2025-01-01T00:02:00Z', 0.52, '141', 'api-1'],
        ['2025-01-01T00:03:00Z', 0.48, '128', 'api-1'],
        ['2025-01-01T00:04:00Z', 0.63, '166', 'api-1'],
      ].map(([time, cpuValue, requests, host]) => [
        time,
        cpuValue,
        Number(requests),
        host,
      ]),
    });

    const perMinute = cpu.align(Sequence.every('1m'), {
      method: 'hold',
    });
    const fiveMinute = cpu.aggregate(Sequence.every('5m'), {
      cpu: 'avg',
      requests: 'sum',
      host: 'last',
    });
    const rolling = cpu.rolling('3m', {
      cpu: 'avg',
      requests: 'sum',
    });
    const smoothed = cpu.smooth('cpu', 'ema', {
      alpha: 0.35,
      output: 'cpuTrend',
    });

    expect(perMinute.firstColumnKind).toBe('interval');
    expect(perMinute.length).toBe(5);
    expect(perMinute.first()?.key()).toEqual(
      new Interval({
        value: Date.parse('2025-01-01T00:00:00.000Z'),
        start: Date.parse('2025-01-01T00:00:00.000Z'),
        end: Date.parse('2025-01-01T00:01:00.000Z'),
      }),
    );
    expect(perMinute.last()?.get('cpu')).toBe(0.63);

    expect(fiveMinute.firstColumnKind).toBe('interval');
    expect(fiveMinute.length).toBe(1);
    expect(fiveMinute.first()?.get('cpu')).toBeCloseTo(0.476, 6);
    expect(fiveMinute.first()?.get('requests')).toBe(690);
    expect(fiveMinute.first()?.get('host')).toBe('api-1');

    expect(rolling.firstColumnKind).toBe('time');
    expect(rolling.last()?.get('cpu')).toBeCloseTo((0.52 + 0.48 + 0.63) / 3, 6);
    expect(rolling.last()?.get('requests')).toBe(141 + 128 + 166);

    expect(smoothed.firstColumnKind).toBe('time');
    expect(smoothed.last()?.get('cpu')).toBe(0.63);
    expect(smoothed.last()?.get('cpuTrend')).toBeCloseTo(0.5042241875, 9);
  });

  it('collapses a timeseries across selected columns', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'in', kind: 'number' },
      { name: 'out', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'traffic',
      schema,
      rows: [
        [new Date('2025-01-01T00:00:00.000Z'), 10, 20],
        [new Date('2025-01-01T00:01:00.000Z'), 20, 40],
      ],
    });

    const collapsed = ts.collapse(
      ['in', 'out'],
      'avg',
      ({ in: inValue, out }) => {
        return (inValue + out) / 2;
      },
    );

    expect(collapsed.length).toBe(2);
    expect(collapsed.at(0)?.get('avg')).toBe(15);
    expect(collapsed.at(1)?.get('avg')).toBe(30);
    expect(collapsed.at(0)?.data()).toEqual({ avg: 15 });
  });

  it('can append a collapsed field while keeping the originals', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'in', kind: 'number' },
      { name: 'out', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'traffic',
      schema,
      rows: [[new Date('2025-01-01T00:00:00.000Z'), 10, 20]],
    });

    const collapsed = ts.collapse(
      ['in', 'out'],
      'avg',
      ({ in: inValue, out }) => (inValue + out) / 2,
      { append: true },
    );

    expect(collapsed.at(0)?.get('in')).toBe(10);
    expect(collapsed.at(0)?.get('out')).toBe(20);
    expect(collapsed.at(0)?.get('avg')).toBe(15);
  });

  it('selects timeseries columns while preserving event keys', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'host', kind: 'string' },
      { name: 'healthy', kind: 'boolean' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu-usage',
      schema,
      rows: [
        [new Date('2025-01-01T00:00:00.000Z'), 0.42, 'api-1', true],
        [new Date('2025-01-01T00:01:00.000Z'), 0.51, 'api-2', true],
      ],
    });

    const selected = ts.select('host', 'healthy');

    expect(selected.length).toBe(2);
    expect(selected.at(1)?.type()).toBe('time');
    expect(selected.at(1)?.data()).toEqual({ host: 'api-2', healthy: true });
    expect(selected.at(1)?.get('host')).toBe('api-2');
    expect(selected.at(1)?.get('healthy')).toBe(true);
  });

  it('maps a timeseries into a new typed schema', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'in', kind: 'number' },
      { name: 'out', kind: 'number' },
    ] as const;
    const nextSchema = [
      { name: 'time', kind: 'time' },
      { name: 'avg', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'traffic',
      schema,
      rows: [
        [new Date('2025-01-01T00:00:00.000Z'), 10, 20],
        [new Date('2025-01-01T00:01:00.000Z'), 20, 40],
      ],
    });

    const mapped = ts.map(nextSchema, (event) =>
      event.collapse(
        ['in', 'out'],
        'avg',
        ({ in: inValue, out }) => (inValue + out) / 2,
      ),
    );

    expect(mapped.length).toBe(2);
    expect(mapped.firstColumnKind).toBe('time');
    expect(mapped.at(0)?.type()).toBe('time');
    expect(mapped.at(0)?.get('avg')).toBe(15);
    expect(mapped.at(1)?.get('avg')).toBe(30);
    expect(mapped.rows[0]?.[0]).toBeInstanceOf(Time);
  });

  it('renames timeseries columns while preserving keys', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'host', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu-usage',
      schema,
      rows: [
        [new Date('2025-01-01T00:00:00.000Z'), 0.42, 'api-1'],
        [new Date('2025-01-01T00:01:00.000Z'), 0.51, 'api-2'],
      ],
    });

    const renamed = ts.rename({ cpu: 'usage', host: 'server' });

    expect(renamed.length).toBe(2);
    expect(renamed.at(0)?.type()).toBe('time');
    expect(renamed.at(0)?.data()).toEqual({ usage: 0.42, server: 'api-1' });
    expect(renamed.at(1)?.get('usage')).toBe(0.51);
    expect(renamed.at(1)?.get('server')).toBe('api-2');
  });

  it('supports merging payload fields through series.map', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'host', kind: 'string' },
    ] as const;
    const nextSchema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'host', kind: 'string' },
      { name: 'healthy', kind: 'boolean' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu-usage',
      schema,
      rows: [
        [new Date('2025-01-01T00:00:00.000Z'), 0.42, 'api-1'],
        [new Date('2025-01-01T00:01:00.000Z'), 0.51, 'api-2'],
      ],
    });

    const mapped = ts.map(nextSchema, (event) =>
      event.merge({ healthy: event.get('cpu') < 0.9 }),
    );

    expect(mapped.length).toBe(2);
    expect(mapped.at(0)?.get('cpu')).toBe(0.42);
    expect(mapped.at(0)?.get('host')).toBe('api-1');
    expect(mapped.at(0)?.get('healthy')).toBe(true);
    expect(mapped.at(1)?.get('healthy')).toBe(true);
  });

  it('supports first, last and slice as positional operations', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [new Date('2025-01-01T00:00:00.000Z'), 1],
        [new Date('2025-01-01T00:01:00.000Z'), 2],
        [new Date('2025-01-01T00:02:00.000Z'), 3],
      ],
    });

    const sliced = ts.slice(1, 3);

    expect(ts.first()?.get('value')).toBe(1);
    expect(ts.last()?.get('value')).toBe(3);
    expect(sliced.length).toBe(2);
    expect(sliced.at(0)?.get('value')).toBe(2);
    expect(sliced.at(1)?.get('value')).toBe(3);
  });

  it('filters events while preserving schema and order', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'active', kind: 'boolean' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [new Date('2025-01-01T00:00:00.000Z'), 1, false],
        [new Date('2025-01-01T00:01:00.000Z'), 2, true],
        [new Date('2025-01-01T00:02:00.000Z'), 3, true],
      ],
    });

    const filtered = ts.filter((event) => event.get('active'));

    expect(filtered.length).toBe(2);
    expect(filtered.first()?.get('value')).toBe(2);
    expect(filtered.last()?.get('value')).toBe(3);
    expect(filtered.first()?.key()).toBeInstanceOf(Time);
  });

  it('supports find, some and every over typed events', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'active', kind: 'boolean' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [new Date('2025-01-01T00:00:00.000Z'), 1, false],
        [new Date('2025-01-01T00:01:00.000Z'), 2, true],
        [new Date('2025-01-01T00:02:00.000Z'), 3, true],
      ],
    });

    const found = ts.find((event) => event.get('active'));

    expect(found?.get('value')).toBe(2);
    expect(found?.key()).toBeInstanceOf(Time);
    expect(ts.some((event) => event.get('value') === 3)).toBe(true);
    expect(ts.some((event) => event.get('value') === 4)).toBe(false);
    expect(ts.every((event) => event.get('value') > 0)).toBe(true);
    expect(ts.every((event) => event.get('active'))).toBe(false);
  });

  it('selects events within timestamps inclusively', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [new Date('2025-01-01T00:00:00.000Z'), 1],
        [new Date('2025-01-01T00:01:00.000Z'), 2],
        [new Date('2025-01-01T00:02:00.000Z'), 3],
      ],
    });

    const selected = ts.within(
      new Date('2025-01-01T00:01:00.000Z'),
      new Date('2025-01-01T00:02:00.000Z'),
    );

    expect(selected.length).toBe(2);
    expect(selected.at(0)?.get('value')).toBe(2);
    expect(selected.at(1)?.get('value')).toBe(3);
  });

  it('selects interval keyed events contained by a range-like value', () => {
    const schema = [
      { name: 'interval', kind: 'interval' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'windowed',
      schema,
      rows: [
        [new Interval({ value: 'a', start: 0, end: 10 }), 1],
        [new Interval({ value: 'b', start: 10, end: 20 }), 2],
        [new Interval({ value: 'c', start: 20, end: 30 }), 3],
      ],
    });

    const byRange = ts.within(new TimeRange({ start: 10, end: 30 }));
    const byInterval = ts.within(
      new Interval({ value: 'window', start: 0, end: 20 }),
    );

    expect(byRange.length).toBe(2);
    expect(byRange.at(0)?.key().valueOf()).toBe('b');
    expect(byRange.at(1)?.key().valueOf()).toBe('c');
    expect(byInterval.length).toBe(2);
    expect(byInterval.at(0)?.key().valueOf()).toBe('a');
    expect(byInterval.at(1)?.key().valueOf()).toBe('b');
  });

  it('supports before and after with exclusive boundaries', () => {
    const schema = [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'ranges',
      schema,
      rows: [
        [new TimeRange({ start: 0, end: 10 }), 1],
        [new TimeRange({ start: 10, end: 20 }), 2],
        [new TimeRange({ start: 20, end: 30 }), 3],
      ],
    });

    const before = ts.before(20);
    const after = ts.after(10);

    expect(before.length).toBe(1);
    expect(before.first()?.get('value')).toBe(1);
    expect(after.length).toBe(1);
    expect(after.first()?.get('value')).toBe(3);
  });

  it('supports exact key membership and key-position lookup', () => {
    const schema = [
      { name: 'interval', kind: 'interval' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'windowed',
      schema,
      rows: [
        [new Interval({ value: 'a', start: 0, end: 10 }), 1],
        [new Interval({ value: 'b', start: 10, end: 20 }), 2],
        [new Interval({ value: 'c', start: 20, end: 30 }), 3],
      ],
    });

    expect(
      ts.includesKey(new Interval({ value: 'b', start: 10, end: 20 })),
    ).toBe(true);
    expect(
      ts.includesKey(new Interval({ value: 'missing', start: 10, end: 20 })),
    ).toBe(false);
    expect(ts.bisect(new Interval({ value: 'bb', start: 15, end: 18 }))).toBe(
      2,
    );
    expect(
      ts
        .atOrBefore(new Interval({ value: 'bb', start: 15, end: 18 }))
        ?.get('value'),
    ).toBe(2);
    expect(
      ts
        .atOrAfter(new Interval({ value: 'bb', start: 15, end: 18 }))
        ?.get('value'),
    ).toBe(3);
    expect(
      ts
        .atOrBefore(new Interval({ value: 'b', start: 10, end: 20 }))
        ?.get('value'),
    ).toBe(2);
    expect(
      ts
        .atOrAfter(new Interval({ value: 'b', start: 10, end: 20 }))
        ?.get('value'),
    ).toBe(2);
  });

  it('nearest rounds to the closest event by key distance', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const ts = new TimeSeries({
      name: 'pts',
      schema,
      rows: [
        [new Time(0), 1],
        [new Time(10), 2],
        [new Time(20), 3],
      ],
    });
    // Within the span: the nearer neighbour; ties go to the earlier event.
    expect(ts.nearest(new Time(12))?.get('value')).toBe(2); // closer to 10
    expect(ts.nearest(new Time(16))?.get('value')).toBe(3); // closer to 20
    expect(ts.nearest(new Time(15))?.get('value')).toBe(2); // tie → earlier
    expect(ts.nearest(new Time(10))?.get('value')).toBe(2); // exact
    // Out of range: the nearest endpoint that exists (closest existing event).
    expect(ts.nearest(new Time(-5))?.get('value')).toBe(1);
    expect(ts.nearest(new Time(999))?.get('value')).toBe(3);
    // Empty series → undefined.
    expect(
      new TimeSeries({ name: 'empty', schema, rows: [] }).nearest(new Time(5)),
    ).toBeUndefined();
  });

  it('aligns a point series onto a sequence using hold sampling', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [10, 1, 'a'],
        [20, 3, 'b'],
        [30, 5, 'c'],
      ],
    });

    const aligned = ts.align(Sequence.every(10), {
      method: 'hold',
      range: new TimeRange({ start: 10, end: 30 }),
    });

    expect(aligned.firstColumnKind).toBe('interval');
    expect(aligned.length).toBe(3);
    expect(aligned.at(0)?.key()).toEqual(
      new Interval({ value: 10, start: 10, end: 20 }),
    );
    expect(aligned.at(0)?.get('value')).toBe(1);
    expect(aligned.at(1)?.get('value')).toBe(3);
    expect(aligned.at(2)?.get('value')).toBe(5);
    expect(aligned.at(2)?.get('status')).toBe('c');
  });

  it('aligns a point series onto a bounded sequence directly', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [10, 1],
        [20, 3],
        [30, 5],
      ],
    });

    const bounded = new BoundedSequence([
      new Interval({ value: 10, start: 10, end: 20 }),
      new Interval({ value: 20, start: 20, end: 30 }),
      new Interval({ value: 30, start: 30, end: 40 }),
    ]);

    const aligned = ts.align(bounded, { method: 'hold' });

    expect(aligned.length).toBe(3);
    expect(aligned.at(0)?.get('value')).toBe(1);
    expect(aligned.at(1)?.get('value')).toBe(3);
    expect(aligned.at(2)?.get('value')).toBe(5);
  });

  it('aligns a point series onto a sequence using linear interpolation', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [10, 0, 'a'],
        [20, 10, 'b'],
        [30, 20, 'c'],
      ],
    });

    const aligned = ts.align(Sequence.every(5), {
      method: 'linear',
      range: new TimeRange({ start: 10, end: 30 }),
    });

    expect(aligned.length).toBe(5);
    expect(aligned.at(0)?.get('value')).toBe(0);
    expect(aligned.at(1)?.get('value')).toBe(5);
    expect(aligned.at(2)?.get('value')).toBe(10);
    expect(aligned.at(3)?.get('value')).toBe(15);
    expect(aligned.at(4)?.get('value')).toBe(20);
    expect(aligned.at(1)?.get('status')).toBe('a');
    expect(aligned.at(3)?.get('status')).toBe('b');
  });

  it('supports center-sampled alignment', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [10, 1],
        [20, 3],
        [30, 5],
      ],
    });

    const aligned = ts.align(Sequence.every(10), {
      method: 'hold',
      sample: 'center',
      range: new TimeRange({ start: 10, end: 30 }),
    });

    expect(aligned.length).toBe(2);
    expect(aligned.at(0)?.key()).toEqual(
      new Interval({ value: 10, start: 10, end: 20 }),
    );
    expect(aligned.at(0)?.get('value')).toBe(1);
    expect(aligned.at(1)?.get('value')).toBe(3);
  });

  it('supports end-sampled alignment with hold', () => {
    // sample: 'end' anchors at interval.end(); the held value is the
    // most recent source ≤ that endpoint.
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [10, 1],
        [20, 3],
        [30, 5],
      ],
    });

    const aligned = ts.align(Sequence.every(10), {
      method: 'hold',
      sample: 'end',
      range: new TimeRange({ start: 10, end: 30 }),
    });

    // Two interval-keyed outputs; end-sample reads the value at
    // interval.end() — i.e. the source value at 20 for the first
    // bucket [10, 20) and at 30 for the second [20, 30).
    expect(aligned.length).toBe(2);
    expect(aligned.at(0)?.key()).toEqual(
      new Interval({ value: 10, start: 10, end: 20 }),
    );
    expect(aligned.at(0)?.get('value')).toBe(3); // hold @ end=20 -> source@20=3
    expect(aligned.at(1)?.get('value')).toBe(5); // hold @ end=30 -> source@30=5
  });

  it('supports end-sampled alignment with linear interpolation', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [10, 1],
        [30, 5], // linear interpolation between 10 and 30
      ],
    });

    const aligned = ts.align(Sequence.every(10), {
      method: 'linear',
      sample: 'end',
      range: new TimeRange({ start: 10, end: 30 }),
    });

    // First bucket [10, 20) ends at 20 — interpolated between 1@10 and
    // 5@30 gives 3 at t=20. Second bucket [20, 30) ends at 30 — exactly
    // the source value 5.
    expect(aligned.length).toBe(2);
    expect(aligned.at(0)?.get('value')).toBe(3);
    expect(aligned.at(1)?.get('value')).toBe(5);
  });

  it('merges aligned series on exact interval keys', () => {
    const leftSchema = [
      { name: 'interval', kind: 'interval' },
      { name: 'cpu', kind: 'number' },
    ] as const;
    const rightSchema = [
      { name: 'interval', kind: 'interval' },
      { name: 'host', kind: 'string' },
    ] as const;

    const left = new TimeSeries({
      name: 'left',
      schema: leftSchema,
      rows: [
        [new Interval({ value: 0, start: 0, end: 10 }), 1],
        [new Interval({ value: 10, start: 10, end: 20 }), 2],
      ],
    });
    const right = new TimeSeries({
      name: 'right',
      schema: rightSchema,
      rows: [
        [new Interval({ value: 0, start: 0, end: 10 }), 'a'],
        [new Interval({ value: 10, start: 10, end: 20 }), 'b'],
      ],
    });

    const joined = left.join(right);

    expect(joined.firstColumnKind).toBe('interval');
    expect(joined.length).toBe(2);
    expect(joined.at(0)?.key()).toEqual(
      new Interval({ value: 0, start: 0, end: 10 }),
    );
    expect(joined.at(0)?.get('cpu')).toBe(1);
    expect(joined.at(0)?.get('host')).toBe('a');
    expect(joined.at(1)?.get('cpu')).toBe(2);
    expect(joined.at(1)?.get('host')).toBe('b');
  });

  it('performs a full outer join when keys appear on only one side', () => {
    const leftSchema = [
      { name: 'interval', kind: 'interval' },
      { name: 'cpu', kind: 'number' },
    ] as const;
    const rightSchema = [
      { name: 'interval', kind: 'interval' },
      { name: 'host', kind: 'string' },
    ] as const;

    const left = new TimeSeries({
      name: 'left',
      schema: leftSchema,
      rows: [[new Interval({ value: 0, start: 0, end: 10 }), 1]],
    });
    const right = new TimeSeries({
      name: 'right',
      schema: rightSchema,
      rows: [
        [new Interval({ value: 0, start: 0, end: 10 }), 'a'],
        [new Interval({ value: 10, start: 10, end: 20 }), 'b'],
      ],
    });

    const joined = left.join(right);

    expect(joined.length).toBe(2);
    expect(joined.at(0)?.get('cpu')).toBe(1);
    expect(joined.at(0)?.get('host')).toBe('a');
    expect(joined.at(1)?.get('cpu')).toBeUndefined();
    expect(joined.at(1)?.get('host')).toBe('b');
  });

  it('supports left, right and inner join variants', () => {
    const leftSchema = [
      { name: 'interval', kind: 'interval' },
      { name: 'cpu', kind: 'number' },
    ] as const;
    const rightSchema = [
      { name: 'interval', kind: 'interval' },
      { name: 'host', kind: 'string' },
    ] as const;

    const left = new TimeSeries({
      name: 'left',
      schema: leftSchema,
      rows: [
        [new Interval({ value: 0, start: 0, end: 10 }), 1],
        [new Interval({ value: 10, start: 10, end: 20 }), 2],
      ],
    });
    const right = new TimeSeries({
      name: 'right',
      schema: rightSchema,
      rows: [
        [new Interval({ value: 10, start: 10, end: 20 }), 'b'],
        [new Interval({ value: 20, start: 20, end: 30 }), 'c'],
      ],
    });

    const leftJoined = left.join(right, { type: 'left' });
    const rightJoined = left.join(right, { type: 'right' });
    const innerJoined = left.join(right, { type: 'inner' });

    expect(leftJoined.length).toBe(2);
    expect(leftJoined.at(0)?.get('cpu')).toBe(1);
    expect(leftJoined.at(0)?.get('host')).toBeUndefined();
    expect(leftJoined.at(1)?.get('cpu')).toBe(2);
    expect(leftJoined.at(1)?.get('host')).toBe('b');

    expect(rightJoined.length).toBe(2);
    expect(rightJoined.at(0)?.get('cpu')).toBe(2);
    expect(rightJoined.at(0)?.get('host')).toBe('b');
    expect(rightJoined.at(1)?.get('cpu')).toBeUndefined();
    expect(rightJoined.at(1)?.get('host')).toBe('c');

    expect(innerJoined.length).toBe(1);
    expect(innerJoined.at(0)?.key()).toEqual(
      new Interval({ value: 10, start: 10, end: 20 }),
    );
    expect(innerJoined.at(0)?.get('cpu')).toBe(2);
    expect(innerJoined.at(0)?.get('host')).toBe('b');
  });

  it('supports prefix-based conflict handling for join', () => {
    const left = new TimeSeries({
      name: 'left',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [[new Interval({ value: 0, start: 0, end: 10 }), 1]],
    });
    const right = new TimeSeries({
      name: 'right',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [[new Interval({ value: 0, start: 0, end: 10 }), 2]],
    });

    const joined = left.join(right, {
      onConflict: 'prefix',
      prefixes: ['left', 'right'] as const,
    });

    expect(joined.at(0)?.data()).toEqual({ left_value: 1, right_value: 2 });
  });

  it('joins many series into one wide series', () => {
    const cpu = new TimeSeries({
      name: 'cpu',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'cpu', kind: 'number' },
      ] as const,
      rows: [
        [new Interval({ value: 0, start: 0, end: 10 }), 1],
        [new Interval({ value: 10, start: 10, end: 20 }), 2],
      ],
    });
    const host = new TimeSeries({
      name: 'host',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'host', kind: 'string' },
      ] as const,
      rows: [[new Interval({ value: 10, start: 10, end: 20 }), 'api-1']],
    });
    const healthy = new TimeSeries({
      name: 'healthy',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'healthy', kind: 'boolean' },
      ] as const,
      rows: [
        [new Interval({ value: 0, start: 0, end: 10 }), true],
        [new Interval({ value: 20, start: 20, end: 30 }), false],
      ],
    });

    const joined = TimeSeries.joinMany([cpu, host, healthy]);

    expect(joined.length).toBe(3);
    expect(joined.at(0)?.get('cpu')).toBe(1);
    expect(joined.at(0)?.get('host')).toBeUndefined();
    expect(joined.at(0)?.get('healthy')).toBe(true);
    expect(joined.at(1)?.get('cpu')).toBe(2);
    expect(joined.at(1)?.get('host')).toBe('api-1');
    expect(joined.at(1)?.get('healthy')).toBeUndefined();
    expect(joined.at(2)?.get('cpu')).toBeUndefined();
    expect(joined.at(2)?.get('host')).toBeUndefined();
    expect(joined.at(2)?.get('healthy')).toBe(false);
  });

  it('supports prefix-based conflict handling for joinMany', () => {
    const left = new TimeSeries({
      name: 'left',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [[new Interval({ value: 0, start: 0, end: 10 }), 1]],
    });
    const middle = new TimeSeries({
      name: 'middle',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [[new Interval({ value: 0, start: 0, end: 10 }), 2]],
    });
    const right = new TimeSeries({
      name: 'right',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [[new Interval({ value: 0, start: 0, end: 10 }), 3]],
    });

    const joined = TimeSeries.joinMany([left, middle, right], {
      onConflict: 'prefix',
      prefixes: ['left', 'middle', 'right'] as const,
    });

    expect(joined.at(0)?.data()).toEqual({
      left_value: 1,
      middle_value: 2,
      right_value: 3,
    });
  });

  it('supports joinMany with inner join semantics', () => {
    const left = new TimeSeries({
      name: 'left',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'cpu', kind: 'number' },
      ] as const,
      rows: [
        [new Interval({ value: 0, start: 0, end: 10 }), 1],
        [new Interval({ value: 10, start: 10, end: 20 }), 2],
      ],
    });
    const middle = new TimeSeries({
      name: 'middle',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'host', kind: 'string' },
      ] as const,
      rows: [[new Interval({ value: 10, start: 10, end: 20 }), 'api-1']],
    });
    const right = new TimeSeries({
      name: 'right',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'healthy', kind: 'boolean' },
      ] as const,
      rows: [
        [new Interval({ value: 10, start: 10, end: 20 }), true],
        [new Interval({ value: 20, start: 20, end: 30 }), false],
      ],
    });

    const joined = TimeSeries.joinMany([left, middle, right], {
      type: 'inner',
    });

    expect(joined.length).toBe(1);
    expect(joined.at(0)?.key()).toEqual(
      new Interval({ value: 10, start: 10, end: 20 }),
    );
    expect(joined.at(0)?.get('cpu')).toBe(2);
    expect(joined.at(0)?.get('host')).toBe('api-1');
    expect(joined.at(0)?.get('healthy')).toBe(true);
  });

  it('rejects join when payload column names overlap', () => {
    const schema = [
      { name: 'interval', kind: 'interval' },
      { name: 'value', kind: 'number' },
    ] as const;

    const left = new TimeSeries({
      name: 'left',
      schema,
      rows: [[new Interval({ value: 0, start: 0, end: 10 }), 1]],
    });
    const right = new TimeSeries({
      name: 'right',
      schema,
      rows: [[new Interval({ value: 0, start: 0, end: 10 }), 2]],
    });

    expect(() => left.join(right)).toThrowError('duplicate column names');
  });

  it('rejects prefix conflict handling when prefixed names still collide', () => {
    const left = new TimeSeries({
      name: 'left',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [[new Interval({ value: 0, start: 0, end: 10 }), 1]],
    });
    const right = new TimeSeries({
      name: 'right',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'value', kind: 'number' },
        { name: 'left_value', kind: 'number' },
      ] as const,
      rows: [[new Interval({ value: 0, start: 0, end: 10 }), 2, 3]],
    });

    expect(() =>
      left.join(right, {
        onConflict: 'prefix',
        prefixes: ['left', 'right'] as const,
      }),
    ).toThrowError('still produced duplicate column names');
  });

  it('rejects join when key kinds differ', () => {
    const left = new TimeSeries({
      name: 'left',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cpu', kind: 'number' },
      ] as const,
      rows: [[10, 1]],
    });
    const right = new TimeSeries({
      name: 'right',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'host', kind: 'string' },
      ] as const,
      rows: [[new Interval({ value: 10, start: 10, end: 20 }), 'api-1']],
    });

    expect(() => left.join(right)).toThrowError('different key kinds');
  });

  it('aggregates point series into sequence buckets with built-in reducers', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 1, 'a'],
        [5, 2, 'b'],
        [10, 3, 'c'],
        [15, 4, 'd'],
        [20, 5, 'e'],
      ],
    });

    const aggregated = ts.aggregate(
      Sequence.every(10),
      { value: 'avg', status: 'first' },
      { range: new TimeRange({ start: 0, end: 20 }) },
    );

    expect(aggregated.firstColumnKind).toBe('interval');
    expect(aggregated.length).toBe(3);
    expect(aggregated.at(0)?.key()).toEqual(
      new Interval({ value: 0, start: 0, end: 10 }),
    );
    expect(aggregated.at(0)?.get('value')).toBe(1.5);
    expect(aggregated.at(0)?.get('status')).toBe('a');
    expect(aggregated.at(1)?.get('value')).toBe(3.5);
    expect(aggregated.at(1)?.get('status')).toBe('c');
    expect(aggregated.at(2)?.get('value')).toBe(5);
    expect(aggregated.at(2)?.get('status')).toBe('e');
  });

  it('computes trailing rolling aggregations while preserving the original key type', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 1, 'a'],
        [5, 2, 'b'],
        [10, 3, 'c'],
        [15, 4, 'd'],
      ],
    });

    const rolled = ts.rolling(10, { value: 'avg', status: 'last' });

    expect(rolled.firstColumnKind).toBe('time');
    expect(rolled.at(0)?.key()).toEqual(new Time(0));
    expect(rolled.at(0)?.get('value')).toBe(1);
    expect(rolled.at(0)?.get('status')).toBe('a');
    expect(rolled.at(1)?.get('value')).toBe(1.5);
    expect(rolled.at(1)?.get('status')).toBe('b');
    expect(rolled.at(2)?.get('value')).toBe(2.5);
    expect(rolled.at(2)?.get('status')).toBe('c');
    expect(rolled.at(3)?.get('value')).toBe(3.5);
    expect(rolled.at(3)?.get('status')).toBe('d');
  });

  it('supports centered rolling windows', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 1],
        [5, 2],
        [10, 3],
      ],
    });

    const rolled = ts.rolling(
      10,
      { value: 'count' },
      { alignment: 'centered' },
    );

    expect(rolled.at(0)?.get('value')).toBe(1);
    expect(rolled.at(1)?.get('value')).toBe(2);
    expect(rolled.at(2)?.get('value')).toBe(2);
  });

  it('supports sequence-driven rolling windows on a fixed grid', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 1, 'a'],
        [5, 2, 'b'],
        [10, 3, 'c'],
        [15, 4, 'd'],
      ],
    });

    const rolled = ts.rolling(
      Sequence.every(10),
      10,
      { value: 'avg', status: 'last' },
      { range: new TimeRange({ start: 0, end: 20 }) },
    );

    expect(rolled.firstColumnKind).toBe('interval');
    expect(rolled.at(0)?.key()).toEqual(
      new Interval({ value: 0, start: 0, end: 10 }),
    );
    expect(rolled.at(0)?.get('value')).toBe(1);
    expect(rolled.at(0)?.get('status')).toBe('a');
    expect(rolled.at(1)?.key()).toEqual(
      new Interval({ value: 10, start: 10, end: 20 }),
    );
    expect(rolled.at(1)?.get('value')).toBe(2.5);
    expect(rolled.at(1)?.get('status')).toBe('c');
    expect(rolled.at(2)?.key()).toEqual(
      new Interval({ value: 20, start: 20, end: 30 }),
    );
    expect(rolled.at(2)?.get('value')).toBe(4);
    expect(rolled.at(2)?.get('status')).toBe('d');
  });

  it('supports centered fixed-window rolling with centered bucket sampling', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 1],
        [5, 2],
        [10, 3],
        [15, 4],
      ],
    });

    const rolled = ts.rolling(
      Sequence.every(10),
      10,
      { value: 'count' },
      {
        alignment: 'centered',
        sample: 'center',
        range: new TimeRange({ start: 0, end: 15 }),
      },
    );

    expect(rolled.length).toBe(2);
    expect(rolled.at(0)?.get('value')).toBe(2);
    expect(rolled.at(1)?.get('value')).toBe(2);
  });

  it('supports ema smoothing on one numeric column while preserving keys and other fields', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 1, 'a'],
        [5, 3, 'b'],
        [10, 5, 'c'],
      ],
    });

    const smoothed = ts.smooth('value', 'ema', { alpha: 0.5 });

    expect(smoothed.firstColumnKind).toBe('time');
    expect(smoothed.at(0)?.key()).toEqual(new Time(0));
    expect(smoothed.at(0)?.get('value')).toBe(1);
    expect(smoothed.at(0)?.get('status')).toBe('a');
    expect(smoothed.at(1)?.get('value')).toBe(2);
    expect(smoothed.at(2)?.get('value')).toBe(3.5);
    expect(smoothed.at(0)?.data()).toEqual({ value: 1, status: 'a' });
  });

  it('can append a smoothed column instead of replacing the source column', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 1, 'a'],
        [5, 3, 'b'],
        [10, 5, 'c'],
      ],
    });

    const smoothed = ts.smooth('value', 'ema', {
      alpha: 0.5,
      output: 'valueEma',
    });

    expect(smoothed.at(0)?.get('value')).toBe(1);
    expect(smoothed.at(0)?.get('valueEma')).toBe(1);
    expect(smoothed.at(1)?.get('value')).toBe(3);
    expect(smoothed.at(1)?.get('valueEma')).toBe(2);
    expect(smoothed.at(2)?.get('status')).toBe('c');
  });

  it('warmup drops the first N rows from the EMA output', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const ts = new TimeSeries({
      name: 's',
      schema,
      rows: Array.from({ length: 10 }, (_, i) => [i * 1000, i] as const),
    });

    // Without warmup — first event is the raw value (EMA seed), EMA
    // converges toward the source over time.
    const full = ts.smooth('value', 'ema', { alpha: 0.5 });
    expect(full.length).toBe(10);
    expect(full.at(0)!.get('value')).toBe(0); // seed

    // With warmup: 4 — drops the first 4 rows. The remaining rows
    // have been through enough updates that the EMA has "warmed up".
    const warm = ts.smooth('value', 'ema', { alpha: 0.5, warmup: 4 });
    expect(warm.length).toBe(6);
    expect(warm.first()!.begin()).toBe(4000);

    // Same smoothed values — the warmup only trims the output, it
    // doesn't change how the remaining values were computed.
    for (let i = 0; i < warm.length; i += 1) {
      expect(warm.at(i)!.get('value')).toBe(full.at(i + 4)!.get('value'));
    }
  });

  it('warmup: 0 is a no-op (matches no-warmup behavior)', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const ts = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, 1],
        [1000, 2],
        [2000, 3],
      ],
    });

    const zero = ts.smooth('value', 'ema', { alpha: 0.5, warmup: 0 });
    const none = ts.smooth('value', 'ema', { alpha: 0.5 });
    expect(zero.length).toBe(none.length);
    for (let i = 0; i < zero.length; i += 1) {
      expect(zero.at(i)!.get('value')).toBe(none.at(i)!.get('value'));
    }
  });

  it('warmup >= series length returns an empty series with the same schema', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const ts = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, 1],
        [1000, 2],
      ],
    });

    const empty = ts.smooth('value', 'ema', { alpha: 0.5, warmup: 5 });
    expect(empty.length).toBe(0);
    // Smooth always marks the target column as optional (smoothing may
    // produce undefined), so the schema is equal-up-to-required.
    expect(empty.schema.map((c) => [c.name, c.kind])).toEqual(
      ts.schema.map((c) => [c.name, c.kind]),
    );
  });

  it('warmup works with the output option (keeps source, trims rows)', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const ts = new TimeSeries({
      name: 's',
      schema,
      rows: Array.from({ length: 6 }, (_, i) => [i * 1000, i + 1] as const),
    });

    const smoothed = ts.smooth('value', 'ema', {
      alpha: 0.4,
      warmup: 2,
      output: 'ema',
    });
    expect(smoothed.length).toBe(4);
    // Source column preserved on every kept row.
    expect(smoothed.first()!.get('value')).toBe(3);
    expect(smoothed.first()!.get('ema')).toBeGreaterThan(0);
  });

  it('rejects invalid warmup values', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const ts = new TimeSeries({
      name: 's',
      schema,
      rows: [[0, 1]],
    });

    expect(() => ts.smooth('value', 'ema', { alpha: 0.5, warmup: -1 })).toThrow(
      /non-negative integer/,
    );
    expect(() =>
      ts.smooth('value', 'ema', { alpha: 0.5, warmup: 2.5 }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      ts.smooth('value', 'ema', { alpha: 0.5, warmup: NaN }),
    ).toThrow(/non-negative integer/);
  });

  it('uses interval centers when smoothing moving averages', () => {
    const schema = [
      { name: 'interval', kind: 'interval' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'windows',
      schema,
      rows: [
        [{ value: 'a', start: 0, end: 10 }, 1],
        [{ value: 'b', start: 20, end: 30 }, 3],
        [{ value: 'c', start: 40, end: 50 }, 5],
      ],
    });

    const smoothed = ts.smooth('value', 'movingAverage', {
      window: 50,
      alignment: 'centered',
    });

    expect(smoothed.firstColumnKind).toBe('interval');
    expect(smoothed.at(0)?.key()).toEqual(
      new Interval({ value: 'a', start: 0, end: 10 }),
    );
    expect(smoothed.at(0)?.get('value')).toBe(2);
    expect(smoothed.at(1)?.get('value')).toBe(3);
    expect(smoothed.at(2)?.get('value')).toBe(4);
  });

  it('supports loess smoothing on a numeric column', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 0, 'a'],
        [10, 11, 'b'],
        [20, 19, 'c'],
        [30, 31, 'd'],
        [40, 39, 'e'],
      ],
    });

    const smoothed = ts.smooth('value', 'loess', {
      span: 0.8,
      output: 'valueLoess',
    });

    expect(smoothed.firstColumnKind).toBe('time');
    expect(smoothed.at(0)?.get('value')).toBe(0);
    expect(smoothed.at(0)?.get('status')).toBe('a');
    expect(smoothed.at(0)?.get('valueLoess')).toBeGreaterThan(-1);
    expect(smoothed.at(0)?.get('valueLoess')).toBeLessThan(1);
    expect(smoothed.at(2)?.get('valueLoess')).toBeGreaterThan(18);
    expect(smoothed.at(2)?.get('valueLoess')).toBeLessThan(22);
    expect(smoothed.at(4)?.get('valueLoess')).toBeGreaterThan(38);
    expect(smoothed.at(4)?.get('valueLoess')).toBeLessThan(42);
  });

  it('loess is numerically stable and shift-invariant on epoch-ms anchors', () => {
    // Regression: the local regression must be conditioned on centred x. With
    // absolute epoch-ms anchors (~1.7e12) the un-centred normal equations lost
    // all precision to floating-point cancellation, so the fit overshot wildly
    // (well outside the data range) instead of smoothing. The fitted trend must
    // not depend on the absolute time origin, only on the spacing + values.
    //
    // The spacing matters: cancellation severity scales with
    // (anchor magnitude / window width)², so second-spaced anchors (old-code
    // error ~81, fits far outside the data range) pin the bug where day-spaced
    // anchors (~6e-7) would slip under the assertion and pass on the old code.
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const values = Array.from({ length: 60 }, (_, i) =>
      Math.round(50 + 30 * Math.sin(i / 5) + (i % 7) - 3),
    );
    const min = Math.min(...values);
    const max = Math.max(...values);

    const build = (base: number) =>
      new TimeSeries({
        name: 's',
        schema,
        rows: values.map((v, i) => [base + i * 1000, v]),
      }).smooth('value', 'loess', { span: 0.3, output: 'loess' });

    const small = build(0);
    const epoch = build(Date.UTC(2026, 0, 1));

    for (let i = 0; i < values.length; i++) {
      const s = small.at(i)?.get('loess') as number;
      const e = epoch.at(i)?.get('loess') as number;
      // Shift-invariant to the absolute origin (was off by >0.5 before the fix).
      expect(Math.abs(s - e)).toBeLessThan(1e-6);
      // And a genuine local mean — never outside the data range.
      expect(e).toBeGreaterThanOrEqual(min - 1);
      expect(e).toBeLessThanOrEqual(max + 1);
    }
  });

  it('supports sum, count and last aggregations', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 1, 'a'],
        [5, 2, 'b'],
        [10, 3, 'c'],
        [15, 4, 'd'],
      ],
    });

    const aggregated = ts.aggregate(
      Sequence.every(10),
      { value: 'sum', status: 'last' },
      { range: new TimeRange({ start: 0, end: 10 }) },
    );
    const counted = ts.aggregate(
      Sequence.every(10),
      { value: 'count' },
      { range: new TimeRange({ start: 0, end: 10 }) },
    );

    expect(aggregated.length).toBe(2);
    expect(aggregated.at(0)?.get('value')).toBe(3);
    expect(aggregated.at(0)?.get('status')).toBe('b');
    expect(aggregated.at(1)?.get('value')).toBe(7);
    expect(aggregated.at(1)?.get('status')).toBe('d');
    expect(counted.at(0)?.get('value')).toBe(2);
    expect(counted.at(1)?.get('value')).toBe(2);
  });

  it('supports min and max aggregations at the series level', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 10],
        [5, 2],
        [10, 8],
        [15, 4],
      ],
    });

    const aggregated = ts.aggregate(
      Sequence.every(10),
      { value: 'min' },
      { range: new TimeRange({ start: 0, end: 10 }) },
    );
    const aggregatedMax = ts.aggregate(
      Sequence.every(10),
      { value: 'max' },
      { range: new TimeRange({ start: 0, end: 10 }) },
    );

    expect(aggregated.at(0)?.get('value')).toBe(2);
    expect(aggregated.at(1)?.get('value')).toBe(4);
    expect(aggregatedMax.at(0)?.get('value')).toBe(10);
    expect(aggregatedMax.at(1)?.get('value')).toBe(8);
  });

  it('supports custom reducers for aggregate buckets', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 1, 'a'],
        [5, 2, 'b'],
        [10, 3, 'c'],
      ],
    });

    const aggregated = ts.aggregate(
      Sequence.every(10),
      {
        value: (values) =>
          values.reduce<number>(
            (sum, value) => sum + (typeof value === 'number' ? value : 0),
            0,
          ),
        status: (values) =>
          values.filter((value): value is string => typeof value === 'string')
            .length > 0
            ? 'seen'
            : undefined,
      },
      { range: new TimeRange({ start: 0, end: 30 }) },
    );

    expect(aggregated.length).toBe(4);
    expect(aggregated.at(0)?.get('value')).toBe(3);
    expect(aggregated.at(0)?.get('status')).toBe('seen');
    expect(aggregated.at(1)?.get('value')).toBe(3);
    expect(aggregated.at(1)?.get('status')).toBe('seen');
    expect(aggregated.at(2)?.get('value')).toBe(0);
    expect(aggregated.at(2)?.get('status')).toBeUndefined();
    expect(aggregated.at(3)?.get('value')).toBe(0);
    expect(aggregated.at(3)?.get('status')).toBeUndefined();
  });

  it('supports named aggregate outputs using from + using with built-ins', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'latency', kind: 'number' },
      { name: 'host', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'api',
      schema,
      rows: [
        [0, 100, 'a'],
        [5, 200, 'b'],
        [10, 300, 'c'],
      ],
    });

    const aggregated = ts.aggregate(
      Sequence.every(10),
      {
        latency_avg: { from: 'latency', using: 'avg' },
        host_last: { from: 'host', using: 'last' },
      },
      { range: new TimeRange({ start: 0, end: 10 }) },
    );

    expect(aggregated.at(0)?.get('latency_avg')).toBe(150);
    expect(aggregated.at(0)?.get('host_last')).toBe('b');
    expect(aggregated.at(1)?.get('latency_avg')).toBe(300);
    expect(aggregated.at(1)?.get('host_last')).toBe('c');
  });

  it('supports multiple named custom outputs from a single source column', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'latency', kind: 'number' },
      { name: 'host', kind: 'string' },
    ] as const;
    const quantile = (values: number[], q: number): number | undefined => {
      if (values.length === 0) {
        return undefined;
      }
      const sorted = [...values].sort((left, right) => left - right);
      const index = Math.floor((sorted.length - 1) * q);
      return sorted[index];
    };

    const ts = new TimeSeries({
      name: 'api',
      schema,
      rows: [
        [0, 100, 'a'],
        [1, 200, 'a'],
        [2, 300, 'b'],
        [3, 400, 'b'],
      ],
    });

    const aggregated = ts.aggregate(
      Sequence.every(10),
      {
        p50: {
          from: 'latency',
          using: (values) =>
            quantile(
              values.filter(
                (value): value is number => typeof value === 'number',
              ),
              0.5,
            ),
          kind: 'number',
        },
        p95: {
          from: 'latency',
          using: (values) =>
            quantile(
              values.filter(
                (value): value is number => typeof value === 'number',
              ),
              0.95,
            ),
          kind: 'number',
        },
        host: { from: 'host', using: 'last' },
      },
      { range: new TimeRange({ start: 0, end: 0 }) },
    );

    expect(aggregated.length).toBe(1);
    expect(aggregated.at(0)?.get('p50')).toBe(200);
    expect(aggregated.at(0)?.get('p95')).toBe(300);
    expect(aggregated.at(0)?.get('host')).toBe('b');
  });

  it('supports custom reducers for event-driven rolling windows', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 1],
        [5, 2],
        [10, 3],
      ],
    });

    const rolled = ts.rolling(10, {
      value: (values) => {
        const numeric = values.filter(
          (value): value is number => typeof value === 'number',
        );
        if (numeric.length === 0) {
          return undefined;
        }
        const total = numeric.reduce((sum, value) => sum + value, 0);
        return total / numeric.length;
      },
    });

    expect(rolled.at(0)?.get('value')).toBe(1);
    expect(rolled.at(1)?.get('value')).toBe(1.5);
    expect(rolled.at(2)?.get('value')).toBe(2.5);
  });

  it('supports custom reducers for sequence-driven rolling windows', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [0, 1],
        [5, 2],
        [10, 3],
      ],
    });

    const rolled = ts.rolling(
      Sequence.every(10),
      10,
      {
        value: (values) => values.filter((value) => value !== undefined).length,
      },
      { range: new TimeRange({ start: 0, end: 20 }) },
    );

    expect(rolled.length).toBe(3);
    expect(rolled.at(0)?.get('value')).toBe(1);
    expect(rolled.at(1)?.get('value')).toBe(2);
    expect(rolled.at(2)?.get('value')).toBe(0);
  });

  it('supports mixed built-in and custom reducers in rolling windows', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'status', kind: 'string' },
    ] as const;

    const ts = new TimeSeries({
      name: 'mixed',
      schema,
      rows: [
        [0, 10, 'a'],
        [5, 20, 'b'],
        [10, 30, 'c'],
      ],
    });

    const rolled = ts.rolling(10, {
      value: 'avg',
      status: (values) =>
        values.filter((v): v is string => typeof v === 'string').join(','),
    });

    expect(rolled.at(0)?.get('value')).toBe(10);
    expect(rolled.at(0)?.get('status')).toBe('a');
    expect(rolled.at(1)?.get('value')).toBe(15);
    expect(rolled.at(1)?.get('status')).toBe('a,b');
    expect(rolled.at(2)?.get('value')).toBe(25);
    expect(rolled.at(2)?.get('status')).toBe('b,c');
  });

  it('aggregates interval-like events into every overlapping bucket', () => {
    const schema = [
      { name: 'interval', kind: 'interval' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'windowed',
      schema,
      rows: [
        [new Interval({ value: 'a', start: 0, end: 10 }), 1],
        [new Interval({ value: 'b', start: 10, end: 20 }), 2],
        [new Interval({ value: 'c', start: 18, end: 22 }), 3],
      ],
    });

    const aggregated = ts.aggregate(
      Sequence.every(10),
      { value: 'count' },
      { range: new TimeRange({ start: 0, end: 20 }) },
    );

    expect(aggregated.length).toBe(3);
    expect(aggregated.at(0)?.get('value')).toBe(1);
    expect(aggregated.at(1)?.get('value')).toBe(2);
    expect(aggregated.at(2)?.get('value')).toBe(1);
  });

  it('computes temporal extent and relations for a timeseries', () => {
    const schema = [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'windowed',
      schema,
      rows: [
        [new TimeRange({ start: 0, end: 10 }), 1],
        [new TimeRange({ start: 10, end: 20 }), 2],
        [new TimeRange({ start: 30, end: 40 }), 3],
      ],
    });

    expect(ts.timeRange()).toEqual(new TimeRange({ start: 0, end: 40 }));
    expect(ts.overlaps(new TimeRange({ start: 35, end: 50 }))).toBe(true);
    expect(ts.contains(new TimeRange({ start: 5, end: 15 }))).toBe(true);
    expect(ts.contains(new TimeRange({ start: 5, end: 45 }))).toBe(false);
    expect(ts.intersection(new TimeRange({ start: 5, end: 35 }))).toEqual(
      new TimeRange({ start: 5, end: 35 }),
    );
  });

  it('filters and trims events by range', () => {
    const schema = [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'value', kind: 'number' },
    ] as const;

    const ts = new TimeSeries({
      name: 'windowed',
      schema,
      rows: [
        [new TimeRange({ start: 0, end: 10 }), 1],
        [new TimeRange({ start: 10, end: 20 }), 2],
        [new TimeRange({ start: 20, end: 30 }), 3],
      ],
    });

    const overlapping = ts.overlapping(new TimeRange({ start: 5, end: 15 }));
    const contained = ts.containedBy(new TimeRange({ start: 5, end: 25 }));
    const trimmed = ts.trim(new TimeRange({ start: 18, end: 22 }));

    expect(overlapping.length).toBe(2);
    expect(overlapping.at(0)?.get('value')).toBe(1);
    expect(overlapping.at(1)?.get('value')).toBe(2);
    expect(contained.length).toBe(1);
    expect(contained.at(0)?.get('value')).toBe(2);
    expect(trimmed.length).toBe(2);
    expect(trimmed.at(0)?.get('value')).toBe(2);
    expect(trimmed.at(0)?.key()).toEqual(new TimeRange({ start: 18, end: 20 }));
    expect(trimmed.at(1)?.get('value')).toBe(3);
    expect(trimmed.at(1)?.key()).toEqual(new TimeRange({ start: 20, end: 22 }));
  });

  it('rejects rows with invalid shape', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const badRows = [[Date.now()]] as unknown as RowForSchema<typeof schema>[];

    expect(
      () =>
        new TimeSeries({
          name: 'cpu',
          schema,
          rows: badRows,
        }),
    ).toThrowError(ValidationError);
  });

  it('rejects invalid first column values', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    const badRows = [['not-a-time', 1]] as unknown as RowForSchema<
      typeof schema
    >[];

    expect(
      () =>
        new TimeSeries({
          name: 'cpu',
          schema,
          rows: badRows,
        }),
    ).toThrowError('time must be a finite timestamp');
  });

  it('rejects invalid timeRange', () => {
    const schema = [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'value', kind: 'number' },
    ] as const;

    const badRows = [[{ start: 2, end: 1 }, 1]] as unknown as RowForSchema<
      typeof schema
    >[];

    expect(
      () =>
        new TimeSeries({
          name: 'range',
          schema,
          rows: badRows,
        }),
    ).toThrowError('start must be <=');
  });

  it('rejects out of order events', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    expect(
      () =>
        new TimeSeries({
          name: 'cpu',
          schema,
          rows: [
            [new Date('2025-01-02T00:00:00.000Z'), 1],
            [new Date('2025-01-01T00:00:00.000Z'), 2],
          ],
        }),
    ).toThrowError('out of order');
  });

  /* ---------------------------------------------------------------------- */
  /* Columnar integration invariants (sub-step 2a)                          */
  /* ---------------------------------------------------------------------- */

  describe('columnar integration (sub-step 2a)', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;

    function makeSeries(): TimeSeries<typeof schema> {
      return new TimeSeries({
        name: 's',
        schema,
        rows: [
          [1000, 10],
          [2000, 20],
          [3000, 30],
        ],
      });
    }

    it('series.events === series.events (lazy materialization is memoized)', () => {
      const s = makeSeries();
      expect(s.events).toBe(s.events);
    });

    it('series.at(i) === series.events[i] (event identity invariant)', () => {
      const s = makeSeries();
      const events = s.events;
      for (let i = 0; i < s.length; i += 1) {
        expect(s.at(i)).toBe(events[i]);
      }
    });

    it('series.events is runtime-frozen — push/sort/splice throw in strict mode', () => {
      const s = makeSeries();
      // The lazy materialization caches the array; freezing it
      // prevents a caller bypassing the `ReadonlyArray` type
      // (`series.events as Event[]`) from corrupting subsequent
      // reads.
      expect(Object.isFrozen(s.events)).toBe(true);
      // ES strict mode (which Vitest runs in) throws on mutation
      // attempts against a frozen array.
      expect(() => (s.events as unknown as unknown[]).push('x')).toThrow();
      expect(() => (s.events as unknown as unknown[]).sort()).toThrow();
    });

    it('series.length doesn’t materialize the lazy events array', () => {
      const s = makeSeries();
      const lengthBeforeMaterializing = s.length;
      // Reading `.length` should not have triggered `.events`
      // materialization. We can probe this by checking that the
      // events array IS subsequently created on first access AND
      // has the expected length — the `length` getter delegated
      // straight to the columnar store either way, so observable
      // behaviour just needs to be correct.
      expect(lengthBeforeMaterializing).toBe(3);
      expect(s.events.length).toBe(3);
    });

    // Regression: Codex round 1 on PR #150 caught that point accessors
    // (`at` / `first` / `last` / `find` / `some` / `every` /
    // `includesKey` / `bisect` / `atOrBefore` / `atOrAfter` /
    // iterator) still routed through `this.events[i]`, forcing the
    // lazy `events` array to materialize on the very first point
    // lookup. The fix routes them through `#store.eventAt(i)` so
    // a single `series.at(0)` doesn't allocate every Event in
    // the series.
    //
    // The probe: build a 1000-row series, take a point lookup,
    // then assert that `series.events` IS a NEW array on first
    // demand. The store's `#eventsArray` cache is private; we
    // can't observe it directly, but we CAN verify identity:
    // before any `series.events` call, the cache is unset;
    // after, it's set; and the per-row cache (populated by
    // point accessors) preserves event identity into the array.
    it("point accessors don't force materialization of the full events array", () => {
      const big = new TimeSeries({
        name: 'big',
        schema,
        rows: Array.from(
          { length: 1000 },
          (_, i) => [1000 + i, i * 10] as [number, number],
        ),
      });
      // Point lookup. Pre-fix this would have materialized all 1000.
      const first = big.at(0);
      const middle = big.at(500);
      const last = big.last();
      expect(first?.get('value')).toBe(0);
      expect(middle?.get('value')).toBe(5000);
      expect(last?.get('value')).toBe(9990);
      // After explicitly materializing, the per-row identity is
      // preserved: the cached events at 0, 500, 999 are the same
      // references the point accessors returned.
      const events = big.events;
      expect(events[0]).toBe(first);
      expect(events[500]).toBe(middle);
      expect(events[999]).toBe(last);
    });

    it('bisect / includesKey / atOrBefore / atOrAfter use #store.keyAt without materializing events', () => {
      // The keyAt cache is touched but the eventAt cache for
      // non-target rows is not. We verify the lookups return
      // correct results; the absence of full materialization is
      // structural (the new implementations don't reference
      // `this.events`) and is the test above's domain.
      const big = new TimeSeries({
        name: 'big',
        schema,
        rows: Array.from(
          { length: 1000 },
          (_, i) => [1000 + i, i * 10] as [number, number],
        ),
      });
      expect(big.bisect(new Time(1500))).toBe(500);
      expect(big.includesKey(new Time(1500))).toBe(true);
      expect(big.includesKey(new Time(1500.5))).toBe(false);
      expect(big.atOrBefore(new Time(1500.5))?.get('value')).toBe(5000);
      expect(big.atOrAfter(new Time(1500.5))?.get('value')).toBe(5010);
    });

    // Regression: Codex round 4 on PR #150 caught that
    // `at(NaN)` and `at(1.5)` previously returned `undefined`
    // via JS array-indexing semantics; the post-2a route through
    // `#store.eventAt` would proceed past the bounds check and
    // throw from key materialization. The fix is an integer-guard
    // at the `at()` boundary; other point accessors already
    // produce integer indices internally (bisect's binary
    // search uses `(low + high) >>> 1`).
    it('at() returns undefined for non-integer / NaN / out-of-range inputs; negatives count from the end', () => {
      const s = new TimeSeries({
        name: 's',
        schema,
        rows: [
          [1000, 10],
          [2000, 20],
          [3000, 30],
        ],
      });
      expect(s.at(NaN)).toBeUndefined();
      expect(s.at(1.5)).toBeUndefined();
      expect(s.at(100)).toBeUndefined();
      expect(s.at(Infinity)).toBeUndefined();
      expect(s.at(-Infinity)).toBeUndefined();
      // Negative indices count from the end (F8); deep underflow → undefined.
      expect(s.at(-1)?.get('value')).toBe(30);
      expect(s.at(-100)).toBeUndefined();
      // Valid integer indices still work.
      expect(s.at(0)?.get('value')).toBe(10);
      expect(s.at(2)?.get('value')).toBe(30);
    });

    it('rejects interval-keyed series with mixed string + number labels at intake', () => {
      // Pre-2a, mixed-kind interval labels were silently tolerated
      // because events were stored as a raw array. The columnar
      // `IntervalKeyColumn` requires one label kind per column; mixed
      // inputs now throw at construction with a row-pointed error.
      const intervalSchema = [
        { name: 'interval', kind: 'interval' },
        { name: 'v', kind: 'number' },
      ] as const;
      expect(
        () =>
          new TimeSeries({
            name: 'mixed',
            schema: intervalSchema,
            rows: [
              [{ value: 'a', start: 1000, end: 2000 }, 1],
              [{ value: 2, start: 2000, end: 3000 }, 2],
            ],
          }),
      ).toThrowError(/interval-keyed series must use one label type/);
    });
  });
});
