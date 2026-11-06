import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { StoryObj } from '@storybook/react-vite';
import * as marker from '../src/AnnotationsMarker.stories.js';
import * as region from '../src/AnnotationsRegion.stories.js';

afterEach(cleanup);

/**
 * Render smoke test for the `<Marker>` and `<Region>` stories, with the list
 * pinned so a knob that loses its dedicated story fails here rather than
 * quietly thinning coverage. The `Role*` entries are the [PND-ANNROLE] fan-out:
 * one story per shipped role, since a role nobody can see is one nobody adopts.
 */
const cases: Array<[string, Record<string, unknown>, string[]]> = [
  [
    'Marker',
    marker,
    [
      'Coincident',
      'CustomLabel',
      'Default',
      'Indicator',
      'IndicatorOnly',
      'IndicatorWithLabel',
      'Inert',
      'Multiple',
      'NoLabel',
      'RoleArgument',
      'RoleWash',
      'Selected',
    ],
  ],
  [
    'Region',
    region,
    [
      'CustomLabel',
      'Default',
      'Inert',
      'Multiple',
      'NarrowAndWide',
      'NoLabel',
      'NoOutlines',
      'RoleArgument',
      'RoleWash',
      'RoleWashSelected',
      'Selected',
    ],
  ],
];

for (const [title, mod, expected] of cases) {
  describe(`${title} stories render`, () => {
    const entries = Object.entries(mod).filter(
      ([name, v]) =>
        name !== 'default' && typeof (v as StoryObj).render === 'function',
    ) as Array<[string, StoryObj]>;

    it('exposes the expected feature-axis stories', () => {
      expect(entries.map(([n]) => n).sort()).toEqual(expected);
    });

    for (const [name, story] of entries) {
      it(`${name} mounts without throwing`, () => {
        const el = (story.render as () => ReactElement)();
        expect(() => render(el)).not.toThrow();
      });
    }
  });
}
