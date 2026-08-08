import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/MultiSelectorComponent.stories.js';
import type { StoryObj } from '@storybook/react-vite';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * Render smoke test for the `<MultiSelector>` stories: each must mount without
 * throwing. The fan-out covers the feature's axes (the systematic-coverage
 * rule): freeform sweep, sequence-snapped sweep, sweep + modifier, the
 * click-is-still-a-click superset, the live preview, A5.2's demote-on-edit
 * worked example, and the category-axis fold-in.
 */
describe('Interactions/MultiSelector stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('covers the sweep, snap, modifier, click, preview, edit and axis-kind axes', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'CategorySweep',
      'ClickStillSelectsOne',
      'DemoteOnEdit',
      'LivePreviewDuringDrag',
      'SweepAdditive',
      'SweepBars',
      'SweepWithSequence',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stub = stubCanvasContext();
      try {
        const Render = story.render as () => ReactElement;
        expect(() => render(<Render />)).not.toThrow();
      } finally {
        stub.restore();
        warn.mockRestore();
      }
    });
  }
});
