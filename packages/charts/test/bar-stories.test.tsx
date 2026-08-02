import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/Bar.stories.js';
import type { StoryObj } from '@storybook/react-vite';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * Render smoke test for the `Charts/BarChart` stories — the single-series
 * feature axis (buckets, diverging, per-bar colours, hover/select, and the two
 * controlled-selection channels), each mounting headlessly the way Storybook
 * would: pond's own series through layer registration, extent resolution, and
 * the canvas draw path. The stacked / histogram / categorical siblings have
 * their own suites (`histogram-stories`, `category-stories`).
 */
describe('BarChart stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected feature-axis stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'BinColors',
      'Buckets',
      'ControlledSelection',
      'Diverging',
      'HoverSelect',
      'HoverVsSelectColours',
      'MarkSelection',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }

  /** The two controlled-selection stories must actually *show* a selection —
   *  a pin that silently matched nothing would still "mount without throwing". */
  for (const name of ['ControlledSelection', 'MarkSelection'] as const) {
    it(`${name} paints a selection outline`, () => {
      const stub = stubCanvasContext();
      try {
        render((stories[name].render as () => ReactElement)());
        expect(
          stub.calls.filter((c) => c.name === 'strokeRect').length,
        ).toBeGreaterThan(0);
      } finally {
        stub.restore();
      }
    });
  }
});
