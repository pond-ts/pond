import type { Meta } from '@storybook/react-vite';
import { makeMultiSelectorStories } from './selection-stories.js';
import { boxWhisker } from './selection-fixtures.js';

/**
 * **`<MultiSelector>` on a whisker box plot.** A box is an aggregation: it owns
 * one `[begin, end)` interval of the key axis, so it sweeps exactly as a bar
 * does — the sweep cuts **columns**, and a box is a bar that simply isn't
 * grounded to the axis.
 *
 * Read against `Interactions/MultiSelector/BarChart`: the band, the block
 * preview, the span descriptor and the mark count should all behave
 * identically, because the only difference between the two columns is how tall
 * the ink is and where it starts.
 */
const meta = {
  title: 'Interactions/MultiSelector/BoxWhisker',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeMultiSelectorStories(boxWhisker)!;

export const SweepMarks = s.SweepMarks;
export const ClickStillSelectsOne = s.ClickStillSelectsOne;
export const LivePreviewDuringDrag = s.LivePreviewDuringDrag;
export const SweepAdditive = s.SweepAdditive;
export const DemoteOnEdit = s.DemoteOnEdit;
export const SweepWithSequence = s.SweepWithSequence!;
