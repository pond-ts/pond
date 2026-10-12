import { describe, expect, it } from 'vitest';
import {
  Event,
  Sequence,
  Time,
  TimeSeries,
  ValidationError,
} from '../src/index.js'; // also installs the column API
import { LiveSeries } from '../src/live/live-series.js';
import { bucketStateFor, rollingStateFor } from '../src/reducers/index.js';
import {
  Float64ColumnBuilder,
  float64ColumnFromArray,
} from '../src/columnar/index.js';
import { NumericOutput } from '../src/batch/operators/numeric-io.js';

/* -------------------------------------------------------------------------- */
/* [PND-NANREP] — the public rule: a non-finite number (NaN, ±Infinity) in a */
/* number column means missing.                                               */
/*                                                                             */
/* Storage is still the validity bitmap; these tests pin the rule at each     */
/* write chokepoint so a later switch to NaN-in-buffer storage is invisible.  */
/* Doors that reject NaN (row intake, boxed withColumn) reject ±Infinity too. */
/* -------------------------------------------------------------------------- */

const MAX = Number.MAX_VALUE;

describe('[PND-NANREP] write chokepoints store non-finite as missing', () => {
  it('float64ColumnFromArray: NaN and ±Infinity are gaps', () => {
    const col = float64ColumnFromArray([
      1,
      NaN,
      Infinity,
      -Infinity,
      undefined,
    ]);
    expect([0, 1, 2, 3, 4].map((i) => col.read(i))).toEqual([
      1,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(col.validity!.definedCount).toBe(1);
    expect(col.nullCount()).toBe(4);
    expect(col.count()).toBe(1);
    expect(col.hasMissing()).toBe(true);
    expect(col.allFinite).toBe(true); // every defined cell is finite
    const seen: number[] = [];
    col.scan((v) => seen.push(v));
    expect(seen).toEqual([1]);
  });

  it('float64ColumnFromArray: a non-finite slot never clears allFinite', () => {
    const col = float64ColumnFromArray([1, NaN, 3, Infinity]);
    expect(col.allFinite).toBe(true);
    expect(col.sum()).toBe(4);
    expect(col.max()).toBe(3);
  });

  it('NumericOutput.set: NaN and ±Infinity leave the cell missing', () => {
    const out = new NumericOutput(4);
    out.set(0, 1);
    out.set(1, NaN);
    out.set(2, Infinity);
    out.set(3, -Infinity);
    const col = out.finish();
    expect([0, 1, 2, 3].map((i) => col.read(i))).toEqual([
      1,
      undefined,
      undefined,
      undefined,
    ]);
    expect(col.nullCount()).toBe(3);
    expect(col.allFinite).toBe(true);
  });

  it('NumericOutput: an all-NaN-but-one output is not mistaken for dense', () => {
    const out = new NumericOutput(2);
    out.set(0, NaN);
    out.set(1, 2);
    const col = out.finish();
    expect(col.validity).toBeDefined();
    expect(col.read(0)).toBeUndefined();
    expect(col.allFinite).toBe(true);
  });

  it('Float64ColumnBuilder: NaN appends as missing, and overwrites to missing', () => {
    const b = new Float64ColumnBuilder();
    b.append(1);
    b.append(NaN);
    b.append(3);
    b.appendAt(2, NaN); // overwrite a defined cell with NaN
    const col = b.finalize();
    expect([0, 1, 2].map((i) => col.read(i))).toEqual([
      1,
      undefined,
      undefined,
    ]);
    expect(col.validity!.definedCount).toBe(1);
  });

  it('Float64ColumnBuilder: ±Infinity appends as missing, and overwrites to missing', () => {
    const b = new Float64ColumnBuilder();
    b.append(1);
    b.append(Infinity);
    b.append(3);
    b.appendAt(2, -Infinity);
    const col = b.finalize();
    expect([0, 1, 2].map((i) => col.read(i))).toEqual([
      1,
      undefined,
      undefined,
    ]);
    expect(col.validity!.definedCount).toBe(1);
  });
});

describe('[PND-NANREP] doors: Infinity follows NaN', () => {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
  ] as const;

  it('row intake rejects ±Infinity, as it rejects NaN', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(
        () => new TimeSeries({ name: 'x', schema, rows: [[0, bad]] }),
      ).toThrow(ValidationError);
    }
  });

  it('fromColumns stores ±Infinity as a gap, as it does NaN', () => {
    const s = TimeSeries.fromColumns({
      name: 'x',
      schema,
      columns: {
        time: [0, 1000, 2000, 3000],
        value: [1, NaN, Infinity, -Infinity],
      },
    });
    expect(s.column('value').count()).toBe(1);
    expect(s.column('value').nullCount()).toBe(3);
  });

  it('fromEvents packs ±Infinity as a gap, as it does NaN', () => {
    // The column is built by `Float64ColumnBuilder`, which stores a
    // non-finite value as missing. (`fromEvents` is the documented trust
    // door: `at(i)` hands back the caller's own Event objects verbatim, so
    // the event-level read is NOT normalised — that is a known gap of the
    // trust contract, for NaN and ±Infinity alike.)
    const s = TimeSeries.fromEvents(
      [1, NaN, Infinity, -Infinity].map(
        (value, i) => new Event(new Time(i * 1000), { value }),
      ),
      { schema, name: 'x' },
    );
    const col = s.column('value');
    expect([0, 1, 2, 3].map((i) => col.at(i))).toEqual([
      1,
      undefined,
      undefined,
      undefined,
    ]);
    expect(col.nullCount()).toBe(3);
    expect(s.reduce('value', 'sum')).toBe(1);
  });
});

