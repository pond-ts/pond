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

describe('[PND-NANREP] a rolling overflow recovers once the huge values leave', () => {
  // Before the overflow lanes (`reducers/overflow-lanes.ts`) a subtractive
  // running sum that reached ±Infinity stayed there (`Infinity − x` is
  // `Infinity`), so every later row read missing — for the rest of a batch
  // series and the rest of a live stream.
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
  ] as const;
  const SUM_CELLS = [1, 2, MAX, MAX, 3, 4, 5];
  // Width-2 windows: [1] [1,2] [2,MAX] [MAX,MAX] [MAX,3] [3,4] [4,5]
  const SUM = [1, 3, MAX, undefined, MAX, 7, 9];
  const AVG = [1, 1.5, (2 + MAX) / 2, undefined, (MAX + 3) / 2, 3.5, 4.5];
  // Large enough to overflow Welford's m2 (1e300² = Infinity).
  const SD_CELLS = [1, 2, 1e300, -1e300, 3, 4, 5];
  const SD_TAIL = [0.5, 0.5]; // rows 5, 6: [3,4] and [4,5]

  const series = (cells: number[]) =>
    new TimeSeries({
      name: 'o',
      schema,
      rows: cells.map((v, i) => [i * 1000, v] as [number, number]),
    });
  const read = (s: TimeSeries<typeof schema>) =>
    Array.from({ length: s.length }, (_, i) => s.at(i)!.get('value'));

  it('batch rolling sum / avg: count window (packed sweep) and duration window', () => {
    for (const window of [{ count: 2 }, '2s'] as const) {
      const s = series(SUM_CELLS);
      expect(read(s.rolling(window as never, { value: 'sum' }))).toEqual(SUM);
      expect(read(s.rolling(window as never, { value: 'avg' }))).toEqual(AVG);
    }
  });

  it('batch rolling stdev recovers after an m2 overflow', () => {
    for (const window of [{ count: 2 }, '2s'] as const) {
      const out = read(
        series(SD_CELLS).rolling(window as never, { value: 'stdev' }),
      );
      expect(out.slice(5)).toEqual(SD_TAIL);
      expect(out[3]).toBe(1e300); // representable, so not missing
    }
  });

  it('rolling stdev: a delta overflow never reads as a defined 0', () => {
    // −0.9·MAX → 0.9·MAX overflows Welford's delta; plain Welford then holds
    // mean = Infinity with m2 clamped to 0 and would answer 0. Count window
    // (packed sweep) and duration window (state) both answer the true stdev.
    const cells = [-0.9 * MAX, 0.9 * MAX, 1, 2];
    for (const window of [{ count: 2 }, '2s'] as const) {
      const out = read(
        series(cells).rolling(window as never, { value: 'stdev' }),
      );
      expect(out[1]! / (0.9 * MAX)).toBeCloseTo(1, 12);
      expect(out[3]).toBe(0.5);
      // …including when the series ends on that row, so no later NaN
      // exposes the bad state.
      const end = read(
        series(cells.slice(0, 2)).rolling(window as never, { value: 'stdev' }),
      );
      expect(end[1]! / (0.9 * MAX)).toBeCloseTo(1, 12);
    }
  });

  it('smooth movingAverage recovers too', () => {
    const sm = series(SUM_CELLS).smooth('value', 'movingAverage', {
      window: '2s',
    });
    expect(read(sm)).toEqual(AVG);
  });

  it('live rolling sum / avg / stdev recover in a long-running stream', () => {
    for (const [using, cells, tail] of [
      ['sum', SUM_CELLS, SUM.slice(5)],
      ['avg', SUM_CELLS, AVG.slice(5)],
      ['stdev', SD_CELLS, SD_TAIL],
    ] as const) {
      const live = new LiveSeries({ name: 'o', schema });
      const r = live.rolling('1500ms', { value: using });
      const seen: Array<number | undefined> = [];
      cells.forEach((v, i) => {
        live.push([i * 1000, v]);
        seen.push(r.value().value as number | undefined);
      });
      expect(seen.slice(5)).toEqual(tail);
      if (using === 'sum') expect(seen[3]).toBeUndefined();
    }
  });

  it('reducer states: the overflowing lane resets when the window drains', () => {
    for (const reducer of ['sum', 'avg', 'stdev'] as const) {
      const st = rollingStateFor(reducer);
      st.add(0, MAX);
      st.add(1, MAX);
      if (reducer !== 'stdev') expect(st.snapshot()).toBeUndefined();
      st.remove(0, MAX);
      st.remove(1, MAX);
      // Empty window: sum of nothing is 0, mean / stdev of nothing missing.
      expect(st.snapshot()).toBe(reducer === 'sum' ? 0 : undefined);
      st.add(2, 4);
      st.add(3, 6);
      expect(st.snapshot()).toBe(
        reducer === 'sum' ? 10 : reducer === 'avg' ? 5 : 1,
      );
    }
  });

  it('the mean still overflows with its sum: avg([MAX, MAX]) is missing', () => {
    // Documented in docs/notes/reducer-nan-policy.md — sum-then-divide, on
    // every path, so batch reduce and rolling agree.
    const s = series([MAX, MAX]);
    expect(s.reduce('value', 'avg')).toBeUndefined();
    expect(
      s
        .rolling({ count: 2 } as never, { value: 'avg' })
        .at(1)!
        .get('value'),
    ).toBeUndefined();
  });
});

