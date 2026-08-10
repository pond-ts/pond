import type { Meta } from '@storybook/react-vite';
import { makeMultiSelectorStories } from './selection-stories.js';
import { scatterPoints } from './selection-fixtures.js';

/**
 * **`<MultiSelector>` on a scatter — the first 2-D column in the matrix.**
 *
 * Every other column sweeps a *band*: the mark owns a column of the key axis,
 * so a drag is a range of keys and y never enters the question. A point owns
 * a position, so the same gesture has to be a **rect** — and it is drawn
 * free, unsnapped in both dimensions, because there is no grid to snap to
 * ([PND-INTERACT2D]).
 *
 * Read against `MultiSelector/HeatMap`, which is the other 2-D column and
 * snaps both dimensions. The pair is the point: dimensionality and snapping
 * are properties of the **layer**, and a consumer mounts the same
 * `<MultiSelector>` over all four kinds.
 *
 * Two cells behave differently here than in the 1-D columns, both for the
 * same reason — a 2-D layer has no snap *block*:
 *
 * - **`ClickStillSelectsOne`** — a click selects the point under the pointer,
 *   never a column of them. In a 1-D column with a declared `sequence` a
 *   click commits the whole block it previewed; the block a rect gesture
 *   would capture isn't a column, so there is nothing to widen to.
 * - **`LivePreviewDuringDrag`** — the preview lights only while a drag is in
 *   flight. The resting *block* preview the 1-D columns show at hover is
 *   suppressed for the same reason: it would advertise a column that the
 *   drag next to it never selects.
 */
const meta = {
  title: 'Interactions/MultiSelector/Scatter',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeMultiSelectorStories(scatterPoints)!;

export const SweepMarks = s.SweepMarks;
export const ClickStillSelectsOne = s.ClickStillSelectsOne;
export const LivePreviewDuringDrag = s.LivePreviewDuringDrag;
export const SweepAdditive = s.SweepAdditive;
export const DemoteOnEdit = s.DemoteOnEdit;
