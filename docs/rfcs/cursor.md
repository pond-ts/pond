# RFC: Cursor / readout system — per-chart-type cursor modes

> _Drafted by the pond-ts library agent (Claude) from pjm17971's spec,
> 2026-06-21. A build spec + API proposal, not a red-team RFC: the behaviours
> below are pjm17971's design; the open question is the **API shape**, flagged
> for a nod before implementation. Binding scope lands in PLAN.md._

## Status

The current tracker is a first cut: the crosshair (vertical line) **and** the
per-series dots **always** render on hover, and a single container-level
`readout: 'none' | 'flag' | 'inline'` toggles only the value-text chips
(`flag` chips stack at the crosshair top; `inline` chips sit beside each dot).
Value formatting is a local round-to-2-decimals — **not** axis-matched
(flagged in `Layers.tsx` as backlog).

pjm17971's spec replaces this with a **per-chart-type cursor taxonomy**: the
line, the points, and the readout become a single chosen mode per layer, the
flag grows a real **staff anchored to the data point** (not the cursor), the
readout **formatting matches the axis**, and each chart type specialises the
modes it supports + how it draws them.

## The spec (verbatim intent, by chart type)

**Line / area** — cursor modes:

- **`line`** — vertical line, no points, stays exactly under the cursor; used
  with an off-canvas readout.
- **`inline`** — no line, just points + a readout beside each point.
- **`flag`** — the staff rises **from the data point** (not from under the
  cursor — these differ when the data is sparse relative to pixels), up to the
  flag; the staff extends **only to the top of the flag**, which sits **a little
  below the top of the row**.
- **`point`** — points only, no line; used with an off-canvas readout.
- _(`none`)_

Sharp edge called out: an `inline` readout on the **top** row, when its point
is near the bottom, is **covered by the next row** (the chips are DOM siblings
that can overflow the row box).

**Bar** — cursor modes:

- **`line`** — vertical line only, under the cursor, no other effect; off-canvas
  readout or just lining up row data.
- **`flag`** — staff from the **top of the centre of the bar** (not the
  top-left corner) up to the flag (same visual as the line flag). **If the bar
  is tall enough that the flag would overlap it + some margin, drop the staff:
  put a dot at top-centre and hang the flag off that dot.**
- **`none`**.

Plus: hovering a bar should **highlight** it (no story today; code unchecked),
and **click selects** it — which _does_ have a story, **mis-named `hover`**
(rename it; it's selection).

**Box** — cursor modes:

- **`line`** — under the cursor, no interactions.
- **`flag`** — bar-style flag behaviour, connected to the **centre-top of the
  box**; the flag shows **all the box's values on one flag**, each value
  coloured to match its box piece (q1/median/q3/whiskers).
- **no `inline`** — too complex.

Separately (not a cursor concern): box whiskers should be **feather**
(optional), **solid**, or **T-shaped**. The attached reference is RTC's
**solid** look (light outer bars = whisker range, darker inner boxes = q1–q3,
candlestick-like).

**Scatter** — cursor modes:

- **`line`** — under the cursor, mostly for correspondence across rows.
- **`inline`** — a `< VAL`-style readout for the point **closest to the cursor
  in x,y** (no line).
- **`flag`** — staff from the **top of the dot** up to the flag, readout
  alongside.

**Cross-cutting:**

- **Optional time above readouts** — a readout (flag / inline) can optionally
  show the cursor time at the top.
- **Readout formats match the axes** — value text uses the value axis's
  format; the optional time uses the time axis's format.

## Proposed API

A **per-layer `cursor` prop**, typed to each chart type's supported modes:

```ts
// shared vocabulary; each layer's prop is a typed subset
type CursorMode = 'none' | 'line' | 'point' | 'inline' | 'flag';

LineChart  / AreaChart : cursor?: 'none' | 'line' | 'point' | 'inline' | 'flag'
BarChart               : cursor?: 'none' | 'line' | 'flag'
BoxPlot                : cursor?: 'none' | 'line' | 'flag'
ScatterChart           : cursor?: 'none' | 'line' | 'inline' | 'flag'
```

Each layer renders its own at-cursor presentation, so the **type-specific
geometry lives in the layer** (line flag anchors to the point, bar flag to the
bar's top-centre with the tall-bar dot fallback, box flag to the box top with
all-values, scatter flag to the dot). This mirrors how `sampleAt` / `hitTest` /
`rangeStat` already hang off the layer contract.

This **supersedes the container-level `readout` prop** — presentation moves
from one chart-wide mode to per-layer, because the spec's modes and geometry
are per-chart-type. (Unpublished package; the `readout` removal breaks no
external caller.)

**Formatting (the cross-cutting wins) is resolved centrally:** the readout
value text uses the layer's **axis format** (the `<YAxis format>` the layer
scales against), and the optional time uses the **time-axis format** — handed
to the layer via the row/container frame, so the same number that labels the
axis labels the readout. A container-level **`cursorTime?: boolean`** toggles
the time line atop each readout.

