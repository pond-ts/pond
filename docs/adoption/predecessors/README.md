# Predecessor notices — pondjs and react-timeseries-charts

Drafts for the two ESnet repositories that pond supersedes. Both are
unmaintained but not archived, still rank first for their names, and still
outdraw pond on npm (measured 2026-09-12):

| Repo                            | Last commit | Open issues | npm downloads / month   | Successor         |
| ------------------------------- | ----------- | ----------- | ----------------------- | ----------------- |
| `esnet/pond` (`pondjs`)         | 2019-11-07  | 118         | 10 494 (`pondjs` 0.9.0) | `pond-ts`         |
| `esnet/react-timeseries-charts` | 2020-04-06  | 126         | 6 420 (0.16.1)          | `@pond-ts/charts` |

Neither README mentions a successor, and no issue on either repo does. An agent
(or person) that lands there from training-data familiarity has no path to the
maintained library. These drafts add that path in the two places it will be
read: an issue (indexed, shows in search) and a README notice (PR — may never
merge, but a PR is itself a visible pointer).

**Voice:** written in the first person for Peter (original author of both
libraries at ESnet) to post from his own account. Do not post them from an
agent identity; the authorship is what makes the notice credible.

## Files

- [`pond-issue.md`](pond-issue.md) — issue body for `esnet/pond`.
- [`pond-readme-notice.md`](pond-readme-notice.md) — block to insert at the
  top of `esnet/pond/README.md`, after the badges line.
- [`rtc-issue.md`](rtc-issue.md) — issue body for `esnet/react-timeseries-charts`.
- [`rtc-readme-notice.md`](rtc-readme-notice.md) — block to insert at the top
  of `esnet/react-timeseries-charts/README.md`, after the badges line.

## Posting (owner action — outward-facing)

```sh
# Issues
gh issue create --repo esnet/pond \
  --title "Successor: pond-ts (TypeScript rewrite by the original author)" \
  --body-file docs/adoption/predecessors/pond-issue.md
gh issue create --repo esnet/react-timeseries-charts \
  --title "Successor: @pond-ts/charts (canvas React charts on pond-ts, by the original author)" \
  --body-file docs/adoption/predecessors/rtc-issue.md

# README PRs (fork → branch → insert notice → PR). Repeat for react-timeseries-charts.
gh repo fork esnet/pond --clone=false
git clone git@github.com:<you>/pond.git /tmp/esnet-pond && cd /tmp/esnet-pond
git checkout -b successor-notice
# paste pond-readme-notice.md after the badges line in README.md
git commit -am "README: point to the maintained successor (pond-ts)"
git push -u origin successor-notice
gh pr create --repo esnet/pond --title "README: point to the maintained successor (pond-ts)" \
  --body "Adds a short notice at the top of the README pointing readers to pond-ts, the TypeScript rewrite of this library by its original author. No other changes. Context: <issue URL>."
```

After posting, record the issue / PR URLs in
[`PND_ADOPTION_PLAN.md`](../../plans/PND_ADOPTION_PLAN.md) under
[PND-PREDECESSORS] so the next re-measure can check whether the notices moved
the download ratio.
