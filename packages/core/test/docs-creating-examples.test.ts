import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries, ValueSeries } from '../src/index.js';

/**
 * Executable mirror of the code examples on the ingest page,
 * `website/docs/pond-ts/creating.mdx`.
 *
 * **Why this file exists.** A Layer 2 review of PR #564 found three defects in
 * that page — one example that didn't compile, one that threw at runtime, and
 * one asserted timestamp that was an hour wrong — and found all three by
 * *running* the examples. Reading them (against a correct reading of the
 * source, no less) had missed every one. A doc example is the code a reader is
 * most likely to paste, so it is the code least affordable to leave unrun.
 *
 * **What this pins, and what it doesn't.** Each test mirrors one example and
 * names the heading it came from, so a doc edit has an obvious counterpart
 * here. It does *not* parse the MDX — most blocks on that page are fragments
 * that share a `schema` const, reference `fetch`, or throw on purpose, so
 * extracting and evaluating them would need the page annotated for a harness
 * rather than for readers. Transcription can therefore drift from the prose.
 * It degrades gracefully: a drifted test still pins a real API contract, and
 * the failure mode is a stale mirror rather than a false green.
 *
 * The compile-time half lives in `test-d/docs-creating-examples.test-d.ts` —
 * `test/` is not type-checked, so the "doesn't compile" class of defect cannot
 * be caught from here.
 */

// The shared schema the page's columnar examples reuse across several blocks.
// `venue` is load-bearing: it was added to demonstrate string columns, and the
// downstream examples that reuse this const must supply it (the exact defect
// the review caught).
const BARS = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'venue', kind: 'string' },
] as const;

const TIME = [1735689600000, 1735689660000, 1735689720000];
const OPEN = [193.1, 193.4, 193.2];
const CLOSE = [193.4, 193.2, 193.6];
const VENUE = ['XNAS', 'XNAS', 'XNAS'];

describe('Introduction', () => {
  it('the constructor example builds', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'host', kind: 'string' },
    ] as const;

    const cpu = new TimeSeries({
      name: 'cpu',
      schema,
      rows: [
        [Date.parse('2025-01-01T00:00:00Z'), 0.31, 'api-1'],
        [Date.parse('2025-01-01T00:01:00Z'), 0.44, 'api-1'],
      ],
    });

    expect(cpu.length).toBe(2);
  });

  it('sort: true accepts out-of-order rows and is stable', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
    ] as const;

    const rows = [
      [2000, 0.2],
      [1000, 0.1],
      [2000, 0.9], // equal key: must keep input order relative to [2000, 0.2]
    ] as const;

    const cpu = new TimeSeries({
      name: 'cpu',
      schema,
      rows: rows as unknown as ConstructorParameters<
        typeof TimeSeries<typeof schema>
      >[0]['rows'],
      sort: true,
    });

    expect(cpu.toRows().map((r) => r[1])).toEqual([0.1, 0.2, 0.9]);
  });
});