describe('[PND-NANREP] computed-rows operators store a non-finite result as missing', () => {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
  ] as const;
  const swing = new TimeSeries({
    name: 's',
    schema,
    rows: [
      [0, -MAX],
      [2000, MAX],
    ],
  });

  it("smooth('ema') cannot overflow on finite input — huge values stay defined", () => {
    // alpha·v + (1 − alpha)·prev is a convex combination of finite values,
    // so it never leaves [−MAX, MAX]; the fast path's non-finite guard (and
    // the row path, reachable only for non-number sources) has nothing to
    // catch. Pin that the extremes come through defined rather than missing.
    const e = new TimeSeries({
      name: 'e',
      schema,
      rows: [
        [0, MAX],
        [1000, MAX],
        [2000, -MAX],
        [3000, MAX],
      ],
    }).smooth('value', 'ema', { alpha: 0.3 });
    expect(e.column('value').nullCount()).toBe(0);
    for (let i = 0; i < 4; i += 1) {
      expect(Number.isFinite(e.at(i)!.get('value'))).toBe(true);
    }
  });

  it('align linear: an interpolation that overflows is missing', () => {
    const a = swing.align(Sequence.every('1s'), {
      method: 'linear',
      range: swing.timeRange()!,
    });
    // t=1000 sits between −MAX and MAX: −MAX + (MAX − −MAX)·0.5 overflows.
    expect(a.at(1)!.get('value')).toBeUndefined();
    expect(a.at(0)!.get('value')).toBe(-MAX);
  });

  it('baseline: an upper/lower band that overflows is missing', () => {
    const b = new TimeSeries({
      name: 'b',
      schema,
      rows: [
        [0, -MAX / 2],
        [1000, MAX / 2],
      ],
    }).baseline('value', { window: '1h', sigma: 4 });
    const row = b.at(1)!;
    expect(row.get('avg')).toBe(0);
    expect(row.get('sd')).toBe(MAX / 2);
    expect(row.get('upper')).toBeUndefined(); // 0 + 4·(MAX/2)
    expect(row.get('lower')).toBeUndefined();
  });

  it('pivotByGroup: an aggregate that overflows is missing', () => {
    const p = new TimeSeries({
      name: 'p',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'host', kind: 'string' },
        { name: 'cpu', kind: 'number' },
      ] as const,
      rows: [
        [0, 'a', MAX],
        [0, 'a', MAX],
        [0, 'b', 1],
      ],
    }).pivotByGroup('host', 'cpu', { aggregate: 'sum' });
    expect(p.at(0)!.get('a_cpu' as never)).toBeUndefined();
    expect(p.at(0)!.get('b_cpu' as never)).toBe(1);
  });

  it('arrayAggregate: a per-row reduction that overflows is missing', () => {
    const s = new TimeSeries({
      name: 'arr',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'xs', kind: 'array' },
      ] as const,
      rows: [
        [0, [MAX, MAX]],
        [1000, [1, 2]],
      ],
    }).arrayAggregate('xs', 'sum', { as: 'total' });
    expect(s.at(0)!.get('total')).toBeUndefined();
    expect(s.at(1)!.get('total')).toBe(3);
  });

  it('live map returning ±Infinity: toTimeSeries() works on an optional column', () => {
    // The map view keeps the source schema, so the missing cell it stores
    // for a non-finite fn result is only snapshot-safe when the column is
    // optional; a required column still throws (the `required` check).
    const optional = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number', required: false },
    ] as const;
    const live = new LiveSeries({ name: 'm', schema: optional });
    live.push([1000, 1], [2000, 2]);
    const m = live.map((e) =>
      e.set('value', e.get('value') === 2 ? Infinity : 5),
    );
    const ts = m.toTimeSeries();
    expect(ts.at(0)!.get('value')).toBe(5);
    expect(ts.at(1)!.get('value')).toBeUndefined();

    const req = new LiveSeries({ name: 'r', schema });
    req.push([1000, 2]);
    const rm = req.map((e) => e.set('value', Infinity));
    expect(rm.at(0)!.get('value')).toBeUndefined();
    expect(() => rm.toTimeSeries()).toThrow(/is required/);
  });
});
