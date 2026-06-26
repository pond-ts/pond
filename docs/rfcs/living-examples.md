# RFC: Living examples — tested, output-rendering code in the docs

> **Status:** draft (**v2**), red-teamed. **Not a commitment** (see CLAUDE.md →
> Strategic RFCs). Explores how the docs site makes its code examples
> _trustworthy_ — type-checked against the real API, run-and-asserted where they
> show output, rendered (table / bar / line) from that verified output, and — for
> a hero few — made **interactive**. Phases adopted into PLAN.md become the
> contract; the rest is forward-looking.
>
> **Original draft:** the pond-ts docs agent (Claude), prompted by pjm17971
> ("an MDX plugin that 1) shows the example, 2) tests it really works, 3) shows
> the output, maybe as a chart"). The reframe — _decompose the three asks, they
> cost wildly differently_ — came out of that exchange; pjm17971 asked for
> pushback and this is it.
>
> **Revision note (v1 → v2).** Four reviews landed on PR #285 (Codex, library,
> charts, estela) and converged on: (a) **split Layer 1's guarantee from its
> presentation** — the compile-check floor (`tangle → tsc`) is un-blockable;
> Twoslash's Shiki highlighting + inline types are the spike-gated enhancement
> (Codex [high]); (b) **bar is a missing first-class render target** (estela); (c)
> **pull the interactive tier _up_** from deferred-someday to the headline bet
> (pjm17971 — "the killer feature"); (d) determinism must round computed floats,
> not just fix clocks (estela). The v1 → v2 changelog is in **Amendments**.
>
> **Grounding.** Numbers/facts measured against the repo: 422 doc code blocks,
> charts is canvas-rendered, highlighting is Prism, and `pond-ts` is a permanent
> dual **browser + Node** target (pjm17971) — which is what makes the interactive
> tier viable by construction. Cited inline.

## 1. The question, and the bar

The most persuasive evidence for this RFC is the RFC itself. v1's §5 chart example
used `<ChartContainer timeRange={…}>`. **`timeRange` was retired → `range` in #286,
merged the day after v1 was written — and #286's rename sweep grepped `website/` +
`packages/` but not root `docs/`, so this very document silently went stale within
24 hours,** caught only by two human-attentive reviewers. That is _exactly_ the
failure mode below: plausible-looking code that no longer matches the API, that a
careful sweep misses. If a doc _about preventing drift_ drifts in a day, the prose
docs — 422 examples, none machine-checked — are worse off than they look.

The docs carry **422 fenced code blocks** (386 ```ts``` + 36 ```tsx```, across
`website/docs`). **None are checked against the real `pond-ts` types** — they're
text, highlighted by Prism, never compiled. Where an example shows its result, it
does so as a hand-typed comment:

```ts
ride.byColumn('watts', { width: 25 }, { secs: { from: 'watts', using: 'count' } });
// → [{ start: 0, end: 25, secs: 3 }, { start: 25, end: 50, secs: 0 }, ...]
```

There are **15 such `// →` lines across 6 files** — a hand-maintained,
**untested** expected-output convention that rots the same silent way.

And **15 is itself debt.** The low count doesn't mean output is rarely wanted — it
means it's rarely _filled in_: many examples compute a value and show nothing,
where showing it would teach (pjm17971). So "living examples" is **two jobs** —
_verify_ the outputs that exist, and _fill in_ the ones that should. The machinery
below does both: every example you add output to becomes tested _and_ rendered,
never hand-typed.

The bar pjm17971 set: examples a reader can **trust** — that **fail loud** when
the API drifts, **show what an operator does**, and for a hero few let the reader
**play with it** — _without_ a fragile bespoke runtime babysat on jet-lagged
evenings. Three asks: **(1) show**, **(2) test it works**, **(3) show the output**
(data, chart, or interactive).

## 2. The reframe: correctness is not presentation, and the asks don't cost the same

The instinct to build "one MDX plugin that does all three" is the thing to push
back on. The asks decompose into pieces with very different cost and blast radius,
and **coupling them produces a monolith** whose correctness guarantee is hostage to
its renderer.

- **Show** — free. Docusaurus already does it.
- **Test it works** splits: **(2a) type-check** against the real API — _cheap,
  catches the dominant rot mode (drift)_ — and **(2b) run and assert the output** —
  _medium cost, only for the subset that has output_.
- **Show output** is an **escalation ladder**, not one thing: **data table**
  (cheapest, default) → **bar / line** (static chart, the visual operators) →
  **interactive widget** (the hero tier — most expensive, most curated).

The spine: **correctness broad and cheap, presentation narrow and escalating.**
This is pond's own "composition of small primitives" applied to docs tooling — the
correctness layer must never depend on the renderer. The rest of the RFC walks the
ladder:

| Tier | Mechanism | Coverage |
| --- | --- | --- |
| type-check (§3) | `tangle → tsc`, optionally Twoslash | **all 422** |
| run + assert (§4) | extracted tested snippets, vitest | output subset |
| static render (§5) | `<ExampleOutput as="table\|bar\|line">` | visual subset |
| interactive (§6) | bespoke explorable widgets, live pond | **hero few** |

## 3. Layer 1 — type-check every block. The guarantee, and its presentation.

For a library whose **types are the product** (the schema-narrowing
`TimeSeries<S>` work), the dominant way an example goes wrong is **type drift** — a
method renamed, a signature widened, an option removed (the §1 incident, exactly).
A build-time type-check catches it for all 422 blocks and **fails CI**. estela's
review is the consumer's-eye confirmation: their `pond-friction.md` is full of
"RESOLVED in 0.29 / 0.30" renames they tracked by hand against prose examples that
had silently gone stale — "a type-checked example that fails CI on drift is the
single thing that would have saved us the most reading-time tax."

**The key v2 correction (Codex [high]): separate the _guarantee_ from the
_presentation_.** v1 hung the whole "biggest win" on Twoslash, which rides an
unproven Docusaurus-3.10 integration — so if the spike failed, the headline value
collapsed. It needn't. The guarantee and the pretty layer are separable:

- **The guarantee — `tangle → tsc`, un-blockable.** Extract every ```ts``` block
  into a generated `.ts` file and run `tsc --noEmit` against the real `pond-ts`
  types in CI. This is "fails on drift across all 422" with **zero Docusaurus
  coupling, no Shiki swap, no preset** — pure tooling under our control. It loses
  only the inline-type rendering and Shiki highlighting.
- **The presentation — Twoslash, spike-gated.** `@shikijs/twoslash` adds VS-Code-
  quality highlighting **and** inline _resolved_ types (what the TypeScript, Astro/
  Starlight, and Vue docs use). This is the part that depends on Phase 0.

So **the win does not depend on the spike**: Phase 1 ships `tangle → tsc` (robust);
Twoslash layers on _if_ Phase 0 says go. The "biggest win" stops being hostage.

**Inline types are opt-in, not automatic (library).** §8 concedes pond's generics
render as "walls of nested conditionals"; auto-surfacing a monstrous
`TimeSeries<[…]>` on every block would reproduce that unintelligibility in the
prose docs. So type-surfacing is **surgical** — Twoslash's `// ^?` query on the
examples where the narrowed type _teaches_ — never blanket.