describe('[PND-NANREP] batch operators store a non-finite result as missing', () => {
  it('a numeric collapse reducer returning NaN yields a missing cell', () => {
    const s = new TimeSeries({
      name: 'c',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'a', kind: 'number' },
        { name: 'b', kind: 'number' },
      ] as const,
      rows: [
        [0, 0, 0],
        [1000, 6, 3],
      ],
    });
    const c = s.collapse(['a', 'b'], 'ratio', ({ a, b }) => a / b);
    expect(c.at(0)!.get('ratio')).toBeUndefined(); // 0 / 0
    expect(c.at(1)!.get('ratio')).toBe(2);
    expect(c.column('ratio').nullCount()).toBe(1);
  });

  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
  ] as const;
  const MAXES = new TimeSeries({
    name: 'm',
    schema,
    rows: [
      [0, MAX],
      [1000, MAX],
      [2000, 1],
    ],
  });

  it('collapse reducer returning ±Infinity yields a missing cell', () => {
    const c = MAXES.collapse(['value'], 'twice', ({ value }) => value * 2);
    expect(c.at(0)!.get('twice')).toBeUndefined();
    expect(c.at(2)!.get('twice')).toBe(2);
  });

  it('mapColumns: a non-finite mapper result is missing', () => {
    const m = MAXES.mapColumns({ value: (v) => v * 10 });
    expect([0, 1, 2].map((i) => m.at(i)!.get('value'))).toEqual([
      undefined,
      undefined,
      10,
    ]);
  });

  it('cumulative / diff: an overflow is missing; count + nullCount === length', () => {
    const c = MAXES.cumulative({ value: 'sum' }).column('value');
    expect([0, 1, 2].map((i) => c.at(i))).toEqual([MAX, undefined, undefined]);
    expect(c.count() + c.nullCount()).toBe(c.length);
    const d = new TimeSeries({
      name: 'd',
      schema,
      rows: [
        [0, -MAX],
        [1000, MAX],
      ],
    }).diff(['value']);
    expect(d.at(1)!.get('value')).toBeUndefined();
  });

  it('aggregate: an overflowed bucket is missing (columnar and row paths)', () => {
    const fast = MAXES.aggregate(Sequence.every('1h'), { value: 'sum' });
    expect(fast.at(0)!.get('value')).toBeUndefined();
    const custom = MAXES.aggregate(Sequence.every('1h'), {
      value: () => Infinity,
    });
    expect(custom.at(0)!.get('value')).toBeUndefined();
  });

  it('rolling: an overflowed window is missing (fast path and sweep)', () => {
    const r = MAXES.rolling('1h', { value: 'sum' });
    expect(r.at(0)!.get('value')).toBe(MAX);
    expect(r.at(1)!.get('value')).toBeUndefined();
    const custom = MAXES.rolling('1h', { value: () => -Infinity });
    expect(custom.column('value').nullCount()).toBe(3);
  });

  it('smooth: an overflowed moving average is missing', () => {
    const sm = MAXES.smooth('value', 'movingAverage', { window: '1h' });
    expect(sm.at(0)!.get('value')).toBe(MAX);
    expect(sm.at(1)!.get('value')).toBeUndefined(); // (MAX + MAX) / 2
  });

  it('reduce: an overflowed answer is missing, like the column it would fill', () => {
    expect(MAXES.reduce('value', 'sum')).toBeUndefined();
    expect(MAXES.reduce('value', 'avg')).toBeUndefined();
    expect(MAXES.reduce('value', (vs) => vs.length * Infinity)).toBeUndefined();
    expect(MAXES.reduce('value', 'max')).toBe(MAX);
  });

  it('reducer states: a non-finite result snapshots as missing', () => {
    const b = bucketStateFor('sum');
    b.add(MAX);
    b.add(MAX);
    expect(b.snapshot()).toBeUndefined();
    const r = rollingStateFor((vs) => (vs.length > 1 ? NaN : 1));
    r.add(0, 1);
    expect(r.snapshot()).toBe(1);
    r.add(1, 2);
    expect(r.snapshot()).toBeUndefined();
  });
});

