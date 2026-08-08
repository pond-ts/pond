import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/CursorsComponents.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the cursor-component stories: each must mount without
 * throwing. This exercises the mounted-preset pipeline headless — each preset
 * registering its `CursorSpec`, the container resolving the effective per-row
 * set (container mounts, in-row overrides, stacked render-only presets), and
 * the rows/`<XAxis>` rendering the registered slots.
 */
describe('Cursors/Components stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories (one per preset + the mount/stack/none axes)', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'Crosshair',
      'CrosshairFree',
      'Flag',
      'Inline',
      'Line',
      'MountedInRow',
      'NoCursor',
      'Point',
      'Range',
      'RangeFreeform',
      'RowOverride',
      'ShowTime',
      'StackedRenderOnly',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