**Cost — reframed "biggest win, moderate-but-bounded cost" (library).** Not the
"lowest cost" v1 claimed; there are four real risks: the Prism → Shiki swap
(site-wide; mitigated by the light-only theme), Docusaurus-3.10 viability (Phase 0),
the types-in-vfs wiring (§5's "one resolution problem"), and — the unmeasured one —
**fragment blocks.** Tutorial MDX routinely references vars from earlier blocks;
both `tangle → tsc` and Twoslash check each block as a unit, so non-self-contained
blocks need per-block `// ---cut---` setup or `@noErrors` escapes — judgment-heavy,
and a risk of turning teaching examples into compiler-appeasing noise. **Phase 0
must census the non-self-contained blocks** — that count, not 422, is the real
sizing of Phase 1.

**Lean: the `tangle → tsc` correctness floor is the un-blockable, commitment-worthy
core; Twoslash is the enhancement on top, gated by Phase 0.**

## 4. Layer 2 — run-and-assert the subset (reuse vitest; do not build a sandbox)

Type-checking proves an example _compiles_; it does not prove `byColumn` returns
`secs: 3`. For examples that show output we want "runs and produces exactly what's
shown." The **seductive-wrong** way is a remark plugin that `eval`s code during
`docusaurus build` — a new execution path whose failures break the _docs build_
instead of surfacing as a test failure. Don't. The repo already has the substrate:
**vitest** (and `@pond-ts/charts` already splits `test:type` from `test:runtime` —
precedent). Two wirings:

- **(a) Tangle inline blocks → generated tests.** Most fluid to author, but
  **cross-tree codegen** — docs live in `website/`, tests need `pond-ts` in
  `packages/`, and **`website` is outside the npm workspace** — so the execution
  context is awkward.
- **(b) Extracted tested snippet files (single source of truth).** The
  output-bearing examples live as real `.ts` files where `pond-ts` _is_ a sibling;
  the test asserts and emits output JSON; the doc **embeds the source verbatim**
  via an include-by-region plugin. Less fluid, but the file **can't drift from its
  assertion** and it sidesteps not-a-workspace.

**Lean: (b) for the output subset; Layer 1 for everything else — different
mechanisms by scale.** Two honest caveats the red-team sharpened:

- **(b) fixes code-vs-assertion drift, not prose drift (Codex).** The tested file
  can't lie about its own output, but the surrounding MDX can still _describe_
  different behavior, include the wrong region, or carry a stale narrative.
  "Small N makes the indirection affordable" is _asserted, not measured_ — so
  **Phase 2 measures the author workflow and its failure modes**, it doesn't assume
  them away.
- **Check off-the-shelf before bespoke (library + Codex).** `remark-code-import`
  (and kin) already do file → doc inclusion with region selection; the RFC must not
  build the bespoke include glue it warns against without first trying these. Same
  for the Twoslash vehicle — evaluate **Expressive Code** (Starlight's highlighter,
  has a Twoslash plugin) against the bare Docusaurus preset in Phase 0.

## 5. Layer 3 (static) — render verified output. Table default; **table / bar / line**.

**Grounded chart facts.** `@pond-ts/charts` is **React, canvas-rendered (SVG
overlay)**, `private: true` (**unpublished** — consumed via the workspace build),
React peer `^18 || ^19` (compatible with the site's React 19). Its compositional
API consumes a `TimeSeries`/`ValueSeries` directly:

```tsx
<ChartContainer range={[BASE, BASE + (N - 1) * STEP]} width={480}>
  <ChartRow height={200}>
    <Layers>
      <LineChart series={series} column="v" />
    </Layers>
  </ChartRow>
</ChartContainer>
```

(`range`, not v1's `timeRange` — §1.) Canvas means **no static build-time bake**
(no DOM), so the path is: **compute at test time (Layer 2) → serialize → render
client-side.**

**The render targets are three, not two (estela).** estela's actual operator →
rendering map sorts into three buckets, and v1's table-vs-chart binary dropped one:

| `as=` | Operators | Why |
| --- | --- | --- |
| **`table`** (default) | `byColumn`/splits, `bestEfforts`, `collapse`/`select`/`reduce`, conversions | read the exact rows (`{start,end,secs:3}`) |
| **`line`** | `rolling`/`rollingByColumn`, `smooth`, `align`, `aggregate`, profiles, power curve | the curve _is_ the lesson |
| **`bar`** | **zone distributions** (time-in-band), splits-comparison | categorical proportion — neither a values table nor a line |

**Bar is the miss, and it matters:** zone distribution (`byColumn` over a value
axis summing time-in-band) is a flagship pond use case — it's in `byColumn`'s own
JSDoc — and its honest rendering is a labeled bar, which `BarChart` already ships.
So `<ExampleOutput as="table | bar | line">`. (Direct answer to v1's open question:
splits teach as a **table** — the exact per-split rows; the bar view is a UX aid,
not the operator's lesson.)

**The JSON contract is resolved — it's the `TimeSeries` constructor shape
(charts).** No bespoke adapter: Layer 2 emits `{ name, schema, rows }` (exactly the
constructor input); the client does `new TimeSeries(json)` → `<LineChart
series={ts}>`. Serialize/deserialize symmetric by construction. **Library
carry-forward:** confirm `TimeSeries` exposes a stable `toJSON()` → `{name, schema,
rows}` (`LiveSeries` already has one); add if missing — small. Record-array outputs
(`byColumn` → `{start,end,…}[]`) need none of this — raw JSON → `as="table"`.

**Rendering is less ceremony than v1 feared (charts).** The chart import is
**SSG-safe** — the only `window` access is guarded, `getContext('2d')` runs in the
client render effect, no module-top-level DOM — so `<BrowserOnly>` is needed only
so the canvas _draws_ client-side (reserve the box in `fallback` to avoid layout
shift). **Reuse fixtures, not stories:** `sf-temperatures.fixture.ts` + the
`Date.UTC(2026,0,1,…)` idiom are Layer 2's determinism need and import as siblings
under (4b); `.stories.tsx` are Storybook CSF, not droppable into MDX — re-author
the JSX, share the _data_. **Division of labor (scopes the work down):** charts'
own e2e baselines verify components _render_; Layer 2 verifies the example's
_data_; **docs compose verified-components + verified-data and pixel-assert
neither.**

**Pushback, still: do not default to charts.** A three-row table is more truthful
than a line for most of the surface.

## 6. The hero tier — interactive explorable examples

_pjm17971's call, and the strongest bet in v2._ The static ladder renders a
_result_; the highest-value examples let the reader **manipulate the operation and
watch it recompute** — drag a window from 5m to 15m and see `aggregate`'s buckets
redraw; toggle `align`'s method and watch the grid snap. Time-series operators are
inherently spatial, so this is the genre they're _made_ for — **explorable
explanations** (the Victor / Ciechanowski / Nicky Case lineage), a pattern with
outsized teaching return. "Understanding different windows by playing" is the kind
of thing that's worth the investment many times over — _for the operators where
playing is the only thing that teaches._

Three things make this fit the RFC instead of blowing it up:

- **It runs _real_ pond in the browser, by invariant.** pond-ts is a permanent dual
  **browser + Node** target (pjm17971), so "compute live in the reader's browser" is
  a guarantee, not a bundling gamble. The reader sees an actual `aggregate`
  recompute, not a faked animation.
- **It's a bespoke component, not a `live` code fence — so it does _not_ conflict
  with Twoslash.** The Twoslash-vs-live-blocks problem (§3) is specifically about
  react-live processing _fenced code blocks_. A purpose-built `<WindowExplorer/>` is
  an MDX component; it never touches the code-block pipeline. So interactivity and
  repo-wide type-checking **coexist** — the conflict that deferred "playgrounds" in
  v1 simply doesn't apply to widgets. (This is the unlock: the thing I deferred was
  the _generic editable-code sandbox_; the _purpose-built widget_ is a different,
  better animal.)
- **Interactivity sweeps a _verified_ code path.** The widget's pond call is the
  same extracted tested snippet Layer 2 asserts (at representative control values).
  "Playing" moves a bounded control across that verified operation; it does not
  reintroduce the untested surface the RFC fights.

**The discipline: this is the most expensive tier, so it is the most curated.** Each
widget is a small bespoke app (control state → live pond → chart). Bespoke is
_justified here_ — you cannot buy an interactive aggregation explainer — in a way it
is _not_ for the include plumbing (§4), where off-the-shelf exists. So a **handful
of hero operators** (windowing, aggregation, rolling, alignment), not every example.
The cost ceiling is what keeps "worth it ×100" true: it's true _because_ it's
rationed to where nothing else teaches as well.

Determinism is _easier_ here: the widget recomputes live, so there's no serialized
output to churn (the §7 float rule governs the _asserted static_ outputs, not the
live render); its input is a fixed fixture, its control bounded.

## 7. Determinism — the hazard, grounded (and it's floats, not just clocks)

Asserted output (Layers 2–3) must be **reproducible**, or the JSON churns every
build and assertions flake. v1 worried about clocks; estela sharpened the real
hazard:

- **The bigger risk is computed floats, not timestamps.** estela's outputs are
  computed floats — distance `5901.3 m`, NP `152.4 W`, percentile edges, haversine
  sums, `^0.25` — and those wobble in the last decimal across Node/platform.
  Asserting raw serialized-float JSON _will_ flake. **Rule: round/format emitted
  output to displayed precision before asserting** (`"5.9 km"`, `"152 W"` — estela
  already does this for display), never exact float equality. **And emit small
  results only** — a few split rows, a zone table — never a full series (a real
  track is thousands of points: huge JSON, noisy diffs). The chart emits the
  _bucketed/decimated_ form, not raw samples.
- **Clocks: the static case is the easy one.** A static fixture (FIT/GPX) →
  operator → small result is fully deterministic — estela volunteered its analysis
  examples (and `aggregation.mdx`) as the Phase-2 model. The non-deterministic ones
  are specifically the **streaming** examples (`Date.now()` live ingest — `intro`,
  `creating`, the dashboard guide): route those to **Layer-1-only** (type-checked,
  no asserted output) or vitest **fake timers** (`vi.setSystemTime`). "Watch it
  stream" isn't a static-output example anyway.

## 8. The honest tension, and the staged path

The genuine counter: **422 blocks is a lot**, full run+render for all is
over-investment, and bespoke machinery is evening-maintenance. The resolution is
the §2 ladder made into phases:

- **Phase 0 — de-risk spike.** Census the **non-self-contained blocks** (§3 — the
  real Phase-1 sizing); stand up Twoslash on Docusaurus **3.10** (vs Expressive
  Code) and the types-in-vfs wiring; evaluate `remark-code-import` for (4b). This
  gates the **Twoslash presentation**, _not_ the correctness floor.
- **Phase 1 — the correctness floor, un-blockable.** `tangle → tsc` repo-wide;
  drift fails CI across all 422. Twoslash highlighting + opt-in `^?` types layer on
  _iff_ Phase 0 is go. Mostly mechanical (modulo fragment blocks) — a good agent
  task, and the consumer-protecting layer (estela).
- **Phase 2 — one page end-to-end + _measure_.** `aggregation.mdx` (real `// →`,
  tabular and chartable): extracted tested snippet (4b) + `<ExampleOutput
  as="table">`. Prove the mechanism **and measure the author workflow** (Codex)
  before generalizing.
- **Phase 3 — roll out output.** Verify the `// →` examples and **fill the debt**
  (§1) — to a **quantified target count + ordering** (library), not open-ended; add
  `as="bar|line"` for the visual operators. Charts becomes a website dependency
  here.
- **Phase 4a — the interactive hero tier (§6).** Explorable widgets for windowing /
  aggregation / rolling / alignment. The high-value bet, rationed to the hero few.
- **Phase 4b — (deferred) generic editable-code playground.** Sandpack / react-live,
  only if a real "edit arbitrary code and re-run" need appears; this is the one with
  the sandbox weight and the Twoslash conflict.

**Lean: Phase 1 (the `tangle → tsc` floor) is the un-blockable commitment-worthy
core; Twoslash is gated by Phase 0; 2–3 are friction-gated; 4a is the headline bet;
4b is someday-maybe.**

## 9. The adjacent problem: the generated API reference

pjm17971's second point lands on a _different_ surface — the typedoc-generated
`/api` reference (`typedoc.core.json` → `static/generated-api`), not the prose docs.
The complaints are specific and fair: not **class-centric** (the main classes should
be the spine, with adjacent types linked/inlined, not a flat type dump); **style
clashes** with the site; **doc-comment examples render badly**; **signatures are
unintelligible** — pond's generic/conditional machinery (see
[column-api.md](column-api.md), [columnar-core.md](columnar-core.md)) renders raw as
walls of nested conditionals.

This is **its own body of work** and folding it in would be the scope creep this
RFC's discipline warns against. One real intersection is worth naming: **Twoslash
attacks "unintelligible signatures" from the other end** — the raw generic
declaration is unreadable, but the _inferred type at a call site_
(`const out: TimeSeries<[…]>`) is legible, so the §3 tooling that type-checks prose
examples can _surface the resolved type_ where the declaration can't be read.

v1 also proposed building the example machinery so the API ref could "consume it
later." **Cut, per Codex [medium]:** designing now for a future consumer that isn't
being built is speculative generality. Layer 2/3 optimize for authored MDX; if a
later API-reference RFC wants the machinery, it adapts then. The strategic question —
**invest in typedoc legibility vs. lean on hand-written, example-driven reference**
(which living-examples makes trustworthy) — is real but **out of scope here**, its
own RFC. _[pjm17971; future api-reference RFC]_

## 10. Non-goals · open decisions

**Non-goals.** Not a **generic** in-browser code playground (Phase 4b, deferred —
the Sandpack/react-live kind that conflicts with the Twoslash preset; the
purpose-built widgets of §6 are explicitly _in_ scope). Not executing all 422 blocks
(type-check is the broad net; run+assert is the curated subset). Not baking static
charts at build time (canvas is client-only). Not a `docusaurus build`-time eval
sandbox (reuse vitest). Not pixel-asserting charts in docs (charts' e2e owns that).
Not fixing the generated API reference (§9 — its own RFC). Not a commitment.

**Open decisions (remaining after the red-team).**

- **The Layer-1 vehicle for presentation** — Twoslash via the Docusaurus preset vs
  Expressive Code vs a rehype `@shikijs/twoslash` transformer. Phase 0 settles it;
  the `tangle → tsc` floor stands regardless. _[website]_
- **Off-the-shelf include** — `remark-code-import` (or kin) vs bespoke
  include-by-region for (4b). Prefer off-the-shelf. _[website / library]_
- **Fragment-block count** — the Phase-0 census that actually sizes Phase 1. _[docs]_
- **Output-debt scope** — how aggressively to fill output into bare examples, and
  the ordering (visual/teaching first?). _[pjm17971 / use-case]_
- **Interactive-widget scaffolding** — how much shared structure (a `<Explorable>`
  harness?) vs each hero widget hand-built; which four operators ship first. _[docs /
  charts]_
- **Shiki theme** to re-match the Prism `github` look (light-only). _[pjm17971 /
  design]_
- **API-reference direction** (§9) — typedoc legibility vs example-driven reference.
  Deferred to its own RFC. _[pjm17971]_

_Resolved by the red-team (was open in v1):_ the **emitted-output JSON contract** =
the `TimeSeries` constructor shape (§5, charts); **which operators are visual** =
the table/bar/line three-bucket map (§5, estela); the **types-in-vfs + charts-dep
resolution** = one fix, below (charts).

---

## Review — Codex (adversarial)

_Full text on PR #285. Verdict: sound spine, five findings — all folded into v2._
**[high]** Phase 0 is a harder gate than v1's adoption story admitted: the "biggest
win" hung on an unproven Twoslash/Docusaurus-3.10 integration with no graceful
degradation. → v2 splits the **guarantee (`tangle → tsc`)** from the
**presentation (Twoslash)** so the win doesn't collapse if the spike fails (§3, §8).
**[medium]** Layer 2's "can't drift / small N affordable" is asserted — (4b) still
has prose/region/output coupling. → Phase 2 now **measures** the workflow (§4, §8).
**[medium]** the chart architecture was stated as "forced" when table-only/static
paths exist. → reframed as the escalation ladder with table the default, charts a
later phase (§5). **[medium]** §8's "build it reusable for the API ref" is a
speculative constraint masquerading as out-of-scope. → **cut** (§9). **[low]**
reinvention risk → evaluate off-the-shelf (Expressive Code, `remark-code-import`) in
Phase 0 (§4). Confirmed all grounded facts check out. _Reviewer confidence: high._

## Review — core / library

_Full text on PR #285. Summary, attributed:_ Endorses the spine; nothing a blocker.
Surfaced the **§5 drift incident** (`timeRange` → `range`, #286, and the sweep
missed root `docs/`) — now v2's opening evidence (§1). Layer 1 is **undersold as
"lowest cost / mostly mechanical"**: the **fragment-block** problem (blocks
referencing earlier vars) makes per-block compilation judgment-heavy → Phase-0
census + "moderate-but-bounded cost" reframe (§3). Inline inferred-types can
**backfire** (§3 vs §8) → made opt-in via `^?` (§3). Check **`remark-code-import`**
before bespoke include (§4). **Phase 3 scope unquantified** → target count + ordering
(§8). Recommended prioritizing the (then-empty) Codex slot — done. _Confidence: high
on the design; medium on the Layer-1 effort estimate until Phase 0 counts fragments._

## Review — charts agent (@pond-ts/charts)

_Full text on PR #285. Summary, attributed:_ The **compute → serialize →
`<BrowserOnly>`** path holds — and the chart **import is SSG-safe** (guarded
`window`, `getContext` in the render effect, no module-top DOM), so `<BrowserOnly>`
is only for the canvas _draw_ (+ a `fallback` box for CLS) (§5). The **JSON
contract = the `TimeSeries` constructor shape** (`{name,schema,rows}` →
`new TimeSeries(json)`), collapsing that open decision; the one library ask is a
stable `toJSON` (§5). **Reuse fixtures, not stories** (CSF isn't droppable into
MDX); and a clean **division of labor** — e2e verifies components render, Layer 2
verifies data, docs assert neither's pixels (§5). Two cross-cutting calls: the
**types-in-vfs (§3) and the Phase-3 chart import are one resolution problem** (make
`website/` resolve the local workspace builds; charts is `private` → always the
`dist`); and a light-theme cursor/chip delineation gap exists but **doesn't apply to
static-output charts**. _Reviewer confidence: high._

## Review — estela agent (use-case)

_Full text on PR #285. Summary, attributed:_ **Layer 1 first, no hesitation** — it's
the consumer-protecting layer (their `pond-friction.md` is API-drift churn tracked by
hand). **Add `bar` as a first-class render target** — the operator→rendering map is
**three** buckets (table / line / **bar**), and zone distributions (a flagship
`byColumn` case) render honestly only as a labeled bar (§5). **Determinism is about
computed floats, not just clocks** — round to displayed precision + emit small/
bucketed results, never raw float equality or full series (§7). Splits teach as a
**table**. Volunteered as the Phase-2 use case. _Reviewer confidence: high; the
estela analysis examples are the easy deterministic case to prove Layer 2 on._

## Review — website / docs-infra

_Full text on PR #285. Summary, attributed:_ Verified every tooling claim against
current npm/GitHub rather than the RFC's optimism, and corrected three. **[high] the
Twoslash path the RFC names is largely dead** — `docusaurus-preset-shiki-twoslash` is
abandoned (last published 2023, monorepo archived, predates Docusaurus 3), and
Expressive Code is Starlight/Astro-only with no real Docusaurus support. The one
viable route is a **hand-wired `@shikijs/rehype` + `@shikijs/twoslash@4` rehype
transformer** via `docs.beforeDefaultRehypePlugins` (proven on Docusaurus 3.7+/React
19), with a build-OOM risk that forces `explicitTrigger` (twoslash only on opt-in
blocks — aligns with §3's opt-in stance). Crucially, **that reference proves Shiki
_highlighting_, not Twoslash _type-checking_** — so `tangle → tsc` is not the fallback
but the **workhorse** (validates §3's split, harder). **[medium] the Prism→Shiki swap
is bigger than "mitigated"** — a site-wide `MDXComponents` `Code`/`Pre` swizzle plus
re-adding the copy-button / meta-highlight affordances. **[confirmations]**
type-resolution = **`file:` deps** for `pond-ts`/`@pond-ts/charts` in
`website/package.json` (covers both the type-check vfs _and_ the Phase-3 chart
import — the charts agent's "one problem"); `remark-code-import` is **line-range only,
not named regions**, so the drift-proof pairing is whole-file-per-snippet.
_Reviewer confidence: high on the verified tooling facts; medium on the swizzle-effort
estimate (only a Phase-0 smoke test settles it)._

_Reconciliation into §3 / Phase 0 — the dead-preset → rehype-transformer path, the
larger swap cost, `file:` deps, whole-file snippets — is **pending**, coupled to
pjm17971's open call: are Twoslash's inline resolved-types worth the bespoke rehype +
site-wide swizzle, or is `tangle → tsc` + Prism the whole of Layer 1?_

## Amendments — pond-ts docs agent (v1 → v2 changelog)

The red-team converged on a stronger Layer 1, a missing render target, and a
pulled-forward interactive tier:

- **Opened with the drift incident** (§1). Driver: library + charts — v1's own §5
  example drifted within 24h; it's the most persuasive evidence in the doc.
- **Layer 1 split** into the `tangle → tsc` **guarantee** (un-blockable) + Twoslash
  **presentation** (spike-gated) (§3, §8). Driver: Codex [high]. The single change
  that most strengthens the RFC — the "biggest win" no longer hostage to Phase 0.
- **Bar added as a first-class render target**; table/bar/line three-bucket map
  (§5). Driver: estela. Zone distributions are too central to force into table-or-
  line.
- **Interactive hero tier pulled up** from deferred-someday to the headline bet
  (§6, Phase 4a); the _generic_ playground stays deferred (4b). Driver: pjm17971.
  The unlock: bespoke widgets ≠ `live` code fences, so no Twoslash conflict.
- **Determinism = float-precision + small results** (§7). Driver: estela — the real
  flake hazard is computed floats, not clocks.
- **Inline types made opt-in** via `^?` (§3). Driver: library — auto-surfacing
  reproduces §9's unintelligibility in the prose.
- **§8 (now §9) trimmed** — cut the speculative "build it reusable for the API ref."
  Driver: Codex [medium]. Scope discipline by _removing_, not adding.
- **JSON contract resolved** = `TimeSeries` constructor shape; `toJSON`
  carry-forward (§5). Driver: charts.
- **Off-the-shelf-first** for the include plugin + Twoslash vehicle (§4, Phase 0).
  Driver: library + Codex.
- **One resolution problem** — types-in-vfs and the chart import unified (§5, §10).
  Driver: charts.
- **Cost reframed** "moderate-but-bounded"; fragment-block census as the Phase-0
  sizing of Phase 1 (§3). Driver: library.

---

## Appendix A — Per-method visualization survey

_Produced by a 12-agent survey (one per API family) that read the source for `TimeSeries` / `LiveSeries` / `ValueSeries`, then synthesized; full per-method verdicts live in the PR #285 workflow record. — pond-ts docs agent_

This is the operator-by-operator map behind §5–§6: every public method of
`TimeSeries`, `LiveSeries`, and `ValueSeries` — read from the source
(`packages/core/src/batch/time-series.ts`, `live/live-series.ts`,
`batch/value-series.ts`), not from the docs — assigned the **cheapest render tier
that actually teaches it**. The tier vocabulary is the §5 ladder plus its honest
floor: **table** (values are the lesson) · **bar** (categorical proportion) ·
**line** (shape over an axis) · **interactive** (the §6 hero tier — _playing_ is the
only thing that teaches) · **—** (no render earns its cost; a sentence or a code
block is the honest medium). Read each family's table as "if this operator gets an
`<ExampleOutput>` at all, here's the form and why" — it is the input to the §3
output-debt fill (which examples to render) and the §6 rationing (which few get a
widget).

**Headline counts.** 118 unique public methods surveyed (a handful appear in two
families — e.g. `materialize` buckets _and_ cleans, `concat` reshapes _and_
constructs — counted once, at their strongest verdict). The distribution is
lopsided toward **table** exactly as §2 predicts — most operators are reshapes whose
_values_ are the lesson, not curves:

| Tier | TimeSeries | LiveSeries | ValueSeries | **Total** |
| --- | --: | --: | --: | --: |
| **interactive** | 11 | 4 | 1 | **16** |
| **line** | 9 | 7 | 0 | **16** |
| **bar** | 0 | 0 | 0 | **0** |
| **table** | 37 | 8 | 2 | **47** |
| **—** (none) | 19 | 20 | 0 | **39** |
| **surveyed** | 76 | 39 | 3 | **118** |

Two numbers carry weight for the RFC. **`bar` came up zero** as a method's _primary_
tier — the §5 bar case (zone distributions) is real but it is a _byColumn-output
view_, not a distinct operator, so bar earns its first-class slot from one flagship
shape, not from breadth (consistent with §5's "bar is a UX aid on the splits
table"). And **39 methods are honest `—`** — a third of the surface is I/O,
scalar accessors, and boolean predicates that no chart improves; the survey's job is
as much to _stop_ us rendering those as to greenlight the rest.

### The interactive hero shortlist

This is the concrete candidate list for the **Phase 4a open decision** ("Explorable
widgets for windowing / aggregation / rolling / alignment — rationed to the hero
few"). 15 methods cleared `interactive` + **high** teaching value. But the count to
budget against is **smaller than 15**, because of two collapses the survey makes
explicit:

- The three key-lookup operators **`atOrBefore` / `atOrAfter` / `nearest`** are
  _one concept_ (where does a query key land in sorted keys?) and want **one shared
  "key-lookup" explorable** — drag a marker, watch all three pins diverge in the
  gaps and fall off the ends. Do not build three.
- **`aggregate` and `rolling` recur** on both `TimeSeries` and `LiveSeries`. The
  windowing widget is the same shape; the live variant adds a moving "now" and
  eviction. Budget them as **two builds, not four**.

Net: roughly **9 distinct widgets** cover all 15 high-value hits. Ranked by
teaching-return-per-build:

| Rank | Operator(s) | The control the reader drags | Why _playing_ is the only thing that teaches |
| --: | --- | --- | --- |
| 1 | **`aggregate`** (TS) | bucket-width slider + reducer toggle | The canonical "sweep the window" — count-vs-resolution tradeoff and how a reducer collapses a bucket are felt only by widening it live; half-open membership snaps an on-boundary event into the right bucket as you cross it. **The §6 archetype.** |
| 2 | **`rolling`** (TS + Live) | window-width slider + alignment 3-way + `minSamples` gate | "Wider = flatter; trailing _lags_ the peak, centered _sits_ on it" is the single hardest thing to read from prose; the warmup gate blanking the left edge only makes sense in motion. |
| 3 | **`smooth`** (TS) | method toggle (ema/movingAverage/loess) swapping its parameter slider + `missing` bridge/skip | Smoothing-parameter _feel_ (alpha, span, window) is unlearnable statically; flipping `bridge`↔`skip` over a deliberate gap is the clearest possible teach of a behavior invisible in a frozen frame. |
| 4 | **`align`** (TS) | grid-size × method (hold/linear) × sample-anchor | Three orthogonal knobs: hold's flat plateaus vs linear's ramps, and empty edge buckets, are laborious in a table and obvious the instant you toggle. The cleaning-family designated hero. |
| 5 | **`window`** (Live) | window-width slider, count⇄duration mode | The essence is _dynamic eviction against a moving now_ — events scroll off the trailing edge as time advances; a static frame cannot show "leaving the band," which is the whole idea of a live window. |
| 6 | **`byColumn`** (TS) | bin-width slider + even-width⇄explicit-edges toggle | The value-axis leap (re-key off time) _plus_ the histogram-vs-profile duality, contiguous empty bins, and floor-inclusive bin-0 rule — all only legible by sweeping width. The value-axis twin of `aggregate`. |
| 7 | **`join`** (TS) | segmented control: inner/left/right/outer (+ onConflict) | Join is a relational _truth-table_, not one output — rows vanish under inner and blanks fill under outer on the _same_ fixture. Provenance-colored cells teach the `required:false` widening in the same widget. |
| 8 | **key-lookup: `atOrBefore`/`atOrAfter`/`nearest`** (TS) — **one widget** | a query marker dragged along the key axis | Watching three pins diverge in the gaps and `nearest` flip at the gap-midpoint (then _clamp_ at the ends while the other two go `undefined`) is the only way the directional-bounds contract becomes intuitive. One build, three operators. |
| 9 | **`stats`** (Live) | scripted stream + "inject late event" button | The cumulative-counter narrative — ingested climbs monotonically while `length` plateaus at the retention cap and `rejected` ticks on a late arrival — only teaches when the counters _move_. The dashboard-observability core. |

**Honorable mention, ranked just below the line:**

- **`tail`** (TS) — drag a duration handle, watch the kept set recompute; teaches the
  two non-obvious axes (anchored to the _last event's_ begin, strictly-greater
  boundary) that a static figure under-sells. The strongest play _outside_ the
  windowing cluster.
- **`overlapping`** (TS) — the drag-the-range band that animates the existing
  `temporal-relations.mdx` figure; one widget covers four selectors
  (within/overlapping/containedBy/trim) by recoloring/clipping bars as an edge
  crosses a straddling event. High value, but it _amortizes_ across a family rather
  than teaching one operator, so it reads as a family explainer.
- **`push`** (Live) — the "what _is_ a LiveSeries" opener: a step/play control feeds a
  scripted stream and the sparkline accretes one point per tick. Cheapest possible
  widget; its value is the _first-contact_ mental model, not depth.
- **`nearestIndex`** (ValueSeries) — the value-axis cursor primitive; drag a cursor,
  watch it snap to the nearest row, with the midpoint snap-flip, end-clamp, and
  empty→`-1` all emerging from play. Doubles as the live foundation a docs page
  reuses to illustrate `sliceByValue`.

> **Verdict conflict, flagged honestly.** `LiveSeries.stats` was surveyed twice and
> the two passes split — **table** (a checkpoint counter snapshot) in the
> ingest family, **interactive** (a live moving dashboard) in the transforms family.
> Both are defensible: the _inter-counter invariants_ (ingested ≥ length,
> evicted + length ≤ ingested) pin cleanly in a static table, while the _accrual over
> time_ wants motion. Resolution for Phase 4a: ship the **table** first (cheap,
> covers the invariants), promote to the widget only if the dashboard guide needs a
> live counter — `stats` is the one shortlist entry that is genuinely _optional_ as a
> widget.

### TimeSeries

**Bucketing & aggregation**

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `aggregate` | interactive | high | Raw dots + aggregated step line + bucket bands; **bucket-width slider** + reducer toggle re-buckets live. The family hero. |
| `byColumn` | interactive | high | Histogram-vs-profile by data shape; **bin-width slider** + even/edges toggle; the value-axis re-key leap. |
| `materialize` | table | high | Side-by-side irregular source → grid rows; empty buckets render an explicit `undefined`; `select` toggle changes the winner. |
| `pivotByGroup` | table | high | The definitive long→wide before/after; one row per timestamp, `${group}_${col}` columns, `undefined` holes the lesson. |
| `reduce` | table | medium | Two-column table of output-key → reduced scalar; "the whole series = one bucket." Scalar form needs no figure. |
| `groupBy` | table | medium | Nested table: distinct key values fan out into N labelled sub-tables, event order preserved. |
| `arrayAggregate` | table | medium | Per-event array → scalar before/after; output _kind_ shifts with the reducer (numeric→number, unique→array). |

**Windowed & running**

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `rolling` | interactive | high | Raw dots + bold smoothing line; **window-width slider** + alignment 3-way + `minSamples` gate. The window-size hero. |
| `smooth` | interactive | high | Method toggle swaps the active parameter slider (alpha/window/span); `missing` bridge⇄skip over a gap. Second window-size hero. |
| `cumulative` | line | high | Raw per-event vs monotone running total; `max`/`min` as a ratchet staircase; small-multiple of the four built-ins. |
| `diff` | line | high | Two stacked panels: level (top) vs signed per-event delta (bottom); flat→zero, dip→negative, leading `undefined`. |
| `rate` | line | high | Like `diff` but ÷ elapsed seconds — **uneven gaps** make the normalization visible (same +6 reads 3/s then 2/s). |
| `scan` | table | high | 5-column fold table exposing the hidden accumulator (acc-before/after/output); deadband "carry" rows are the lesson. |
| `rollingByColumn` | line | medium | x = a monotonic value column (distance), not time; raw scatter + windowed band; one window's ±radius bracketed. |
| `pctChange` | line | medium | Signed-% panel vs raw level; equal absolute moves render as unequal % (+10% on 100 vs +1% on 1000). |
| `shift` | line | medium | Original vs shifted copy offset by _event count_ (not time); `undefined` at the vacated edge; +1/−1 small-multiples. |

**Alignment, resampling & cleaning**

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `align` | interactive | high | Irregular dots + grid-snapped line; **grid-size × method × anchor** — hold plateaus vs linear ramps live. Family hero. |
| `materialize` | table | high | Three tables, one per `select` mode; same bucket picks different source events; empty bucket = `undefined` row. |
| `fill` | line | high | Gappy dots + four small-multiples (hold/bfill/linear/zero) painting different _shapes_ into the same hole; `maxGap` cap. |
| `outliers` | line | high | Source line + rolling ±σ band + flagged dots _outside_ it; teaches deviation-from-_local_-baseline, not absolute threshold. |
| `dedupe` | table | high | Before/after with duplicate-key rows banded; one resolved table per `keep` policy (first/last/max/drop/error). |
| `sample` | line | medium | Dense source + sampled dots; stride's regular comb _aliases_ a periodic signal, reservoir preserves the envelope. |

**Range relations & temporal selection**

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `overlapping` | interactive | high | **Drag-the-range hero** for the whole family: a band + radio (within/overlapping/containedBy/trim) recolors/clips bars live. |
| `within` | table | high | Source vs `within(range)` output; only fully-contained events survive (5→2); half-open boundary rule in the caption. |
| `trim` | table | high | The only key-_mutating_ op; before/after begin/end + duration column; the clipped event **keeps its value** (gotcha). |
| `containedBy` | table | medium | Equivalence table vs `within` ({b,d} identical); folds into the hero's radio toggle, no separate widget. |
| `after` | table | medium | Combined with `before`: on-boundary event kept by _neither_ (both strict) — they are **not** a partition. |
| `before` | table | medium | Shares the `after` table; strict `end < limit` cut; TimeRange aside shows it tests `end()` not `begin()`. |

**Positional selection & lookup**

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `tail` | interactive | high | Drag a duration handle; kept set recomputes — teaches the last-event anchor + strictly-greater boundary together. |
| `atOrBefore` | interactive | high | **Shared "key-lookup" hero** (with the two below): drag a marker, three pins diverge in the gaps and at the ends. |
| `nearest` | interactive | high | Same hero; rounds to the closer neighbor (tie→earlier) and _clamps_ at the ends — the pin flips at the gap-midpoint. |
| `atOrAfter` | interactive | medium | Same hero, the at-or-right pin; `at(bisect(key))`, `undefined` past the last event. No standalone widget. |
| `at` | table | medium | Index gutter + highlighted `at(2)`; chips show `at(-1)` from-end, `at(1.5)`→undefined, `at(9)`→undefined. |
| `slice` | table | medium | Two stacked tables, kept span boxed; `Array.prototype.slice` contract (half-open, negative, clamp) as variant chips. |
| `bisect` | table | medium | Key-axis + probe→insertion-index table; the shared primitive under the atOrBefore/atOrAfter/nearest trio. |
| `find` | table | low | First match highlighted, trailing rows greyed (early-stop); barely beats an inline value. |

**Grid-preserving transforms & reshape**

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `map` | table | high | Before/after rows; keys unchanged, schema one column wider; anchors the whole per-event mental model. |
| `mapColumns` | table | high | Before/after on one column with a **missing cell** (stays missing) and a **NaN** (mapper runs) — the carry rule made visible. |
| `collapse` | table | high | Three panels: source, default (columns _replaced_ by `total`), `{append:true}` (originals kept) — the branch newcomers trip on. |
| `concat` | table | high | Two color-tagged inputs → merged re-sorted result; a tied key keeps input order (A before B) — the stable-sort guarantee. |
| `select` | table | medium | Wide→narrow table, dropped columns struck through; key always survives; type-narrowing noted in prose (runtime half only). |
| `withColumn` | table | medium | A derived `Float64Array` "side-channel" slotting in as a real column; length-match + non-finite-throws guardrails. |
| `rename` | table | low | Header-only diff (`cpu`→`usage`), data rows faint/unchanged (zero-copy relabel); near the `—` boundary. |

**Array-column & key-type ops**

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `arrayAggregate` | table | high | Array cell → scalar per row; output kind by reducer; replace-in-place vs `{as}` append shown side by side. |
| `arrayExplode` | table | high | 1-row→N-rows fan-out with **duplicated keys**; empty/undefined array row vanishes; replace vs append reshape differently. |
| `asTime` | table | high | TimeRange→Time with three anchor columns (begin/center/end); overlapping fixture shows the non-monotonic **throw**. |
| `asTimeRange` | table | medium | Time→TimeRange; an instant becomes a zero-width `[t,t]`; values untouched. |
| `asInterval` | table | medium | Rekey + per-row label via `(range,index)=>label` callback; one-kind-throughout throw flagged. |
| `arrayContains` | table | medium | Kept/dropped table, chips for the array, needle highlighted; `undefined` arrays dropped. |
| `arrayContainsAll` | table | medium | Per-needle checklist (AND); paired beside `arrayContainsAny` on identical data; `[]`→keep-all-defined edge. |
| `arrayContainsAny` | table | medium | The OR half of the pair; any one match keeps the row; `[]`→empty-series edge (the inverse). |

**Join**

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `join` | interactive | high | Two partial-overlap sources + result; **inner/left/right/outer** segmented control; provenance-colored cells, em-dash blanks. |
| `joinMany` | table | high | Three narrow sources → one wide table; outer-default blanks where a source lacked a timestamp; delegates to `join` (no 2nd widget). |

**Construction, output & meta** — overwhelmingly `—` (see roll-up); the round-trip
exports earn a table:

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `toRows` | table | medium | Raw input vs normalized output (Date→Time, null→undefined); positional tuples, index headers. |
| `toPoints` | table | medium | Flat `{ts, ...}` rows — **the documented bridge to Recharts/Plot/visx**; `ts = event.begin()`, missing→gap. Pair with `fromPoints`. |
| `fromPoints` | table | medium | Inverse of `toPoints`; flat points → typed rows, missing key→undefined; the right half of the round-trip pair. |
| `concat` (static) | table | medium | UNION ALL: two inputs color-coded, re-sorted, stable tie-break (A before B) at a shared key. |
| `toObjects` | table | low | Schema-keyed object rows verbatim; the object-vs-tuple distinction readers check against `toRows`. |
| `rows` (getter) | table | low | Identical to `toRows()`; cross-reference, don't render separately. |

### LiveSeries

**Ingest & subscription**

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `push` | interactive | high | **Step/Play hero**: a scripted stream accretes one sparkline point per tick — the "what _is_ live" opener. Deterministic by script, not clock. |
| `stats` | interactive | high | Live counter dashboard + "inject late event"; ingested climbs while `length` plateaus, `rejected` ticks. _(Also surveyed as table — see conflict note.)_ |
| `on` | table | high | Firing-log timeline: every row fires one `event` (in order) **before** `batch`, `evict` last — the ordering contract subscribers misread. |
| `pushMany` | table | medium | Input array → buffer after one call; teaches the array-in shape (no spread, large-batch safe) vs `push`. |
| `pushJson` | table | medium | Wire JSON → typed buffer; null→undefined, ISO-string→Time; the `parse.timeZone` disambiguation. |
| `clear` | — | low | State reset observable via the `evict` channel; a one-line prose note, not a picture. |
| `eventRate` | — | low | A single derived scalar (length ÷ span-seconds); plotting a constant teaches nothing. |
| `graceWindowMs` | — | low | Read-only config echo (`Infinity` when unset); pure metadata. |

**Transforms, snapshot & lookups**

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `window` | interactive | high | **Live-eviction hero**: events scroll off a moving band; width slider + count⇄duration mode. Can't be shown in a static frame. |
| `rolling` | interactive | high | Live raw dots + recomputing reducer line; width slider + `minSamples` gap + trigger cadence; fused multi-window overlay. |
| `fill` | line | high | hold vs zero step lines over a gap — **and the marquee live⇄batch contrast**: bfill/linear _throw_ (need future values); `{limit}` reopens the gap. |
| `aggregate` | line | medium | Raw dots + bucket bands + emitted step; a bucket **emits on boundary-cross** (data-driven, not wall-clock); late-within-grace lands in an open bucket. |
| `reduce` | line | medium | A single evolving value + shaded retention band; window is _implicit_ (= retention) vs `rolling`'s explicit — eviction pulls the value back. |
| `cumulative` | line | medium | Raw vs monotone running scan; on an evicting source the accumulator does **not** decrease (scan over arrivals, not the retained set). |
| `diff` | line | medium | Raw + per-event delta; **first event = undefined** (no prior yet) or dropped — the live-streaming signature; 2-row inset. |
| `rate` | line | medium | Per-second line; **irregular spacing** makes the dt-divisor visible; same-timestamp→undefined guard. |
| `pctChange` | line | medium | Fractional-change line on a % axis; prev=0→undefined guard; 3-row inset ties curve to arithmetic. |
| `partitionBy` | table | medium | Fan-out lane diagram: one mixed stream → N keyed sub-buffers; sub-series **inherit** ordering/grace/retention; the multi-entity warning. |
| `filter` | table | medium | Source vs filtered **live view** (re-runs on every push, mirrors eviction); dropped rows greyed; membership is the lesson. |
| `map` | table | medium | Before/after values + the sharp-edge callout: map does **not** re-sort, so a key-rewriting fn breaks `bisect`/`atOrBefore`. |
| `pushMany` | table | medium | Observer-log table: per-row `event` firings then one `batch` — the fan-out ordering + commit-granularity the JSDoc labors over. |
| `pushJson` | table | medium | Wire→buffer cell-by-cell (null→undefined, string→Time); the compile-time safety over `push(row as never)`. |
| `on` | table | medium | Shares the firing-log widget with the ingest-family `on`; the subscription side of the same ordering story. |
| `sample` | table | medium | Kept/dropped stride timeline + the **multi-entity bias trap**: round-robin hosts + stride 2 keeps only A,C. |
| `select` | table | low | Column-highlight projection; key retained implicitly; mirrors batch `select`. |

`push` (no return), `clear`, `toTimeSeries`/`toRows`/`toObjects`/`toJSON`/`fromJSON`,
and the positional/boolean accessors
(`at`/`first`/`last`/`length`/`find`/`some`/`every`/`includesKey`/`bisect`/`atOrBefore`/`atOrAfter`/`timeRange`/`eventRate`)
are all `—` in this family — see the roll-up.

### ValueSeries

| Method | Tier | Teaching | One-line viz |
| --- | --- | --- | --- |
| `byValue` (on `TimeSeries`) | table | high | The family's before/after hero: the chosen column **moves** from a value column to the key and is **dropped** from values; rows byte-identical; a `throws` chip for the non-decreasing precondition. |
| `nearestIndex` | interactive | high | **Value-axis cursor hero**: drag a query value, marker snaps to nearest row; midpoint snap-flip, end-clamp, empty→`-1` all emerge from play. |
| `sliceByValue` | table | medium | Half-open `[lo,hi)` taught by contrast: `[400,1300)` keeps 1200 but `[500,1200)` excludes it; `lo≥hi`→empty. |
| `axisValues` | table | low | One-row strip of axis coordinates; anchors "what the axis is" under the `byValue` table; zero-copy caveat in prose. |

`axisAt`, `axisName`, `column`, and `length` on `ValueSeries` are `—` (scalar reads /
opaque handle) — see the roll-up.

### Visualization does not apply (the honest `—`)

39 methods earn no render. They fall into three clean buckets — and the survey's
discipline is to keep them as prose + code, never force a figure:

**I/O & serialization** — _shape is text; a code block beats any tier._
`constructor`, `fromJSON`, `fromEvents`, `toJSON`, `toArray` (TS);
`toTimeSeries`, `toRows`, `toObjects`, `toJSON`, `fromJSON` (Live). The teachable
facts (null→undefined parsing, timestamps-as-numbers, `parse.timeZone`, the trust
contract of `fromEvents`) are _parsing rules and caveats_, shown best in a runnable
snippet. (`toRows`/`toPoints`/`toObjects`/`fromPoints` are the exceptions that _do_
render — they are reshape round-trips where the output shape is the lesson.)

**Scalar & handle accessors** — _one number or an opaque object; nothing to plot._
`length`, `timeRange`, `firstColumnKind`, `events`, `column`, `keyColumn` (TS);
`length`, `eventRate`, `graceWindowMs`, `timeRange` (Live); `axisAt`, `axisName`,
`column`, `length` (ValueSeries). `column`/`keyColumn` return typed-array _handles_ —
a code + type story (the schema-narrowed return, the read-only-buffer caveat), and
the column's own reductions belong to a separate Column survey, not to the accessor.
`first`/`last`/`at`/`find` on `LiveSeries` collapse here too: single-row reads whose
only live framing ("the buffer is the working set," `at(-1) === last()`) is a caption
on a table other widgets already draw.

**Boolean predicates** — _the answer is one word._ `overlaps`, `contains`,
`intersection`, `some`, `every`, `includesKey` (TS — note `every` was a seed-list
near-miss: it is the boolean universal-quantifier, _not_ `Sequence.every('1m')`, the
grid factory); `some`, `every`, `includesKey`, `bisect`, `atOrBefore`, `atOrAfter`
(Live). The series-vs-range predicates (`overlaps`/`contains`/`intersection`) collapse
the whole series to its `timeRange()` and return a boolean or a single interval —
their only teaching need is _disambiguation_ from the per-event selectors
(`overlapping`/`containedBy`), which is one sentence.

### Patterns & gaps

**The windowing idiom recurs three times and wants one shared widget shell.**
`aggregate` (fixed grid), `rolling` (sliding window), and `align` (resampling grid)
are the same interaction — _raw series faintly behind, a recomputing output line on
top, a width/grid control the reader drags_ — and `byColumn`, `smooth`, and the live
`window`/`rolling` are the same shell with a different axis or a moving "now." A
single `<WindowExplorer>` skeleton (control state → live pond → chart, §6) amortizes
across the entire interactive top of the list. This is the strongest argument that
Phase 4a is **~9 builds, not 16** — and that the first build (`aggregate`) de-risks
the rest.

**The before/after table is the workhorse, and it has two recurring sub-forms.**
Most `table` verdicts are one of: (a) the **reshape pair** — wide↔narrow, long↔wide,
1↔N rows — where the lesson is the _shape_ (`pivotByGroup`, `select`, `collapse`,
`arrayExplode`, `map`); or (b) the **policy small-multiple** — the same call under
each discrete mode laid side by side (`materialize` select-modes, `dedupe` keep-modes,
`fill` strategies, the array-set AND/OR pair). Both are static by nature — the modes
are a finite menu, not a continuum, so they are small-multiples, _not_ sliders. A
shared `<ExampleOutput as="table">` with an optional "modes" prop covers nearly all
of them.

**The honest `undefined` cell is a load-bearing visual primitive.** A surprising
number of high-value table verdicts hinge on rendering missing data _visibly_ —
`materialize`'s empty buckets, `pivotByGroup`'s holes, `join`'s outer blanks,
`mapColumns`' missing-vs-NaN, `diff`/`rate`'s leading `undefined`. A line chart
_swallows_ exactly these rows; the table is chosen precisely because it can show the
hole. `<ExampleOutput>` must render `undefined`/missing as a distinct, deliberate cell
(em-dash, not blank) — this is a concrete component requirement the survey surfaces.

**Where no tier felt fully right.** Three honest tensions:

- **`stats`** (Live) split table/interactive across two passes — the invariants are
  static, the accrual is temporal. Resolved by shipping the table and treating the
  widget as optional (above).
- **`bar` has no native operator.** Its §5 first-class slot rests entirely on
  `byColumn`-as-zone-distribution — a _view_ of one operator's output, not a method
  whose primary tier is bar. The survey confirms bar is correctly first-class _and_
  correctly narrow: budget exactly one bar example (zone distribution), not a family.
- **`rename`** sits on the table/`—` boundary — it changes _nothing_ but a column
  label. It earns a minimal header-diff table only to keep it visually grouped with
  the `select`/`withColumn` schema-reshape trio; alone it would be a sentence.
