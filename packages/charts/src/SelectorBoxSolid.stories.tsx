import type { Meta } from '@storybook/react-vite';
import { makeSelectorStories } from './selection-stories.js';
import { boxSolid } from './selection-fixtures.js';

/**
 * **`<Selector>` on a solid box plot** — `shape="solid"`, the candlestick
 * look: a light outer bar over the whole p5→p95 range with a darker inner
 * q1→q3 body, and no stems.
 *
 * Same data and same feature set as `Interactions/Selector/BoxWhisker`, so the
 * only variable is how the spread is *drawn* — which is exactly the variable
 * that decides what a pointer can hit. The whisker shape puts thin ink far
 * from the body with empty space either side of it; the solid shape fills that
 * span. Whether selection agrees across the two is the comparison.
 */
const meta = {
  title: 'Interactions/Selector/BoxSolid',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeSelectorStories(boxSolid);

export const MountedAtContainer = s.MountedAtContainer;
export const MountedInRow = s.MountedInRow;
export const NoSelector = s.NoSelector;
export const ControlledNoSelector = s.ControlledNoSelector;
export const ModifiersReported = s.ModifiersReported;
export const HoverOnly = s.HoverOnly;
export const BareSelector = s.BareSelector;
