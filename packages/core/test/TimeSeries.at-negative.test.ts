import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* TimeSeries.at — negative-index parity (audit v2 §5 F8).                     */
/*                                                                             */
/* `at(-1)` worked on LiveSeries but returned undefined on batch. Now batch    */
/* counts negatives from the end (Array.prototype.at / LiveSeries parity),     */
/* while keeping the #150 guard: non-integer / NaN → undefined.                */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

const make = () =>
  new TimeSeries({
    name: 's',
    schema,
    rows: [
      [0, 10],
      [1000, 20],
      [2000, 30],
    ] as any,
  });

describe('TimeSeries.at — negative index', () => {
  it('counts from the end (at(-1) is the last event)', () => {
    const s = make();
    expect(s.at(-1)!.get('v')).toBe(30);
    expect(s.at(-2)!.get('v')).toBe(20);
    expect(s.at(-3)!.get('v')).toBe(10);
  });

  it('returns undefined when a negative index underflows', () => {
    expect(make().at(-4)).toBeUndefined();
    expect(make().at(-999)).toBeUndefined();
  });

  it('preserves the #150 guard: non-integer / NaN / out-of-range → undefined', () => {
    const s = make();
    expect(s.at(NaN)).toBeUndefined();
    expect(s.at(1.5)).toBeUndefined();
    expect(s.at(-1.5)).toBeUndefined();
    expect(s.at(3)).toBeUndefined(); // == length
    expect(s.at(0)!.get('v')).toBe(10); // positive indices unaffected
  });

  it('at(-1) agrees with last()', () => {
    const s = make();
    expect(s.at(-1)!.get('v')).toBe(s.last()!.get('v'));
  });
});
