import type { Meta } from '@storybook/react-vite';
import { makeMultiSelectorStories } from './selection-stories.js';
import { heatGrid } from './selection-fixtures.js';

/**
 * **`<MultiSelector>` on a heat map — the snapped 2-D column.**
 *
 * The rect gesture is the one `MultiSelector/Scatter` shows, with both
 * dimensions **snapped**: x to the bin edges (as every 1-D column's band
 * snaps), y outward to whole rows. A drag that clips two rows and three bins
 * captures all six cells, and the committed span names its rows rather than
 * numbering them — `rows: ['low', 'mid']`, not `[0, 2)` — so the descriptor
 * survives a re-ordered `columns` list the way a bar's key survives a
 * re-sorted series ([PND-INTERACT2D]).
 *
 * **Snapping both dimensions is what makes the capture a rectangle**, which
 * is in turn what lets a selected region be drawn as a single perimeter
 * rather than a per-cell outline. That is not a coincidence the styling
 * noticed — it is a consequence of the cut.
 *
 * As on the scatter, a click selects the cell under the pointer and hover
 * lights that one cell: a 2-D layer publishes no resting *block*, because
 * the block would be a whole column and the drag beside it captures a rect.
 */
const meta = {
  title: 'Interactions/MultiSelector/HeatMap',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeMultiSelectorStories(heatGrid)!;

export const SweepMarks = s.SweepMarks;
export const ClickStillSelectsOne = s.ClickStillSelectsOne;
export const LivePreviewDuringDrag = s.LivePreviewDuringDrag;
export const SweepAdditive = s.SweepAdditive;
export const DemoteOnEdit = s.DemoteOnEdit;