describe('JSON', () => {
  // "### fromJSON" — the page states the resulting epoch value outright, and
  // that literal is what was wrong before the review.
  it('parse.timeZone resolves a wall-clock string in the named zone', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'host', kind: 'string' },
    ] as const;

    const ts = TimeSeries.fromJSON({
      name: 'cpu',
      schema,
      rows: [
        ['2025-01-01T09:00', 0.42, 'api-1'],
        ['2025-01-01T10:00', 0.51, 'api-1'],
      ],
      parse: { timeZone: 'Europe/Madrid' },
    });

    // 09:00 Madrid in January (UTC+1) is 08:00Z.
    expect(ts.at(0)!.begin()).toBe(1735718400000);
    expect(new Date(1735718400000).toISOString()).toBe(
      '2025-01-01T08:00:00.000Z',
    );
  });

  // The page's sharpest edge, and the one this harness caught the page getting
  // backwards: an ambiguous local string does NOT throw. `parse.timeZone`
  // defaults to 'UTC' (`core/calendar.ts`), so it resolves silently.
  it('a wall-clock string without parse.timeZone is read as UTC, not rejected', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
    ] as const;

    const ts = TimeSeries.fromJSON({
      name: 'cpu',
      schema,
      rows: [['2025-01-01T09:00', 0.42]],
    });

    expect(ts.at(0)!.begin()).toBe(Date.parse('2025-01-01T09:00:00Z'));
  });

  it('null in an optional column reads back as undefined', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'status', kind: 'string', required: false },
    ] as const;

    const ts = TimeSeries.fromJSON({
      name: 'cpu',
      schema,
      rows: [
        ['2025-01-01T00:00Z', 0.42, 'ok'],
        ['2025-01-01T00:01Z', 0.51, null],
      ],
    });

    expect(ts.at(1)!.get('status')).toBeUndefined();
  });

  it('object rows round-trip through toJSON({ rowFormat })', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
    ] as const;

    const ts = TimeSeries.fromJSON({
      name: 'cpu',
      schema,
      rows: [[1735689600000, 0.31]],
    });

    expect(ts.toJSON().rows).toEqual([[1735689600000, 0.31]]);
    expect(ts.toJSON({ rowFormat: 'object' }).rows).toEqual([
      { time: 1735689600000, cpu: 0.31 },
    ]);
  });
});

describe('Columnar', () => {
  it('### JSON columnar — plain arrays, including a string column', () => {
    const bars = TimeSeries.fromColumns({
      name: 'AAPL',
      schema: BARS,
      columns: { time: TIME, open: OPEN, close: CLOSE, venue: VENUE },
    });

    expect(bars.length).toBe(3);
    expect(bars.at(0)!.get('venue')).toBe('XNAS');
  });

  it('### Missing values and ordering — null and non-finite are gaps', () => {
    const bars = TimeSeries.fromColumns({
      name: 'AAPL',
      schema: BARS,
      columns: {
        time: [1735689600000, 1735689660000],
        open: [193.1, 193.4],
        close: [193.4, null],
        venue: ['XNAS', null],
      },
    });

    expect(bars.at(1)!.get('close')).toBeUndefined();
    expect(bars.at(1)!.get('venue')).toBeUndefined();
  });

  it('### Missing values and ordering — out-of-order throws, sort: true does not', () => {
    const columns = {
      time: [1735689660000, 1735689600000],
      open: [193.4, 193.1],
      close: [193.2, 193.4],
      venue: ['XNAS', 'XNAS'],
    };

    expect(() =>
      TimeSeries.fromColumns({ name: 'AAPL', schema: BARS, columns }),
    ).toThrow(/out of order/);

    expect(
      TimeSeries.fromColumns({
        name: 'AAPL',
        schema: BARS,
        columns,
        sort: true,
      }).length,
    ).toBe(2);
  });

  // "### Float64Array columnar" reuses BARS, so it must supply `venue` too —
  // and `venue` stays a string[], since strings have no typed-array form.
  it('### Float64Array columnar — typed arrays beside a string column', () => {
    const bars = TimeSeries.fromColumns({
      name: 'AAPL',
      schema: BARS,
      columns: {
        time: Float64Array.from(TIME),
        open: Float64Array.from(OPEN),
        close: Float64Array.from(CLOSE),
        venue: ['XNAS', 'XNAS', 'XNAS'],
      },
    });

    expect(bars.length).toBe(3);
  });

  it('### Float64Array columnar — a typed array for a string column throws', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 'AAPL',
        schema: BARS,
        columns: {
          time: Float64Array.from(TIME),
          open: Float64Array.from(OPEN),
          close: Float64Array.from(CLOSE),
          venue: Float64Array.from([1, 2, 3]),
        },
      }),
    ).toThrow(/string column/);
  });

  // "### Mutating a buffer you handed to fromColumns" (Common ingest issues).
  it('adopted Float64Array buffers alias the series', () => {
    const closes = Float64Array.from(CLOSE);

    const bars = TimeSeries.fromColumns({
      name: 'AAPL',
      schema: BARS,
      columns: {
        time: Float64Array.from(TIME),
        open: Float64Array.from(OPEN),
        close: closes,
        venue: VENUE,
      },
    });

    closes[0] = 0;
    expect(bars.at(0)!.get('close')).toBe(0);
  });

  it('### Columnar out: toColumns — round-trips, gaps spelled null', () => {
    const bars = TimeSeries.fromColumns({
      name: 'AAPL',
      schema: BARS,
      columns: {
        time: [1735689600000, 1735689660000],
        open: [193.1, 193.4],
        close: [193.4, null],
        venue: VENUE.slice(0, 2),
      },
    });

    const payload = bars.toColumns();
    expect(payload.columns.close).toEqual([193.4, null]);

    // The page's in-process round trip, and its across-a-wire variant.
    expect(TimeSeries.fromColumns(payload).length).toBe(2);
    const parsed = JSON.parse(JSON.stringify(payload)) as typeof payload;
    expect(TimeSeries.fromColumns(parsed).length).toBe(2);
  });
});

