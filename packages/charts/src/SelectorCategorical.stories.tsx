import type { Meta } from '@storybook/react-vite';
import { makeSelectorStories } from './selection-stories.js';
import { categoricalBars } from './selection-fixtures.js';

/**
 * **`<Selector>` on an ordinal axis** — one column of the selection matrix
 * (`selection-stories.tsx` holds the feature set, `selection-fixtures.tsx` the
 * chart types). Compare against `Interactions/Selector/BarChart`: the stories
 * are generated from one definition, so anything that differs between the two
 * is the **library** differing, not the story.
 *
 * No `<RangeCursor>` here — it gates on a continuous x, and mounting one on a
 * category axis costs the row its cursor entirely.
 */
const meta = {
  title: 'Interactions/Selector/Categorical',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeSelectorStories(categoricalBars);

export const MountedAtContainer = s.MountedAtContainer;
export const MountedInRow = s.MountedInRow;
export const NoSelector = s.NoSelector;
export const ControlledNoSelector = s.ControlledNoSelector;
export const ModifiersReported = s.ModifiersReported;
export const HoverOnly = s.HoverOnly;
export const BareSelector = s.BareSelector;
