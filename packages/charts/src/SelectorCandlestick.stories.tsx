import type { Meta } from '@storybook/react-vite';
import { makeSelectorStories } from './selection-stories.js';
import { candles } from './selection-fixtures.js';

/**
 * **`<Selector>` on candlesticks** — the matrix column whose mark cannot
 * recolour to show its state.
 *
 * Rising vs falling is a candle's primary read and it lives in hue, which is
 * exactly the channel a bar swaps and a box's tint ladder rotates. So a candle
 * carries state in every channel *except* colour: an outline around its slot,
 * a heavier wick when selected, and the field receding by opacity.
 *
 * The thing to check walking these: a selected candle still says which way the
 * price went.
 */
const meta = {
  title: 'Interactions/Selector/Candlestick',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeSelectorStories(candles);

export const MountedAtContainer = s.MountedAtContainer;
export const MountedInRow = s.MountedInRow;
export const NoSelector = s.NoSelector;
export const ControlledNoSelector = s.ControlledNoSelector;
export const ModifiersReported = s.ModifiersReported;
export const HoverOnly = s.HoverOnly;
export const BareSelector = s.BareSelector;
