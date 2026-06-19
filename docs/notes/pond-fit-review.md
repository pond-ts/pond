# `@pond-ts/fit` design review — pond-core implications

_Written by the pond-ts library agent (Claude), reviewing
[estela-app/estela#76](https://github.com/estela-app/estela/pull/76)
("Canonical activity series: carry every channel; compute reads it") and its
`docs/pond-fit-api.md`. Lens: alignment with pond + what the fitness library
pulls on the core. Analytics correctness is estela's domain (207-test net)._

## Verdict

Aligned. The spine decision — the **canonical activity series carries every
channel and compute reads it** — is the pond model: the `TimeSeries` as the
columnar source of truth, `required:false` columns + the validity bitmap for
"present iff recorded," no side-channel parallel arrays. Collapsing the
FIT→arrays→partial-series→arrays round-trip is right, and "producer schema ==
consumer read schema" is the same contract `@pond-ts/charts` reads on (columns by
name). The **ingest-membrane / wrangle-once firewall** is the strongest idea in
the doc — the correct home for format messiness, making the vault read a fast
path. Functional-core / thin-`Activity`-façade matches pond's composition ethos;
inline-then-extract matches the experiment cadence. Quantity types
(`Distance`/`Power`/`Speed`) correctly live in `@pond-ts/fit`, not core — pond
stays generic.

## Pond-core carry-forwards this surfaces

1. **Validity-aware bulk read — now a SECOND data point (priority).** estela#76
   hand-rolls `numberColumn` (`toFloat64Array()` + re-map missing → `NaN` via the
   validity API). `@pond-ts/charts` independently hand-rolls the same thing
   (`data.ts` `readNumericColumn`, per-cell `read(i)` → `NaN`) — and was forced
   off `toFloat64Array()` because the bulk reader tree-shakes away in a bundled
   app **and** flattens missing to `0`. Two consumers want the identical
   primitive: a **bundle-safe, validity-aware `column.toFloat64Array({ missing:
   'nan' | <fill> })`**. This is the `toFloat64Array` carry-forward already on the
   books; estela#76 is what tips it from "noted" to "land it." Closing it in core
   removes the by-hand NaN-laundering both libs do (the fit doc even says "no NaN
   laundering," but the read path still does).

2. **`column.hasAnyDefined()` / `allMissing()`.** estela#76's `anyDefined()`
   (O(N) scan per optional channel, to decide if a channel was recorded) is the
   complement of the existing `hasMissing()`. A cheap core addition; would replace
   the hand-rolled scan and directly back the fit doc's
   `activity.timeSeries().has('power')` presence check.

3. **`TimeSeries` (de)serialization (vault rehydrate).** "Canonical-in-vault,
   fast read" depends on rehydrating a columnar `TimeSeries` without re-wrangling.
   pond has no (de)serialize yet — a genuine core gap, correctly parked as a
   `pond-friction` item. Architecture settled; the mechanism (columnar JSON vs
   native (de)serialize) is the core decision when it gates.

## Convergence worth noting

**Sample-at-time has two independent consumers now.** The fit doc's
`activity.at(Duration)` (interpolated values at an instant — scrub + annotation
anchors) is the same family as the chart tracker's `sampleAt`, which landed on the
new core `TimeSeries.nearest` (#246), with `align` (linear/hold) for the
interpolated case. Two domain libs pulling on the same core sample-at-time
surface validates that those primitives belong in core, not in either lib.

## Their calls (flagged, not blocking)

- **Name** — `@pond-ts/fit` (pun, parses `.fit`) vs `@pond-ts/activity` (no
  FIT-format-only misread). The doc frames the tradeoff honestly.
- **estela ↔ library boundary** — decide at extraction; seam is "domain analytics
  vs app/UX."
