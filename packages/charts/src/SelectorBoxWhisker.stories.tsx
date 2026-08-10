import type { Meta } from '@storybook/react-vite';
import { makeSelectorStories } from './selection-stories.js';
import { boxWhisker } from './selection-fixtures.js';

/**
 * **`<Selector>` on a whisker box plot** — the matrix column whose mark has
 * *internal structure*. Every column before it is one filled rect per x; a box
 * is a q1→q3 body plus a median rule plus two thin stems with caps, and
 * `hitTest` is rect containment over that composite.
 *
 * So the question here is **what counts as the mark for hit purposes** — and
 * the stems are the interesting part, being drawn ink a long way from the
 * body. Read against `Interactions/Selector/BoxSolid`, which is the same data
 * and the same feature set with the spread drawn as one bar instead.
 *
 * The sweep half lives in `Interactions/MultiSelector/BoxWhisker`: a box is an
 * aggregation owning one column of the key axis, so it sweeps like any bar.
 */
const meta = {
  title: 'Interactions/Selector/BoxWhisker',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeSelectorStories(boxWhisker);

export const MountedAtContainer = s.MountedAtContainer;
export const MountedInRow = s.MountedInRow;
export const NoSelector = s.NoSelector;
export const ControlledNoSelector = s.ControlledNoSelector;
export const ModifiersReported = s.ModifiersReported;
export const HoverOnly = s.HoverOnly;
export const BareSelector = s.BareSelector;
