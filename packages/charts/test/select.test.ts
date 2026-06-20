import { describe, expect, it } from 'vitest';
import { resolveSelection } from '../src/select.js';
import type { LayerEntry, SelectInfo } from '../src/context.js';

const noop = () => {};
const yScaleFor = () => (v: number) => v;

const HIT_A: SelectInfo = { key: 1, value: 10, color: '#a', label: 'a' };
const HIT_B: SelectInfo = { key: 2, value: 20, color: '#b', label: 'b' };

/** A layer entry whose hitTest returns `hit` (omit hitTest entirely when
 *  `selectable` is false, like a line/band/area layer). */
function layer(
  index: number,
  hit: SelectInfo | null,
  selectable = true,
): LayerEntry {
  return {
    layer: {
      yExtent: () => null,
      sampleAt: () => [],
      draw: noop,
      ...(selectable ? { hitTest: () => hit } : {}),
    },
    axisId: undefined,
    index,
  };
}

describe('resolveSelection', () => {
  it('returns the topmost layer hit (reverse z-order)', () => {
    const entries = [layer(0, HIT_A), layer(1, HIT_B)]; // B on top
    expect(resolveSelection(entries, 5, 5, (v) => v, yScaleFor)).toBe(HIT_B);
  });

  it('falls through to a lower layer when the top misses', () => {
    const entries = [layer(0, HIT_A), layer(1, null)];
    expect(resolveSelection(entries, 5, 5, (v) => v, yScaleFor)).toBe(HIT_A);
  });

  it('skips layers without hitTest (line / band / area)', () => {
    const entries = [layer(0, HIT_A), layer(1, null, false)];
    expect(resolveSelection(entries, 5, 5, (v) => v, yScaleFor)).toBe(HIT_A);
  });

  it('skips layers with no resolvable y-scale', () => {
    const entries = [layer(0, HIT_A)];
    expect(
      resolveSelection(
        entries,
        5,
        5,
        (v) => v,
        () => undefined,
      ),
    ).toBeNull();
  });

  it('returns null when nothing is hit', () => {
    const entries = [layer(0, null), layer(1, null)];
    expect(resolveSelection(entries, 5, 5, (v) => v, yScaleFor)).toBeNull();
  });
});
