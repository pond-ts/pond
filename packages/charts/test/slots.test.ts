import { describe, expect, it } from 'vitest';
import { maxSlotWidths, sum } from '../src/slots.js';

describe('maxSlotWidths', () => {
  it('reserves each slot to the widest row in that column', () => {
    // row A = [60] (one inner axis); row B = [30 inner, 20 outer].
    // slot 0 (inner) = max(60, 30) = 60; slot 1 (outer) = max(—, 20) = 20.
    expect(maxSlotWidths([[60], [30, 20]])).toEqual([60, 20]);
  });

  it('treats an outer slot a row lacks as no contribution', () => {
    // only row B reaches slot 1, so slot 1 is purely its width.
    expect(maxSlotWidths([[40], [10, 70]])).toEqual([40, 70]);
  });

  it('handles a single row and no rows', () => {
    expect(maxSlotWidths([[50, 30]])).toEqual([50, 30]);
    expect(maxSlotWidths([])).toEqual([]);
    expect(maxSlotWidths([[], []])).toEqual([]);
  });
});

describe('sum', () => {
  it('totals the slot widths (the side gutter)', () => {
    expect(sum([60, 20])).toBe(80);
    expect(sum([])).toBe(0);
  });
});
