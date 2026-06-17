/**
 * `RowForSchema` honors `required: false` — an optional tuple cell accepts
 * `undefined` (a missing value) WITHOUT a cast, matching the runtime's intake
 * (estela F-geo-row-optional). The **compile** of the no-cast construction in
 * the first test is the type-level assertion (if the type forbade `undefined`
 * for the optional cell, this file would not typecheck); the runtime check
 * confirms the missing cell reads back as `undefined`.
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

describe('RowForSchema honors required: false', () => {
  it('accepts undefined in an optional tuple cell with no cast', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'lat', kind: 'number' }, // required
      { name: 'ele', kind: 'number', required: false }, // optional
    ] as const;
    // No `as never` cast — the type must admit `undefined` for the `ele` cell.
    const s = new TimeSeries({
      name: 'track',
      schema,
      rows: [
        [0, 10, 100],
        [1, 20, undefined], // missing elevation
        [2, 30, 105],
      ],
    });
    expect([...s].map((e) => e.get('ele'))).toEqual([100, undefined, 105]);
  });

  it('a required column still rejects undefined at runtime', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'lat', kind: 'number' },
    ] as const;
    expect(
      () =>
        new TimeSeries({
          name: 'track',
          schema,
          // cast past the (correct) compile-time rejection to reach the runtime guard
          rows: [
            [0, 10],
            [1, undefined as never],
          ],
        }),
    ).toThrow(/required/);
  });
});
