import type { Meta } from '@storybook/react-vite';
import { makeSelectorStories } from './selection-stories.js';
import { heatGrid } from './selection-fixtures.js';

/**
 * **`<Selector>` on HeatMap** — the 2-D family, where the click surface works
 * today and the *sweep* does not.
 *
 * These marks do not reduce to a run of columns: a scatter point is a position
 * with no span, and a heat map's cells are a grid whose y dimension a
 * column-sweep would simply ignore. So both fixtures declare `sweep: false`
 * and there is no `MultiSelector` column — the rect that reads them is
 * [PND-INTERACT2D], a different gesture rather than the same one rewired.
 *
 * Everything a `<Selector>` does is unaffected, which is what this column is
 * here to keep honest.
 */
const meta = {
  title: 'Interactions/Selector/HeatMap',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeSelectorStories(heatGrid);

export const MountedAtContainer = s.MountedAtContainer;
export const MountedInRow = s.MountedInRow;
export const NoSelector = s.NoSelector;
export const ControlledNoSelector = s.ControlledNoSelector;
export const ModifiersReported = s.ModifiersReported;
export const HoverOnly = s.HoverOnly;
export const BareSelector = s.BareSelector;
