import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { StoryObj } from '@storybook/react-vite';
import * as selectorCategorical from '../src/SelectorCategorical.stories.js';
import * as selectorBarChart from '../src/SelectorBarChart.stories.js';
import * as multiCategorical from '../src/MultiSelectorCategorical.stories.js';
import * as multiBarChart from '../src/MultiSelectorBarChart.stories.js';

afterEach(cleanup);

/**
 * The **selection matrix** — one feature set × one fixture per chart type.
 *
 * Two things are pinned here, and the second is the point of the file:
 *
 * 1. Every cell mounts without throwing (the ordinary smoke test).
 * 2. **The columns cover the same features.** A matrix only works as a review
 *    instrument if the cells are comparable, so a story silently existing in
 *    one column and not the other is a defect in the matrix itself. The one
 *    legitimate gap is declared explicitly below rather than tolerated.
 */

const namesOf = (mod: Record<string, unknown>): string[] =>
  Object.entries(mod)
    .filter(
      ([name, v]) =>
        name !== 'default' && typeof (v as StoryObj)?.render === 'function',
    )
    .map(([n]) => n)
    .sort();

const SELECTOR_FEATURES = [
  'BareSelector',
  'ControlledNoSelector',
  'HoverOnly',
  'ModifiersReported',
  'MountedAtContainer',
  'MountedInRow',
  'NoSelector',
];

const MULTI_FEATURES = [
  'ClickStillSelectsOne',
  'DemoteOnEdit',
  'LivePreviewDuringDrag',
  'SweepAdditive',
  'SweepMarks',
];

describe('the selection matrix covers the same features in every column', () => {
  it('<Selector>: both columns, identical feature set', () => {
    expect(namesOf(selectorCategorical)).toEqual(SELECTOR_FEATURES);
    expect(namesOf(selectorBarChart)).toEqual(SELECTOR_FEATURES);
  });

  it('<MultiSelector>: identical except the declared sequence gap', () => {
    // A time bucketing over ordinal slots is meaningless, so the categorical
    // fixture declares no `sequence` and the factory generates no cell. The
    // gap is *information* — asserted, not merely allowed.
    expect(namesOf(multiCategorical)).toEqual(MULTI_FEATURES);
    expect(namesOf(multiBarChart)).toEqual(
      [...MULTI_FEATURES, 'SweepWithSequence'].sort(),
    );
  });
});

describe.each([
  ['Selector/Categorical', selectorCategorical],
  ['Selector/BarChart', selectorBarChart],
  ['MultiSelector/Categorical', multiCategorical],
  ['MultiSelector/BarChart', multiBarChart],
])('%s stories render', (_group, mod) => {
  for (const [name, story] of Object.entries(mod).filter(
    ([n, v]) =>
      n !== 'default' && typeof (v as StoryObj)?.render === 'function',
  ) as Array<[string, StoryObj]>) {
    it(`${name} mounts without throwing`, () => {
      // `NoSelector` deliberately trips the one-time migration warning.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const Render = story.render as () => ReactElement;
      expect(() => render(<Render />)).not.toThrow();
      warn.mockRestore();
    });
  }
});
