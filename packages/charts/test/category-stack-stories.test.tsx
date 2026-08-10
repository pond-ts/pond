import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/CategoryStack.stories.js';
import type { StoryObj } from '@storybook/react-vite';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * Render smoke test for the category-stack stories ([PND-CATSTACK]). Each must
 * mount without throwing, which exercises the whole path headless: the
 * `categoryStacks` reader, the container reconciling `xCategories` from the
 * per-bin `marks`, the band scale, and `drawStacks` with `G > 1` on an ordinal
 * axis.
 *
 * The story-count assertion is deliberate: it fails when a story is added
 * without being listed, which is how the fan-out stays a **reviewable** set
 * rather than drifting into "whatever happens to be in the file".
 */
describe('Category stack stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'CallSiteColors',
      'Default',
      'GapInAGroup',
      'Horizontal',
      'OneGroup',
      'Selected',
      'SelectedWithColors',
      'TwoGroups',
      'WithLegend',
    ]);
  });

  it.each(
    Object.entries(stories).filter(
      ([name, v]) =>
        name !== 'default' && typeof (v as StoryObj).render === 'function',
    ) as Array<[string, StoryObj]>,
  )('%s mounts without throwing', (_name, story) => {
    const stub = stubCanvasContext();
    try {
      expect(() =>
        render((story.render as () => ReactElement)()),
      ).not.toThrow();
    } finally {
      stub.restore();
    }
  });
});
