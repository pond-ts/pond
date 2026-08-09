import type { Meta } from '@storybook/react-vite';
import { makeMultiSelectorStories } from './selection-stories.js';
import { categoricalBars } from './selection-fixtures.js';

/**
 * **`<MultiSelector>` on an ordinal axis** — one column of the selection
 * matrix. Sweeping ordinal slots is the case `[PND-CATRANGE]` named: the sweep
 * reports **marks**, so ordinal and continuous are the same gesture and nobody
 * has to re-implement the inverse of the band scale.
 *
 * **`SweepWithSequence` is absent by construction** — a time bucketing over
 * ordinal slots is meaningless, so the fixture declares no `sequence` and the
 * factory generates no cell. A gap in the matrix is information; a story that
 * silently did nothing would not be.
 */
const meta = {
  title: 'Interactions/MultiSelector/Categorical',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeMultiSelectorStories(categoricalBars);

export const SweepMarks = s.SweepMarks;
export const ClickStillSelectsOne = s.ClickStillSelectsOne;
export const LivePreviewDuringDrag = s.LivePreviewDuringDrag;
export const SweepAdditive = s.SweepAdditive;
export const DemoteOnEdit = s.DemoteOnEdit;
