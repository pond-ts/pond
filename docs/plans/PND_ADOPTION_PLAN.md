# PND_ADOPTION_PLAN — driving adoption by coding agents

> Breakout plan for the **Agent adoption** roadmap section in
> [PLAN.md](../../PLAN.md). Tasks: [PND-ADOPTMETA], [PND-ADOPTLINKS],
> [PND-LLMSTXT], [PND-AGENTGUIDE], [PND-SKILL], [PND-CONTEXT7],
> [PND-COLDSTART], [PND-CHOOSE], [PND-ERRLINKS], [PND-PREDECESSORS]. Opened
> 2026-09-12.

Status: in flight — the metadata / guide / skill / llms.txt tranche is the
first PR; the cold-start experiment is the measurement loop that decides what
comes after.

## The thesis

pond is built _by_ agents (see CLAUDE.md, "Multi-agent experiments"), and its
next consumers will mostly be agents too: a Claude / Codex / Gemini session
told "load this CSV of per-host latency, compute a rolling p95 per host, chart
it" in some repo that has never heard of pond. That agent picks a library in
the first thirty seconds, from three inputs:

1. **What it already knows** — training-data prevalence. Not controllable
   short-term, but every public artifact (README, docs, guides) is the corpus
   that eventually shapes it.
2. **What it can find in under a minute** — `npm search`, the package's npm
   page, the GitHub repo card, an `llms.txt`, a docs MCP (Context7 and
   friends). Cheap to fix, and today pond is nearly invisible on every one of
   these channels (baseline below).
3. **What its harness hands it** — a skill / plugin the repo owner installed,
   an `AGENTS.md` / `CLAUDE.md` in the consuming repo, a file it stumbles on in
   `node_modules`. This is the highest-leverage channel: once a skill is
   installed the agent does not have to _find_ pond, it is told about it and
   handed the idioms.

The work below is ordered by leverage per hour: fix the discoverability
metadata (channel 2), ship the agent-facing guide + installable skill (channel
3), then **measure** with a cold-start experiment before building anything
larger. Everything is doc / metadata / tooling — no runtime changes.

## Baseline (measured 2026-09-12)

Numbers to beat. Re-measure after each tranche lands.

| Channel                                | Finding                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm `keywords`                         | **None** on any of the six packages. `homepage` and `bugs` absent too — the npm page has no docs link.                                                 |
| `npm search "time series"`             | `pond-ts` is **20th of 20** results. `npm search "time series typescript"`: not in the top 20.                                                         |
| npm downloads, last 30 days            | core 2 591 · react 2 362 · charts 1 905 · financial 1 926 · fit 1 295 · process 1 086 — consistent with CI + the constellation agents, not organic     |
| GitHub repo card                       | description "Timeseries platform"; 6 topics (`typescript`, `immutable`, `charts`, `financial`, `fitness`, `timeseries-analysis`); 2 stars              |
| `pond-ts.org/llms.txt`                 | Exists (8.9 KB) but is a bare URL list — no per-page description, no package sections, no pointer to API.md or the repo                                |
| `pond-ts.org/llms-full.txt`            | 1.22 MB in one file — too large for most agents' single-fetch budget; no per-package split                                                             |
| Context7 (`context7.com/pond-ts/pond`) | **Not indexed** (404). No `context7.json` in the repo                                                                                                  |
| Tarball contents                       | ✅ `API.md` ships in every package (agent-facing map). ❌ No usage guide for an agent that lands in `node_modules/pond-ts/`                            |
| Package READMEs                        | `@pond-ts/charts` and `@pond-ts/fit` READMEs point at the **dead** `pjm17971.github.io/pond-ts` site and `pjm17971/pond-ts` repo; eight docs pages too |
| Installable agent tooling              | None — no Claude Code plugin/skill, no Cursor rules, no Codex `AGENTS.md` snippet for consumers                                                        |

## Tasks

### [PND-ADOPTMETA] — npm + GitHub discoverability metadata

**Ship:** `keywords`, `homepage`, `bugs` on all six `packages/*/package.json`;
descriptions that carry the search terms an agent types (`time series`,
`rolling window`, `aggregate`, `OHLC`, `streaming`, `typed schema`, `react
charts`, `technical indicators`, `trading calendar`, …). Keyword sets are
per-package (financial gets `technical-analysis`, `rsi`, `macd`, `bollinger`;
charts gets `canvas`, `react`, `candlestick`; core gets the generic set).

**Why it matters:** `npm search` ranks on name + description + keywords; the
registry `keywords` field is also what the npm site's "keywords" chips and
third-party indexes (libraries.io, Socket, npms) key on. Zero keywords is why
pond ranks last for its own category. `homepage` puts the docs one click from
the npm page, which is where an agent that ran `npm view pond-ts` lands.

