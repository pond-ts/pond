import type { Meta } from '@storybook/react-vite';
import {
  makeMultiSelectorStories,
  makeSessionStories,
} from './selection-stories.js';
import { tradingSessions } from './selection-fixtures.js';

/**
 * **`<MultiSelector>` on a trading-time axis** — the matrix column where the x
 * axis has *seams*. Closed-market time collapses to nothing and
 * `sessionDividers="all"` draws a rule at each collapse, so the session grid a
 * selection block either respects or ignores is visible in every cell.
 *
 * Compare against `Interactions/MultiSelector/BarChart`: same generated feature
 * set on a continuous axis, so anything that behaves differently here is the
 * discontinuity, not the story.
 *
 * Two cells are unique to this column, and they are the reason it exists —
 * `SequenceConformsToSessions` and `SequenceCrossesSessions`. A snap block on a
 * continuous axis is just an interval; here it either lines up with the
 * sessions or cuts across them, which is a question no other column can ask.
 */
const meta = {
  title: 'Interactions/MultiSelector/TradingSessions',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const s = makeMultiSelectorStories(tradingSessions);
const sessions = makeSessionStories(tradingSessions)!;

export const SweepMarks = s.SweepMarks;
export const ClickStillSelectsOne = s.ClickStillSelectsOne;
export const LivePreviewDuringDrag = s.LivePreviewDuringDrag;
export const SweepAdditive = s.SweepAdditive;
export const DemoteOnEdit = s.DemoteOnEdit;
export const SweepWithSequence = s.SweepWithSequence!;

export const SequenceConformsToSessions = sessions.SequenceConformsToSessions;
export const SequenceCrossesSessions = sessions.SequenceCrossesSessions;
