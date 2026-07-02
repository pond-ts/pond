import { describe, expect, it } from 'vitest';
import {
  cursorParts,
  DEFAULT_CURSOR_MODE,
  resolveCursorX,
} from '../src/tracker.js';

describe('resolveCursorX', () => {
  const xScale = (t: number) => t / 10; // simple linear time→pixel for the test

  it('uses the hover pixel when uncontrolled (trackerPosition undefined)', () => {
    expect(resolveCursorX(undefined, 42, xScale)).toBe(42);
    expect(resolveCursorX(undefined, null, xScale)).toBeNull();
  });

  it('maps a controlled timestamp through xScale (ignoring hover)', () => {
    expect(resolveCursorX(300, 42, xScale)).toBe(30);
  });

  it('hides on a controlled null', () => {
    expect(resolveCursorX(null, 42, xScale)).toBeNull();
  });
});

describe('cursorParts', () => {
  it('line — the synced line only, no dots or chip', () => {
    expect(cursorParts('line')).toEqual({
      line: true,
      dots: false,
      chip: 'none',
    });
  });
  it('point — dots only, no line or chip', () => {
    expect(cursorParts('point')).toEqual({
      line: false,
      dots: true,
      chip: 'none',
    });
  });
  it('inline — dots + an inline chip, no line', () => {
    expect(cursorParts('inline')).toEqual({
      line: false,
      dots: true,
      chip: 'inline',
    });
  });
  it('flag — dots + a flag chip, no line', () => {
    expect(cursorParts('flag')).toEqual({
      line: false,
      dots: true,
      chip: 'flag',
    });
  });
  it('crosshair — a single reticle drawn by Layers (no generic line/dots)', () => {
    // Layers draws the dashed vertical + full-width horizontal + centre dot + one
    // value pill itself, so cursorParts asks for no generic line/dots here.
    expect(cursorParts('crosshair')).toEqual({
      line: false,
      dots: false,
      chip: 'axis',
    });
  });
  it('none — nothing', () => {
    expect(cursorParts('none')).toEqual({
      line: false,
      dots: false,
      chip: 'none',
    });
  });
  it('defaults to line', () => {
    expect(DEFAULT_CURSOR_MODE).toBe('line');
  });
});
