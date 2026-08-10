import type { Meta } from '@storybook/react-vite';
import { makeMultiSelectorStories } from './selection-stories.js';
import { timeBars } from './selection-fixtures.js';

/**
 * **`<MultiSelector>` on a time axis** — one column of the selection matrix.
 * Compare against `Interactions/MultiSelector/Categorical`: same feature set,
 * generated from one definition, so a visible difference is the library's.
 *
 * This column additionally carries **`SweepWithSequence`**, since a time axis
 * has a bucketing to snap to. No cursor is mounted anywhere here — a mounted
 * `<MultiSelector>` draws its own resting band, which is the preview of the
 * block a drag would select.
 */
const meta = {
  title: 'Interactions/MultiSelector/BarChart',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeMultiSelectorStories(timeBars)!;

export const SweepMarks = s.SweepMarks;
export const ClickStillSelectsOne = s.ClickStillSelectsOne;
export const LivePreviewDuringDrag = s.LivePreviewDuringDrag;
export const SweepAdditive = s.SweepAdditive;
export const DemoteOnEdit = s.DemoteOnEdit;
export const SweepWithSequence = s.SweepWithSequence!;