describe('Two-edged keys', () => {
  it('an interval key flattens into begin / End / Label and round-trips', () => {
    const trades = TimeSeries.fromJSON({
      name: 'trades',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'price', kind: 'number' },
      ] as const,
      rows: [
        [1735689600000, 10],
        [1735689600000 + 86_400_000, 20],
      ],
    });

    const daily = trades.aggregate(Sequence.every('1d'), { price: 'avg' });
    const payload = daily.toColumns();

    // The names the page states are derived from the key's kind.
    expect(Object.keys(payload.columns)).toEqual(
      expect.arrayContaining(['interval', 'intervalEnd', 'intervalLabel']),
    );

    const restored = TimeSeries.fromColumns(payload);
    expect(restored.length).toBe(daily.length);
  });

  it('a value column may not take a derived name', () => {
    const schema = [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'timeRangeEnd', kind: 'number' },
    ] as const;

    expect(() =>
      TimeSeries.fromColumns({
        name: 'clash',
        schema,
        columns: { timeRange: [1, 2], timeRangeEnd: [3, 4] },
      }),
    ).toThrow();
  });
});

describe('ValueSeries', () => {
  const CHAIN = [
    { name: 'strike', kind: 'value' },
    { name: 'iv', kind: 'number' },
    { name: 'oi', kind: 'number' },
  ] as const;

  it('all three direct doors build the same series', () => {
    const fromRows = ValueSeries.fromJSON({
      name: 'chain',
      schema: CHAIN,
      rows: [
        [90, 0.31, 1200],
        [95, 0.28, 3400],
      ],
    });

    const fromCols = ValueSeries.fromColumns({
      name: 'chain',
      schema: CHAIN,
      columns: { strike: [90, 95], iv: [0.31, 0.28], oi: [1200, 3400] },
    });

    expect(fromRows.toColumns().columns).toEqual(fromCols.toColumns().columns);
  });

  it('object rows work too, and toColumns round-trips', () => {
    const chain = ValueSeries.fromJSON({
      name: 'chain',
      schema: CHAIN,
      rows: [
        { strike: 90, iv: 0.31, oi: 1200 },
        { strike: 95, iv: 0.28, oi: 3400 },
      ],
    });

    expect(ValueSeries.fromColumns(chain.toColumns()).length).toBe(2);
  });

  it('there is no timestamp parsing — a string axis is an error', () => {
    expect(() =>
      ValueSeries.fromJSON({
        name: 'chain',
        schema: CHAIN,
        rows: [
          ['2026-01-01', 0.31, 1200] as unknown as [number, number, number],
        ],
      }),
    ).toThrow();
  });
});
