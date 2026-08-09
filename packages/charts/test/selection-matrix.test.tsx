import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { StoryObj } from '@storybook/react-vite';
import * as selectorCategorical from '../src/SelectorCategorical.stories.js';
import * as selectorBarChart from '../src/SelectorBarChart.stories.js';
import * as multiCategorical from '../src/MultiSelectorCategorical.stories.js';
import * as multiBarChart from '../src/MultiSelectorBarChart.stories.js';
import * as selectorStacked from '../src/SelectorStacked.stories.js';
import * as selectorBoxWhisker from '../src/SelectorBoxWhisker.stories.js';
import * as selectorBoxSolid from '../src/SelectorBoxSolid.stories.js';
import * as multiBoxWhisker from '../src/MultiSelectorBoxWhisker.stories.js';
import * as multiBoxSolid from '../src/MultiSelectorBoxSolid.stories.js';
import * as selectorCandlestick from '../src/SelectorCandlestick.stories.js';
import * as multiCandlestick from '../src/MultiSelectorCandlestick.stories.js';
import * as selectorScatter from '../src/SelectorScatter.stories.js';
import * as selectorHeatMap from '../src/SelectorHeatMap.stories.js';
import * as multiStacked from '../src/MultiSelectorStacked.stories.js';
import * as multiTradingSessions from '../src/MultiSelectorTradingSessions.stories.js';
import {
  makeMultiSelectorStories,
  makeSessionStories,
} from '../src/selection-stories.js';
import {
  FIXTURES,
  categoricalBars,
  timeBars,
  tradingSessions,
  type ChartFixture,
} from '../src/selection-fixtures.js';

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
    expect(namesOf(selectorStacked)).toEqual(SELECTOR_FEATURES);
    expect(namesOf(selectorBoxWhisker)).toEqual(SELECTOR_FEATURES);
    expect(namesOf(selectorBoxSolid)).toEqual(SELECTOR_FEATURES);
    expect(namesOf(selectorCandlestick)).toEqual(SELECTOR_FEATURES);
    expect(namesOf(selectorScatter)).toEqual(SELECTOR_FEATURES);
    expect(namesOf(selectorHeatMap)).toEqual(SELECTOR_FEATURES);
  });

  it('<MultiSelector>: identical except the declared sequence gap', () => {
    // A time bucketing over ordinal slots is meaningless, so the categorical
    // fixture declares no `sequence` and the factory generates no cell. The
    // gap is *information* — asserted, not merely allowed.
    expect(namesOf(multiCategorical)).toEqual(MULTI_FEATURES);
    expect(namesOf(multiBarChart)).toEqual(
      [...MULTI_FEATURES, 'SweepWithSequence'].sort(),
    );
    expect(namesOf(multiStacked)).toEqual(
      [...MULTI_FEATURES, 'SweepWithSequence'].sort(),
    );
    expect(namesOf(multiBoxWhisker)).toEqual(
      [...MULTI_FEATURES, 'SweepWithSequence'].sort(),
    );
    expect(namesOf(multiBoxSolid)).toEqual(
      [...MULTI_FEATURES, 'SweepWithSequence'].sort(),
    );
    expect(namesOf(multiCandlestick)).toEqual(
      [...MULTI_FEATURES, 'SweepWithSequence'].sort(),
    );
    // The trading column adds the session pair on top of the sequence cell —
    // the *only* column whose axis has seams for a block to respect or cross,
    // so these two have nothing to be compared against elsewhere.
    expect(namesOf(multiTradingSessions)).toEqual(
      [
        ...MULTI_FEATURES,
        'SweepWithSequence',
        'SequenceConformsToSessions',
        'SequenceCrossesSessions',
      ].sort(),
    );
  });

  it('a fixture that cannot sweep gets no <MultiSelector> column at all', () => {
    // The capability is declared, not inferred from what happens to be wired.
    // Nothing in the matrix declares `sweep: false` today — box plots did
    // until `<BoxPlot>` gained `beginSweep` — so this pins the *mechanism*
    // against a stub rather than leaving it untested until it is needed.
    const cannot: ChartFixture = { ...timeBars, sweep: false };
    expect(makeMultiSelectorStories(cannot)).toBeNull();
    expect(makeMultiSelectorStories(timeBars)).not.toBeNull();
  });

  it('every fixture that CAN sweep has a MultiSelector column wired up', () => {
    // The failure this exists to catch: adding a fixture, forgetting its cell
    // file, and reading the absence as a declared capability gap. A gap is
    // only information when it was declared — so derive the expected set from
    // the declarations, not from the files that happen to exist.
    const wired = new Set(
      [
        multiCategorical,
        multiBarChart,
        multiStacked,
        multiBoxWhisker,
        multiBoxSolid,
        multiCandlestick,
        multiTradingSessions,
      ].map((m) => (m.default as { title: string }).title.split('/').pop()),
    );
    const shouldSweep = FIXTURES.filter((f) => f.sweep).map((f) => f.name);
    expect([...shouldSweep].sort()).toEqual([...wired].sort());
  });

  it('the session pair is generated only where the axis has seams', () => {
    // A fixture that declares no `sessions` gets no session stories — the
    // capability is declared, not assumed, so a column can never carry a cell
    // that silently demonstrates nothing (the rule `rangeCursor` earned).
    expect(makeSessionStories(categoricalBars)).toBeNull();
    expect(makeSessionStories(timeBars)).toBeNull();
    expect(makeSessionStories(tradingSessions)).not.toBeNull();
  });
});

describe.each([
  ['Selector/Categorical', selectorCategorical],
  ['Selector/BarChart', selectorBarChart],
  ['MultiSelector/Categorical', multiCategorical],
  ['Selector/Stacked', selectorStacked],
  ['Selector/BoxWhisker', selectorBoxWhisker],
  ['Selector/BoxSolid', selectorBoxSolid],
  ['MultiSelector/BarChart', multiBarChart],
  ['MultiSelector/Stacked', multiStacked],
  ['MultiSelector/BoxWhisker', multiBoxWhisker],
  ['MultiSelector/BoxSolid', multiBoxSolid],
  ['Selector/Candlestick', selectorCandlestick],
  ['MultiSelector/Candlestick', multiCandlestick],
  ['Selector/Scatter', selectorScatter],
  ['Selector/HeatMap', selectorHeatMap],
  ['MultiSelector/TradingSessions', multiTradingSessions],
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
