import { describe, expect, it } from 'vitest';

import { TimeSeries } from '../src/index.js';

/* [PND-ROLLEMPTY] — Codex review of pond-rs (2026-10-29) R07, shared with  */
/* pond-ts: a leading or centred time window that is empty let earlier rows */
/* in, because the sweep only removed rows it had added before adding new   */
/* ones. A 0 ms window counted 0, 1, 1 on three rows.                       */

const series = (times: number[]) =>
  new TimeSeries({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: times.map((t, i) => [t, i + 1] as [number, number]),
  });

const column = (ts: TimeSeries<any>, name: string) =>
  ts
    .toJSON()
    .rows.map((r: any[]) => r[ts.schema.findIndex((c) => c.name === name)]);

describe('[PND-ROLLEMPTY] empty leading / centred windows', () => {
  for (const alignment of ['leading', 'centered'] as const) {
    it(`a 0 ms ${alignment} window holds nothing`, () => {
      const out = series([0, 1000, 2000]).rolling(
        '0ms',
        { n: { from: 'v', using: 'count' } },
        { alignment },
      );
      expect(column(out, 'n')).toEqual([0, 0, 0]);
      const smooth = series([0, 1000, 2000]).smooth('v', 'movingAverage', {
        window: '0ms',
        alignment,
      });
      expect(column(smooth, 'v')).toEqual([null, null, null]);
    });
  }

  it('a 1 ms centred window whose edges round shut past 2^52 ms', () => {
    const b = 2 ** 52;
    const out = series([b + 100, b + 104, b + 108]).rolling(
      '1ms',
      { n: { from: 'v', using: 'count' } },
      { alignment: 'centered' },
    );
    expect(column(out, 'n')).toEqual([0, 0, 0]);
  });

  it('non-empty windows are unchanged', () => {
    const out = series([0, 1000, 2000, 2500]).rolling(
      '1s',
      { n: { from: 'v', using: 'count' } },
      { alignment: 'leading' },
    );
    expect(column(out, 'n')).toEqual([1, 1, 2, 1]);
  });
});
