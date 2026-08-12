import { createElement, type ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as frameStories from '../src/ChartFrame.stories.js';
import * as autoStories from '../src/AutoWidth.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

const storiesOf = (mod: Record<string, unknown>) =>
  Object.entries(mod).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

/**
 * Render smoke test for the `useChartFrame()` stories: each must mount without
 * throwing. Exercises the whole publish path headless — the container
 * resolving gutters / plot width / band packing, a row publishing its top
 * inset and y scales, and consumer chrome reading all of it from outside and
 * inside a `<ChartRow>`.
 */
describe('useChartFrame stories render', () => {
  const entries = storiesOf(frameStories);

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'BandAlignEnd',
      'CappedBands',
      'Default',
      'DualAxis',
      'InPlotOverlay',
      'MultiRow',
      'PerSlotHeader',
      'TopInset',
      'WideGutter',
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

/**
 * Render smoke test for the auto-width stories. happy-dom has no layout
 * engine, so every measured box reads 0 and these mount in their
 * pre-measurement state — which is exactly the state that must not throw.
 */
describe('Auto width stories render', () => {
  const entries = storiesOf(autoStories);

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'ConstrainedParent',
      'Default',
      'Fixed',
      'FlexRow',
      'OmittedWidth',
      'PaddedWrapper',
      'ResizableBox',
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
