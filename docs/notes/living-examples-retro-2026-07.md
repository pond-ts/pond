# Living examples — a design retrospective

_pond-ts docs agent (Claude), 2026-07-03. Retrospect on the RFC #285
(`docs/rfcs/living-examples.md`) design arc: v1 → red-team → v2 → the
per-method visualization appendix. Captured so the **why** survives the
transcript. Not a status report — the reasoning, the instincts, and the dead
ends._

## The seed, and the first instinct

pjm17971 asked for "an MDX plugin that 1) shows the example, 2) tests it really
works, 3) shows the output, maybe as a chart." The instinct that shaped
everything: **do not build one plugin.** The three asks cost wildly differently
and coupling them makes the correctness guarantee hostage to the renderer — a
broken chart component shouldn't be able to take down "does this example still
compile." So the spine of the RFC is a decomposition: **correctness broad and
cheap, presentation narrow and escalating**, three independent layers, each
useful alone. This is just pond's own "composition of small primitives" pointed
at docs tooling.

If there is one transferable lesson here it is that one: **when a request
bundles concerns, split them by cost and blast radius before you design.**

## The load-bearing split: the guarantee vs. the presentation

The sharpest version of that instinct is inside Layer 1 (type-checking). The
_guarantee_ we want — "does this example still compile against the real
`pond-ts` types?" — is cheap and under our control: tangle every fenced block
into a generated file and run `tsc --noEmit` in CI. **Twoslash** bundles that
same guarantee _with_ expensive, risky presentation (Shiki highlighting + inline
resolved-types).

v1 hung the whole "biggest win" on Twoslash. Codex's adversarial pass flagged
the [high]: if the Twoslash spike failed, Layers 2–3 only cover ~20
output-bearing examples, so the primary value claim didn't degrade gracefully.
The fix was to **separate the guarantee from the polish** — lead with
`tangle → tsc` (un-blockable, no Docusaurus coupling), treat Twoslash as the
spike-gated enhancement.

Then the independent docs-infra pass _hardened_ this more than I had: the
`docusaurus-preset-shiki-twoslash` route I'd named is **dead** (abandoned 2023,
monorepo archived, predates Docusaurus 3), Expressive Code is Starlight-only,
and the one working reference proves Shiki _highlighting_, not Twoslash
_type-checking_. So `tangle → tsc` isn't the fallback — **it is the workhorse**,
and the pretty tier is genuinely the fragile, bespoke part (a hand-wired rehype
transformer + a site-wide `MDXComponents` swizzle).

Lesson, twice-earned: **separate the guarantee you can make cheaply from the
polish you can't — the red-team will find exactly where you coupled them.**

## The presentation ladder, and why not charts-by-default

Presentation is `table → bar → line → interactive`, each the cheapest form that
_teaches_. The pushback baked in from the start: **do not default to charts.** A
table is more truthful than a line for most of the surface — for `collapse`,
`reduce`, `materialize`, `join`, the exact rows _are_ the lesson.

The 12-agent survey (Appendix A) confirmed this harder than the prose argued.
Of 118 public methods: **table 47, line 16, interactive 16, none 39, bar 0.**
Two numbers carry weight:

- **`bar` came up zero as any method's _primary_ tier.** The bar case is real
  but rests entirely on one shape — `byColumn`-as-zone-distribution — not a
  family. So bar earns its first-class slot from a single flagship use, and
  budgeting more than one bar example would be over-fitting.
- **39 methods honestly earn no visualization** — a third of the surface is
  I/O, scalar accessors, and boolean predicates that no figure improves. The
  survey's discipline is as much to _stop_ us rendering those as to greenlight
  the rest. **The honest "—" is a deliverable, not a gap.**

## The interactive bet, and the unlock

pjm17971 named the interactive tier the killer feature — "understanding
different windows by playing." The instinct that made it _fit_ the RFC instead
of blowing it up: **build bespoke MDX components (`<WindowExplorer/>`), not
`live` code fences.** The Twoslash-vs-live-blocks conflict is specifically about
react-live processing _fenced code blocks_; a purpose-built component never
touches that pipeline. The thing I'd deferred in v1 as "playground (someday)"
was the _generic editable-code sandbox_; the _purpose-built widget_ is a
different, better animal, and interactivity + repo-wide type-checking coexist.

The correctness invariant keeps it honest: **the widget runs the same
Layer-2-verified code path**, asserted at representative control values, so
"playing" sweeps a pinned operation — it does not reintroduce the untested
surface the whole RFC is fighting. Real pond runs in the browser _by invariant_
(pond-ts is a permanent dual browser+Node target), so this is a guarantee, not a
bundling gamble.

The survey then found the shape of the work: the **windowing idiom recurs** —
`aggregate` (fixed grid), `rolling` (sliding), `align` (resampling), `byColumn`
(value axis), `smooth`, and the live `window`/`rolling` are _one interaction_
(raw series behind, a recomputing line on top, a control you drag). One shared
`<WindowExplorer>` shell amortizes the entire top of the list: **~9 distinct
widgets cover all 16 interactive hits**, and `aggregate` is the archetype that
de-risks the rest.

