import type { Meta } from '@storybook/react-vite';
import { makeMultiSelectorStories } from './selection-stories.js';
import { candles } from './selection-fixtures.js';

/**
 * **`<MultiSelector>` on candlesticks.** A candle owns one `[x, xEnd)` column
 * of the key axis, so it sweeps exactly as a bar or a box does.
 *
 * The column's own question is what a *swept run* looks like when the marks
 * inside it are two different colours: the run recedes the field by opacity
 * and outlines the covered slots, leaving every candle's direction legible
 * inside the selection.
 */
const meta = {
  title: 'Interactions/MultiSelector/Candlestick',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeMultiSelectorStories(candles)!;

export const SweepMarks = s.SweepMarks;
export const ClickStillSelectsOne = s.ClickStillSelectsOne;
export const LivePreviewDuringDrag = s.LivePreviewDuringDrag;
export const SweepAdditive = s.SweepAdditive;
export const DemoteOnEdit = s.DemoteOnEdit;
export const SweepWithSequence = s.SweepWithSequence!;
