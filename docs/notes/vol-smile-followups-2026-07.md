# Vol-smile follow-ups — direction notes (2026-07-11)

_Direction set by pjm17971 in review of the vol-smile Phase-1 wave
(`ValueSeries.fromColumns` #420, Scatter-on-ValueSeries #422, docs callout
#421 — all merged, riding `[Unreleased]`). These two items are **direction,
not commitments** — they move to PLAN when a wave picks them up. Recorded by
the pond-ts technical consultant agent; code claims verified at
`fb72ea0`._

The driving chart is a volatility smile: implied vol on y, strike on x — a
live cross-section on the value axis. Phase 1 made the smile's lines, bands,
and marks render; these notes capture the agreed shape of the two follow-ups
that came out of its gap list.

## 1. Per-x range marks (bid/ask "error bars"): finish `BoxPlot`, don't mint a mark

The smile's signature market mark is a **vertical bid→ask IV segment per
strike per side**. The gap list initially framed this as a possible new
`RangeMark` primitive; pjm17971's better framing: **a bid/ask segment is a
degenerate box** (whiskers only, no body) — so the work is _finishing
`BoxPlot`_, not new vocabulary. Verified deltas between `BoxPlot` today and
that mark:

1. **Time-only series prop** (`BoxPlot.tsx:22`). Needs the
   `TimeSeries | ValueSeries` widening — mechanical since #422; BoxPlot would
   be the sixth mark to branch, and the last core mark still time-only apart
   from `Candlestick`.
2. **Width comes from the interval key span** (`[begin, end)`); a
   `ValueSeries` key is a **point** (`end === begin`), so every box collapses
   to the 1px floor and span-containment hover barely hits. `BarChart`
   already derives a point-keyed span from **neighbour spacing**
   (`data.ts:101`) — share that, don't re-derive.
3. **All five quantile columns are required** and `isFiniteBox` drops a row
   missing any — so bid/ask today means `q1 = q3 = median = mid`, the same
   quantile-name remap the candlestick RFC §1 documented as friction. **Make
   `q1`/`median`/`q3` optional**: `<BoxPlot lower="bidIv" upper="askIv"
shape="whisker" showMedian={false}>` becomes a legal, honestly-named
   range-only box. That _is_ the range mark.
4. **Same-x pairing needs an `offset` prop** — calls and puts sit at the same
   strike; the legacy implementation hand-nudges ±2.5px. pjm17971: _"An
   `offset` prop will probably get the job done. In react-timeseries-charts
   we had something like that for bar charts to support side-by-side
   stacks."_ Pixel-space (zoom-stable), on the discrete marks (`BoxPlot`,
   `ScatterChart`) — the RTC BarChart precedent is the naming and semantics
   anchor.
5. **Ride-along fix:** `BoxPlot.sampleAt` labels its samples by raw column
   names (`BoxPlot.tsx:146`) — the F-charts-8 §3 friction that made the
   candlestick abuse annoying to track. Touching BoxPlot is the moment to
   align the readout with `as ?? column` like Line/Scatter.

**Independent motivation** (why this isn't smile-special): a per-strike
**intraday IV distribution** — p5/p25/p50/p75/p95 of the day's IV at each
strike — is a _real_ box plot on the value axis, no remap. The widening
earns its keep even if the range mode waited.

## 2. Region select on the value axis (G4): neutral payload, not `TimeRange`

G4 is the **region cursor** (`cursor="region"` + `onRegionSelect` — the
draggable one-shot select, #416). Both the drag band and the select callback
are gated `xKind === 'time'` (`Layers.tsx:333, 740`), so a smile can't
drag-select a **strike window** — the gesture that maps 1:1 onto a
subscription's server-side range params.

The gate exists because the payload bakes time into the contract:
`onRegionSelect?: (range: TimeRange) => void` (`ChartContainer.tsx:169`).
pjm17971: _"returning a `TimeRange` was probably the wrong answer there."_
Direction:

- **Payload becomes a neutral numeric pair** — `readonly [number, number]`
  in axis units (epoch ms on a time axis, the axis value on a value axis).
  This mirrors the input side, where the container already accepts
  `range?: [number, number] | TimeRange` and never takes the _kind_ from it.
  Symmetry: inputs are polymorphic for convenience, outputs emit the neutral
  form; a time-axis consumer who wants a `TimeRange` constructs one.
- **Breaking, and that's fine pre-1.0** — it folds into the already-deferred
  "finish the value-axis naming" follow-up (`onTimeRangeChange`,
  `timeFormat`, internal `ContainerFrame.timeRange`), which is the same
  debt: time-named/-typed API on an axis-neutral machine. Doing G4 without
  that pass would mean shipping a second time-shaped callback to deprecate
  later; do them as **one naming+neutrality pass**.
- **Bucket snapping degrades gracefully.** The region cursor snaps to
  interval buckets where interval-keyed layers exist and falls back to a
  freeform raw span otherwise (`tracker.ts` `regionSpan`). A point-keyed
  smile gets freeform spans — correct as-is; value-side bins (`byColumn`
  records on a `BarChart`) would snap, for free, if present.

## Status

Neither item is scheduled. G3's BoxPlot-finish is a well-scoped single PR
(deltas 1–3 + 5; the `offset` prop can land with it or immediately after).
G4 is Phase 2 of the smile wave, paired with G5 (view-windowed y auto-domain)
— the interaction pass that makes the smile feel like a product surface.
