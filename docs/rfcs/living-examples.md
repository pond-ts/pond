# RFC: Living examples — tested, output-rendering code in the docs

> **Status:** draft (**v1**), for red-team. **Not a commitment** (see CLAUDE.md →
> Strategic RFCs). Explores how the docs site makes its code examples
> _trustworthy_ — type-checked against the real API, run-and-asserted where they
> show output, and rendered (as data or a chart) from that verified output.
> Phases adopted into PLAN.md become the contract; the rest is forward-looking.
>
> **Original draft:** the pond-ts docs agent (Claude), prompted by pjm17971
> ("an MDX plugin that 1) shows the example, 2) tests it really works, 3) shows
> the output, maybe as a chart"). The reframe below — _decompose the three asks,
> they have wildly different cost_ — came out of that design exchange; pjm17971
> asked for pushback and this is it.
>
> **Additions (pjm17971, post-draft, folded in):** the output-less examples are
> themselves debt to _fill_, not a sign output isn't wanted (§1, §4, §7); and the
> generated API reference is a related-but-separate quality problem (§8).
>
> **Grounding.** Numbers and facts in this RFC were measured against the repo at
> the time of writing (the `chore/prettier-website` work that surfaced the
> `// →` rot): 422 doc code blocks, charts is canvas-rendered, highlighting is
> Prism, neither `pond-ts` nor `@pond-ts/charts` is a website dependency. Cited
> inline.

## 1. The question, and the bar

The docs carry **422 fenced code blocks** (386 ```ts``` + 36 ```tsx```, measured
across `website/docs`). **None of them are checked against the real `pond-ts`
types** — they're text, highlighted by Prism, never compiled. Where an example
shows its result, it does so as a hand-typed comment:

```ts
ride.byColumn('watts', { width: 25 }, { secs: { from: 'watts', using: 'count' } });
// → [{ start: 0, end: 25, secs: 3 }, { start: 25, end: 50, secs: 0 }, ...]
```

There are **15 such `// →` lines across 6 files** — a hand-maintained,
**untested** expected-output convention. For a library that ships a new operator
most weeks, both of these rot silently: a renamed method or a changed signature
leaves a plausible-looking example that no longer compiles, and a changed reducer
leaves a `// →` that lies.

And **15 is itself debt.** The low count doesn't mean output is rarely wanted — it
means it's rarely _filled in_: many examples compute a value and show nothing,
where showing it would teach (pjm17971). So "living examples" is **two jobs** —
_verify_ the outputs that exist, and _fill in_ the ones that should. The machinery
below does both: every example you add output to becomes tested _and_ rendered,
never hand-typed.

The bar pjm17971 set: examples a reader can **trust** — that **fail loud** when
the API drifts under them, and that **show what an operator does** — _without_
standing up a fragile bespoke runtime that has to be babysat on jet-lagged
evenings. pjm17971's three asks: **(1) show** the example, **(2) test** it really
works, **(3) show the output** (data, or a `@pond-ts/charts` visualization).

## 2. The reframe: correctness is not presentation, and the three asks don't cost the same

The instinct to build "one MDX plugin that does all three" is the thing to push
back on. The three asks decompose into pieces with very different cost and very
different blast radius, and **coupling them produces a monolith** whose
correctness guarantee is hostage to its renderer.

- **Show** — free. Docusaurus already does it.
- **Test it works** splits in two: **(2a) type-checks** against the real API —
  _cheap, mature tooling, catches the dominant rot mode_ — and **(2b) runs and
  asserts the output** — _medium cost, and only meaningful for the subset that
  has output_.
- **Show output** splits in two: **(3a) data** (a table — easy, and often the
  _honest_ rendering) and **(3b) a chart** (client-only, pulls in `@pond-ts/charts`
  as a dependency — real cost, real payoff, but only for examples whose _shape_
  teaches).

This RFC's spine: **three independent layers**, adopt-in-order, each useful
alone. This is just pond's own "composition of small primitives" applied to docs
tooling — the correctness layer must not depend on the rendering layer.

## 3. Layer 1 — type-check every block (Twoslash). Biggest win, lowest cost.

For a library whose **types are the product** (the schema-narrowing
`TimeSeries<S>` work), the dominant way an example goes wrong is **type drift**:
a method renamed, a signature widened, an option removed. That is exactly what a
build-time type-check catches, for all 422 blocks, with mature off-the-shelf
tooling: **Twoslash** (`@shikijs/twoslash`) runs the TS language service over each
code block; a type error **fails the build**. It's what the TypeScript website,
Astro/Starlight, and Vue docs use.

Two payoffs:

- **Drift fails loud.** Once Twoslash is on, an example that no longer compiles
  breaks CI — the rot becomes impossible to merge instead of impossible to see.
- **Inferred types become teaching.** Twoslash renders inferred types inline
  (hover/annotation). For pond, that means an example can _show the reader the
  narrowed schema_ that `aggregate(...)` or `byValue(...)` produces — the types
  are a feature, so surfacing them is pedagogy, not noise.

**Grounded costs / risks — this is not drop-in:**

- **It swaps the highlighter.** Today highlighting is **Prism**
  (`prism-react-renderer`, `prismThemes.github`, light-only — `colorMode` switch
  is disabled). Twoslash is Shiki-based, so adopting it replaces Prism site-wide;
  the syntax theme will change and must be re-matched. Light-only makes this
  simpler (one theme to match).
- **The Docusaurus preset is all-or-nothing per block.**
  `docusaurus-preset-shiki-twoslash` processes _every_ code block and is
  **incompatible with Docusaurus live (`react-live`) blocks**. We're not using
  live blocks (§7 Phase 4), so this is tolerable, but it forecloses the
  trivial-playground path and means non-TS blocks need an explicit opt-out.
- **`pond-ts` / `@pond-ts/charts` types must be reachable by Twoslash's compiler
  vfs — and neither is a website dependency today** (website deps are just
  `@docusaurus/*` + `@mdx-js/react`; typedoc reaches the source via relative
  paths, not `node_modules`). Twoslash type-checks in a virtual TS project, so
  the example `import { TimeSeries } from 'pond-ts'` has to _resolve_. That means
  adding `pond-ts` (and later `@pond-ts/charts`) to the site as a workspace/file
  dependency, or configuring Twoslash's compiler options to point at the source.
- **Docusaurus 3.10 specifically.** The preset predates Docusaurus 3's MDX
  pipeline rewrite; community usage exists but compatibility on 3.10 is the open
  question. **De-risk with a one-page spike before betting on it (§7 Phase 0).**

**Lean: Layer 1 is the first thing to build, and most of its value lands the
moment it's on.** It's also the most agent-friendly slice — flip it on, and the
build tells the agent exactly which examples to fix.

## 4. Layer 2 — run-and-assert the subset (reuse vitest; do not build a sandbox)

Type-checking proves an example _compiles_; it does not prove `byColumn` actually
returns `secs: 3`. For the examples that show output, we want "runs and produces
exactly what's shown." The **seductive-wrong** way is a remark plugin that
`eval`s code during `docusaurus build`: you'd own a new execution path and error
model, and a broken example would fail the _docs build_ instead of surfacing as a
normal test failure. Don't.

The repo already has the execution substrate: **vitest**, and `@pond-ts/charts`
already separates `test:type` (tsc) from `test:runtime` (vitest) — precedent for
exactly this split. Two ways to wire the output-bearing examples into it:

- **(a) Tangle inline blocks → generated tests.** Author the example inline in
  the MDX; a remark plugin extracts tagged blocks into generated `*.test.ts`,
  vitest runs them, the `// →` becomes a real `expect`, and the run emits the
  output as JSON. _Most fluid to author._ But: it's **cross-tree codegen** — docs
  live in `website/`, but the generated tests need `pond-ts`, which lives in
  `packages/` — and **`website` is not part of the npm workspace** (workspaces =
  `packages/{core,react,charts}`), so the execution context is awkward.
- **(b) Extracted tested snippet files (single source of truth).** The
  output-bearing examples (today ~15 carry `// →`; many more _should_, per §1 —
  though still not all 422) live as real
  `.ts` files in a test location where `pond-ts` _is_ a sibling; the test asserts
  and emits the output JSON; the doc **embeds the file's source verbatim** via a
  small remark "include-by-region" plugin. _Less fluid_ (the code isn't typed
  directly into the MDX) but the file is the **single source of truth**, it
  **can't drift**, and it sidesteps the not-a-workspace problem entirely.

**Lean: (b) for the output subset, Layer 1 (Twoslash) for everything else —
different mechanisms chosen by scale.** The ~400 illustrative blocks get
correctness from inline Twoslash (no indirection, no codegen); the ~20
output-bearing ones get full run-and-assert from extracted tested files (where
robustness beats authoring fluidity and the small N makes the indirection
affordable). The `// →` convention is then either _replaced_ by emitted output or
_promoted_ to a real assertion — never hand-maintained again.

## 5. Layer 3 — presentation, fed by verified output. Table by default; charts where shape teaches.

**Grounded chart facts.** `@pond-ts/charts` is a **React, canvas-rendered (with an
SVG overlay)** component library (`Canvas.tsx` / `Layers.tsx`; tests need a
`canvas-mock.ts`), it touches `window`/`document`/`ResizeObserver`, it is
`private: true` (**unpublished** — consumed via the local workspace build, not
npm), and its React peer is `^18 || ^19` (**compatible** with the site's React
19). The compositional API is RTC-shaped and consumes a `TimeSeries`/`ValueSeries`
directly (from `LineChart.stories.tsx`):

```tsx
<ChartContainer timeRange={[BASE, BASE + (N - 1) * STEP]} width={480}>
  <ChartRow height={200}>
    <Layers>
      <LineChart series={series} column="v" />
    </Layers>
  </ChartRow>
</ChartContainer>
```

Canvas means **you cannot bake a static chart at build time** (no DOM). So the
architecture is forced and clean: **compute the output at test time (Layer 2) →
serialize the resulting rows to JSON → embed it → render client-side.** One
component, two render targets:

- **`<ExampleOutput as="table">` — the default.** Renders the emitted rows. This
  is the _honest_ rendering for most transforms: for `collapse`, `reduce`,
  `select`, `byColumn`, you want to see the **exact values**, not a smoothed line.
- **`<ExampleOutput as="chart">` — the visual operators only.** `align`,
  `rolling`, `smooth`, `aggregate` — where the **shape** is the lesson. Renders
  the real chart components from the emitted data, wrapped in Docusaurus
  **`<BrowserOnly>`** (the site is statically rendered; a canvas component crashes
  SSR otherwise). The existing **Storybook** stories and `sf-temperatures.fixture.ts`
  are the working template — same components, same deterministic-data idiom.

**Pushback, stated plainly: do not default to charts.** A three-row table is more
truthful than a line for most of the transform surface. Charts earn their place
on the handful of operators whose output you can't read from a table.

## 6. Determinism — the hazard, grounded

Output-bearing examples must be **reproducible**, or the emitted JSON churns every
build and assertions flake. The repo is mostly already there: **11 examples use
`Date.parse(...)` fixed timestamps**, and the charts stories standardize on a
fixed base (`Date.UTC(2026, 0, 1, 12, 0, 0)` + a fixed step). But **13 uses of
`Date.now()` / `Math.random()` / bare `new Date()`** exist in the docs — the
live-streaming examples (`intro`, `creating`, `series`, the dashboard guide),
which legitimately model wall-clock ingest.

Rule for Layers 2–3: an output-bearing example must use **fixed timestamps /
seeds** (adopt the stories' `Date.UTC` idiom). Live examples either run under
vitest **fake timers** (`vi.setSystemTime`) or are **Layer-1-only** (type-checked,
no asserted output) — which is fine, since "watch it stream" isn't a
static-output example anyway. This is a discipline pond already preaches (the
deterministic data-clock).

## 7. The honest tension, and the staged path

The genuine counter: **422 blocks is a lot**, full run+render for all of them is
over-investment, and a bespoke tangle/plugin is maintenance the project carries on
evenings. The resolution is the §2 split made concrete: **type-check broad and
cheap; run-and-render narrow and where it teaches.**

- **Phase 0 — de-risk spike.** Stand up Twoslash on Docusaurus **3.10**
  specifically, on one page: confirm the Shiki swap, the `pond-ts`-types-in-the-vfs
  wiring, and the build-fails-on-error behavior. **Go/no-go on Layer 1.** Cheap,
  high signal.
- **Phase 1 — Twoslash on, repo-wide.** Whatever breaks is _existing rot_,
  surfaced for free; fix it; thereafter drift fails CI. Biggest ROI, mostly
  mechanical — a good agent task.
- **Phase 2 — one page end-to-end.** `aggregation.mdx` is ideal (real `// →`,
  output that is both tabular and chartable): extracted tested snippet (4b) +
  `<ExampleOutput as="table">`. Prove the mechanism before generalizing.
- **Phase 3 — roll out output** across the value-producing examples — _verifying_
  the ones that have `// →` and _filling in_ the debt (§1) — and add
  `as="chart"` to the visual operators (`align` / `rolling` / `smooth` /
  `aggregate`). This is where `@pond-ts/charts` becomes a website dependency.
- **Phase 4 — (deferred) interactive playground.** `react-live` / Sandpack, only
  if a real "let me edit and re-run" need appears. Note it **conflicts with the
  all-blocks Twoslash preset** (§3) and must resolve that first.

**Lean: Phases 0–1 are the commitment-worthy core** (kill type-drift across the
whole surface); 2–3 are friction-gated (do the curated examples that teach); 4 is
a someday-maybe.

## 8. The adjacent problem: the generated API reference

pjm17971's second point lands on a _different_ surface — the typedoc-generated
`/api` reference (`typedoc.core.json` → `static/generated-api`), not the authored
prose docs. The complaints are specific and fair: it isn't **class-centric** (the
main classes should be the spine, with adjacent types linked or inlined, not a
flat type dump); the **style clashes** with the hand-written site; **doc-comment
examples render badly**; and the **signatures are often unintelligible** — pond's
heavy generic/conditional machinery (see [column-api.md](column-api.md),
[columnar-core.md](columnar-core.md)) renders raw as walls of nested conditionals.

Most of this is **its own body of work** — typedoc theming/config, type-legibility,
class-centric organization — and folding it into living-examples would be exactly
the scope creep this RFC's discipline warns against. But two **intersections** are
worth naming so the work isn't duplicated:

- **Twoslash attacks "unintelligible signatures" from the other end.** The raw
  generic declaration is unreadable; the _inferred type at a call site_
  (`const out: TimeSeries<[…]>`) is legible. The same Layer-1 tooling that
  type-checks prose examples can _surface the resolved type_ where the declaration
  can't be read — a partial cure, at least in the prose docs.
- **Example rendering should be shared.** `@example` blocks in the API ref have
  the same show / test / render need as prose examples. Build `<ExampleOutput>` +
  the tested-snippet machinery so the API ref can consume it later — not two
  example systems.

The strategic question underneath — **invest in typedoc legibility vs. lean
harder on hand-written, example-driven reference pages** (which living-examples
makes trustworthy) — is real but **out of scope here**, and likely earns its own
RFC. _"Better than nothing" is the honest current state; this RFC won't fix it,
but it must leave the example machinery reusable by whatever does._ _[pjm17971;
future api-reference RFC]_

## 9. Non-goals · open decisions

**Non-goals.** Not a live in-browser playground (Phase 4, deferred; conflicts with
the Twoslash preset). Not executing all 422 blocks (type-check is the broad net;
run-and-assert is the curated subset). Not baking static charts at build time
(canvas is client-only). Not a bespoke `docusaurus build`-time eval sandbox (reuse
vitest). Not fixing the generated API reference here (§8 — likely its own RFC).
Not a commitment.

**Open decisions (for the red-team).**

- **Tangle inline (4a) vs extracted tested files (4b)** for the output subset.
  Lean **(b)** — single source of truth, sidesteps not-a-workspace. _[library /
  website]_
- **How `pond-ts` types reach Twoslash's vfs** — website workspace/file
  dependency vs Twoslash compiler-options pointing at source. _[website /
  library]_
- **Does `@pond-ts/charts` become a real website dependency now,** given it's
  `private: true` / unpublished (consume the workspace build)? _[charts /
  pjm17971]_
- **The emitted-output JSON contract + `<ExampleOutput>` API** — what shape a
  serialized `TimeSeries`/`ValueSeries`/record-array takes, and how `as="table"`
  vs `as="chart"` consume it. _[website / charts]_
- **Which operators are "visual enough" for `as="chart"`** vs honest-as-a-table.
  Lean: `align` / `rolling` / `smooth` / `aggregate`; everything else table.
  _[estela / charts use-case]_
- **Shiki theme** to re-match the current Prism `github` look (light-only).
  _[pjm17971 / design]_
- **Docusaurus 3.10 × Twoslash viability** — the Phase 0 gate; if the preset
  fights 3.10, the fallback is a rehype `@shikijs/twoslash` transformer wired into
  `markdown.rehypePlugins`. _[website]_
- **Output-debt scope** — how aggressively to fill output into currently-bare
  examples, and in what order (the visual/teaching ones first?). _[pjm17971 /
  use-case]_
- **API-reference direction** (§8) — invest in typedoc legibility vs. lean on
  hand-written example-driven reference; deferred to its own RFC. _[pjm17971]_

---

## Review — charts agent (@pond-ts/charts) _[to fill]_

_Questions for this reviewer:_ does the **compute → serialize → `<BrowserOnly>`
client-render** path hold for canvas charts inside Docusaurus's SSG? What's the
right **serialized-data → chart** ergonomics (feed a JSON row array back through
`new TimeSeries(...)` client-side, or a lighter adapter)? Can the docs **reuse the
Storybook stories / fixtures** rather than reinventing example data? Any SSR
landmines beyond `window`/`ResizeObserver`?

## Review — website / docs-infra _[to fill]_

_Questions:_ Twoslash on Docusaurus **3.10** — preset vs rehype-transformer; the
Prism→Shiki swap blast radius; the remark **include-by-region** plugin for (4b);
and the cleanest way to make `pond-ts` resolvable in the type-check vfs given
`website` is outside the npm workspace.

## Review — estela agent (use-case) _[to fill]_

_Questions:_ for the value-axis / splits output (see [value-axis.md](value-axis.md)),
is the teaching rendering a **table** (exact split rows) or a **chart** (the
profile)? Which activity-data examples are inherently non-deterministic and should
stay Layer-1-only?

## Review — Codex (adversarial) _[to fill]_

## Review — core / library _[to fill]_
