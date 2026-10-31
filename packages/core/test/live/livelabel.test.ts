import { describe, expect, it } from 'vitest';

import { LiveSeries } from '../../src/live/live-series.js';

/* [PND-LIVELABEL] — Codex review of pond-rs (2026-10-29) R03, shared with   */
/* pond-ts: a live interval-keyed series never checked label types, so a     */
/* batch mixing number and text labels was stored and every later snapshot   */
/* failed.                                                                   */

const SCHEMA = [
  { name: 'interval', kind: 'interval' },
  { name: 'v', kind: 'number' },
] as const;

describe('[PND-LIVELABEL] live interval labels keep one type', () => {
  it('refuses a mixed batch whole', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    expect(() =>
      live.pushMany([
        [{ value: 1, start: 0, end: 10 }, 1],
        [{ value: 'a', start: 10, end: 20 }, 2],
      ]),
    ).toThrow(/one label type/);
    expect(live.length).toBe(0);
  });

  it('checks against the events held', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.push([{ value: 'a', start: 0, end: 10 }, 1]);
    expect(() => live.push([{ value: 2, start: 10, end: 20 }, 2])).toThrow(
      /one label type/,
    );
    live.push([{ value: 'b', start: 10, end: 20 }, 2]);
    expect(live.toTimeSeries().length).toBe(2);
  });
});
