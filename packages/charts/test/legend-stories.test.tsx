import { createElement, type ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/Legend.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the Legend stories: each must mount without throwing.
 * Exercises the registration → order/dedup → render pipeline headless across
 * every story state (mixed swatch kinds, stacked groups, placements, opt-out /
 * rename, dedup, multi-row order, interactions, standalone items).
 */
describe('Legend stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'DedupSharedIdentity',
      'Default',
      'HeadlessCustomLegend',
      'InteractiveSelect',
      'MixedMarkSwatches',
      'MultiRowOrder',
      'OptOutAndRename',
      'PlacementBottomLeft',
      'PlacementBottomRight',
      'PlacementTopLeft',
      'ScopedPerRow',
      'StackedBarGroups',
      'StandaloneItems',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      // Mount the story's render as a *component* (not a plain call) so a
      // story that uses hooks (InteractiveSelect's useState) is legal.
      expect(() =>
        render(createElement(story.render as ComponentType)),
      ).not.toThrow();
    });
  }
});
