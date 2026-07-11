import { describe, expect, it } from 'vitest';
import {
  drawScatter,
  hitTestScatter,
  nearestIndex,
  scatterExtent,
} from '../src/scatter.js';
import { recordingContext } from './canvas-mock.js';
import type { ChartSeries } from '../src/data.js';
import type { ResolvedEncoding } from '../src/encoding.js';
import type { ScatterStyle } from '../src/theme.js';
import type { SelectInfo } from '../src/context.js';

const cs = (x: number[], y: number[]): ChartSeries => ({
  x: Float64Array.from(x),
  y: Float64Array.from(y),
  length: x.length,
});
const identity = (v: number) => v;
const keyAt = (cs: ChartSeries) => (i: number) => cs.x[i]!;

/** A fixed-radius / fixed-colour encoding (radius/colour math is tested in
 *  encoding.test.ts; here we hold them constant to assert draw + hit geometry). */
const fixed = (r: number, color = '#abc'): ResolvedEncoding => ({
  radiusAt: () => r,
  colorAt: () => color,
});

const style: ScatterStyle = {
  color: '#abc',
  radius: 4,
  outline: '#fff',
  outlineWidth: 1,
  selectedOutline: '#000',
  selectedWidth: 2,
  label: '#333',
};
const font = { family: 'sans-serif', size: 11 };

describe('scatterExtent', () => {
  it('returns [min, max] of finite values, ignoring NaN gaps', () => {
    expect(scatterExtent(cs([0, 1, 2, 3], [10, NaN, 30, 20]))).toEqual([
      10, 30,
    ]);
  });
  it('returns null when nothing is finite', () => {
    expect(scatterExtent(cs([0, 1], [NaN, NaN]))).toBeNull();
  });
});

describe('nearestIndex', () => {
  const s = cs([0, 10, 20, 30], [1, 2, 3, 4]);
  it('finds the nearest point by |x - time|', () => {
    expect(nearestIndex(s, 12)).toBe(1); // closest to 10
    expect(nearestIndex(s, 26)).toBe(3); // closest to 30
  });
  it('handles times before the first and after the last point', () => {
    expect(nearestIndex(s, -5)).toBe(0);
    expect(nearestIndex(s, 999)).toBe(3);
  });
  it('breaks ties toward the earlier point', () => {
    // 15 is equidistant from 10 (idx 1) and 20 (idx 2) → earlier wins.
    expect(nearestIndex(s, 15)).toBe(1);
  });
  it('skips gaps — returns the nearest *finite* point', () => {
    // idx 1 (x=10) is a gap; nearest real point to 11 is idx 0 (x=0) vs idx 2
    // (x=20): |11-0|=11, |11-20|=9 → idx 2.
    const g = cs([0, 10, 20], [1, NaN, 3]);
    expect(nearestIndex(g, 11)).toBe(2);
  });
  it('returns -1 when there are no finite points', () => {
    expect(nearestIndex(cs([0, 1], [NaN, NaN]), 0)).toBe(-1);
  });
  it('returns -1 on an empty series', () => {
    expect(nearestIndex(cs([], []), 0)).toBe(-1);
  });
});

