import { describe, expect, it } from 'vitest';
import { Interval } from 'pond-ts';
import {
  bandRect,
  bucketAt,
  cursorParts,
  DEFAULT_CURSOR_MODE,
  regionSpan,
  resolveCursorX,
} from '../src/tracker.js';

describe('bucketAt — the interval containing t (region cursor)', () => {
  // Three non-adjacent buckets: [0,10) [20,30) [40,50) (a gap between each).
  const buckets = [
    new Interval({ value: 0, start: 0, end: 10 }),
    new Interval({ value: 20, start: 20, end: 30 }),
    new Interval({ value: 40, start: 40, end: 50 }),
  ];

  it('finds the containing bucket (half-open [begin, end))', () => {
    expect(bucketAt(buckets, 0)?.begin()).toBe(0); // left edge inclusive
    expect(bucketAt(buckets, 5)?.begin()).toBe(0);
    expect(bucketAt(buckets, 25)?.begin()).toBe(20);
    expect(bucketAt(buckets, 49)?.begin()).toBe(40);
  });

  it('returns undefined off the ends or in a gap between buckets', () => {
    expect(bucketAt(buckets, -1)).toBeUndefined(); // before the first
    expect(bucketAt(buckets, 10)).toBeUndefined(); // exclusive end → the gap
    expect(bucketAt(buckets, 15)).toBeUndefined(); // between buckets
    expect(bucketAt(buckets, 50)).toBeUndefined(); // past the last end
    expect(bucketAt([], 5)).toBeUndefined(); // empty
  });
});

describe('bandRect — the region-cursor pixel band', () => {
  const buckets = [
    new Interval({ value: 0, start: 0, end: 10 }),
    new Interval({ value: 20, start: 20, end: 30 }),
  ];
  const identity = (v: number) => v;

  it('maps the containing bucket to its pixel span', () => {
    expect(bandRect(buckets, 5, identity, 100)).toEqual({ x0: 0, x1: 10 });
    expect(bandRect(buckets, 25, identity, 100)).toEqual({ x0: 20, x1: 30 });
  });

  it('clamps to the plot and is null in a gap', () => {
    expect(bandRect(buckets, 15, identity, 100)).toBeNull(); // between buckets
    // A bucket running past the right edge clamps to plotWidth.
    const wide = [new Interval({ value: 90, start: 90, end: 130 })];
    expect(bandRect(wide, 100, identity, 100)).toEqual({ x0: 90, x1: 100 });
  });

  it('crops through a discontinuous scale — a bucket in a collapsed gap is null', () => {
    // A scale that collapses the domain [10, 90) onto pixel 10.
    const disc = (v: number) => (v <= 10 ? v : v < 90 ? 10 : 10 + (v - 90));
    // A bucket entirely inside the collapsed gap → both edges hit pixel 10 → null.
    const inGap = [new Interval({ value: 20, start: 20, end: 80 })];
    expect(bandRect(inGap, 50, disc, 200)).toBeNull();
    // A bucket spanning into live time crops to the live pixels.
    const spanning = [new Interval({ value: 0, start: 0, end: 95 })];
    expect(bandRect(spanning, 5, disc, 200)).toEqual({ x0: 0, x1: 15 });
  });

  it('a drag anchor (t2) extends the band to the union of both buckets', () => {
    // anchor in bucket [0,10), pointer in [20,30) → span [0,30) → px [0,30].
    const buckets = [
      new Interval({ value: 0, start: 0, end: 10 }),
      new Interval({ value: 20, start: 20, end: 30 }),
    ];
    expect(bandRect(buckets, 25, identity, 100, 5)).toEqual({ x0: 0, x1: 30 });
  });
});

