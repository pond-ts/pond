# PND_CHARTS_PLAN — `@pond-ts/charts` remaining work

> Breakout plan for the **Charts** roadmap section in [PLAN.md](../../PLAN.md).
> Architecture: [docs/rfcs/charts.md](../rfcs/charts.md). Full shipped history
> of the canvas wave (M0–M4, chart types, decimator, cursor model, annotations,
> trading-time axis, categorical axis):
> [docs/archive/charts-wave-2026.md](../archive/charts-wave-2026.md).

The canvas wave (kicked off 2026-06-17) shipped the rendering spine, seven
chart types, the full interaction stack (cursor modes, pan/zoom, selection
Phase 1, annotations), the M4 decimator (pan-FPS cliff closed to 1M points),
the trading-time axis, and the categorical axis Phase 1. The package is
**published** (`@pond-ts/charts` on npm, `private: false`); what remains is
landing the built-but-unmerged work, Phase-2 slices of the adopted RFCs, and
the M5 parity gate for the stable / estela-parity milestone.

## Tasks

### [PND-CATAX] — Land categorical axis Phase 1

The three PRs (band-scale foundation, `transposeRow` reader, per-column
`mark` identity + label policy) are **built and verified on
`feat/charts-categorical-axis` but not yet pushed**. Landing sequence per PR:
self-review → Layer-2 → a Codex pass (a new scale primitive warrants it); the
`SelectInfo.mark` widening needs the human-approval gate. The RFC's own owed
Codex red-team (§12.3) runs in parallel.

Deferred beyond Phase 1 (stay RFC-only until adopted): the metric branch
(value-x coordinates — Tidal/Estela), the cursor binding / head-row (Phase 2),
label rotation. RFC:
[docs/rfcs/categorical-axis.md](../rfcs/categorical-axis.md).

### [PND-PARITY] — M5 estela parity (stable milestone)

Faithful `DataChart` reproduction on real activity data; prove no-regressions;
hand the production swap to the estela agent (the package already publishes
pre-parity — this is the stable/parity bar, not the first publish). Known M5
gates collected along the way:

- **Statistical bands** (named an M5-parity gate in the decimator wave).
- **Theme tokens required → optional-with-default** so a new chart type isn't
  a breaking `ChartTheme` change (deferred from the chart-type wave).
