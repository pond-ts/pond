import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/AnnotationsZone.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the `<Zone>` stories — the systematic prop fan-out,
 * exercised headlessly the way Storybook would. The list is pinned so a story
 * deleted (or a knob that quietly loses its dedicated story) shows up as a
 * failure rather than as silently thinner coverage.
 */
describe('Zone stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected feature-axis stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'Clamped',
      'DashedEdges',
      'Default',
      'DualAxis',
      'Edges',
      'Label',
      'LabelSideRight',
      'LabelledZoneSet',
      'OpenEnded',
      'ReversedBounds',
      'Role',
      'Selectable',
      'Selected',
      'UnknownRole',
      'ZoneSet',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
