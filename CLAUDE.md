# pond-ts

TypeScript time series library. Successor to pondjs / react-timeseries-charts.

## Plan

**Read [PLAN.md](PLAN.md) at the start of every session.** It is the single
source of truth for what has shipped, what is next, and the design decisions
behind each phase.

**Update PLAN.md when meaningful work lands.** If you complete a task, add a
feature, fix a bug, or make a design decision that affects upcoming work, update
the relevant section of PLAN.md in the same pass. Move items from "remaining" to
"completed", add new design notes, or adjust phase scope as needed. Do not defer
this — a lost session should not erase the current state of the project.

## Architecture

**Read [ARCHITECTURE.md](ARCHITECTURE.md) when working across the layered
model.** Covers the live/batch/core layering, recurring patterns
(typed-groups, trusted-construction via `static #foo`, factory-based
per-partition state, append-only fan-in), and the decision log of what
we deliberately didn't build.

Update it when you change a layer boundary, add a new class to one of
the layers, or introduce a new recurring pattern.

## API map

**Read [API.md](API.md) to locate any public export quickly.** It maps
every package's export surface (name → purpose → source file) so you
don't crawl `src/` to find the right primitive. Each package's
`src/index.ts` is the authority; when a PR adds, removes, or renames a
public export, update the matching API.md row in that PR.

