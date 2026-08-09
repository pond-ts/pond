import type { Meta } from '@storybook/react-vite';
import { makeSelectorStories } from './selection-stories.js';
import { timeBars } from './selection-fixtures.js';

/**
 * **`<Selector>` on a time axis** — one column of the selection matrix
 * (`selection-stories.tsx` holds the feature set, `selection-fixtures.tsx` the
 * chart types). Compare against `Interactions/Selector/Categorical`: the stories
 * are generated from one definition, so anything that differs between the two
 * is the **library** differing, not the story.
 *
 * A `<RangeCursor>` **is** mounted here: it gates on a continuous x, so this
 * column is where it draws — the band shows the bin under the pointer.
 */
const meta = {
  title: 'Interactions/Selector/BarChart',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeSelectorStories(timeBars);

export const MountedAtContainer = s.MountedAtContainer;
export const MountedInRow = s.MountedInRow;
export const NoSelector = s.NoSelector;
export const ControlledNoSelector = s.ControlledNoSelector;
export const ModifiersReported = s.ModifiersReported;
export const HoverOnly = s.HoverOnly;
export const BareSelector = s.BareSelector;
