import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js'; // also installs the column API
import { LiveSeries } from '../src/live/live-series.js';
import {
  Float64ColumnBuilder,
  float64ColumnFromArray,
} from '../src/columnar/index.js';
import { NumericOutput } from '../src/batch/operators/numeric-io.js';

/* -------------------------------------------------------------------------- */
/* [PND-NANREP] — the public rule: a NaN in a number column means missing.    */
/*                                                                             */
/* Storage is still the validity bitmap; these tests pin the rule at each     */
/* write chokepoint so a later switch to NaN-in-buffer storage is invisible.  */
/* ±Infinity is a real number and stays a defined cell.                       */
/* -------------------------------------------------------------------------- */

const MAX = Number.MAX_VALUE;

describe('[PND-NANREP] write chokepoints store NaN as missing', () => {
  it('float64ColumnFromArray: NaN is a gap, ±Infinity is defined', () => {
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
      Infinity,
      -Infinity,
      undefined,
    ]);
    expect(col.validity!.definedCount).toBe(3);
    expect(col.nullCount()).toBe(2);
    expect(col.hasMissing()).toBe(true);
    expect(col.allFinite).toBe(false); // Infinity is still defined
    const seen: number[] = [];
    col.scan((v) => seen.push(v));
    expect(seen).toEqual([1, Infinity, -Infinity]);
  });

  it('float64ColumnFromArray: NaN alone does not clear allFinite', () => {
    const col = float64ColumnFromArray([1, NaN, 3]);
    expect(col.allFinite).toBe(true);
    expect(col.sum()).toBe(4);
  });

  it('NumericOutput.set: NaN leaves the cell missing; Infinity is defined', () => {
    const out = new NumericOutput(3);
    out.set(0, 1);
    out.set(1, NaN);
    out.set(2, Infinity);
    const col = out.finish();
    expect([0, 1, 2].map((i) => col.read(i))).toEqual([1, undefined, Infinity]);
    expect(col.nullCount()).toBe(1);
    expect(col.allFinite).toBe(false);
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
});

describe('[PND-NANREP] batch user-callback operators', () => {
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
});

describe('[PND-NANREP] live operators emit NaN results as missing', () => {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
  ] as const;

  const overflowing = () => {
    const live = new LiveSeries({ name: 'nan', schema });
    live.push([1000, MAX], [2000, MAX], [3000, 1], [4000, 1]);
    return live;
  };

  it('cumulative sum to Infinity then diff: Infinity - Infinity is missing', () => {
    // cumulative: [MAX, Inf, Inf, Inf]; diff: [-, Inf, NaN, NaN].
    const d = overflowing().cumulative({ value: 'sum' }).diff('value');
    expect(d.at(1)!.get('value')).toBe(Infinity);
    expect(d.at(2)!.get('value')).toBeUndefined();
    expect(d.at(3)!.get('value')).toBeUndefined();
  });

  it('rate / pctChange of Infinity - Infinity are missing', () => {
    const c = overflowing().cumulative({ value: 'sum' });
    expect(c.rate('value').at(2)!.get('value')).toBeUndefined();
    expect(c.pctChange('value').at(2)!.get('value')).toBeUndefined();
  });

  it('a cumulative fold that reaches NaN emits missing', () => {
    const live = new LiveSeries({ name: 'nan', schema });
    live.push([1000, 1], [2000, 2], [3000, 3]);
    const c = live.cumulative({ value: (acc, v) => (v === 2 ? NaN : acc + v) });
    expect(c.at(0)!.get('value')).toBe(1);
    expect(c.at(1)!.get('value')).toBeUndefined();
    expect(c.at(2)!.get('value')).toBeUndefined(); // NaN + 3 is still NaN
  });

  it('batch and live diff agree on the overflow case', () => {
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