**GitHub side (owner action — outward-facing, not run by an agent):**

```sh
gh repo edit pond-ts/pond \
  --description "Typed time series for TypeScript: batch + streaming transforms, React canvas charts, financial studies. Built for and by coding agents." \
  --add-topic time-series --add-topic timeseries --add-topic streaming \
  --add-topic react --add-topic canvas --add-topic technical-analysis \
  --add-topic trading --add-topic ohlc --add-topic llms-txt --add-topic ai-agents
```

### [PND-ADOPTLINKS] — fix dead links in shipped READMEs and docs

`packages/charts/README.md`, `packages/fit/README.md` and eight docs pages
(`recipes/error-rate-dashboard`, `how-to-guides/dashboard-guide`,
`how-to-guides/categorical-charts`, `charts/index`, `charts/axes/value-axis`,
`financial/index`, `learn-charts/index`, `pond-ts/transforms/cleaning`) all
point at the pre-migration
`pjm17971.github.io/pond-ts` site or `pjm17971/pond-ts` repo (see
`MIGRATION.md`). The GitHub redirect covers the repo; the Pages URL is dead.
These READMEs are what the npm page renders — a dead docs link on the npm page
is the single worst first impression a package can make on an agent.

### [PND-LLMSTXT] — llms.txt that follows the spec, plus per-section full dumps

**Ship:** rewrite `website/plugins/llms-txt.js` so `llms.txt` is
llmstxt.org-shaped: `# Pond` / blockquote summary / a short "how to use this
site as an agent" paragraph / one `##` section per docs area, each entry
`- [Title](url): one-line description` (title + description read from the
docs plugin's loaded metadata — Docusaurus already extracts an excerpt per
page) / an `## Optional` section carrying the raw-GitHub links to `API.md`,
the agent guide, and `CHANGELOG.md`. Emit `llms-<section>.txt` per top-level
docs area (`pond-ts`, `charts`, `financial`, …) so a single fetch stays in the
tens-to-low-hundreds of KB; keep `llms-full.txt` for the tools that want it.

**Why:** every docs-MCP and agent browser that speaks llms.txt reads the
descriptions to decide which page to fetch; a bare URL list makes it fetch
blind. The 1.2 MB full dump exceeds most tools' per-fetch cap so it is
effectively unreadable today.

**Verification:** the plugin runs only in `postBuild`, so the real check is a
`docusaurus build` and a read of `build/llms.txt`. Keep a pure
`renderIndex(docs)` function so the shaping is unit-testable without a build.

### [PND-AGENTGUIDE] — `AGENTS.md` shipped inside every tarball

**Ship:** `docs/agents/USING_POND.md`, copied by every package's `prepack` to
`AGENTS.md` in the tarball (added to `files`). Audience: an agent that is
working in a repo which depends on pond and has just opened
`node_modules/pond-ts/`. Contents, in order of what the agent needs first:

1. What pond is in three lines and which package to reach for (decision
   table by task shape).
2. The five idioms that cover 80% of use: schema `as const` → `fromJSON` /
   `fromPoints`; `aggregate(Sequence.every(...))` for downsample;
   `align` for regrid; `rolling`; `partitionBy(...).collect()`; `LiveSeries`
   push + `on('event')`.
