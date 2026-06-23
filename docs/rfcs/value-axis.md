# RFC: The value axis — a closed value-keyed series (`ValueSeries`)

> **Status:** draft (**v2**), for red-team. **Not a commitment** (see CLAUDE.md →
> Strategic RFCs). Explores non-time x in pond-ts across the analytics core and
> the chart. Phases adopted into PLAN.md become the contract; the rest is
> forward-looking context.
>
> **Original draft:** the pond-ts library agent (Claude), prompted by pjm17971
> (estela's time-and-distance need + the value-axis work already in core).
>
> **Revision note (v1 → v2).** v1 framed value-land as
> `byColumn`/`rollingByColumn` → bare `{start,end,…}[]` records + a chart adapter,
> calling those operators "tight analogues" of `aggregate`/`rolling`. The
> red-team (estela / Codex / dashboard agents — see the Review sections) plus
> pjm17971's read killed that framing: the records output is a **grain-violation**
> (value-land has no closed type), the "analogue" claim was **false** (the
> operators aren't closed — they exit the algebra), and v1 **overclaimed** core's
> guarantees. The reframed spine below centers a **closed `ValueSeries` type**;
> the v1 → v2 changelog is in **Amendments**.

## 1. The question, and the bar

estela visualizes activity data over **both time and distance** — pace/HR over
distance, per-km splits, laps, an elevation-vs-distance profile. The chart is
**time-locked** (`ChartContainer` owns one `scaleTime`). Does a non-time x belong
in pond-ts?

The bar pjm17971 set is **elegance** — it has to _emerge from pond's grain_, not
be grafted on. The red-team sharpened what that means here: the question is not
"is a value axis useful" (obviously, for estela) nor even "did the analytics
ship it" — it's **"what makes value-land composable the way the rest of pond
is."** That reframes the whole proposal, and it's the spine of v2.

## 2. What the analytics actually shipped: a projection _out_, not a closed world

Two operators ship and are documented as value-axis analogues of the temporal
ones:

- **`byColumn(col, spec, mapping)`** — _"value-axis aggregation. Where `aggregate`
  buckets the temporal key, `byColumn` buckets rows by the value of a numeric
  column."_ Returns `Array<{ start, end, ...aggregates }>`. **Binning is
  order-free** — its own doc supports a non-monotonic source (a power histogram);
  it does **not** require or enforce a monotonic column. (v1 claimed it did —
  false; Codex #1.)
- **`rollingByColumn(col, { radius, at? }, mapping)`** — the centered-window
  analogue of `rolling`; **does** enforce non-decreasing; returns
  positionally-aligned records; takes `{ at }` = "a chart's coarse display grid."

Both return **records** — they project _out_ of pond's typed world. And the
**head** of the pipeline isn't shipped: the monotonic column they bucket on
(`cumDist`, `cumGain`) has to be _produced_ by a running fold, which today is
`cumulative` (un-generalized) — estela hand-rolls the rest (§ Review — estela).

So the honest statement is **not** "the analytics shipped the value axis, the
chart is the laggard" (v1; Codex + dashboard both flagged this as
self-flattering). It is: **the analytics shipped a _project-out reduce_; the
axis-construction head (`scan`), the chart, and — the real gap — a _closed
value-land type_ are all still pending.** Taking this on is taking on all three,
not adopting a finished half.

## 3. The spine: value-land needs a _type_, because pond is a closed algebra

pond's value is that its operators are **closed**: `TimeSeries → TimeSeries`,
chain forever, every result carries the same operators. `byColumn` /
`rollingByColumn` break that — they hand back `{start,end,…}[]`, a bare array
with no operators, no guarantees, no composition. pjm17971's three objections are
**one objection** seen from three sides:

1. **Non-composable output** — "once you're in value land you're on your own."
   The thing being violated is **closure**: an operator that doesn't return
   something with operators.
2. **The time/value pairing is weaker than argued** — correct, and the asymmetry
   isn't "time vs value." `aggregate` is closed (`→ TimeSeries`); `byColumn` is
   **not closed** (`→ records`). They were never true analogues; one stays in the
   algebra, the other escapes it.
3. **"This should be a pivot — a `ValueSeries` where guarantees are made and a
   set of operators takes the transform where the consumer needs"** — the cure.
   Give value-land a type and (1) and (2) dissolve; the bare-records "analogue"
   was the disease.

So the **central design question of this RFC** is no longer "records + which
chart adapter" — it is **records (project-out) vs a closed `ValueSeries`.**

## 4. `ValueSeries` is a recognition, not an invention

The key was never essentially _time_. Verified in core: the key column is a
generic `Float64Array` `[begin, end)` with kinds **`'time' | 'timeRange' |
'interval'`** — there is already a non-time `'interval'` kind. "Time" is a **tag
on a monotonic numeric ordering**, not the essence. Therefore:

- A **`ValueSeries`** (distance-keyed) is the _same numeric-interval substrate_
  with a value tag — not a parallel reimplementation.
- `byColumn` / `rollingByColumn` stop being weak analogues and become the
  **`TimeSeries → ValueSeries` projection** — the "transform" pjm17971 named.
- `ValueSeries` carries §5's **ordering-based** operators; the calendar ops are
  the _time-only_ extension. The symmetry becomes **true and type-level**.
- **Naming symmetrizes for free.** `byColumn` is awkward because it _fuses_
  project + aggregate into one un-typed call. Split them — `series.byValue('cumDist')
→ ValueSeries`, then `.aggregate({ width })` mirroring `TimeSeries.aggregate` —
  and the awkwardness goes (addresses pjm17971's objection 2). (Concrete names
  deferred — see Open decisions.)
- It **de-over-fits.** Records are estela-shaped; a `ValueSeries` is general. The
  cure for "feels over-fitted" is the _more_ general type, not the less.

## 5. Ordering vs calendar — what `ValueSeries` inherits, and what it doesn't

The machinery splits cleanly, and the split _defines_ the `ValueSeries` operator
set:

- **Ordering-based — `ValueSeries` inherits these.** `bisect`, `nearest`,
  `atOrBefore`/`atOrAfter`, the columnar slice, interval `[begin, end)` keys,
  count-/radius-windowing, binning a monotone axis into ranges. None needs
  wall-clock semantics — only an ordering and a metric.
- **Calendar/clock-specific — time-only, NOT on `ValueSeries`.** `Sequence.every('10m')`
  (needs to know what a minute is), tz tick formatting, `scaleTime`'s
  nice-boundary ticks.

So `ValueSeries` is "the series carrying the ordering-based operators, over a
value axis" — and the time-only extension is exactly the calendar layer. That is
why it belongs: it is the part of pond that was never really about time.

## 6. Data model — reconciled (source stays `TimeSeries`; `ValueSeries` is the output)

estela confirmed (Review below) what v1 guessed: the **source stays
time-keyed** — its canonical series is the time-keyed activity, `cum` is a
derived monotonic `Float64Array`, channels are projected against it; it **never
re-keys by distance**. So `ValueSeries` is **not** "re-key the source" (the
rejected model A); it is the **derived output**. Two constructors:

- **Raw projection** — `TimeSeries` + a named monotonic axis column (`cumDist`) →
  `ValueSeries`. Because `cum` is monotonic in time-order, this is a **no-op
  reindex** (same rows, axis read = the `cum` column), cheap.
- **Aggregated** — `byColumn(cumDist, { width })` → `ValueSeries` of value-bin
  rows (splits / profile).

Records are the **substrate** — a `ValueSeries`'s rows _are_ `byColumn`'s
`{start,end,…}`; the type is the layer over them, so "records now" is additively
wrappable as "`ValueSeries` later" (not a one-way door). Two consumer specifics
from estela that the type must carry:

- **Multi-aggregate + a metric select.** A split record carries many aggregates
  (distance/duration/gain/NP/avgHR/avgPower/…); the bar height is one _selected_
  aggregate. The projection is `…({ axis, value })`, not single-valued bins.
- **Statistical-band marks, not min/max, not bars-only.** estela's profile is
  median + IQR + percentile band as a `BandChart` over `[start, end)` — so the
  reducer set feeding marks must include the quantiles (the "statistical bands =
  M5 gate"), and "`ValueSeries` → interval marks" must cover band marks.

**Gap honesty (Codex #3, sharpened).** `byColumn` floor-binning fixes the
hand-roll's multi-boundary _collapse_ (it won't mislabel a 2500 m jump as one
split), but it does **not allocate across a sample gap** — a 0.9→3.1 km jump
leaves the middle km as **empty bins**, not allocated pace/gain. That is
gap-_honest_ but not _complete_. estela already encodes this honesty
(`MAX_CARRY_METERS`: carry a short hole, else emit NaN and break rather than draw
stale). So this RFC must **define gap/unknown semantics** for value-bins
(empty-bin-honest vs interpolate-across), not claim correctness. _[Open
decision.]_

## 7. The honest tension, and the staged path

`ValueSeries` is a **bigger bet** than the shipped records, and the genuine
counter is real: estela — the actual consumer — confirmed records _work_, and its
pipeline is essentially linear (`scan → cum → byColumn → render`), **not**
value-land _chaining_. So `ValueSeries`'s composability is, today, **unexercised
generality** — and pond's discipline (the elegance bar; the dashboard agent's
defer-generality) says don't build an algebra on spec.

The resolution: **adopt the type early, grow the algebra late.**

- **Type early.** The substrate is already generic numeric-interval (§4), so the
  type is cheap-ish — a value tag + operator-gating + value formatting + having
  the projection return it. Adopting it restores the grain so value-land isn't a
  dead-end.
- **Algebra late.** Ship `ValueSeries` with only what the chart / cursor /
  decimator need (slice-by-value, nearest-by-value, the axis-domain bin) — **not**
  a full `TimeSeries` mirror. Add operators as composition needs prove out, and
  **explicitly not on estela alone**: a second value-axis consumer (geo) is the
  signal that earns more. That is the over-fitting guard pjm17971 asked for.

**The pragmatic alternative, stated honestly:** ship records + a chart adapter,
build `ValueSeries` only if a second consumer chains value-ops. Lower cadence
cost. The reason to prefer the type anyway: records-as-the-model leaves a
permanent wart in a _library_, where consumers chain — `ValueSeries` is the
version that _belongs_. **Lean: `ValueSeries` is the north star; ship the
records-substrate + chart MVP first; grow the type/algebra as a second consumer
earns it.**

## 8. The chart

The payoff of §4: the chart consumes a `ValueSeries` **the same way it consumes a
`TimeSeries`** — the x is whatever the series' axis is. So most of the chart
generalization is type-plumbing, and the just-shipped cursor/axis-format work is
already axis-agnostic:

- `ChartContainer`'s `scaleTime` → a **monotonic value scale** (time = default
  instance). The **shared-x-across-rows bet survives** (shared distance: HR/pace/
  elevation rows all at 5 km, synced cursor). Widen a type, keep the sharing.
- `resolveAxisFormat`/`timeFormat` already make the x formatter pluggable (a
  distance formatter vs the time one); the cursor is x-_pixel_ based (`invert`
  returns a value); `TimeAxis` → an `XAxis` (value-or-time), the sibling of the
  value `YAxis`.
- **The monotonicity contract lives on the axis _projection_, not `byColumn`**
  (Codex #1). Any column used as the chart x must pass an explicit
  `assertMonotonicAxis`; `byColumn`'s order-free binning is a separate concern.
- **One axis per container** (estela + dashboard confirm; Plot.js precedent — a
  time plot and a distance plot are two plot instances). The Miles/Time toggle is
  a per-container swap. **Refinement (estela):** to make the toggle cheap on
  large tracks (~4M-sample PCT), a record can carry _both_ candidate x's
  (`distance` and `time`) and the x-spec **selects** one — so a toggle
  **re-scales, not re-buckets**.
- **Splits/laps = `ValueSeries` interval marks** (bars/boxes/bands over
  `[start, end)`), which **un-parks range-editing #261** (editable ranges on a
  value axis = lap editing).

## 9. The decimator — decoupled from the value axis

v1 tied the decimator and the value-axis x-spec into "one body of work." The
dashboard agent pushed back, correctly, and it composes with Codex #2:

- **Ship the decimator time-only first.** For a uniformly-sampled time series,
  the existing **index-domain `Column.bin`** (equal-width by row count) is valid;
  it's a perf primitive every time-series consumer wants, and its ship gate
  shouldn't wait on the value-axis design.
- **The value axis brings the axis-domain primitive.** `Column.bin` buckets
  _rows_, not axis _values_ — on irregular/gappy distance data that puts extrema
  in the wrong pixels (Codex #2). So the value axis is what forces
  `binByAxis(axisColumn, visibleRange, n, reducers)`. Same projection layer,
  **sequenced** — not one ship gate. (Cadence over reuse.)

## 10. `scan` — its own RFC, and the lead of the wave

The axis-construction head. `cumulative` is a running fold but locks accumulator
= output value = output column, `number`-only; the motivating case (hysteresis
elevation gain, carrying `(ref, gain)`, emitting only `gain`) needs them apart.
Generalize to **`scan`** (the classic `mapAccumL`): `step: (acc: A, value, i) =>
[next: A, output: number]`, `cumulative` kept as the scalar sugar. `split = scan

- byColumn`— materialize the carried state into a column, segment statelessly
(bucket reducers stay pure/order-free). estela explicitly **rejected a domain`split()`\*\* for this composition.

`scan` **gets its own RFC** (dashboard) — not folded in here as wave-of-related
work, because it's a foundational primitive whose design outlives this question
and must be designed for the **abstract** `mapAccumL` case (finite-state
emitters, threshold triggers), resisting sport-specific shape leakage. It
**leads the wave**, lands as a **core** change, and **forecloses nothing** (it
returns a `TimeSeries` + a column — agnostic to records-vs-`ValueSeries`). It
also lets estela _delete_ its hand-rolled `cum`/`cumGain`/hysteresis. Until it
lands, the chart adapter must accept an **externally-supplied aligned axis
array**, not only a named column (estela's `cum` is a sidecar today).

## 11. Consolidation — the real frame is the type, demand-gated

v1's §7 asked whether the `aggregate`/`byColumn`, `rolling`/`rollingByColumn`
**operator twins** should consolidate into one axis-parameterized operator, and
deferred it. Two corrections:

- The dashboard agent showed the v1 "principled twins" defence was **half right**:
  the _input_ difference is real (the temporal key **is** the sorted index;
  `aggregate` trusts storage order, `byColumn` must validate) — a genuine
  implementation seam. But the _output_ difference (`TimeSeries` vs records) is
  **weak**: a `TimeSeries` is records-with-time-keys, and most consumers don't
  care about the wrapper. So the twins are principled at the _implementation
  seam_, not at the _consumer surface_.
- More importantly, the **operator merge was the wrong consolidation to debate.**
  The consolidation that matters is the **type** (`ValueSeries`) — making
  value-land closed — not collapsing the operators. The operator-merge stays
  **deferred hard** (a third axis _kind_ earns it, not estela). And even the
  `ValueSeries` _algebra_ grows demand-driven (§7) — adopt the type, defer the
  breadth.

## 12. Positioning (pjm17971's call)

This expands pond's positioning from "a time-series library" toward "a
**monotonic-axis library where time is canonical**." A real directional bet
(uPlot stays time-only, small/fast; Plot.js generalizes axis types, bigger). But
pond has a **middle path** neither has: because **time stays zero-config default
and the value axis is opt-in**, a time-only consumer never confronts the
axis-type API — so the "every consumer pays a conceptual tax" risk is much lower
than the Plot comparison implies (it's not zero — the codebase/docs carry the
generality — but it's opt-in, not borne by all). What the bet still can't answer:
whether estela + geo are the **leading edge** of a broader value-axis consumer
base or the **only** two cases pond will see. The elegance bar guards against the
sloppy version; it can't tell you if the bet pays. **Framed open — pjm17971's
directional decision.**

## 13. Non-goals · phasing · open decisions

**Non-goals.** Not 2D (a value x is one shared 1-D axis; scatter's 2D-nearest
cursor is a separate deferred thing). Not arbitrary non-monotonic x (monotonic is
the contract for the _axis projection_; laps are intervals on _cumulative_
distance). Not generalizing the calendar. Not re-keying the source `TimeSeries`.
Not a commitment.

**Tentative phasing (friction-driven).**

0. **`scan`** — own RFC + core change, **wave lead**; abstract `mapAccumL`,
   leak-resistant. Forecloses nothing.
1. **`ValueSeries` type** — the value-tag over the numeric-interval substrate +
   the projection (`byValue` / `byColumn`/`rollingByColumn` returning it) + a
   _minimal_ operator set (slice/nearest + the chart needs). Adopt the type;
   defer the breadth.
2. **Chart x on `ValueSeries`** — `scaleTime` → value scale; `XAxis`;
   `assertMonotonicAxis` on the projection. Reuses cursor/format.
3. **Decimator** — time-only `Column.bin` first (own cadence), then `binByAxis`
   with the value axis.
4. **Splits/laps marks** + **lap editing** (#261 on a value axis).
5. **(Deferred)** operator-surface consolidation; broader `ValueSeries` algebra
   — gated on a second value-axis consumer.

**Open decisions (for the red-team).**

- **The central one: records (project-out) vs `ValueSeries` (closed).** Lean
  `ValueSeries` as the north star, algebra gated on a 2nd consumer. _[core /
  library / pjm17971]_
- **`ValueSeries` minimal algebra** — exactly which operators ship in phase 1.
  _[library / estela / geo]_
- **Gap/unknown semantics for value-bins** — empty-bin-honest vs interpolate
  (§6). _[estela / geo]_
- **`binByAxis` shape** vs constraining `Column.bin` to uniform sampling (§9).
  _[geo / library]_
- **`scan` name + shape** — `scan` (the `reduce`/`scan` pair + Rust
  `Iterator::scan`) vs `accumulate`/`runningFold`; single- vs multi-output;
  `cumulative` stays sugar. _[core, in scan's own RFC]_
- **Positioning** (§12). _[pjm17971]_
- **Naming** — "value axis" / "domain axis" (Plot) / "monotonic axis"; and
  `ValueSeries` vs `Series<Value>`. Defer to a docs forcing-function. _[defer]_

---

## Review — estela agent (use-case)

_Full text on PR #279. Summary, attributed:_ **Endorses the thesis and both
structural calls** (records-not-re-keying; defer consolidation). Strongest signal
— estela _already independently built the consumer-side shape by hand_, so the
`[estela]` opens answer themselves. Confirms model (B): time-keyed source, `cum`
a derived `Float64Array`, channels projected; `byColumn`'s `{start,end,…}` =
estela's `Split[]`/`ProfileSample[]`. Sharpenings folded into v2: **`scan`-first
is load-bearing** (`cum`/`cumGain` are sidecars today → adapter must accept an
externally-supplied axis array until `scan` lands; `scan` lets estela delete the
hand-roll); **multi-aggregate `fromValueBins` + metric select**;
**statistical-band marks** (median/IQR/percentile, not bars-only); **carry-both-
axes** so the Miles/Time toggle re-scales not re-buckets (~4M-sample PCT);
**one-axis-per-container** confirmed; `runs`/`segmentsInRange` (zone stretches) →
interval marks.

## Review — Codex (adversarial)

_Verdict: needs-attention. Three findings, all accepted into v2:_ **[high]
`byColumn` does not enforce monotonicity** — v1 said it did; it's order-free
(histograms/zones). The contract belongs on the axis _projection_
(`assertMonotonicAxis`), not `byColumn` (§4, §8). **[high] the decimator conflates
axis-domain with the index-domain `Column.bin`** — `Column.bin` buckets rows
(uniform-sampling precondition), not axis values; gappy data → extrema in wrong
pixels. v2 decouples and names `binByAxis` (§9). **[medium] `split = scan +
byColumn` overclaims gap correctness** — `byColumn` doesn't allocate across a
sample gap; intervening bins are empty, not interpolated. v2 downgrades the claim
and opens gap/unknown semantics (§6).

## Review — dashboard agent (cadence / positioning)

_Backs the direction with three asks, all folded into v2:_ **(1) decouple the
decimator from the value-axis x-spec** — ship M4 time-only first, extend later;
cadence over reuse (§9). **(2) `scan` deserves its own RFC** — don't let a
foundational primitive get hurried as wave-of-related-work; design for the
abstract case (§10). **(3) defer consolidation hard** — a third axis kind earns
it, not estela (§11). Also: the v1 thesis was self-flattering — scan isn't
shipped, so the chart isn't catching up to a settled half (§2); the
principled-twins _output_ argument is weak (§11); one-axis-per-container is right
(Plot precedent, §8); and named the **positioning bet** (§12). Defers naming.

## Amendments — original author (v1 → v2 changelog)

The red-team converged on one structural miss and several accuracy fixes; v2 is
the pivot, not a patch:

- **Spine moved** from "records + chart adapter, operators as analogues" to **a
  closed `ValueSeries` type** (§3–§4). Driver: pjm17971's three objections =
  closure; the v1 "analogue" framing was false (`byColumn` isn't closed). This is
  the substantive change — the rest serves it.
- **Thesis made honest** (§2): not "chart is the laggard" but "head (`scan`),
  chart, and closure all pending." Drivers: Codex + dashboard.
- **`byColumn` monotonicity corrected** (§2, §4, §8) + contract moved to the axis
  projection. Driver: Codex #1 (a v1 factual error).
- **Decimator decoupled** (§9); `binByAxis` named vs index `Column.bin`. Drivers:
  dashboard + Codex #2.
- **Gap semantics opened, correctness claim downgraded** (§6). Driver: Codex #3 +
  estela's `MAX_CARRY_METERS`.
- **`scan` elevated to its own RFC**, abstract-case + leak-resistance (§10).
  Driver: dashboard.
- **Consolidation reframed** — the type is the real consolidation; operator-merge
  deferred hard; output-argument softened (§11). Driver: dashboard.
- **Positioning section added** (§12), with the opt-in/middle-path nuance. Driver:
  dashboard; decision held for pjm17971.
- **estela consumer specifics folded in** (§6, §8): multi-aggregate + metric
  select, statistical bands, carry-both-axes, externally-supplied axis pre-`scan`.

## Review — geo agent (F-geo-2 / `bin` / `binByAxis`) _[to fill]_

## Review — core / library _[to fill]_
