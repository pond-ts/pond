import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as stories from '../src/Scatter.stories.js';
import type { StoryObj } from '@storybook/react-vite';

afterEach(cleanup);

/**
 * Render smoke test for the ScatterChart stories: each must mount without
 * throwing. Exercises the layer end-to-end headless — the data-driven
 * radius/colour encodings (`Encoded`), the value-axis variants (`ValueAxis*` on
 * a `ValueSeries`), the per-point labels, and the plural `selected` / `hovered`
 * sets (`Multi*`). What those last ones actually *paint* is asserted in
 * `plural-mark-highlight.test.tsx`; this pins only that they mount.
 *
 * `<BoxPlot>` has had this net since its stories landed (`box-stories.test.tsx`)
 * and the scatter did not, which is how a story could go stale unnoticed.
 */
describe('ScatterChart stories render', () => {
  const entries = Object.entries(stories).filter(
    ([name, v]) =>
      name !== 'default' && typeof (v as StoryObj).render === 'function',
  ) as Array<[string, StoryObj]>;

  it('exposes the expected stories', () => {
    expect(entries.map(([n]) => n).sort()).toEqual([
      'ControlledSelect',
      'CursorFlag',
      'Encoded',
      'Labelled',
      'MultiHovered',
      'MultiSelected',
      'MultiSelectedAndHovered',
      'OverLine',
      'PanZoomXY',
      'ValueAxis',
      'ValueAxisEncoded',
      'ValueAxisFlag',
      'ValueAxisLabelled',
      'ValueAxisSmile',
    ]);
  });

  for (const [name, story] of entries) {
    it(`${name} mounts without throwing`, () => {
      const el = (story.render as () => ReactElement)();
      expect(() => render(el)).not.toThrow();
    });
  }
});
