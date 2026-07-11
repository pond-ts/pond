import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/CategoryAxis.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the category-axis stories: each must mount without
 * throwing. This exercises the whole Phase 1 pipeline headless — `<BarChart
 * categories>` publishing `xKind:'category'` + `xCategories`, the container
 * reconciling the categories and building the band scale, the axis ticking once
 * per category, and the stacked draw path on the band scale.
 */
describe('CategoryAxis stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'CrowdedLabels',
      'HighCardinality',
      'Select',
      'Signed',
      'SingleHue',
      'Tickers',
      'Transpose',
      'TransposeScrub',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
