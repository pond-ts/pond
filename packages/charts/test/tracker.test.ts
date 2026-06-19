import { describe, expect, it } from 'vitest';
import {
  drawCrosshair,
  drawTrackerDot,
  resolveCursorX,
} from '../src/tracker.js';
import { recordingContext } from './canvas-mock.js';

describe('drawCrosshair', () => {
  it('strokes a vertical line at a pixel-snapped x, full height', () => {
    const { ctx, calls } = recordingContext();
    drawCrosshair(ctx, 40.3, 100, '#abc');
    // round(40.3) + 0.5 = 40.5 → crisp 1px line, top to bottom.
    expect(calls.find((c) => c.name === 'moveTo')?.args).toEqual([40.5, 0]);
    expect(calls.find((c) => c.name === 'lineTo')?.args).toEqual([40.5, 100]);
  });

  it('applies the colour and brackets canvas state with save/restore', () => {
    const { ctx, calls } = recordingContext();
    drawCrosshair(ctx, 10, 50, '#7FE2D2');
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'strokeStyle')?.args,
    ).toEqual(['#7FE2D2']);
    const seq = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(seq).toEqual([
      'save',
      'beginPath',
      'moveTo',
      'lineTo',
      'stroke',
      'restore',
    ]);
  });
});

describe('drawTrackerDot', () => {
  it('fills a dot at (x, y) in the colour, ringed by the background', () => {
    const { ctx, calls } = recordingContext();
    drawTrackerDot(ctx, 30, 40, '#15B3A6', '#06191D');
    expect(calls.find((c) => c.name === 'arc')?.args).toEqual([
      30,
      40,
      3,
      0,
      Math.PI * 2,
    ]);
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'fillStyle')?.args,
    ).toEqual(['#15B3A6']);
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'strokeStyle')?.args,
    ).toEqual(['#06191D']);
    const seq = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(seq).toEqual([
      'save',
      'beginPath',
      'arc',
      'fill',
      'stroke',
      'restore',
    ]);
  });

  it('skips the ring stroke when no ring colour is given', () => {
    const { ctx, calls } = recordingContext();
    drawTrackerDot(ctx, 10, 10, '#000');
    expect(calls.find((c) => c.name === 'stroke')).toBeUndefined();
  });
});

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
