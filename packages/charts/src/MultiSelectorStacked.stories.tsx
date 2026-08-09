import type { Meta } from '@storybook/react-vite';
import { makeMultiSelectorStories } from './selection-stories.js';
import { stackedBars } from './selection-fixtures.js';

/**
 * **`<MultiSelector>` on a stacked bar chart** — the matrix column where a
 * sweep's *mark count* stops matching its bin count.
 *
 * A covered bin materialises every drawn segment, so sweeping N bins of a
 * three-group stack commits 3N marks. That is the number to watch in every
 * cell here against `Interactions/MultiSelector/BarChart`, whose identical
 * sweep commits N: the span descriptor is the same either way, which is the
 * argument for a span existing at all.
 */
const meta = {
  title: 'Interactions/MultiSelector/Stacked',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeMultiSelectorStories(stackedBars);

export const SweepMarks = s.SweepMarks;
export const ClickStillSelectsOne = s.ClickStillSelectsOne;
export const LivePreviewDuringDrag = s.LivePreviewDuringDrag;
export const SweepAdditive = s.SweepAdditive;
export const DemoteOnEdit = s.DemoteOnEdit;
export const SweepWithSequence = s.SweepWithSequence!;