describe('[PND-NANREP] live operators emit non-finite results as missing', () => {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
  ] as const;

  const overflowing = () => {
    const live = new LiveSeries({ name: 'nan', schema });
    live.push([1000, MAX], [2000, MAX], [3000, 1], [4000, 1]);
    return live;
  };

  it('a cumulative sum that overflows is missing, and toTimeSeries() works', () => {
    // cumulative: [MAX, Inf, Inf, Inf] → [MAX, -, -, -].
    const c = overflowing().cumulative({ value: 'sum' });
    expect(c.at(0)!.get('value')).toBe(MAX);
    expect(c.at(1)!.get('value')).toBeUndefined();
    // This used to throw: a live view holding Infinity failed row intake.
    const ts = c.toTimeSeries();
    expect(ts.column('value').nullCount()).toBe(3);
    // diff of the gapped view is missing where either side is.
    const d = c.diff('value');
    expect(d.at(1)!.get('value')).toBeUndefined();
  });

  it('diff / rate / pctChange whose delta overflows are missing', () => {
    const live = new LiveSeries({ name: 'o', schema });
    live.push([1000, -MAX], [2000, MAX]);
    expect(live.diff('value').at(1)!.get('value')).toBeUndefined();
    expect(live.rate('value').at(1)!.get('value')).toBeUndefined();
    expect(live.pctChange('value').at(1)!.get('value')).toBeUndefined();
  });

  it('live rolling / aggregate: an overflowed reducer result is missing', () => {
    const live = overflowing();
    const r = live.rolling('1h', { value: 'sum' });
    expect(r.value().value).toBeUndefined();
    const a = live.aggregate(Sequence.every('1h'), { value: 'sum' });
    expect(() => a.snapshot()).not.toThrow();
    expect(a.snapshot().column('value').count()).toBe(0);
  });

  it('a cumulative fold that reaches NaN emits missing', () => {
    const live = new LiveSeries({ name: 'nan', schema });
    live.push([1000, 1], [2000, 2], [3000, 3]);
    const c = live.cumulative({ value: (acc, v) => (v === 2 ? NaN : acc + v) });
    expect(c.at(0)!.get('value')).toBe(1);
    expect(c.at(1)!.get('value')).toBeUndefined();
    expect(c.at(2)!.get('value')).toBeUndefined(); // NaN + 3 is still NaN
  });

  it('a cumulative custom fold recovers after its accumulator becomes NaN (matches batch)', () => {
    // The accumulator is kept as-is (NaN), so a fold that tests for it can
    // restart — the emitted cells go [1, missing, 3, 7], as in batch.
    const fold = (acc: number, v: number) =>
      v === 2 ? NaN : Number.isNaN(acc) ? v : acc + v;
    const live = new LiveSeries({ name: 'nan', schema });
    live.push([1000, 1], [2000, 2], [3000, 3], [4000, 4]);
    const c = live.cumulative({ value: fold });
    const batch = new TimeSeries({
      name: 'nan',
      schema,
      rows: [
        [1000, 1],
        [2000, 2],
        [3000, 3],
        [4000, 4],
      ],
    }).cumulative({ value: fold });
    const expected = [1, undefined, 3, 7];
    for (let i = 0; i < 4; i += 1) {
      expect(c.at(i)!.get('value')).toBe(expected[i]);
      expect(batch.at(i)!.get('value')).toBe(expected[i]);
    }
  });

  it('a map fn that writes NaN or ±Infinity into a number field reads as missing', () => {
    const live = new LiveSeries({ name: 'nan', schema });
    live.push([1000, 1]);
    const m = live.map((e) => e.set('value', e.get('value') === 2 ? NaN : 7));
    live.push([2000, 2]);
    expect(m.at(0)!.get('value')).toBe(7);
    expect(m.at(1)!.get('value')).toBeUndefined();
    // ±Infinity is non-finite, so it reads as missing too.
    const inf = live.map((e) => e.set('value', -Infinity));
    expect(inf.at(0)!.get('value')).toBeUndefined();
  });

  it('batch and live cumulative + diff agree on the overflow case', () => {
    const liveDiff = overflowing().cumulative({ value: 'sum' }).diff('value');
    const batch = new TimeSeries({
      name: 'nan',
      schema,
      rows: [
        [1000, MAX],
        [2000, MAX],
        [3000, 1],
        [4000, 1],
      ],
    })
      .cumulative({ value: 'sum' })
      .diff(['value']);
    for (let i = 0; i < 4; i += 1) {
      expect(liveDiff.at(i)!.get('value')).toBe(batch.at(i)!.get('value'));
    }
  });
});
