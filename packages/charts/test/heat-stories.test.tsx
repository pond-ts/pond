import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/HeatMap.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the HeatMap stories: each must mount without throwing.
 * Exercises the layer end-to-end headless — both shapes on either series kind
 * (`Stripe` / `Grid` / `ValueAxisStripe`), the pinned domain, the transpose
 * (`Horizontal` and its pan/zoom variants), and the plural `selected` /
 * `hovered` sets (`Multi*`). What those last ones actually *paint* is asserted
 * in `heat-plural-highlight.test.tsx`; this pins only that they mount.
 *
 * `<BoxPlot>` has had this net since its stories landed (`box-stories.test.tsx`)
 * and the heat map did not, which is how a story could go stale unnoticed.
 */
describe('HeatMap stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'Grid',
      'Horizontal',
      'ManyRows',
      'MultiHovered',
      'MultiSelected',
      'MultiSelectedAndHovered',
      'PanZoomXY',
      'PanZoomY',
      'PinnedDomain',
      'Selectable',
      'Stripe',
      'ValueAxisStripe',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
