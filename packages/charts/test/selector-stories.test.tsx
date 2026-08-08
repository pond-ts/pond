import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/SelectorComponent.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the `<Selector>` stories: each must mount without
 * throwing. Exercises the registration pipeline headless — a selector mounted
 * at the container, one mounted inside a `<ChartRow>` (the scoped case), the
 * inert no-selector chart, and the deprecation shim.
 */
describe('Interactions/Selector stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('covers the mount-point, callback, state and modifier axes', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'BareSelector',
      'ControlledNoSelector',
      'HoverOnly',
      'LegacyContainerProps',
      'ModifiersReported',
      'MountedAtContainer',
      'MountedInRow',
      'NoSelector',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      // `LegacyContainerProps` deliberately trips the deprecation warning.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const Render = story.render as () => ReactElement;
      expect(() => render(<Render />)).not.toThrow();
      warn.mockRestore();
    });
  }
});
