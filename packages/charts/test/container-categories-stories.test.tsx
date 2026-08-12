import { createElement, type ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/ContainerCategories.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the container-`categories` stories. Exercises the
 * whole [PND-IGNITECAT] path headless: the container declaring the ordinal
 * domain with no category layer present, value-keyed line / scatter / band
 * layers keying to slot coordinates, a category layer reconciled against the
 * prop, the packing knobs, and axis label thinning.
 */
describe('Container categories stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'CappedPitch',
      'Default',
      'EnvelopeOverBars',
      'LineOverBars',
      'ManyThinnedLabels',
      'MultiRow',
      'PointsOverBars',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      expect(() =>
        render(createElement(story.render as ComponentType)),
      ).not.toThrow();
    });
  }
});
