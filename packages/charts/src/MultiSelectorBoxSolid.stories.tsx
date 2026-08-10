import type { Meta } from '@storybook/react-vite';
import { makeMultiSelectorStories } from './selection-stories.js';
import { boxSolid } from './selection-fixtures.js';

/**
 * **`<MultiSelector>` on a solid box plot.** Same data and same feature set as
 * `Interactions/MultiSelector/BoxWhisker`, with the spread drawn as one bar.
 *
 * The sweep should not notice the difference — it cuts the key axis by column,
 * and `shape` changes only what is painted inside a column. Any divergence
 * between these two is therefore a bug in something reading ink where it
 * should be reading the slot.
 */
const meta = {
  title: 'Interactions/MultiSelector/BoxSolid',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeMultiSelectorStories(boxSolid)!;

export const SweepMarks = s.SweepMarks;
export const ClickStillSelectsOne = s.ClickStillSelectsOne;
export const LivePreviewDuringDrag = s.LivePreviewDuringDrag;
export const SweepAdditive = s.SweepAdditive;
export const DemoteOnEdit = s.DemoteOnEdit;
export const SweepWithSequence = s.SweepWithSequence!;