- Shared **axis-headroom** policy (no layer's auto-fit pads the top edge);
  BarChart hover-vs-select wide-bucket JSDoc (same deferral list).
- Open decision: how the estela swap is coordinated across the two agents.

### [PND-SELECT] — Selection Phase 2

Phase 1 (series-`id` identity, id-gates-interactivity) shipped. Phase 2, per
[docs/rfcs/selection.md](../rfcs/selection.md) A2/A3: the
`SelectInfo | null → readonly SelectInfo[]` widen + `selectionMode`
(multi-select, re-motivated as "pin several series to read");
`LineChart.hitTest` threshold nearest-point; the
`snapToClosest | snapToClosestSelected` prop; theme-referenced dim state.
The widen is a breaking public change — human-approval gate; estela's bar is
the sole external reader (shim for estela only).

### [PND-DECIM] — Decimator Phase 5 (finish-the-wave)

**Shipped (Phases 2–4):** viewport culling (all layers); M4 line/area/band
decimation (auto-on, every gap mode, session breaks); the pan-FPS re-bench
(cliff closed — line/band 90–120 fps to 1M, `three` 24 fps floor). Source of
truth:
[docs/notes/charts-decimator-assessment-2026-07.md](../notes/charts-decimator-assessment-2026-07.md).
**Not released** — the whole wave sits under CHANGELOG `[Unreleased]`; latest
tag `v0.48.1` predates it.

The remainder is one **Tidal-anchored experiment** (the candle default is the
thing to red-team against a real financial workload before it hardens), run
bench-ordered, each step Layer-1 + Layer-2 review-gated:

1. **Candlestick decimation.** OHLC re-aggregation _is_
   `binBy('minMaxFirstLast')` per pixel column — `open=first, high=max,
low=min, close=last` — i.e. a faithful **coarser-timeframe aggregate
   candle**. **Design fork (assessment §2.4):** auto-on (matches every trading
   UI — candles aggregate on zoom-out) vs. opt-in (a re-bucketed candle is "a
   statement about the data"; financial-correctness purists pre-aggregate
   upstream). **Reasoned default: auto-on + opt-out `decimate` prop + prominent
   doc that decimation aggregates to the pixel-column timeframe** — it is never
   _wrong_ (it is the exact OHLC of that column's time range), and it matches
   convention; revisable if Tidal's real usage pushes back (friction-driven).
   A new `candle` decimate-hint goes in the spec first. Roll the stale PLAN
   `private` note fix into this first PR.
2. **Box-plot decimation** (fast-follow). BoxPlot is interval-keyed like the
   candle (shared geometry, see [PND-BOXPLT]); extend the same interval-mark
   aggregate — `min(lower)/max(upper)` whiskers + aggregated body.
3. **`three`-at-1M floor — decide, don't speculatively build.** The static
   `three` (3 overlaid lines) at 1M pans at 24 fps = 3× the per-frame decimation
   walk (render, not data-side — a static series has no snapshot rebuild).
   **Path2D caching does _not_ help pan** (the `(view, width)` cache invalidates
   every frame as the window moves — assessment's own note), so rung (i)
   (cull-then-decimate per frame) is terminal here. Document 24 fps as the
   extreme-case floor + defer Path2D and further `binBy` optimization (narrow
   case) with this reasoning. No build.
4. **Release.** Promote CHANGELOG `[Unreleased]` → a version, bump every
   `packages/*/package.json` lock-step, tag `vX.Y.Z`, push → the workflow
   publishes. **Human-confirm the version + package set before the tag push**
   (npm publish is irreversible + covers all five packages).
5. **How-to guide** — "Rendering large time series in pond" in
   `website/docs/how-to-guides/`: the real perf work + the **honest** bench
   numbers (flat line/band curve, the `three` floor, "render ceiling ≠ perf
   solved — the data-side ceiling hits first for live"). uPlot / AG Charts
   head-to-head is an optional appendix.

**Explicitly deferred (named, not dropped):** LTTB opt-in (§2.5 — reducer shape
reserved; build when a smooth-signal consumer pulls); non-linear-`curve`
decimation (a smoothing curve blobs the 4-points-per-column verticals; fix =
decimate-then-re-smooth, only on a real driver); WebGL dense-scatter/heatmap
parity (conceded). M4 stays the auto-on default; LTTB the explicit opt-in.

### [PND-BOXPLT] — Finish BoxPlot

The G3/G4 direction from the vol-smile review
([docs/notes/vol-smile-followups-2026-07.md](../notes/vol-smile-followups-2026-07.md)):
per-x range marks (bid/ask error bars) = finish `BoxPlot`, not a new mark —
`ValueSeries` widening, point-key neighbour-spacing width, optional
`q1`/`median`/`q3` for an honest range-only mode, px `offset` prop for same-x
call/put pairing. Plus the follow-on-wave items: a line-only /
stem-without-caps `shape` variant, and reconciling the `cursorFlag` x-snap
exclusion so crosshairs grab box plots (Candlestick never opted out; this
remains BoxPlot-only).

Added by the #508 triage (item 5): **selection `id`** — extends the shipped
id-gated discrete contract (rect-containment `hitTest` like Bar, not the
still-RFC continuous-layer threshold model); Candlestick takes the same
geometry helper in the pass so the interval marks don't fork the contract.

### [PND-LEGEND] — `<Legend>` wave

#508 item 2, accepted as one scoped wave; the sender's design sketch (on the
issue) is the basis: per-layer resolved `SwatchSpec` at registration,
zero-config `<Legend placement>`, dedup + per-layer `legend={false | 'name'}`
opt-out, `theme.legend` slot, hover echo + id-gated select toggle via the
existing frame contract; show/hide stays consumer-side. **Deltas from the
sketch:** row identity keys `id ?? label` (the A2.2 selection model demoted
`as` — a theme role can repeat), and the wave is **sequenced behind
tracker-label-by-`as`** (F-charts-8 §3, in [PND-CURSOR] — the label-source
prerequisite already flagged for the candlestick legend merge). Not
RFC-worthy — the interaction semantics were red-teamed in the selection RFC.

### [PND-ANROLE] — Per-annotation colour via theme role map

#508 item 3. Inline per-mark colour rejected (same discipline as the per-box
red/green reject: colour = theme role, not call-site). Shape:
`theme.annotation.roles?: Record<string, { color; fillOpacity? }>` + a
`role?: string` prop on the three marks, resolving `roles[role] ??
annotation`; the depth ramp applies within the role's hue. `cssVarTheme` role
mapping lands in the same pass.

### [PND-YTICKS] — `YAxis` tick density

#508 item 4. Height-derived default tick count + an explicit `tickCount`
override (the 0.44.1 width-derived-x precedent); explicit `ticks` still wins.
Small.

### [PND-CURSOR] — Cursor/readout polish backlog

Deferred-until-a-design-call items, none blocking: scatter `inline`
**2D-nearest** readout (needs the pointer's y — a cursor-model change);
scatter flag staff from the dot's top for large encoded marks; the "‹ VAL"
callout; chip-vs-chip de-overlap (inline, and box+line in one row);
**tracker-label-by-`as`** on Band/Box/Candle (friction F-charts-8 §3 —
`sampleAt` hardcodes column names; prerequisite for the candlestick legend
merge); the **y-oriented region cursor** for horizontal histograms
([docs/notes/y-oriented-region-cursor-2026-07.md](../notes/y-oriented-region-cursor-2026-07.md),
parked until a real consumer needs it); the **`pointercancel` clear-only
fix** — the region cursor currently commits the span on `pointercancel`
(pre-existing; should clear instead — Layer-2 follow-up from #509). Timezone
control for the cursor readout is tracked with the trading-time work
([PND-TCAL] in [PND_FINANCIAL_PLAN.md](PND_FINANCIAL_PLAN.md)).

### [PND-AXES] — Axis backlog + value-axis naming follow-up

Pull each in as a chart needs it, not before: time-label `align` place-prop
(`center`/`left`/`right`); wall-clock vs relative (elapsed) time axis; custom
labels at custom ticks (estela's intervals/splits); `<YAxis>` label position +
rotation; d3 scale variety (log / pow / sqrt). The deferred **value-axis
naming follow-up** rides here: `timeFormat` (needs an `<XAxis format>` →
cursor-readout coupling), `onTimeRangeChange`, the internal
`ContainerFrame.timeRange` field — one naming+neutrality pass
([docs/rfcs/value-axis.md](../rfcs/value-axis.md)).

### [PND-VALAX] — Value axis: remaining chart types + algebra growth

Box/Candlestick are still time-only on the x axis; widen them to
`ValueSeries` when a consumer pulls (BoxPlot's widening is part of
[PND-BOXPLT]). The `ValueSeries` **algebra grows late**, gated on a second
value-axis consumer (geo), not estela-alone — the type is the real
consolidation ([docs/rfcs/value-axis.md](../rfcs/value-axis.md)).

### [PND-THEME] — `cssVarTheme` candle mapping

LOW; from Tidal's F-charts-4. Deliverable: a candle branch in the
`CssVarTheme` story (rising/falling/neutral body+wick) + a documented
`--*-candle-*` var-name convention so the market palette is one declarative
overlay like the other slots — not new per-slot plumbing (the overlay is
already generic). Earns its keep when the next consumer adopts candles.

### [PND-WIDTH] — Responsive sizing / fill

Container currently needs an explicit px width (`F-charts-width`; estela is
the second consumer to hit it). The `useMeasuredWidth` `ResizeObserver`
pattern is documented as a recipe (#445); the library-side question is
whether `ChartContainer` should own a fill/auto-width mode.

### [PND-ANNRFC] — Annotations RFC write-up

The annotations system shipped (#306/#308/#309) and the staffed cursor-flag
landed (#270/#272), but the short `docs/rfcs/annotations.md` the owner asked
for ("to formalize") was never written. Confirm it is still wanted, then
write it as the durable design record (two registers, depth model, three
interaction modes, the interaction-mode W1/W2/W3 split).

## Core carry-forwards surfaced by charts

Tracked in [PND_CORE_PLAN.md](PND_CORE_PLAN.md): bundle-safe column-API
augmentation + validity-aware `toFloat64Array({ missing })` (F-1, two
consumers), `hasAnyDefined()`/`allMissing()`, the protobuf columnar wire
([PND-WIRE]), and `fromColumns({ onOutOfOrder })` clamp-on-ingest
([PND-INGEST] there).

## Open bug candidates (needs-repro)

- **Canvas async-width first mount** (#508 item 6): does NOT reproduce at the
  React/jsdom level (identical draw-op sequences on a ParentSize-style mount,
  plain + StrictMode; pin test landed in #510). Cause is below React or
  consumer-side; next step is Tidal's minimal browser repro (offered in the
  report).

## Parking lot (deferred, needs a second signal)

- `F-charts-area-gap-split` — a separate `outlineGaps` prop; cuts against the
  deliberate "area fill stays honest" design.
- `F-charts-theme-double-declare` — a vars-first `cssVarTheme` mode; mostly
  consumer-side, current shape buys the stable-ref + free dark toggle.
- Column → semantic-identifier **app-level registry** (global `column → as`
  mapping); composes above the per-chart `as` prop; estela adoption decides.
- Band gap treatment (a filled envelope's break wants its own design; bands
  always break honestly for now).
- M4.3 brush — skipped, no drivers.