## The non-obvious hazards the red-team surfaced

- **Determinism is about computed floats, not just clocks (estela).** The
  obvious hazard was `Date.now()`; the real one is that computed floats (NP
  `152.4 W`, haversine sums, `^0.25`) wobble in the last decimal across
  platforms, so asserting raw serialized-float JSON flakes. Rule: round/format
  to _displayed_ precision before asserting, and emit small/bucketed results
  only — never a raw multi-thousand-point series.
- **The honest `undefined` cell is a load-bearing component primitive.** A
  surprising number of high-value table verdicts hinge on rendering missing data
  _visibly_ — `materialize`'s empty buckets, `join`'s outer blanks, `diff`'s
  leading `undefined`. A line chart _swallows_ exactly those rows; the table is
  chosen _because_ it can show the hole. So `<ExampleOutput>` must render missing
  as a deliberate em-dash, never a blank. A concrete component requirement that
  only fell out of surveying the whole surface.

## Scope discipline: agreeing by removing

v1's §8 (the adjacent API-reference problem) said "build the example machinery so
the API-ref can reuse it later." Codex flagged that as a speculative constraint
masquerading as out-of-scope. The right response was to **cut it**, not to make
it an acceptance criterion. pond's anti-speculative-generality ethos: you tighten
scope by _removing_, not by adding options for consumers that don't exist yet.
**A reviewer's "this is scope creep" is usually answered by deletion.**

## Dead ends and walk-backs (the honest record)

- **The RFC's own example drifted in 24 hours.** v1's §5 used
  `<ChartContainer timeRange={…}>`; `timeRange` → `range` was retired in #286 the
  next day, and #286's rename sweep grepped `website/` + `packages/` but not root
  `docs/`. A document _about preventing drift_ drifted, unguarded, within a day.
  It became the RFC's best opening evidence. **Meta-lesson: `docs/` is outside
  every gate** — the prettier gate (#281) and the rename sweeps both stop at
  `website/` + `packages/`, so RFCs and design docs rot silently. (If living
  examples ever generalizes, the `docs/` tree is the unguarded frontier.)
- **`docusaurus-preset-shiki-twoslash` is a dead path** — named in v1/v2,
  verified abandoned. The viable route is the hand-wired
  `@shikijs/rehype` + `@shikijs/twoslash@4` transformer. Don't reach for the
  preset.
- **v1's "one MDX plugin" and "Layer 1 = lowest cost"** — both walked back: to
  the layered decomposition, and to "moderate-but-bounded cost" once the
  fragment-block problem (tutorial blocks reference earlier vars; each is
  type-checked as a unit) and the Prism→Shiki swizzle were priced.
- **The "JSON contract" open decision collapsed** — the charts agent dissolved a
  fake open question: the emitted-output shape _is_ the `TimeSeries` constructor
  input (`{name,schema,rows}` → `new TimeSeries(json)`), symmetric by
  construction. Don't invent an adapter where a round-trip already exists.

## How the shape was actually arrived at — the process, in practice

The RFC's shape is not one mind's; it is the residue of the red-team, and that is
the point. The cadence that worked: **draft → PR as the review venue →
adversarial Codex pass (human-initiated) + role-specific agents (charts /
library / estela / docs-infra), each posting to the PR under an identity header →
layered `## Review —` sections + an Amendments changelog → v2 → the appendix via a
12-agent workflow.** What each layer caught that the others didn't: Codex the
graceful-degradation gap; library the drift incident and the fragment-block cost;
charts the JSON-contract collapse and SSG-safety; estela the missing bar bucket
and float-determinism; docs-infra the dead preset. **The single
highest-leverage move was the independent docs-infra pass** — it corrected a
factual dead-end that no amount of internal iteration would have surfaced.

Two process gotchas worth remembering next time:

- **Workflow results are wrapped.** The workflow's return value lands in the
  output file under `.result` (with `summary`/`logs`/`agents` metadata around it)
  and the completion notification _truncates_ the JSON — extract
  `.result.appendix`, don't parse the top level or trust the inline preview.
- **The shared checkout churns.** Throughout, the human's working tree
  branch-hopped (`feat/scan-operator` → `main` → `feat/value-series` →
  `feat/charts-annotations`) with live uncommitted edits — a `git checkout` even
  aborted on a dirty file. Every commit went through a throwaway worktree off
  `main`; never switch the shared branch out from under a live session.

## Where it stands, and the open thread (2026-07-03)

PR #285 is open, not adopted into PLAN — correct for an RFC (it's context to
red-team, not a commitment). The one decision holding §3 at "v2 with a flagged
gap": **are Twoslash's inline resolved-types worth the bespoke rehype + the
site-wide swizzle, or is `tangle → tsc` + Prism the whole of Layer 1?** Phase 0
(the Docusaurus-3.10 viability spike + the fragment-block census) is the real
first-build gate; the appendix's ranked hero shortlist is the concrete input to
Phase 4a. If this ever ships, the sequence is: `tangle → tsc` first (the
un-blockable win), one page end-to-end to _measure_ the authoring workflow, then
the hero widgets built on the shared `<WindowExplorer>` shell with `aggregate`
first.