3. The mistakes agents actually make (from the experiments' friction notes):
   forgetting `as const`, reaching for `Sequence.every('1M')` for months,
   wall-clock strings without `parse.timeZone`, `rolling` vs `aggregate`
   confusion, trying to mutate a series, `column()` for hot loops instead of
   `toRows()`.
4. Where to read next: `API.md` (same folder), `https://pond-ts.org/llms.txt`,
   per-package `llms-*.txt`, the how-to guides.

Not a second API.md — it links there. ~150 lines, written so it survives being
read in one shot with no follow-up fetch.

**Why `AGENTS.md`:** it is the one filename every agent harness (Codex, Cursor,
Claude Code, Gemini CLI) already knows to look for. Claude Code does **not**
auto-read files under `node_modules`, so this channel is for agents that
explore the package — the skill below covers the harness-injected channel.

### [PND-SKILL] — installable Claude Code plugin (skills) hosted in this repo

**Ship:** `.claude-plugin/marketplace.json` at the repo root plus
`plugins/pond-ts/` containing `.claude-plugin/plugin.json` and three skills:

- `pond-ts` — core series: when to use it, idioms, gotchas, links.
- `pond-charts` — `@pond-ts/charts` composition and the data contract per
  layer (the cheat sheet, condensed).
- `pond-financial` — studies + `TradingCalendar`, fluent vs function form.

Install path for a consumer:

```
/plugin marketplace add pond-ts/pond
/plugin install pond-ts@pond-ts
```

Skills auto-trigger off their `description`, so the descriptions are written
as _task_ descriptions ("computing rolling / windowed / bucketed statistics
over timestamped rows in TypeScript"), not library descriptions — the agent
matching a skill to a task never has the word "pond" in its prompt.

**Also:** a `.cursor/rules/pond-ts.mdc` and a Codex-flavoured `AGENTS.md`
snippet under `docs/agents/` for consumers to paste — same content, different
wrapper. Deferred until the Claude skill has been through the cold-start
experiment once; no point maintaining three copies of prose that has not
been tested.

**Why in-repo, not a separate repo:** the skill has to track the API. A skill
in this repo is updated in the same PR that renames an export, and the
`API map` CI check can grow a sibling rule later (`plugins/**` must change when
`API.md` changes a section the skills quote).

### [PND-CONTEXT7] — docs-MCP indexing

**Ship:** `context7.json` at the repo root (`projectTitle`, `description`,
`folders: ["website/docs"]`, `excludeFolders` for `api/` typedoc mirrors and
`gallery/_template.mdx`, `rules` = the top five gotchas so they ride along
with every Context7 snippet). **Owner action:** submit the repo at
context7.com/add-library (or open a PR to the Context7 index). Also check
DeepWiki (`deepwiki.com/pond-ts/pond`) indexes; it usually does automatically
for public repos.

**Why:** Context7 is the most common "look up library docs" MCP wired into
Claude Code / Cursor sessions; an agent that _does_ think of pond and asks
Context7 today gets a Go worker-pool library called Pond instead.

### [PND-PREDECESSORS] — notices on the unmaintained predecessors

pond's two predecessors are still the first thing an agent (or a person) finds
for these problems, because they are what the training data knows: `pondjs`
pulls ~10.5k downloads / month and `react-timeseries-charts` ~6.4k against
pond-ts's ~2.6k (2026-09-12), with no release since 2019, 118 and 126 open
issues, and **no mention of a successor** in either README or any issue.

**Ship:** `docs/adoption/predecessors/` — an issue body and a README notice
block per repo, plus the posting commands. Written in the first person for
Peter, who wrote both libraries at ESnet: the authorship is what makes a
"this is the continuation" notice credible rather than spam, so they must be
posted from his account, not an agent identity. Each states plainly that
pond-ts is not an ESnet project.

**Why both an issue and a README PR:** the maintainers may never merge the PR
(the repos have had no commit since 2019/2020), but an open PR titled
"README: point to the maintained successor" is itself indexed and visible on
the repo's PR tab, and the issue is searchable. Either one gives a reader a
path out.

**Measure:** the download ratio (pondjs+rtc : pond-ts) at each re-measure, and
referrer traffic to pond-ts.org if analytics exist. Record the posted URLs
here.

**Considered, not doing:** asking ESnet to archive or transfer the repos
(their call; the issue asks for a note or an archive, nothing more), and
publishing a `pondjs@next` / deprecation on npm (pond does not own those
package names).

### [PND-COLDSTART] — the cold-start adoption experiment (measurement loop)

The experiment that tells us whether any of the above works. Follows the
repo's experiment discipline (CLAUDE.md): build like you're really building,
three outputs (friction notes, numbers, reference code).

**Design:** N fresh agent sessions (Claude Code; Codex second) each in an
empty repo, given the _same_ realistic task with no mention of pond, e.g.
"Here is `latency.csv` (host, ts, ms, 200k rows). Produce per-host 5-minute
p95 and a rolling 1-hour baseline with ±2σ bands, flag breaches, and render a
chart. TypeScript." Arms:

| Arm | Harness state                                    | Question                                                     |
| --- | ------------------------------------------------ | ------------------------------------------------------------ |
| A   | nothing                                          | Does the agent find pond at all? What does it search for?    |
| B   | `pond-ts` already in `package.json`, no guidance | Does it read `node_modules/pond-ts/AGENTS.md`? Use it right? |
| C   | pond skill installed                             | Does the skill trigger? Does the code it writes compile/run? |
| D   | C + a competitor (arquero / danfo) also in deps  | Does it still pick pond, and why?                            |

**Measure:** did it choose pond (and via which channel), time-to-first-working
pipeline, count of API misuses (against the guide's gotcha list), number of
docs fetches and which URLs, whether the final code would pass review.

**Outputs:** `experiments/cold-start/` for the task, harness notes and per-run
transcript summaries (note `experiments/` is gitignored — scratch by
convention), a **committed** friction note into `docs/notes/`, and the numbers
feed the next revision of the guide + skill descriptions. Re-run after each
tranche; the arm-A number is the one that tells us whether channel 2 is
moving at all.

### [PND-CHOOSE] — "When to use pond" page + task → API index

A docs page written for the library-selection moment: pond vs hand-rolled
arrays, vs arquero / danfo / polars-node for the dataframe shapes, vs
uPlot / Recharts / Observable Plot for the chart side; honest about where each
wins (the benchmarks page already has the numbers). Plus a **task index** —
one line per common job ("downsample to 5m buckets", "fill gaps", "per-entity
rolling stats", "OHLC bars from ticks", "render 1M points") pointing to the
method and the page. Agents match task phrasing; this is the page that
phrases every job the way an agent receives it. Source material:
`docs/notes/agent-workloads-2026-07.md` §3 already writes twelve questions
that way.

### [PND-ERRLINKS] — self-explaining errors (deferred)

Runtime errors an agent hits (`aggregate` spec column not in schema,
`fromJSON` timestamp parse failure, `BarChart` one-of violation) should carry
the fix and a `pond-ts.org` URL. Agents paste the error back into their
context; a URL in it is a docs fetch we did not have to earn. Deferred until
the cold-start experiment shows which errors are actually hit; do not sweep
every `throw` speculatively.

## Deferred / considered

- **Separate `create-pond-app` template.** A template repo is a channel-1
  artifact (training data) more than an agent aid; agents scaffold from
  prose fine. Revisit if arm A of the experiment shows agents asking for a
  starter.
- **An MCP server exposing pond docs.** Context7 + llms.txt cover the
  read-side for free. A pond MCP earns its keep only as the `@pond-ts/process`
  execution surface ([PND_PROCESS_DEMO_PLAN.md](PND_PROCESS_DEMO_PLAN.md)),
  which is a different product than "help agents find the docs".
- **Per-agent bot identities for outreach** (posting in discussions, answering
  issues on competitor repos). Out of scope; adoption should come from the
  library being findable and usable, not from campaigning.

## Outcomes log

_Record decisions + reasoning here as tasks land; remove them from PLAN.md in
the same pass._

- **2026-09-12** — plan opened; baseline measured (table above). First tranche
  landed as [#722](https://github.com/pond-ts/pond/pull/722): [PND-ADOPTMETA]
  (npm side), [PND-ADOPTLINKS], [PND-LLMSTXT], [PND-AGENTGUIDE], [PND-SKILL]
  (Claude plugin only), [PND-CONTEXT7] (config file only). GitHub-topics edit
  and the Context7 submission are owner actions and stay open on the PLAN
  entries until done.
  - **[PND-ADOPTLINKS] shipped.** Two READMEs + eight docs pages. Decision: the
    boundary-safe rewrite (`pjm17971/pond-ts/` with the trailing slash) because
    `pjm17971/pond-ts-dashboard` shares the prefix and a naive sweep
    corrupted those links on the first pass.
  - **[PND-LLMSTXT] shipped.** Descriptions come from `frontMatter.description`
    → the page's first prose paragraph → Docusaurus' excerpt, in that order,
    because the excerpt is the first _line_ only and the introduction page's
    excerpt was an MDX editorial comment. `learn-charts` is its own area so
    the charts dump stays under ~520 KB. The pure shaping is unit-checked by
    `website/scripts/check-llms-txt.mjs`, run in the site's `prebuild` so the
    `docs-build` CI job exercises it. 36 typedoc-mirror pages have no
    description (no prose); adding `description:` front matter is the
    per-page upgrade path.
  - **[PND-AGENTGUIDE] shipped.** Every quoted call was checked against the
    built `.d.ts`; the review caught three more (count windows are
    `{ count: n }`, `byColumn` is numeric binning not group-by, theme line
    colour is `line.default.color`). Lesson recorded: an agent guide must be
    verified against types, not docs prose — API.md itself carried a stale
    `smooth()` row and a wrong `byColumn` gloss.
- **2026-09-12** — [PND-COLDSTART] run 1 complete; see
  [cold-start-adoption-2026-09.md](../notes/cold-start-adoption-2026-09.md).
  Decisions it forced: (1) channel 2 is not measurable by this design — no
  arm searched — so the channel-2 tranche is judged by npm/search-rank
  re-measures, not by cold-start runs; (2) the skill is the highest-leverage
  artifact (2/2, one displacing an incumbent) and gets the maintenance
  investment (the `plugins/**` CI rule); (3) two skill/guide fixes shipped
  from the transcripts (`@latest`, `.d.ts` paths, partition-column
  workaround) and one library task opened ([PND-PARTCOL] in
  PND_CORE_PLAN). Harness committed at `docs/adoption/cold-start/`.
