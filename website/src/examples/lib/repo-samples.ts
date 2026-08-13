/**
 * **Real measured data — this repo's own.** Every non-merge commit on
 * pond's default branch, one count per UTC day, in exactly the bins GitHub
 * draws contribution heat maps from: 18 Sunday-start weeks
 * (2026-04-12 →), 1001 commits.
 *
 * **Source and licence.** The GitHub REST API's
 * `/repos/pond-ts/pond/stats/commit_activity` — the numbers behind the
 * repository's own activity graph — retrieved 2026-08-13. The subject is
 * this repository's commit history, so the data is ours to publish; GitHub
 * is credited as the binning.
 *
 * **What was kept, and the binning rules.** The API serves a fixed 52-week
 * window; the 34 leading all-zero weeks (the repo is
 * younger than a year) were trimmed. Weeks start **Sunday**, days are
 * **UTC**, and **merge commits are excluded** — at retrieval the total
 * matched `git rev-list --count --no-merges origin/main` exactly, and the
 * generator refuses to emit when it doesn't.
 *
 * **Quirks.** The last week is the current one, partial by definition —
 * days after retrieval are honest zeros, and the card says so rather than
 * trimming them. Commits land in the day their committer clock says in
 * UTC, which is how a late-evening CEST commit ends up in the next row.
 *
 * Generated once by `website/scripts/fixtures/repo-commits.mjs`, then
 * committed — the docs site fetches nothing. Re-run it to bring the graph
 * up to date; every number after `COMMITS_START_MS` will change, and
 * that's the point.
 */

/** First kept week's start: 2026-04-12T00:00:00.000Z (a Sunday). */
export const COMMITS_START_MS = 1775952000000;

/** One row of the grid: a Sunday-start UTC week. */
export const COMMITS_WEEK_MS = 604800000;

/** Non-merge commits per UTC day, Sunday-first within each week —
 *  18 weeks × 7 days, 1001 commits in all. */
// prettier-ignore
export const COMMITS_PER_DAY: readonly number[] = [
  0, 0, 0, 2, 20, 0, 0, 0, 16, 28, 7, 20, 18, 12, 10, 13, 11, 8, 9, 8, 18, 4, 4,
  7, 12, 4, 8, 1, 8, 1, 0, 35, 0, 0, 0, 8, 0, 8, 0, 0, 0, 0, 0, 13, 6, 19, 2, 11,
  7, 2, 1, 2, 1, 3, 0, 0, 0, 0, 1, 13, 6, 9, 4, 5, 8, 4, 10, 1, 5, 5, 19, 2, 5,
  1, 2, 0, 0, 11, 6, 1, 4, 17, 12, 3, 6, 3, 4, 14, 10, 18, 15, 17, 10, 20, 4, 2,
  13, 17, 17, 24, 22, 23, 5, 0, 19, 7, 25, 5, 11, 6, 4, 7, 28, 20, 32, 16, 2, 7,
  24, 0, 10, 4, 5, 4, 0, 0,
];
