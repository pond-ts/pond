import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  // required:false so the gap tests can construct undefined source cells.
  { name: 'value', kind: 'number', required: false },
] as const;

function makeSeries(values: Array<number | undefined> = [10, 20, 30, 40]) {
  return new TimeSeries({
    name: 'test',
    schema,
    rows: values.map((v, i) => [i * 1000, v] as [number, number | undefined]),
  });
}

describe('TimeSeries.scan', () => {
  describe('replace path (no options.output) — cumulative parity', () => {
    it('computes a running sum, replacing the source column', () => {
      const s = makeSeries().scan('value', (a, v) => [a + v, a + v], 0);
      expect(s.at(0)?.get('value')).toBe(10);
      expect(s.at(1)?.get('value')).toBe(30);
      expect(s.at(2)?.get('value')).toBe(60);
      expect(s.at(3)?.get('value')).toBe(100);
      // schema is unchanged in shape — still a single 'value' column.
      expect(s.schema.map((c) => c.name)).toEqual(['time', 'value']);
    });

    it('is equivalent to cumulative for the scalar sum case', () => {
      const viaCumulative = makeSeries().cumulative({ value: 'sum' });
      const viaScan = makeSeries().scan('value', (a, v) => [a + v, a + v], 0);
      for (let i = 0; i < 4; i += 1) {
        expect(viaScan.at(i)?.get('value')).toBe(
          viaCumulative.at(i)?.get('value'),
        );
      }
    });
  });

  describe('append path (options.output) — new column, source intact', () => {
    it('appends the output column and leaves the source unchanged', () => {
      const s = makeSeries().scan('value', (a, v) => [a + v, a + v], 0, {
        output: 'running',
      });
      expect(s.schema.map((c) => c.name)).toEqual(['time', 'value', 'running']);
      // source preserved verbatim
      expect(s.at(0)?.get('value')).toBe(10);
      expect(s.at(3)?.get('value')).toBe(40);
      // new column carries the fold
      expect(s.at(0)?.get('running')).toBe(10);
      expect(s.at(3)?.get('running')).toBe(100);
    });

    it('rejects an output name that already exists, pointing at replace', () => {
      expect(() =>
        makeSeries().scan('value', (a, v) => [a + v, a + v], 0, {
          output: 'value',
        }),
      ).toThrow(/already exists; omit options\.output to replace/);
      expect(() =>
        makeSeries().scan('value', (a, v) => [a + v, a + v], 0, {
          output: 'time',
        }),
      ).toThrow(/already exists/);
    });
  });

  describe('typed accumulator decoupled from output (mapAccumL)', () => {
    it('carries a structured accumulator and emits a different number', () => {
      // hysteresis elevation gain: carry (ref, gain), emit only gain.
      type GainAcc = { ref: number | null; gain: number };
      const T = 3;
      const ele = [100, 101, 105, 104, 99, 110];
      const track = new TimeSeries({
        name: 'track',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'ele', kind: 'number' },
        ] as const,
        rows: ele.map((e, i) => [i * 1000, e] as [number, number]),
      });
      const withGain = track.scan<'cumGain', GainAcc>(
        'ele',
        (acc, e) => {
          if (acc.ref === null) return [{ ref: e, gain: 0 }, 0];
          const d = e - acc.ref;
          if (d >= T) return [{ ref: e, gain: acc.gain + d }, acc.gain + d];
          if (d <= -T) return [{ ref: e, gain: acc.gain }, acc.gain];
          return [acc, acc.gain]; // within deadband — carry
        },
        { ref: null, gain: 0 },
        { output: 'cumGain' },
      );
      // 100(ref) → 101(+1, noise) → 105(+5≥3, gain 5, ref 105) → 104(-1 noise)
      //   → 99(-6≤-3, ref 99, no gain) → 110(+11≥3, gain 16, ref 110)
      const gains = [0, 1, 2, 3, 4, 5].map((i) =>
        withGain.at(i)?.get('cumGain'),
      );
      expect(gains).toEqual([0, 0, 5, 5, 5, 16]);
      // non-decreasing — the property byColumn's last−first relies on.
      for (let i = 1; i < gains.length; i += 1) {
        expect(gains[i]!).toBeGreaterThanOrEqual(gains[i - 1]!);
      }
      // 'ele' is preserved alongside.
      expect(withGain.at(2)?.get('ele')).toBe(105);
    });

    it('seeds the accumulator from init on the first step', () => {
      // emit acc BEFORE folding in the value → first output is init.
      const s = makeSeries([10, 20, 30]).scan(
        'value',
        (a, v) => [a + v, a],
        100,
        { output: 'pre' },
      );
      expect(s.at(0)?.get('pre')).toBe(100); // init
      expect(s.at(1)?.get('pre')).toBe(110); // 100 + 10
      expect(s.at(2)?.get('pre')).toBe(130); // 110 + 20
    });

    it('passes the row index to step', () => {
      const s = makeSeries([5, 5, 5, 5]).scan(
        'value',
        (a, _v, i) => [a, i],
        0,
        {
          output: 'idx',
        },
      );
      expect([0, 1, 2, 3].map((i) => s.at(i)?.get('idx'))).toEqual([
        0, 1, 2, 3,
      ]);
    });
  });

  describe('missing cells (inherited from cumulative)', () => {
    it('carries the accumulator across a gap and holds the last output', () => {
      const s = makeSeries([10, undefined, 5, undefined, 2]).scan(
        'value',
        (a, v) => [a + v, a + v],
        0,
        { output: 'run' },
      );
      // gap cells re-emit the last output (hold flat), not undefined or reset.
      expect([0, 1, 2, 3, 4].map((i) => s.at(i)?.get('run'))).toEqual([
        10, 10, 15, 15, 17,
      ]);
    });

    it('emits undefined until the first defined value (leading gap)', () => {
      const s = makeSeries([undefined, undefined, 10, 20]).scan(
        'value',
        (a, v) => [a + v, a + v],
        0,
        { output: 'run' },
      );
      expect(s.at(0)?.get('run')).toBeUndefined();
      expect(s.at(1)?.get('run')).toBeUndefined();
      expect(s.at(2)?.get('run')).toBe(10);
      expect(s.at(3)?.get('run')).toBe(30);
      // the gap reads undefined through the column too, not just .get()
      expect(s.column('run').read(0)).toBeUndefined();
    });
  });

  describe('NaN — trusted-compute output, defined source cell', () => {
    it('lands a computed non-finite output as a defined cell', () => {
      const s = makeSeries([1, 2, 3]).scan('value', (a) => [a, NaN], 0, {
        output: 'n',
      });
      expect(s.at(0)?.get('n')).toBeNaN();
      // defined NaN, not a missing cell
      expect(s.column('n').read(0)).toBeNaN();
    });

    it('treats a stored NaN as a defined value step is called with', () => {
      // produce a column of all-NaN, then count how many cells the next scan
      // sees as defined — if NaN were skipped the count would never advance.
      const withNaN = makeSeries([1, 2, 3]).scan('value', (a) => [a, NaN], 0, {
        output: 'n',
      });
      const counted = withNaN.scan('n', (a) => [a + 1, a + 1], 0, {
        output: 'cnt',
      });
      expect([0, 1, 2].map((i) => counted.at(i)?.get('cnt'))).toEqual([
        1, 2, 3,
      ]);
    });
  });

  describe('multi-entity scoping', () => {
    const hostSchema = [
      { name: 'time', kind: 'time' },
      { name: 'host', kind: 'string' },
      { name: 'v', kind: 'number' },
    ] as const;
    const rows: Array<[number, string, number]> = [
      [0, 'A', 1],
      [1000, 'B', 10],
      [2000, 'A', 2],
      [3000, 'B', 20],
    ];

    it('interleaves the accumulator across entities without partitionBy', () => {
      const s = new TimeSeries({ name: 'h', schema: hostSchema, rows }).scan(
        'v',
        (a, v) => [a + v, a + v],
        0,
        { output: 'run' },
      );
      // running sum crosses host boundaries: 1, 11, 13, 33
      expect([0, 1, 2, 3].map((i) => s.at(i)?.get('run'))).toEqual([
        1, 11, 13, 33,
      ]);
    });

    it('scopes per entity with partitionBy(host).scan(...).collect()', () => {
      const s = new TimeSeries({ name: 'h', schema: hostSchema, rows })
        .partitionBy('host')
        .scan('v', (a, v) => [a + v, a + v], 0, { output: 'run' })
        .collect();
      // A: 1, 3 ; B: 10, 30 — in time order: 1, 10, 3, 30
      expect([0, 1, 2, 3].map((i) => s.at(i)?.get('run'))).toEqual([
        1, 10, 3, 30,
      ]);
    });
  });

  describe('errors', () => {
    it('throws on an unknown source column', () => {
      expect(() =>
        // @ts-expect-error — 'nope' is not a numeric column name
        makeSeries().scan('nope', (a, v) => [a + v, a + v], 0),
      ).toThrow(/unknown column 'nope'/);
    });
  });

  describe('integration: split = scan + byColumn', () => {
    it('materializes carried state, then segments statelessly', () => {
      // cumDist (monotonic axis) + ele; per-1000m split gain = last − first of
      // the scan-materialized cumGain in each floor bin. The scan isolates the
      // order-dependence; byColumn's reducer stays pure.
      type GainAcc = { ref: number | null; gain: number };
      const T = 3;
      const cumDist = [0, 400, 900, 1500, 2100, 2600];
      const ele = [100, 110, 108, 130, 125, 145];
      const track = new TimeSeries({
        name: 'track',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'cumDist', kind: 'number' },
          { name: 'ele', kind: 'number' },
        ] as const,
        rows: cumDist.map(
          (d, i) => [i * 1000, d, ele[i]!] as [number, number, number],
        ),
      });
      const withGain = track.scan<'cumGain', GainAcc>(
        'ele',
        (acc, e) => {
          if (acc.ref === null) return [{ ref: e, gain: 0 }, 0];
          const d = e - acc.ref;
          if (d >= T) return [{ ref: e, gain: acc.gain + d }, acc.gain + d];
          if (d <= -T) return [{ ref: e, gain: acc.gain }, acc.gain];
          return [acc, acc.gain];
        },
        { ref: null, gain: 0 },
        { output: 'cumGain' },
      );
      const splits = withGain.byColumn(
        'cumDist',
        { width: 1000 },
        {
          gain: {
            from: 'cumGain',
            using: (vs: number[]) => vs[vs.length - 1]! - vs[0]!,
          },
        },
      );
      // cumGain = [0,10,10,30,30,50]; cumDist floor-bins by /1000:
      // bin [0,1000):   rows 0,1,2 (cumGain 0,10,10) → 10 − 0  = 10
      // bin [1000,2000): row 3     (cumGain 30)       → 30 − 30 = 0
      // bin [2000,3000): rows 4,5  (cumGain 30,50)    → 50 − 30 = 20
      expect(splits.length).toBe(3);
      expect(splits[0]!.start).toBe(0);
      expect(splits[0]!.gain).toBe(10);
      expect(splits[1]!.start).toBe(1000);
      expect(splits[1]!.gain).toBe(0);
      expect(splits[2]!.start).toBe(2000);
      expect(splits[2]!.gain).toBe(20);
    });
  });
});