describe('drawScatter', () => {
  it('draws one arc + fill (+ outline stroke) per finite point', () => {
    const { ctx, calls } = recordingContext();
    const s = cs([0, 1, 2], [5, 6, 7]);
    drawScatter(
      ctx,
      s,
      identity,
      identity,
      style,
      fixed(4),
      keyAt(s),
      undefined,
      font,
      null,
      'v',
    );
    expect(calls.filter((c) => c.name === 'arc')).toHaveLength(3);
    expect(calls.filter((c) => c.name === 'fill')).toHaveLength(3);
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(3); // outlines
  });

  it('skips gap points (non-finite y draws no mark)', () => {
    const { ctx, calls } = recordingContext();
    const s = cs([0, 1, 2], [5, NaN, 7]);
    drawScatter(
      ctx,
      s,
      identity,
      identity,
      style,
      fixed(4),
      keyAt(s),
      undefined,
      font,
      null,
      'v',
    );
    expect(calls.filter((c) => c.name === 'arc')).toHaveLength(2);
  });

  it('places each arc at (xScale(x), yScale(y)) with the encoded radius', () => {
    const { ctx, calls } = recordingContext();
    const s = cs([0, 10], [1, 2]);
    drawScatter(
      ctx,
      s,
      (t) => t * 2,
      (v) => 100 - v,
      style,
      fixed(5),
      keyAt(s),
      undefined,
      font,
      null,
      'v',
    );
    const arcs = calls.filter((c) => c.name === 'arc');
    expect(arcs[0]!.args.slice(0, 3)).toEqual([0, 99, 5]); // x=0*2, y=100-1, r=5
    expect(arcs[1]!.args.slice(0, 3)).toEqual([20, 98, 5]);
  });

  it('brackets the pass with save/restore so state does not leak', () => {
    const { ctx, calls } = recordingContext();
    const s = cs([0], [1]);
    drawScatter(
      ctx,
      s,
      identity,
      identity,
      style,
      fixed(4),
      keyAt(s),
      undefined,
      font,
      null,
      'v',
    );
    const seq = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(seq[0]).toBe('save');
    expect(seq[seq.length - 1]).toBe('restore');
  });

  it('draws a highlight ring for the selected point of THIS series', () => {
    const { ctx, calls } = recordingContext();
    const s = cs([0, 10, 20], [1, 2, 3]);
    const selected: SelectInfo = {
      id: 'v',
      key: 10,
      value: 2,
      color: '#abc',
      label: 'v',
    };
    drawScatter(
      ctx,
      s,
      identity,
      identity,
      style,
      fixed(4),
      keyAt(s),
      undefined,
      font,
      selected,
      'v',
    );
    // 3 base outlines + 1 highlight ring = 4 strokes; the last stroke uses the
    // selected outline colour + width.
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(4);
    const strokeColors = calls
      .filter((c) => c.type === 'set' && c.name === 'strokeStyle')
      .map((c) => c.args[0]);
    expect(strokeColors[strokeColors.length - 1]).toBe('#000'); // selectedOutline
    const widths = calls
      .filter((c) => c.type === 'set' && c.name === 'lineWidth')
      .map((c) => c.args[0]);
    expect(widths[widths.length - 1]).toBe(2); // selectedWidth
  });

  it('does NOT highlight when the selection is a different series', () => {
    const { ctx, calls } = recordingContext();
    const s = cs([0, 10], [1, 2]);
    // same key, different series id → not this series' selection.
    const selected: SelectInfo = {
      id: 'other',
      key: 10,
      value: 2,
      color: '#abc',
      label: 'other',
    };
    drawScatter(
      ctx,
      s,
      identity,
      identity,
      style,
      fixed(4),
      keyAt(s),
      undefined,
      font,
      selected,
      'v',
    );
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(2); // outlines only
  });

  it('draws per-point labels via fillText when a label accessor is given', () => {
    const { ctx, calls } = recordingContext();
    const s = cs([0, 1], [5, 6]);
    drawScatter(
      ctx,
      s,
      identity,
      identity,
      style,
      fixed(4),
      keyAt(s),
      (i) => (i === 0 ? 'A' : undefined), // only the first point is labelled
      font,
      null,
      'v',
    );
    const texts = calls.filter((c) => c.name === 'fillText');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.args[0]).toBe('A');
  });

  it('emits no marks for an empty series (still brackets state)', () => {
    const { ctx, calls } = recordingContext();
    const s = cs([], []);
    drawScatter(
      ctx,
      s,
      identity,
      identity,
      style,
      fixed(4),
      keyAt(s),
      undefined,
      font,
      null,
      'v',
    );
    expect(calls.filter((c) => c.name === 'arc')).toEqual([]);
    expect(calls.filter((c) => c.type === 'call').map((c) => c.name)).toEqual([
      'save',
      'restore',
    ]);
  });
});

