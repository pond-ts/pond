import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/CursorsCrosshair.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the `Cursors/Crosshair` feature-axis stories — each must
 * mount without throwing, and the roster is pinned so a story cannot quietly
 * disappear from the fan-out (the systematic walk is the review technique).
 */
describe('Cursors/Crosshair stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes one story per crosshair state (snap, sides, axis pill placement)', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'AxisColor',
      'DualAxis',
      'FreeReticle',
      'LeftAxis',
      'MultiRow',
      'MultipleSeries',
      'SingleSeries',
      'StackedAxes',
      'StackedAxesColored',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