### The crosshair-line question (the one decision to confirm)

The vertical line is **one line per cursor position, optionally spanning
rows** — it can't be purely per-layer or you'd draw N of them. Two ways to
reconcile with a per-layer `cursor` enum:

1. **(Recommended)** `cursor: 'line'` on a layer means "no per-series mark;
   contribute the shared crosshair." The row draws **one** crosshair when any
   of its layers is in `'line'` mode; because `cursorX` is shared, the line
   reads as continuous/synced when every row uses `'line'`. Mixed rows show the
   line only in `'line'` rows — acceptable, and matches the per-chart-type
   framing of the spec.
2. **(Alternative)** Split it: a container-level `crosshair?: boolean` (the
   synced line across _all_ rows, RTC-style) **independent** of the per-layer
   `cursor` (which then only ever means `none|point|inline|flag`). Cleaner
   separation, but `'line'` stops being a per-chart "cursor type" — it becomes
   `crosshair=true` + `cursor='none'`, which diverges from how the spec is
   written.

I lean (1) — it keeps the spec's mental model intact. Flagging for your call.

## Flag geometry (shared rules)

- The flag sits **a little below the top of the row**; the staff runs from the
  anchor up to the flag's bottom edge (not full row height).
- **Anchor per type:** line/area → the data point `(pointX, pointY)`; scatter →
  the top of the dot; bar → the bar's **top-centre**; box → the box's
  **centre-top**. `pointX` is the **nearest data point's** x, which can differ
  from the cursor x on sparse data — the staff rises from the data, the dot
  snaps to it (today's `sampleAt` already returns the sample's own `x`).
- **Bar tall-bar fallback:** if the staffed flag would overlap the bar +
  margin, drop the staff → dot at top-centre, flag hung off the dot.
- **Multi-series:** staffs share the nearest-x; flags stack near the top.
- **Box flag:** one flag listing all values (q1/median/q3/low/high), each line
  coloured to its box piece.

## Box whisker styles (separate from cursor)

A `BoxStyle` rendering option: **`feather`** (current thin whiskers),
**`solid`** (RTC candlestick bars — light outer range bar + dark inner box),
**`T`** (whisker stems with T-caps). Theme- or prop-driven; default keeps
today's look. Tracked here because it surfaced alongside the box cursor spec,
but it's an independent change.

## Bar hover-highlight + story rename (separate)

- Add **hover-highlight** on bars (distinct from click-select — see the
  hover-vs-select divergence already documented on `BarChart`).
- Rename the mis-named **`hover`** Bar story to reflect that it demonstrates
  **selection** (`Selectable` or similar).

## Open decisions

1. **Crosshair-line API** — option (1) vs (2) above. _(Lead: 1.)_
2. **Inline overflow** — the top-row inline-covered-by-next-row edge. Options:
   clamp the chip within the row box, render the overlay/chips in a single
   chart-level layer above all rows (so they can overhang), or clip to the row.
   Leaning **clamp within the row** (simplest, predictable) — confirm.
3. **`cursor` vs keeping `readout`** — proposal removes `readout` for per-layer
   `cursor`. Confirm the migration (vs a container default + per-layer
   override).
4. **Where the flag/inline render** — today the chips are **DOM** divs and the
   line/dots are **canvas**. The staffed flag (staff on canvas, chip in DOM?)
   needs the two to register against the same geometry. Likely: staff + dot on
   the overlay canvas, chip in DOM positioned at the flag — confirm that split
   is acceptable, or move chips onto the canvas.

## Phasing

1. **Model + formatting** — the per-layer `cursor` prop + the typed unions; the
   crosshair-line decision; **axis-matched formatting** + the `cursorTime`
   option (these two are wins independent of the new modes). Migrate `readout`.
2. **Line / area** — all four modes incl. the staffed flag (point-anchored,
   below-row-top) + inline-overflow handling.
3. **Bar** — line / flag (top-centre staff + tall-bar dot fallback) / none;
   hover-highlight; rename the `hover` story.
4. **Box** — line / flag (centre-top, all-values) ; **+ whisker styles**
   (feather / solid / T) folded in here.
5. **Scatter** — line / inline (nearest-in-x,y) / flag (dot-anchored).

Each phase: stories per mode × chart type, recording-mock unit tests for the
geometry, Playwright baselines.