describe('regionSpan — the region-cursor / drag span', () => {
  const buckets = [
    new Interval({ value: 0, start: 0, end: 10 }),
    new Interval({ value: 20, start: 20, end: 30 }),
    new Interval({ value: 40, start: 40, end: 50 }),
  ];

  it('single bucket when no drag anchor', () => {
    expect(regionSpan(buckets, 25)).toEqual({ start: 20, end: 30 });
  });

  it('unions the two buckets under a drag, either direction', () => {
    // drag from bucket 0 to bucket 2 → [0, 50); same span dragging back.
    expect(regionSpan(buckets, 5, 45)).toEqual({ start: 0, end: 50 });
    expect(regionSpan(buckets, 45, 5)).toEqual({ start: 0, end: 50 });
  });

  it('a pointer in no bucket (a gap) keeps the anchor bucket', () => {
    expect(regionSpan(buckets, 25, 15)).toEqual({ start: 20, end: 30 });
  });

  it('freeform (no bucket under t1): a drag spans raw [t1, t2], a hover is null', () => {
    // No sequence → empty buckets: a drag selects the raw range, either
    // direction; a bare hover has nothing to shade (the cursor is a line).
    expect(regionSpan([], 100, 250)).toEqual({ start: 100, end: 250 });
    expect(regionSpan([], 250, 100)).toEqual({ start: 100, end: 250 });
    expect(regionSpan([], 5)).toBeNull();
    // Same freeform fallback when t1 lands in a gap between buckets.
    expect(regionSpan(buckets, 15, 45)).toEqual({ start: 15, end: 45 });
    expect(regionSpan(buckets, 15)).toBeNull();
  });
});

describe('resolveCursorX', () => {
  const xScale = (t: number) => t / 10; // simple linear time→pixel for the test

  it('uses the hover pixel when uncontrolled (trackerPosition undefined)', () => {
    expect(resolveCursorX(undefined, 42, xScale)).toBe(42);
    expect(resolveCursorX(undefined, null, xScale)).toBeNull();
  });

  it('a live local pointer wins over a controlled timestamp', () => {
    // The hovered chart shows its OWN cursor even while a trackerPosition is
    // supplied — this is what lets cross-chart sync compose (the hovered chart
    // is the source, not a follower). Both the numeric and null controlled
    // values yield to the pointer.
    expect(resolveCursorX(300, 42, xScale)).toBe(42);
    expect(resolveCursorX(null, 42, xScale)).toBe(42);
  });

  it('follows the controlled timestamp when there is no local pointer', () => {
    // A non-hovered chart maps the shared time through its OWN xScale, so it
    // lands at the right pixel even under a different zoom.
    expect(resolveCursorX(300, null, xScale)).toBe(30);
  });

  it('shows nothing with neither a pointer nor a controlled position', () => {
    // null and undefined are equivalent — both "no controlled position".
    expect(resolveCursorX(null, null, xScale)).toBeNull();
    expect(resolveCursorX(undefined, null, xScale)).toBeNull();
  });
});

describe('cursorParts', () => {
  it('line — the synced line only, no dots or chip', () => {
    expect(cursorParts('line')).toEqual({
      line: true,
      dots: false,
      chip: 'none',
      band: false,
    });
  });
  it('point — dots only, no line or chip', () => {
    expect(cursorParts('point')).toEqual({
      line: false,
      dots: true,
      chip: 'none',
      band: false,
    });
  });
  it('inline — dots + an inline chip, no line', () => {
    expect(cursorParts('inline')).toEqual({
      line: false,
      dots: true,
      chip: 'inline',
      band: false,
    });
  });
  it('flag — dots + a flag chip, no line', () => {
    expect(cursorParts('flag')).toEqual({
      line: false,
      dots: true,
      chip: 'flag',
      band: false,
    });
  });
  it('crosshair — a single reticle drawn by Layers (no generic line/dots)', () => {
    // Layers draws the dashed vertical + full-width horizontal + centre dot + one
    // value pill itself, so cursorParts asks for no generic line/dots here.
    expect(cursorParts('crosshair')).toEqual({
      line: false,
      dots: false,
      chip: 'axis',
      band: false,
    });
  });
  it('region — a band only (Layers shades the bucket under the pointer)', () => {
    expect(cursorParts('region')).toEqual({
      line: false,
      dots: false,
      chip: 'none',
      band: true,
    });
  });
  it('none — nothing', () => {
    expect(cursorParts('none')).toEqual({
      line: false,
      dots: false,
      chip: 'none',
      band: false,
    });
  });
  it('defaults to line', () => {
    expect(DEFAULT_CURSOR_MODE).toBe('line');
  });
});
