# estela `@pond-ts/charts` port — friction triage (2026-07-04)

_Triage of the seven findings in estela's `## @pond-ts/charts integration
(2026-07-04)` section of `~/Code/estela/docs/pond-friction.md`, produced by the
pond-ts library agent. Every finding was verified against the real charts (and
core) source before ruling — file:line evidence per item. The rulings are:
**ADOPT** (wave item below), **ALREADY TRACKED** (folds into an existing PLAN
item), **DEFER** (real but low; backlog, not this wave), **REJECT** (not a
library gap — estela can strike it off the friction list)._

Charts version at time of triage: **0.39.0**.

> **Status update (2026-07-04, later same day):** the three ADOPT items **shipped
> and merged** — **#342** (axis-reregister guard), **#343** (bar hover — landed as
> `hovered`/`onHover` on `ChartContainer`), **#344** (`fromColumns` opt-in `sort`).
> All three strictly additive; each carried a full Layer-2 review. #342 merged at
> medium Layer-2 confidence (the layer guard proved unreachable-but-defensive; the
> axis guard is the real loop-fix). The ALREADY-TRACKED / DEFER / REJECT rulings
> below are unchanged.

## Verdict table

| Finding                            | estela sev | Verified            | Ruling                    | Where it lands            |
| ---------------------------------- | ---------- | ------------------- | ------------------------- | ------------------------- |
| F-charts-axis-reregister           | HIGH       | ✅ confirmed        | **ADOPT**                 | Wave item 1 (guard + doc) |
| F-charts-bar-interaction           | LOW-MED    | ✅ confirmed        | **ADOPT**                 | Wave item 2               |
| F-charts-fromColumns-key-monotonic | LOW        | ✅ confirmed (core) | **ADOPT (core)**          | Wave item 3               |
| F-charts-width                     | MED        | ✅ confirmed        | **ALREADY TRACKED**       | PLAN #14 (2nd consumer)   |
| F-charts-area-gap-split            | LOW        | ✅ confirmed        | **DEFER**                 | Backlog                   |
| F-charts-theme-double-declare      | LOW        | ✅ confirmed        | **DEFER (mostly reject)** | Backlog / estela-side     |
| F-charts-band-tint                 | LOW        | ✅ confirmed        | **REJECT**                | Strike from list          |

---

## ADOPT — the wave

### Wave 1 — `F-charts-axis-reregister`: value-equal registration guard + widen the memo warning (HIGH)

**The claim holds, mechanism and all.** `YAxis` builds its `AxisSpec` under a
`useMemo` keyed on `[…, format, ticks, …]` (`YAxis.tsx:108-121`) and registers it
in a `useEffect(… , [registerAxis, slot, spec])` (`YAxis.tsx:132-134`);
`registerAxis` unconditionally `setAxes((m) => new Map(m).set(key, spec))`
(`ChartRow.tsx:93-95`). Layers are the same shape — `LineChart`'s `LayerEntry`
depends on `series` (`LineChart.tsx:163-174`) and registers via `setLayers`.
Registration is **pure reference identity — there is no shallow/value compare
anywhere** in the path. So a fresh `ticks={[]}`, an inline `format`, or a
`series={s.byValue('dist')}` (which mints a fresh projection object every call)
re-fires the effect → `setState` → `ChartRow` re-render → parent re-renders →
fresh refs again → cascade. On estela's scrub-heavy chart (parent lifts pointer
state every move) this compounds into React's "Maximum update depth exceeded".
The `ticks` docstring already warns and names `format` (`YAxis.tsx:52-54`) — but
**nothing warns about `series`**, and `byValue()`/value-projection is exactly the
prop a live chart re-creates most.

**Fix (two parts — both needed, because they cover different prop kinds):**

1. **Structural-equality guard in the two setters.** In `registerAxis` /
   `registerLayer`, compare the incoming spec/entry against the stored one and
   **no-op when value-equal** — so a value-equal-but-fresh reference doesn't set
   state and doesn't spin the loop. This fully kills the churn for the two props
   that _can_ be compared: `ticks`/`tickValues` (compare arrays element-wise) and
   `series` (compare by the compiled column identity + length, or first/last key
   — the projection is fresh but its columns are the same buffers). This is the
   load-bearing fix and it is localized to `ChartRow`'s setters.
2. **Widen the doc warning — the honest half.** An inline `format={(v)=>…}` is a
   fresh _function_ each render; a structural guard cannot value-compare two
   closures, so `format` genuinely must be hoisted/`useCallback`'d by the
   consumer. Extend the `ticks` memo note to (a) name `format` on `YAxis` itself
   and (b) name `series`/`byValue()`-projected layers in `LineChart` /
   `AreaChart` / `BarChart` / `BandChart` layer docs. This is the "at minimum,
   extend the warning" the friction note asked for — pair it with (1) so the
   common array/series case stops being a footgun and only the unavoidable
   function case needs consumer discipline.

Ship (1)+(2) together. Scope note for the PR author: the guard must not deep-walk
on every registration (that reintroduces per-render cost) — a shallow spec
compare + column-identity check is enough; benchmark under the scrub workload
(this is a render-path change, not an operator, so the perf check is "no new
per-frame allocation," not a `perf-*.mjs` script).

### Wave 2 — `F-charts-bar-interaction`: controlled `hovered` + `onBarHover` on `BarChart` (MED)

**Confirmed and it's a real API-symmetry gap.** `BarChart` selection is _already_
controlled — `ChartContainer` takes `selected?: SelectInfo | null` and
`onSelect?` , and a bar click resolves through `barAt()` → `SelectInfo` whose
`key` is the bar's `begin` (`BarChart.tsx:98-154`, `context.ts`). But **hover is
container-internal and read-only**: `BarChart` reads `container.hovered`
(`BarChart.tsx:144-154`) to light the bar, and there is **no `onBarHover`
callback and no controlled `hovered` prop**. So estela's index/row-driven
contract (`onBarHover(i|null)`, an externally-pinned lit bar when the lock comes
from a list row, not a bar click) has nowhere to bind — exactly what they
reported, and why they wired click-only and left the row→bar hover/lock sync off.

**Fix:** add the hover half of the pair that selection already has —
`hovered?: SelectInfo | null` (controlled echo) + `onBarHover?(hit: SelectInfo |
null)`, keyed by the same `SelectInfo.key` the selection uses. Symmetric with
`selected`/`onSelect`; no new vocabulary. That gives a list row both a way to
_pin_ the lit bar (pass `hovered`) and a way to _receive_ bar-originated hover
(the callback), closing the degrade.

### Wave 3 — `F-charts-fromColumns-key-monotonic`: opt-in `sort` on `TimeSeries.fromColumns` (LOW-MED, **core**)

**Confirmed, and it's a core finding, not charts.** `fromJSON` accepts
`sort?: boolean` and threads it to the constructor (`time-series.ts:843-860`);
`fromColumns` has no `sort` and instead **throws** on a decreasing key with a
"pre-sort the columns" message (`time-series.ts:897-957`). The asymmetry is the
whole ask. This lands squarely on the actively-developed Tidal wire-format
ingress path (`fromColumns` = pond task #19) — so it's worth closing now while
that surface is in flux.

**Fix — adopt `sort`, reject `clampNonDecreasing`.** Add `sort?: boolean` to
`fromColumns`, parity with `fromJSON`: when `true`, sort the columns by key
before the monotonic check (paying the `O(n log n)` only when asked). **Keep the
throw as the default** — a backwards key on the _trusted_ columnar path is a real
corruption signal, and silently accepting it is wrong for the fast door. The
`clampNonDecreasing` flavor estela also floated is a **reject**: flattening a
genuine backwards blip to a plateau lies about the data (a stale-value plateau
the chart then draws as real). estela's clamp-in-`buildChannelSeries` workaround
is fine as a _consumer_ choice for elapsed-time data they know is monotonic; the
library shouldn't bless data-mutation as an ingress mode. `sort` gives the
principled escape hatch; the consumer keeps the clamp if they want it.

---

## ALREADY TRACKED

### `F-charts-width` → PLAN #14 (responsive sizing / fill) — MED

Confirmed: `ChartContainer.width` is a required `number` with no auto/measure mode
(`ChartContainer.tsx:62,449`); there's no `height` prop at all (container sizes
to `sum(rows) + time-axis`). But this is **already a tracked backlog item** — the
`MultiPanelLayout` story calls it out by name ("drives PLAN #14 — responsive
sizing / fill", `MultiPanelLayout.stories.tsx:25,127,353`). estela's DataChart
port is the **second independent consumer** hitting it (after the multi-panel
layout demo), which is the signal to raise its priority — not a new todo. Action:
bump PLAN #14, note the 2nd pull. No new wave item.

---

## DEFER — real, but backlog (not this wave)

### `F-charts-area-gap-split` — separate `outlineGaps` on `AreaChart` (LOW)

Confirmed: `AreaChart` has one `gaps: GapMode` governing fill **and** outline
together (`AreaChart.tsx:76`, `area.ts:86-153`) — in `none` both bridge, in
`dashed`/`step`/`fade` the fill stays broken and only the outline gets an inferred
connector; there is no `outlineGaps`. estela wants the _inverse_ — a **continuous
fill under a broken outline** (aid-station pause: elevation shade holds, stroke
breaks). Note this cuts against a **deliberate** design decision ("for area the
fill stays honest", PLAN charts §gap-modes; bands deliberately have no gap mode at
all). It's a single degraded visual, on the **time axis only**, and estela already
degraded gracefully (elevation draws continuously; `timeGapBreaks` kept + unit-
tested but unused). Worth a small opt-in `outlineGaps` (or "let the outline honour
NaN while the fill bridges") eventually — but it's LOW and not worth opening the
gap-mode design mid-wave. **Backlog.**

### `F-charts-theme-double-declare` — vars-first `cssVarTheme` mode (LOW, mostly estela-side)

Confirmed at the mechanism: `cssVarTheme(base, resolve)` is `deepMerge(base,
resolve(readVar))` (`css-theme.ts:55-72`) — the base is the foundation, the
resolver is pure override; there is no "resolve every slot from vars with per-slot
literal fallback only where wanted" mode. **But the framing overstates it.** The
`base` isn't a bespoke second palette — the shipped **neutral `defaultTheme` is
the natural base**, and the double-declaration only appears because estela
authors a full brand literal (`estelaChartTheme`) _and_ a resolver reading the
same `--es-*` tokens. Per pond task #10 (charts must not export consumer-brand
themes; estela's brand theme moves to `@estela/ui`), that brand literal lives in
estela's repo regardless — so most of the "twice" is estela-side by design. And
the current shape buys two things the friction note itself credits: a stable theme
reference across renders (the same memo discipline Wave 1 is about) and a free
light/dark re-resolve on a `data-theme` flip. A vars-first helper is a defensible
_nice-to-have_ but low value against that. **Backlog; lean reject.** If it's ever
built, the shape is a `cssVarTheme`-sibling that takes `overrides` first and fills
unspecified slots from `defaultTheme`, so a consumer with a complete token set
writes the resolver only.

---

## REJECT — strike it off the list

### `F-charts-band-tint` — per-channel band colour

Confirmed _and already expressible_. `BandChart` colours by the theme role
`band[as]` (`BandChart.tsx:99-102`, `theme.ts:252-256`) — but **per-channel bands
are a composition, not a missing feature**: render one `<BandChart … as="foam">`
and another `as="hr">` with those roles defined in the theme, exactly as the
`inner`/`outer` example already does (`BandChart.tsx:62-68`). estela's own note
concedes "none needed unless channel-tinted bands are wanted; a band `as` per
channel is already expressible — just a theme choice", and they accepted the
shared teal atmosphere as "arguably cleaner". There is no library gap here.
**estela can strike this from the friction list.**

---

## Summary for estela

- **We'll fix three** (open PRs against charts/core): the re-registration footgun
  (Wave 1, the real one), controlled bar hover (Wave 2), and `fromColumns` opt-in
  `sort` (Wave 3, core).
- **One you're already covered on**: the container width — it's tracked as PLAN
  #14; your port is the 2nd consumer bumping its priority. Keep your
  `useMeasuredWidth` observer until it lands.
- **Two we're parking**: `outlineGaps` and the vars-first theme mode — both real,
  both LOW, both cut against a deliberate design or live mostly in your repo.
  Keep your current degrades; nothing to do on your side.
- **One to strike**: band-tint. Per-channel bands are already a `as`-per-`BandChart`
  composition — not a gap. Take it off the list.
