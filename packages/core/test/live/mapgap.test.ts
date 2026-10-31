import { describe, expect, it } from 'vitest';

import { LiveSeries } from '../../src/live/live-series.js';

/* [PND-MAPGAP] — Codex review of pond-rs (2026-10-29) R04, shared with     */
/* pond-ts: a live `map` kept `required: true` on its value columns, but a  */
/* non-finite number becomes a gap (and the mapping may return undefined),  */
/* so the push succeeded and every snapshot threw.                          */

describe('[PND-MAPGAP] live map output columns are optional', () => {
  it('snapshots a gap the mapping made in a required column', () => {
    const live = new LiveSeries({
      name: 'x',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number', required: true },
      ] as const,
    });
    const m = live.map((e) => e.set('v', Infinity));
    expect(m.schema[1]).toMatchObject({ name: 'v', required: false });
    live.push([0, 1]);
    const ts = m.toTimeSeries();
    expect(ts.length).toBe(1);
    expect(ts.at(0)!.get('v')).toBeUndefined();
    expect(live.schema[1]).toMatchObject({ required: true });
  });
});
