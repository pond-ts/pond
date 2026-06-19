import { describe, expect, it } from 'vitest';
import {
  maxSlotWidths,
  placeAxisSlots,
  sum,
  type SlotAxis,
} from '../src/slots.js';

// A row axis with a fresh instance key (the label only aids the test's reading).
const ax = (label: string, width: number): SlotAxis => ({
  key: Symbol(label),
  width,
});

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

describe('placeAxisSlots', () => {
  it('maps the inner axis to its reserved (cross-row max) slot, not its own width', () => {
    // Bottom row of PerSlotAlignment: out (40) + in (40); the container reserved
    // [80 inner, 40 outer] because another row had an 80-wide inner axis.
    const out = ax('out', 40);
    const inn = ax('in', 40);
    const { axisSlots, leftPad } = placeAxisSlots([out, inn], [], [80, 40], []);
    expect(axisSlots.get(inn.key)).toBe(80); // slot 0 (inner) = max(80, 40)
    expect(axisSlots.get(out.key)).toBe(40); // slot 1 (outer)
    expect(leftPad).toBe(0); // has both slots
  });

  it('pads the outer slots a row lacks, keeping its plot aligned', () => {
    // Top row of PerSlotAlignment: one wide inner axis (80), missing the outer 40.
    const wide = ax('wide', 80);
    const { axisSlots, leftPad } = placeAxisSlots([wide], [], [80, 40], []);
    expect(axisSlots.get(wide.key)).toBe(80); // slot 0
    expect(leftPad).toBe(40); // the missing outer slot
  });

  it('an axis-less row pads the whole gutter each side', () => {
    const { axisSlots, leftPad, rightPad } = placeAxisSlots(
      [],
      [],
      [80, 40],
      [50],
    );
    expect(axisSlots.size).toBe(0);
    expect(leftPad).toBe(120); // 80 + 40
    expect(rightPad).toBe(50);
  });

  it('maps right axes inner→slot0 in author order (flush toward the plot)', () => {
    const inn = ax('in', 44);
    const out = ax('out', 56);
    const { axisSlots, rightPad } = placeAxisSlots(
      [],
      [inn, out],
      [],
      [44, 56],
    );
    expect(axisSlots.get(inn.key)).toBe(44); // slot 0 (inner, authored first)
    expect(axisSlots.get(out.key)).toBe(56); // slot 1 (outer)
    expect(rightPad).toBe(0);
  });

  it('falls back to own width before the container has reserved', () => {
    const a = ax('a', 50);
    const { axisSlots, leftPad } = placeAxisSlots([a], [], [], []);
    expect(axisSlots.get(a.key)).toBe(50); // no reserved slots yet
    expect(leftPad).toBe(0);
  });

  // Codex regression: layout keys off instance, not the data id.
  it('gives same-id axes on a side distinct slots (no collapse)', () => {
    // Two left axes a user gave the same id="v" — distinct instances. If layout
    // keyed by id they'd collapse to one slot and the gutter would mismatch.
    const outer = ax('v', 40);
    const inner = ax('v', 80);
    const { axisSlots } = placeAxisSlots([outer, inner], [], [80, 40], []);
    expect(axisSlots.size).toBe(2); // not collapsed
    expect(axisSlots.get(outer.key)).toBe(40); // slot 1
    expect(axisSlots.get(inner.key)).toBe(80); // slot 0
  });

  it('gives a left/right mirror of one id its own slot each side', () => {
    const left = ax('v', 50);
    const right = ax('v', 60);
    const { axisSlots } = placeAxisSlots([left], [right], [50], [60]);
    expect(axisSlots.size).toBe(2);
    expect(axisSlots.get(left.key)).toBe(50);
    expect(axisSlots.get(right.key)).toBe(60);
  });
});
