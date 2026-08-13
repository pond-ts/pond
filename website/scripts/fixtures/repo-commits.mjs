#!/usr/bin/env node
/**
 * Generator for `src/examples/lib/repo-samples.ts` — pond's own commit
 * activity, in exactly the bins GitHub draws contribution heat maps from.
 *
 * Run by hand, never by the build (see `src/examples/lib/README.md`):
 *
 *     node website/scripts/fixtures/repo-commits.mjs > website/src/examples/lib/repo-samples.ts
 *
 * One endpoint of the **GitHub REST API**:
 *
 *   - `/repos/pond-ts/pond/stats/commit_activity` — the last 52 weeks of
 *     default-branch commit counts, one entry per week (Sunday-start, UTC),
 *     each with a 7-slot `days` array ordered Sunday → Saturday. This is the
 *     data behind the repo's own activity graph. **It excludes merge
 *     commits** — the total matches `git log --no-merges` exactly, not
 *     `git log` — and the generator refuses to emit if that check fails,
 *     so the header's claim stays true.
 *
 * GitHub computes these stats lazily: the first request often returns
 * **202** with an empty body while the numbers are assembled. The generator
 * polls until it gets a 200.
 *
 * What it does:
 *   - trims the leading all-zero weeks (the repo is younger than the API's
 *     fixed 52-week window)
 *   - flattens the kept weeks into one number-per-day array, Sunday first
 *   - validates week keys are exactly 7 days apart and every week has 7 days
 *   - cross-checks the API total against the local `git log --no-merges`
 *     count on origin/main
 */

import { execFileSync } from 'node:child_process';

const URL = 'https://api.github.com/repos/pond-ts/pond/stats/commit_activity';
const WEEK_S = 7 * 86_400;

async function getStats() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const res = await fetch(URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.status === 202) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${URL}`);
    return res.json();
  }
  throw new Error('GitHub kept returning 202 — stats never materialized');
}

const weeks = await getStats();
if (weeks.length !== 52)
  throw new Error(`expected 52 weeks, got ${weeks.length}`);

const firstActive = weeks.findIndex((w) => w.total > 0);
if (firstActive < 0) throw new Error('no active weeks at all');
const kept = weeks.slice(firstActive);

// Validate the *kept* window only. The API's week keys wobble by ±1 h across
// DST transitions in the empty pre-history (they are local-midnight in
// whatever zone GitHub computed them), but every active week must be a clean
// Sunday 00:00 UTC — the fixture's START/WEEK constants claim exactly that,
// so refuse to emit a window where it doesn't hold (e.g. a future re-run
// whose active weeks cross late October).
for (let i = 0; i < kept.length; i += 1) {
  const d = new Date(kept[i].week * 1000);
  if (d.getUTCDay() !== 0 || d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0)
    throw new Error(`kept week ${d.toISOString()} is not Sunday 00:00 UTC`);
  if (i > 0 && kept[i].week - kept[i - 1].week !== WEEK_S)
    throw new Error(`kept week keys not 7 days apart at index ${i}`);
}

const days = [];
for (const w of kept) {
  if (w.days.length !== 7)
    throw new Error(`week ${w.week} has ${w.days.length} days`);
  days.push(...w.days);
}
const total = days.reduce((a, b) => a + b, 0);

const local = Number(
  execFileSync('git', ['rev-list', '--count', '--no-merges', 'origin/main'], {
    encoding: 'utf8',
  }).trim(),
);
if (total !== local)
  throw new Error(
    `API total ${total} !== local git log --no-merges count ${local} — ` +
      'either main moved since the stats were computed (re-run in a minute) ' +
      'or the no-merges claim in the header is no longer true',
  );

const startMs = kept[0].week * 1000;
const retrieved = execFileSync('date', ['-u', '+%Y-%m-%d'], {
  encoding: 'utf8',
}).trim();

/** Dense ~80-column wrap, matching the house `// prettier-ignore` style. */
function wrap(values) {
  const lines = [];
  let line = ' ';
  for (const v of values) {
    if (line.length + v.length + 2 > 80) {
      lines.push(line + ',');
      line = ' ';
    }
    line += (line === ' ' ? ' ' : ', ') + v;
  }
  lines.push(line + ',');
  return lines.join('\n');
}

process.stdout.write(`/**
 * **Real measured data — this repo's own.** Every non-merge commit on
 * pond's default branch, one count per UTC day, in exactly the bins GitHub
 * draws contribution heat maps from: ${kept.length} Sunday-start weeks
 * (${new Date(startMs).toISOString().slice(0, 10)} →), ${total} commits.
 *
 * **Source and licence.** The GitHub REST API's
 * \`/repos/pond-ts/pond/stats/commit_activity\` — the numbers behind the
 * repository's own activity graph — retrieved ${retrieved}. The subject is
 * this repository's commit history, so the data is ours to publish; GitHub
 * is credited as the binning.
 *
 * **What was kept, and the binning rules.** The API serves a fixed 52-week
 * window; the ${52 - kept.length} leading all-zero weeks (the repo is
 * younger than a year) were trimmed. Weeks start **Sunday**, days are
 * **UTC**, and **merge commits are excluded** — at retrieval the total
 * matched \`git rev-list --count --no-merges origin/main\` exactly, and the
 * generator refuses to emit when it doesn't.
 *
 * **Quirks.** The last week is the current one, partial by definition —
 * days after retrieval are honest zeros, and the card says so rather than
 * trimming them. Commits land in the day their committer clock says in
 * UTC, which is how a late-evening CEST commit ends up in the next row.
 *
 * Generated once by \`website/scripts/fixtures/repo-commits.mjs\`, then
 * committed — the docs site fetches nothing. Re-run it to bring the graph
 * up to date; every number after \`COMMITS_START_MS\` will change, and
 * that's the point.
 */

/** First kept week's start: ${new Date(startMs).toISOString()} (a Sunday). */
export const COMMITS_START_MS = ${startMs};

/** One row of the grid: a Sunday-start UTC week. */
export const COMMITS_WEEK_MS = ${WEEK_S * 1000};

/** Non-merge commits per UTC day, Sunday-first within each week —
 *  ${kept.length} weeks × 7 days, ${total} commits in all. */
// prettier-ignore
export const COMMITS_PER_DAY: readonly number[] = [
${wrap(days.map(String))}
];
`);