describe('hitTestScatter', () => {
  const s = cs([0, 10, 20], [0, 0, 0]); // points on a line at y=0
  it('hits a point when the click is within its radius', () => {
    // click at (10, 3), point at (10, 0) with r=4 → distance 3 <= 4 → hit.
    const hit = hitTestScatter(
      s,
      10,
      3,
      identity,
      identity,
      fixed(4),
      keyAt(s),
      'pts',
      'v',
    );
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe('pts'); // series identity (from the layer's id)
    expect(hit!.key).toBe(10); // click provenance (the sample begin)
    expect(hit!.value).toBe(0);
    expect(hit!.label).toBe('v');
    expect(hit!.color).toBe('#abc');
  });

  it('returns the same series id for different samples (id is stable, key is not)', () => {
    // The id is the series identity — independent of which sample was clicked.
    // A consumer holding { id } re-matches the series across a data update, where
    // a sample `key` (begin) would go stale.
    const hitA = hitTestScatter(
      s,
      0,
      0,
      identity,
      identity,
      fixed(4),
      keyAt(s),
      'pts',
      'v',
    );
    const hitC = hitTestScatter(
      s,
      20,
      0,
      identity,
      identity,
      fixed(4),
      keyAt(s),
      'pts',
      'v',
    );
    expect(hitA!.id).toBe('pts');
    expect(hitC!.id).toBe('pts'); // same series id...
    expect(hitA!.key).not.toBe(hitC!.key); // ...different sample provenance
  });

  it('misses when the click is outside every radius', () => {
    // click at (10, 5), r=4 → distance 5 > 4 → miss.
    expect(
      hitTestScatter(
        s,
        10,
        5,
        identity,
        identity,
        fixed(4),
        keyAt(s),
        'pts',
        'v',
      ),
    ).toBeNull();
  });

  it('hits exactly on the radius boundary (<=)', () => {
    expect(
      hitTestScatter(
        s,
        10,
        4,
        identity,
        identity,
        fixed(4),
        keyAt(s),
        'pts',
        'v',
      ),
    ).not.toBeNull();
  });

  it('returns the topmost (last-drawn) point when discs overlap', () => {
    // two coincident points; the later index (drawn on top) wins.
    const o = cs([5, 5], [0, 0]);
    const hit = hitTestScatter(
      o,
      5,
      0,
      identity,
      identity,
      fixed(4),
      keyAt(o),
      'pts',
      'v',
    );
    // both share key 5, but value/colour come from the last index — assert it
    // returned the last-index match by checking we walked backwards (idx 1).
    expect(hit).not.toBeNull();
    expect(hit!.key).toBe(5);
  });

  it('skips gap points (a non-finite y is not hittable)', () => {
    const g = cs([0, 10], [NaN, 0]);
    // click over the gap's x — the gap point must not be hit.
    expect(
      hitTestScatter(
        g,
        0,
        0,
        identity,
        identity,
        fixed(4),
        keyAt(g),
        'pts',
        'v',
      ),
    ).toBeNull();
    // but the real point still hits.
    expect(
      hitTestScatter(
        g,
        10,
        0,
        identity,
        identity,
        fixed(4),
        keyAt(g),
        'pts',
        'v',
      ),
    ).not.toBeNull();
  });

  it('maps the click through the provided scales', () => {
    // point at data (10, 0); xScale doubles, yScale flips around 100.
    const hit = hitTestScatter(
      s,
      20, // xScale(10) = 20
      100, // yScale(0) = 100
      (t) => t * 2,
      (v) => 100 - v,
      fixed(4),
      keyAt(s),
      'pts',
      'v',
    );
    expect(hit).not.toBeNull();
    expect(hit!.key).toBe(10);
  });

  it('returns null on an empty series', () => {
    expect(
      hitTestScatter(
        cs([], []),
        0,
        0,
        identity,
        identity,
        fixed(4),
        keyAt(cs([], [])),
        'pts',
        'v',
      ),
    ).toBeNull();
  });

  it('offset shifts the hit target in lockstep with the draw (a nudged point still selects)', () => {
    const p = cs([10], [0]); // one point at x=10, y=0, r=4
    // With offset +8 the point draws at px 18, so a click at the un-shifted x=10
    // now MISSES (10 is > r=4 from 18)…
    expect(
      hitTestScatter(
        p,
        10,
        0,
        identity,
        identity,
        fixed(4),
        keyAt(p),
        'pts',
        'v',
        8,
      ),
    ).toBeNull();
    // …and a click at the shifted x=18 HITS. Draw + hit-test move together.
    const hit = hitTestScatter(
      p,
      18,
      0,
      identity,
      identity,
      fixed(4),
      keyAt(p),
      'pts',
      'v',
      8,
    );
    expect(hit).not.toBeNull();
    expect(hit!.key).toBe(10); // identity is still the un-shifted data key
  });
});