This is CI-enforced, not honor-system: the `API map` workflow
(`.github/workflows/api-map.yml`) fails any PR that touches a public
export entry point (`packages/*/src/index.ts`, core's
`schema/public.ts`, financial's `fluent.ts`) without also changing
API.md. If an entry-point change genuinely doesn't alter the export
surface (comments, formatting), apply the `api-map-exempt` label to
the PR instead.

## Strategic RFCs

`docs/rfcs/` holds strategic planning notes — multi-section design
documents exploring where pond is going at a horizon longer than any
single PR. **RFCs are NOT commitments.** They are forward-looking
context, and they are also a way to red-team a strategic direction
through the multi-agent review process before any implementation work
commits to it.

The layering between RFCs and PLAN.md:

- **PLAN.md** is the binding source of truth for what is actually
  being built. Items adopted into PLAN are commitments.
- **RFCs** sit above PLAN. They explore a direction (e.g. "where the
  streaming layer should go"), surface the tradeoffs, and let the
  design get red-teamed before code commits to it.
- When work derived from an RFC lands in PLAN.md, the PLAN entry is
  the binding version. The RFC stays as context for why.

This means: do not treat an RFC as a roadmap to march through.
Phases / sections adopted into PLAN are the contract; the rest of
the RFC may evolve or be deferred indefinitely as friction signals
arrive (or fail to arrive). The friction-driven cadence described
under "Multi-agent experiments" below is the tactical loop; RFCs
are the strategic loop above it.

When writing or contributing to an RFC, follow the multi-agent
review pattern worked through by `docs/rfcs/streaming.md`: original
draft, review notes from the relevant library / use-case agents,
amendments by the original author, each section carrying inline
attribution. Don't merge competing rewrites — layer responses as
new sections so the contributor chain stays visible.

## Multi-agent experiments and the feedback model

Pond is being designed and battle-tested through parallel multi-agent
experiments. Different agents (Claude, Codex, Gemini) each build
real(ish) things end-to-end, hit pain wherever it falls, write
friction reports, and the library iterates. The discipline:

- **Build like you're really building.** The agent driving an
  experiment is told "here's the problem, build it" — not "test
  these specific APIs." Pain surfaces where it surfaces. Pre-empting
  where the gold should be ("you're testing the wrong thing")
  short-circuits the discovery process and we lose insight.
- **Pain outside pond is fine.** Agents work around it; we focus on
  the pain we can address. A friction note that says "we had to
  build a side-channel map because gRPC delivers one event per
  callback" is a workaround, not a pond bug. Calibrate.
- **Three outputs per experiment:**
  1. **Friction notes** — library-actionable items. Drive PRs to
     pond-ts (API gaps, doc clarifications, missing primitives).
  2. **Bench / analysis data** — numbers, comparisons, what
     surprised us. Feeds the _honesty_ sections of the eventual
     writeup ("here's what the bench numbers actually mean for your
     architecture").
  3. **Reference implementation** — the working code, which becomes
     the basis of a how-to guide.
- **Each experiment lands as a how-to guide** in
  `website/docs/how-to-guides/`. First-person narrative, grounded in
  real working code, ~400-600 lines of MDX, friction-driven library
  improvements already baked into the version it pins.
  `ingesting-messy-data.mdx` (CSV-cleaner) and `dashboard-guide.mdx`
  (dashboard) are the templates.
- **Active experiments are tracked in PLAN.md** under the "Active
  experiments" section. That section is the canonical roster of who
  is working on what, what each has driven into the library so far,
  and where each track is now.

### Context preservation across sessions

Conversation transcripts live locally at
`~/.claude/projects/-Users-peter-murphy-Code-pond/<uuid>.jsonl` —
they're per-machine, not committed, and don't survive context
compaction within a session.

When a meaningful decision lands (API shape choice, design pivot,
deferred-but-considered alternative, blind-alley walked-back), the
_reasoning_ must end up in a committed artifact so future sessions
can recover it without the transcript:

- **PLAN.md "Shipped:" and "Deferred from this wave" sections** are
  the load-bearing artifact for library-level decisions.
- **Experiment milestone files** (`experiments/<exp>/M*.md`) capture
  per-milestone friction notes and library carry-forwards.
- **PR comment trail** (Layer 2 adversarial review + author response)
  captures per-PR design discussion. Both comments together are the
  durable record.
- **Closed-as-blind-alley PRs** (e.g. PR #92 → #93 redesign) are
  themselves the trail — link the closed PR from the new one's body
  with a one-line "this approach was tried and rejected because…"

If you find yourself reaching for the transcript to recover _why_ we
made a choice and the answer isn't in any committed file, that's a
gap — capture it in the most-relevant of the three artifacts above
in the same session.

### Agent identity in PRs and comments

Multiple agents (Claude pond-ts library, Claude gRPC experiment,
Codex webapp telemetry, etc.) currently operate against the same
GitHub identity. To keep PR timelines readable when several agents
have touched the same thread:

**When commenting on or reviewing a PR**, prefix the comment body
with an identifying header on its own line:

```
> _Posted by the pond-ts library agent (Claude)_

## <comment body>
```

Other examples:

- `> _Posted by the gRPC experiment agent (Claude)_`
- `> _Posted by the webapp telemetry agent (Codex)_`
- `> _Posted by the dashboard agent (Claude)_`

If a comment has a specific role within the review protocol, append
it: `_— adversarial review_`, `_— review response_`,
`_— friction report_`. The role tag matches the section header
conventions already in use (see "PR review (don't self-merge)"
below).

**When committing**, the existing `Co-Authored-By:` trailer
attributes the agent — keep using it.

This convention is honour-system, not enforced — it exists so a
future reader (human or another agent) reading a PR timeline cold
can tell who said what without the conversation transcript. The
same convention should hold across all experiment repos
(`pond-grpc-experiment`, `pond-ts-dashboard`, etc.) — propagate
this section to those repos' CLAUDE.md / AGENTS.md when convenient.

If GitHub-UI-level identity becomes valuable enough to be worth
setting up (e.g. multiple agents converging on the same PR with
different roles, or external readers needing to filter comments by
author), the next step is per-agent bot accounts with `GH_TOKEN`
configured per session, or GitHub Apps with installation tokens.
Both are out of scope until the friction earns the plumbing.

## Monorepo structure

npm workspaces with two packages:

- `packages/core` — the `pond-ts` package (batch + live time series)
- `packages/react` — the `@pond-ts/react` package (React hooks, peer-depends on React)

Root-level config (prettier, gitignore, CLAUDE.md, PLAN.md, README.md) is shared.
Docs site lives at `website/`.

## Stack

- TypeScript (strict)
- Vitest for tests
- Docusaurus for docs
- npm workspaces for packaging

## Commands

From repo root:

- `npm run build` — build all packages
- `npm test` — test all packages
- `npm run verify` — format check + build + test

For a specific package:

- `npm run build --workspace=pond-ts` — build core
- `npm test --workspace=pond-ts` — test core
- `npm run build --workspace=@pond-ts/react` — build react

From within `packages/core/`:

- `npx vitest run` — run all core tests
- `npx vitest run test/<file>` — run a specific test file
- `npx tsc --noEmit` — type check core
- `npx prettier --write .` — format core

## Before opening a PR

Run `npx prettier --write .` before committing. Unformatted code will fail review.

**Add the CHANGELOG entry when the feature lands, not at release time.** Any PR
with a user-facing change (new/changed API, behaviour shift, notable fix) adds
its entry under the **`## [Unreleased]`** section of `CHANGELOG.md` as part of
that PR, grouped `Added` / `Changed` / `Fixed` / `Deprecated`. The release bump
then just _promotes_ `[Unreleased]` to the new version — it does not have to
reconstruct the changelog from `git log`, which is how a landed feature gets
shipped undocumented (e.g. histograms rode into v0.42.0 with no entry because the
release bump only covered the concurrent trading-calendar wave). A feature that
lands without an `[Unreleased]` entry is a feature that ships invisible.

## Storybook stories: systematic feature coverage

Stories must give **systematic coverage of a feature's states — not just a few
reference examples.** For each feature, fan out **one story per meaningful prop,
prop-combination, or mode**, so a reader (and a reviewer walking the stories in
order) sees _every_ knob, not only the handful a use-case demo happens to touch.

Why this earns its keep: `@pond-ts/charts` stories were once organized only by
**scenario** (`InContext` / `Editable` / `Create` / …), which answers "how would
I build X" but **buries individual capabilities** — a knob with no dedicated
story is a knob nobody discovers or reviews. Reorganizing into a **feature-axis
tree** (per-primitive / per-mode groups) with a methodical prop fan-out (charts
PRs #325 → #326) immediately surfaced a dozen-plus real bugs that spot-check
examples had hidden for waves. The systematic walk _is_ a review technique.

Guidelines:

- **Feature-axis, then fan out.** Group stories by the thing (`Annotations/
Baseline`, `Cursors/Crosshair`, `Indicators/Y Axis`), and within each, a story
  per prop/state (`Default`, `CustomLabel`, `NoLabel`, `Indicator`, `Selected`,
  `DualAxis`, …). Name the story for the state it shows.
- **Keep scenario/use-case stories too** — they're the "how would I build X"
  demos _and_ the e2e visual-regression anchors. The fan-out is **additional**,
  not a replacement (park scenario stories under a `.../Scenarios` group).
- **The deeper "explore every knob" walkthrough** belongs in the docs site's
  interactive examples (see `docs/rfcs/` living-examples); Storybook is the
  systematic reference + regression net.

Applies to any package with stories; `@pond-ts/charts` is the worked example.

## Performance check for new operators on large data

When adding a new operator (or making a non-trivial impl change to
an existing one) that walks events, allocates per-event, or has any
cost path that scales with input size, run a performance check
before merging. The goal is to catch quadratic behavior, redundant
scans, and accidental allocation hotspots while the code is still
cheap to fix — and to leave a durable benchmark in the repo so
future regressions surface.

**When this applies:**

- New methods on `TimeSeries`, `LiveSeries`, or `PartitionedTimeSeries`
- Non-trivial impl changes to existing operators that touch event
  loops, bucket scans, or allocation patterns
- New code paths that scale with event count, bucket count, or
  partition count

**When it doesn't:**

- Bug fixes that don't change asymptotic behavior
- Pure type-level changes, documentation, or test additions
- Refactors that preserve the existing algorithm
- Operators that purely delegate to other operators (no new
  walking logic)

**Procedure:**

1. **Write down the complexity.** Before benchmarking, note the
   asymptotic cost in terms of input dimensions (N events, B
   buckets, C columns, etc.). Identify nested loops; distinguish
   amortized from worst-case behavior. This is what catches the
   quadratic bugs you didn't realize you wrote.

2. **Add a benchmark script** at
   `packages/core/scripts/perf-<operator>.mjs` matching the
   convention used by `perf-aggregate.mjs`, `perf-rolling.mjs`,
   etc. — `makeSeries` + `median` + `benchmark` + JSON output,
   importing from compiled `../dist/index.js`. Cover at minimum:
   - Typical workload size (e.g. 100k events on a 1s grid)
   - Per-element overhead floor (~1 event per bucket — surfaces
     per-bucket fixed costs)
   - Sparse source on dense grid (many empty / no-op cases)
   - Partitioned variant if the operator has one

3. **Run the benchmark; identify hotspots.** Common targets:
   per-iteration array allocations, redundant scans, missing
   cursor advances, post-process passes that could be
   short-circuited.

4. **Land optimizations the analysis surfaces.** Re-run the
   benchmark after each change to confirm the win. Don't ship
   optimization claims that aren't measured.

5. **Report before/after in the commit message** as a table.
   The benchmark numbers are the durable record of what the
   change cost — and what future regressions are measured against.

**Worked example:** `feat(materialize)` (PR #81) — analytical
O(N + B·C) analysis up front, `scripts/perf-materialize.mjs`
covering 5 scenarios, two optimizations identified and shipped
(–14% on bare `'first'`, –41% on partitioned variant, –26% on the
full multi-host pipeline), all results pinned in the commit
message.

## `@pond-ts/financial` studies: oracle-verified, one shape

Studies (SMA, RSI, Bollinger, …) are a **vocabulary package** — thin,
uniformly-shaped wrappers over a small kernel, not new math. When
adding one, follow the checklist in
[`packages/financial/src/studies/README.md`](packages/financial/src/studies/README.md).
The load-bearing rules:

- **Uniform shape.** Every study takes `column` (source, default
  `'close'`) + `output` (or a `prefix` for a multi-column family),
  **bar-count** periods, and a **length-preserving** warm-up
  (`undefined` head, row count kept). Compose on the kernel
  (`rollingValues` / `rollingColumns` / `columnValues` / `emaValues`)
  — don't hand-roll event loops.
- **A pandas oracle case is REQUIRED.** No study merges without one:
  add it to `scripts/oracle/generate.py`, regenerate the committed
  fixture, and wire the dispatch in `test/study-oracle.test.ts`. The
  oracle is how we trust the numbers; conventions must match exactly
  (`ddof=0`, `ewm(adjust=False)`, linear `quantile`, …) — see
  `packages/financial/scripts/oracle/README.md`. Named indicators
  (RSI/MACD/ATR) add **TA-Lib** to the oracle and **document any
  definition delta** (bar-for-bar vendor parity is a non-goal).
- **Each study also gets a fluent method** (opt-in
  `@pond-ts/financial/fluent`) so it composes as
  `bars.sma({…}).rsi({…})`.

## PR review (don't self-merge)

A PR author is the same mind that wrote the code — unlikely to catch
their own design errors, scope creep, silent breaking changes, or
"clever" code that would stump the next editor. Every PR of
meaningful size gets a two-layer review before merge.

**Layer 1 — self-review before opening the PR.** After committing,
before `gh pr create`, read the diff cold:

```
git diff main...HEAD
```

Read it as if it showed up on your desk unannounced. Specifically
look for:

- **Scope creep** — changes that don't belong to this PR's title
- **Speculative features** — options, extension points, or
  parameters with only one valid value
- **New vocabulary** that duplicates existing primitives or
  conventions — pond-ts prefers composition of small primitives
- **Test counts** in the PR description that don't match reality
- **"Strictly additive" claims** that aren't actually true (return
  type widenings, behavior shifts in common paths)
- **Names that don't match behavior** — method, option, and column
  names must describe what the code does
- **Sharp edges the PR body glosses over** — document every one you
  know about, even if not fixing
- **API.md row** — if the diff adds, removes, or renames a public
  export, is the matching API.md row updated? (CI enforces this via
  the `API map` workflow, but fix it here rather than on the red X)
- **Perf check** — for any new operator or non-trivial impl change
  that walks events or allocates per-event, did you do the perf
  check (analytical complexity + `scripts/perf-<operator>.mjs` +
  before/after table in the commit message)? See the dedicated
  section above.

Fix obvious issues before opening the PR.

**Layer 2 — adversarial agent review after CI passes, before
merge.** Spawn a fresh code-review agent via the Agent tool with
`subagent_type: 'general-purpose'`. Give it the PR number and ask
for an adversarial read. The agent has no context from the authoring
session — that's the whole point.

The agent posts its findings **directly to the PR as a comment** via
`gh pr comment`. That comment, together with your response comment,
becomes the durable review record attached to the PR.

Example invocation:

```
Agent({
  description: "Adversarial PR review",
  subagent_type: "general-purpose",
  prompt: `Review pond-ts PR #<N> adversarially. Read the diff via
  \`gh pr diff <N>\` and the description via \`gh pr view <N>\`.

  READ-ONLY CONSTRAINT: use only read-only git/gh operations —
  \`gh pr diff\`, \`gh pr view\`, \`gh pr checks\`, \`git show
  <ref>:<path>\`, \`git log <ref>\`. Never run \`git checkout\`,
  \`git switch\`, \`git merge\`, or \`git reset\` — the tree you're
  running in is very likely the user's live primary checkout, not a
  disposable worktree, and checking out a branch into it clobbers
  uncommitted work. If you need a file's content at the PR branch's
  tip, use \`git show origin/<branch>:<path>\`, never a checkout.

  Flag concerns in these categories, in priority order:
  1. **Correctness** — missing edge cases, off-by-one errors,
     silent breaking changes, unhandled undefined values,
     collisions with existing column/method names.
  2. **Design** — over-engineering, scope creep, speculative
     parameters, duplication of existing primitives, inconsistency
     with the rest of the pond-ts API.
  3. **Tests** — claimed behaviors without assertions, missing
     edge cases, tests that don't actually pin the stated guarantee.
  4. **Docs** — mismatch between code behavior and doc prose,
     missing cross-references, examples that wouldn't compile.
  5. **Name quality** — does every method, option, and column
     name match what the code does?

  The PR author wrote an enthusiastic description. Don't trust it
  — verify against the diff. If you see nothing concerning, say so
  explicitly; don't invent concerns to look thorough.

  Keep the review under 300 words. Post it as a PR comment by
  running:

  gh pr comment <N> --body "$(cat <<'EOF'
  ## Adversarial review

  <your findings here, grouped by category>

  **Reviewer confidence:** <high | medium | low> — <one-sentence reason>
  EOF
  )"

  End every review with a one-line confidence statement on its
  own paragraph. Pick honestly:
  - **high** — standard surface, you saw nothing concerning, the
    diff was small or well-isolated, you fully understood every
    change.
  - **medium** — the change touches subtle ground (deep type-system
    work, algorithmic correctness, non-obvious refactors crossing
    multiple files, performance claims you couldn't fully verify
    from the diff alone) and you have residual uncertainty even
    though you found no concrete issues.
  - **low** — the change is genuinely beyond the depth a single
    Layer 2 review can credibly cover.

  When confidence is **medium** or **low**, end the review with an
  explicit recommendation on a separate line:

  > Recommend a Codex adversarial pass before merge — flagging this
  > review as below-high confidence on <specific dimension>.

  The Layer 2 agent cannot initiate a Codex review; only the human
  can. The recommendation is a flag for the human reviewer.

  Do not return the review as text — the PR comment is the
  deliverable.`,
})
```

**Responding to the review.** After the agent's comment lands, read
it and decide each concern on its merits. Fix genuine issues with a
follow-up commit on the same branch. Then post a **second PR
comment** that closes the loop — without it, the review is
unresolved:

```
gh pr comment <N> --body "$(cat <<'EOF'
## Review response

Addressed in <sha>:
- <concern> — <what changed>

Not addressed — rationale:
- <concern> — <why this is intentional / out of scope / already covered>
EOF
)"
```

Argue back only when you genuinely disagree — don't dismiss. The
response comment is the record that every concern was considered,
not just that the agent was run.

**The two comments together are the review record.** Once both
exist and genuine concerns have fix commits, agent-merge is
acceptable for this project — the PR comments are the durable
trail, not a human approval gate.

**When the reviewer can be skipped:**

- **Pure chore PRs** — CHANGELOG additions, workflow bumps,
  dependency updates, formatting, version bumps. Still self-review
  Layer 1, but Layer 2 doesn't earn its cost.
- **User has explicitly approved the exact change in conversation**
  ("yep, ship it"). Even then, prefer a quick agent pass for
  anything that touches type definitions, public method signatures,
  or runtime behavior — the user approved the intent, the agent
  catches the execution.

**When to require human approval:**

- Any PR that widens or narrows an existing public type in a way
  that could break downstream callers
- Any PR that adds or removes a method on `TimeSeries`, `LiveSeries`,
  or the React hook surface
- Any PR touching the release workflow or npm publish path

For these, the agent review is the floor, not the ceiling. Ask the
user before merging.

**When to escalate to a Codex adversarial pass.** The Layer 2 Claude
agent always ends its review with a confidence statement
(`high | medium | low`). When the agent reports **medium or low
confidence**, the standard Layer 2 review has done its part but the
PR earns an additional pass that only the human reviewer can
initiate — running Codex against the same diff. The agent flags
this in its review comment as `Recommend a Codex adversarial pass
before merge`; the human decides.

Categories that typically pull confidence below high:

- **Deep type-system work** — variance issues, conditional types,
  distributive types, complex generic constraints where "this
  compiles" doesn't fully validate "this is the right type-level
  shape."
- **Algorithmic correctness on non-obvious algorithms** —
  monotonic-deque windows, amortized-cost claims, edge cases that
  aren't enumerable from the diff.
- **Non-obvious refactors crossing many files** — the diff is large
  enough that pattern-matching dominates careful reading.
- **Performance claims** — the agent can verify a benchmark was
  run, but not always whether the benchmark tests what it claims.

The agent should not artificially deflate confidence to dodge
responsibility — pick honestly. If you reviewed the diff carefully
and found nothing concerning on a standard surface, **high** is
the right answer.

## Publishing a release

All packages publish together under one `v*` tag via the GitHub Actions
workflow at `.github/workflows/release.yml`. npm publishes use OIDC
Trusted Publisher — no stored tokens, nothing to configure locally.

To cut a release from `main`:

0. **Check that every PR merged since the last tag had a review.**
   `git log v<previous>..main --merges` shows them. Each one should
   either have an agent-review comment on the PR, explicit user
   approval in chat, or be a pure chore (CHANGELOG / workflow /
   deps). If any slipped through unreviewed, open a short follow-up
   to spot-check before releasing.
1. Bump the `version` field in **every** `packages/*/package.json`. Keep
   them lock-step — the release tag covers the whole monorepo.
2. If `@pond-ts/react`'s `dependencies.pond-ts` caret needs to widen to
   the new minor (e.g. `^0.4.0` → `^0.5.0`), update it in the same pass.
3. **Promote the `## [Unreleased]` section** to a new `## [X.Y.Z] — YYYY-MM-DD`
   heading (leaving a fresh empty `## [Unreleased]` above it), and update the
   compare-link footnotes. Entries should already be there — each feature PR
   adds its own as it lands (see "Before opening a PR"). **Still sweep**
   `git log v<previous>..HEAD` for any user-facing change that slipped in without
   an `[Unreleased]` entry and add it now — the promote-not-reconstruct flow is
   the safety net, not a licence to skip the sweep. Group notes under
   `Added` / `Changed` / `Fixed` / `Deprecated`. Consumers upgrading between
   versions rely on this; skipping it compounds every release.
4. Commit with a message like `chore: bump to vX.Y.Z`.
5. Tag the commit: `git tag vX.Y.Z`.
6. Push the branch, then push the tag:
   ```
   git push origin main
   git push origin vX.Y.Z
   ```
   `--follow-tags` only pushes annotated tags; lightweight tags (the
   default with bare `git tag`) need an explicit push.

That's it. The `v*` tag push triggers `.github/workflows/release.yml`,
which checks out the tag, runs `npm run verify`, then
`npm publish --access public --provenance --workspaces` to publish every
workspace package in one pass. Do not run `npm publish` locally.

### Deploying docs without a release

The docs site (`.github/workflows/docs.yml`) publishes only on `v*`
tag pushes by default — the live site reflects the latest npm
version, not in-flight `main`. After merging doc-only changes to
`main` (new guides, fixed examples, recipe additions), push them
live without waiting for the next release:

```
gh workflow run docs.yml --ref main
```

Watch the run with `gh run list --workflow=docs.yml --limit 1`. The
deploy step runs on the same workflow, so once it completes the
new content is live on the GitHub Pages URL. Use this for any
doc-only change that doesn't justify a version bump (the dashboard
guide adapted from `pond-ts-dashboard` is the canonical example).
