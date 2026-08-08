import { createElement, type FunctionComponent } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { StoryObj } from '@storybook/react-vite';
import * as barList from '../src/BarList.stories.js';
import * as boxList from '../src/BoxList.stories.js';
import * as scenarios from '../src/ListScenarios.stories.js';

afterEach(cleanup);

/**
 * Render smoke test for the list family's stories — the per-knob feature
 * fan-outs (`Lists/BarList`, `Lists/BoxList`) plus the use-case anchors
 * (`Lists/Scenarios`), each mounting headlessly the way Storybook would. The
 * expected-name lists are the systematic-coverage contract: a knob that loses
 * its story fails here rather than quietly going unreviewed.
 */
const storiesOf = (mod: Record<string, unknown>) =>
  Object.entries(mod).filter(
    ([name, v]) =>
      name !== 'default' &&
      typeof (v as StoryObj | undefined)?.render === 'function',
  ) as Array<[string, StoryObj]>;

describe('list stories render', () => {
  it('BarList exposes the expected feature-axis stories', () => {
    expect(storiesOf(barList).map(([n]) => n)).toEqual([
      'Default',
      'MultiColumn',
      'SortedDesc',
      'SortedAsc',
      'CustomSort',
      'ExplicitDomain',
      'CellsBeforeAfter',
      'Expander',
      'SelectedRow',
      'HoveredRow',
      'HoveredRows',
      'UncontrolledHover',
      'HoverMirrored',
      'MissingData',
      'Undivided',
      'Markers',
      'Baseline',
      'BarHeight',
      'EstelaTheme',
    ]);
  });

  it('BoxList exposes the expected feature-axis stories', () => {
    expect(storiesOf(boxList).map(([n]) => n)).toEqual([
      'Default',
      'RangeOnly',
      'NoMedian',
      'NoTick',
      'TickNoLabel',
      'MultiColumn',
      'SortByCurrent',
      'Markers',
      'NoBaseline',
      'HoveredRow',
      'HoveredRows',
      'UncontrolledHover',
      'MissingData',
      'EstelaTheme',
    ]);
  });

  it('Scenarios exposes the use-case anchors', () => {
    expect(storiesOf(scenarios).map(([n]) => n)).toEqual([
      'TrafficByInterface',
      'Splits',
      'HoverLinkedChart',
    ]);
  });

  for (const [group, mod] of [
    ['BarList', barList],
    ['BoxList', boxList],
    ['Scenarios', scenarios],
  ] as const) {
    for (const [name, story] of storiesOf(mod)) {
      it(`${group}/${name} mounts without throwing`, () => {
        // Mounted as a component, not called as a function — several stories
        // are hook-using function components (`render: function XStory()`).
        expect(() =>
          render(createElement(story.render as FunctionComponent)),
        ).not.toThrow();
      });
    }
  }

  /** The controlled-hover stories must actually *light* a row — a pin that
   *  silently matched nothing would still "mount without throwing". */
  for (const [label, story, expected] of [
    ['BarList/HoveredRow', barList.HoveredRow, 1],
    ['BarList/HoveredRows', barList.HoveredRows, 2],
    ['BoxList/HoveredRow', boxList.HoveredRow, 1],
    ['BoxList/HoveredRows', boxList.HoveredRows, 2],
  ] as const) {
    it(`${label} lights ${expected} row(s)`, () => {
      const { container } = render(
        createElement(story.render as FunctionComponent),
      );
      expect(
        container.querySelectorAll('[data-list-row][data-hovered]'),
      ).toHaveLength(expected);
    });
  }
});
