import type { Meta } from '@storybook/react-vite';
import { makeSelectorStories } from './selection-stories.js';
import { stackedBars } from './selection-fixtures.js';

/**
 * **`<Selector>` on a stacked bar chart** — the matrix column where one x
 * position holds *many* marks.
 *
 * Compare against `Interactions/Selector/BarChart`: same feature set, same
 * time axis, and the only variable is that a bin is a stack. So anything that
 * reads differently here is what stacking does to selection — most of all
 * `ControlledNoSelector`, where an external control has to name a segment by
 * `(key, label)` rather than by day alone.
 */
const meta = {
  title: 'Interactions/Selector/Stacked',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeSelectorStories(stackedBars);

export const MountedAtContainer = s.MountedAtContainer;
export const MountedInRow = s.MountedInRow;
export const NoSelector = s.NoSelector;
export const ControlledNoSelector = s.ControlledNoSelector;
export const ModifiersReported = s.ModifiersReported;
export const HoverOnly = s.HoverOnly;
export const BareSelector = s.BareSelector;
