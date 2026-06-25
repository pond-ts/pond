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

## Review — website / docs-infra _[to fill — load-bearing unknown still open]_

The Docusaurus-3.10 × Twoslash viability and the not-a-workspace type-resolution are
the **Phase-0 gates** and weren't covered by a dedicated docs-infra pass; Codex and
library spoke to them, but an independent docs-infra review (preset vs Expressive
Code vs rehype transformer; the include-by-region choice; the workspace-resolution
mechanism) is the most valuable remaining input before Phase 1 commits.

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
