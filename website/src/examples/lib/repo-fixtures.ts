import { TimeSeries } from 'pond-ts';
import {
  COMMITS_PER_DAY,
  COMMITS_START_MS,
  COMMITS_WEEK_MS,
} from './repo-samples';

/**
 * The Gallery's **product, transport & statistical** track — pond's own
 * commit history, shaped for a GitHub-style contribution heat map.
 *
 * Provenance and binning rules live in the header of `repo-samples.ts`
 * (short version: **real measured data, this repo's own** — the GitHub
 * REST API's `commit_activity` stats for pond-ts/pond, non-merge commits
 * per UTC day in Sunday-start weeks). This module only reshapes: the flat
 * day-per-entry array becomes a **wide weekly series** — one row per week,
 * one column per weekday — because a heat map wants its y dimension as
 * columns, exactly like the Niño 3.4 grid's years.
 */

// Range-keyed, not point-keyed, and it matters: a week IS a span, and a
// point-keyed series would make <HeatMap> infer each cell's bin from the
// midpoints to its neighbours — every cell would straddle weekStart ± 3.5
// days and the hover hit would report a key 3.5 days early. Same reasoning,
// same kind, as the day-ahead price fixture's auction hours.
const commitSchema = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'sun', kind: 'number' },
  { name: 'mon', kind: 'number' },
  { name: 'tue', kind: 'number' },
  { name: 'wed', kind: 'number' },
  { name: 'thu', kind: 'number' },
  { name: 'fri', kind: 'number' },
  { name: 'sat', kind: 'number' },
] as const;

/**
 * The weekday columns as heat-map rows, **bottom of the grid first** —
 * `<HeatMap>` draws its first column at the bottom, and the GitHub
 * convention reads Sunday at the top, Saturday at the bottom.
 */
export const COMMIT_ROWS = [
  'sat',
  'fri',
  'thu',
  'wed',
  'tue',
  'mon',
  'sun',
] as const;

/** The rows worth labelling — Mon / Wed / Fri, the same three GitHub
 *  labels, at each row's centre. Labelling all seven reads as clutter at
 *  seven rows tall. */
export const COMMIT_ROW_TICKS = (['fri', 'wed', 'mon'] as const).map((d) => ({
  at: COMMIT_ROWS.indexOf(d) + 0.5,
  label: d[0]!.toUpperCase() + d.slice(1),
}));

/**
 * Non-merge commits to pond's default branch — one row per Sunday-start UTC
 * week, one column per weekday. 18 weeks from the repo's first commit week,
 * 1,001 commits.
 */
export function commitActivity() {
  const rows: Array<
    [
      { start: number; end: number },
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
  > = [];
  for (let w = 0; w * 7 < COMMITS_PER_DAY.length; w += 1) {
    rows.push([
      {
        start: COMMITS_START_MS + w * COMMITS_WEEK_MS,
        end: COMMITS_START_MS + (w + 1) * COMMITS_WEEK_MS,
      },
      COMMITS_PER_DAY[w * 7]!,
      COMMITS_PER_DAY[w * 7 + 1]!,
      COMMITS_PER_DAY[w * 7 + 2]!,
      COMMITS_PER_DAY[w * 7 + 3]!,
      COMMITS_PER_DAY[w * 7 + 4]!,
      COMMITS_PER_DAY[w * 7 + 5]!,
      COMMITS_PER_DAY[w * 7 + 6]!,
    ]);
  }
  return new TimeSeries({
    name: 'pond-commits',
    schema: commitSchema,
    rows,
  });
}

/** `[begin, end]` for the grid — the end is the last week's **end**, not its
 *  key, so the final column of cells gets its full width. */
export function commitActivityRange(): [number, number] {
  return [
    COMMITS_START_MS,
    COMMITS_START_MS + (COMMITS_PER_DAY.length / 7) * COMMITS_WEEK_MS,
  ];
}
