# RFC: Range editing — persistent, editable time-ranges with fan-in stats

> _Drafted by the pond-ts library agent (Claude) + pjm17971, 2026-06-21.
> Follows the multi-agent review pattern of `streaming.md` / `charts.md`:
> this is the original draft; use-case review notes (dashboard, estela)
> layer in as new sections below, each carrying inline attribution.
> **An RFC is not a commitment** — the binding scope is whatever lands in
> PLAN.md._

## Status

The charts perf RFC listed **"brush / range-select (M4.3, skipped — no
drivers)"** under non-goals. A driver has now arrived: reproducing the
ESnet traffic example (the canonical react-timeseries-charts demo) needs
exactly this — a user drags out time-ranges over the traffic areas, each
range persists as a labelled band, and a **table below the chart** shows
per-range stats (max / avg per series) that update live as ranges are
created, moved, and resized.

So this is the design track for it. It is deliberately **not** RTC's old
single transient `<Brush>` — it is the brush generalised to **multiple
persistent, editable, labelled ranges** with a **stats fan-in**. (Transient
brush-to-zoom remains deferred; still no driver — see Deferred.)

## What we're building

A shared interaction surface, at the `<ChartContainer>` level (like the
crosshair and like selection — time-keyed, spans every row):

- **Display** — a list of time-ranges renders as full-height vertical
  bands across the plot, behind the data's crosshair, in front of the
  data.
- **Edit (opt-in)** — when an `rangeEdit` mode is on, the plot's drag
  surface **creates / moves / resizes / selects** ranges instead of
  panning. The list is controlled by the consumer (`ranges` +
  `onRangesChange`).
- **Fan-in stats** — for each range, the container asks every registered
  draw layer for its aggregate over `[start, end]` (a new optional
  `rangeStat` on the layer contract, the range-analog of `sampleAt` /
  `hitTest`), flattens them, and pushes the table to the consumer via
  `onRangeStats`. **The consumer renders the table** — the chart owns the
  data + computation, the consumer owns presentation.

Lineage for the RTC reader: `ranges` is RTC's brush, made plural and
persistent; `onRangeStats` is the `TimeRange` → aggregation the old esnet
example wired by hand, now fanned in across every series the chart already
knows.

## Locked decisions

Two forks were resolved with the user up front:

1. **The consumer renders the stats table — not the chart.** The chart
   computes the per-range / per-series aggregates (it has the pond
   `TimeSeries`, the resolved colours, labels, and axis bindings) and hands
   them out ready-to-render; the consumer lays out the table however it
   wants. Rationale: a stats table is product chrome (column choice,
   sorting, formatting, delete buttons) — baking a table widget into the
   chart would be the RTC styling-prop trap again. The fan-in gives a
   table that matches the chart's series exactly, without caging layout.

2. **Editing is an opt-in mode, exclusive with pan/zoom for v1.** When
   `rangeEdit` is on, pan and wheel-zoom are suppressed — the drag surface
   belongs entirely to range editing. No modifier-key juggling, no
   gesture-arbitration to get wrong. Display-only ranges (annotation
   bands) **do** coexist with pan/zoom — only the _editing_ gesture is
   exclusive. Because ranges are stored as timestamps, re-enabling
   pan/zoom-while-editing later is clean (the bands re-project through
   `xScale` for free); we just don't take that on in v1.

## Public API

All additions hang off `<ChartContainer>`, mirroring the existing
`selected` / `onSelect` (presence-controlled value + notify callback) and
`panZoom` / `applyRange` (opt-in boolean + controlled-by-callback) shapes.

```ts
interface ChartContainerProps {
  // …existing…

  /** Time-ranges to display as full-height bands (epoch-ms spans). Render-
   *  only unless `rangeEdit` is on. Controlled: echo `onRangesChange` back. */
  ranges?: readonly RangeSpec[];

  /** Fires with the complete next list on every edit (create / move / resize
   *  / keyboard-delete). Wire it back into `ranges`. A no-op without it
   *  (ranges stay display-only even if `rangeEdit` is on). */
  onRangesChange?: (ranges: RangeSpec[]) => void;

  /** Opt-in edit mode. When true the plot drag creates/moves/resizes ranges
   *  and pan/zoom is suppressed (exclusive, v1). Default false. */
  rangeEdit?: boolean;

  /** Controlled selected-range id (highlights the band; the consumer
   *  highlights its matching table row). `null` = none. Omitted ⇒
   *  uncontrolled (a click selects internally). Mirrors `selected`. */
  selectedRange?: string | null;

  /** Fires when a band is clicked (its id) or a click misses (null). */
  onSelectRange?: (id: string | null) => void;

  /** Fires with the per-range fan-in table whenever ranges, the underlying
   *  data, or the registered layers change. The table to render. */
  onRangeStats?: (entries: readonly RangeStats[]) => void;
}

/** One editable range. `id` is stable identity (chart-minted on create via
 *  crypto.randomUUID; the consumer may rewrite it). `label`/`color` are
 *  optional consumer overrides — else a theme palette cycles by index. */
interface RangeSpec {
  readonly id: string;
  readonly start: number; // epoch ms, start <= end
  readonly end: number;
  readonly label?: string;
  readonly color?: string;
}

/** A range plus every layer's aggregate over it (flattened across rows). */
interface RangeStats {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly stats: readonly RangeStat[];
}

/** One series' aggregate over a range. The consumer's table picks which
 *  columns to show — the chart always provides the full set. */
interface RangeStat {
  readonly label: string; // series identity (as ?? column)
  readonly color: string;
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly sum: number;
  readonly first: number;
  readonly last: number;
}
```

And one optional method on the existing `RowLayer` contract, alongside
`sampleAt` and `hitTest`:

```ts
interface RowLayer {
  // …yExtent, sampleAt, hitTest?, draw…

  /** This layer's aggregate(s) over `[start, end]` for the range fan-in —
   *  the range-analog of `sampleAt`. Zero or more (a line ⇒ 1, a band could
   *  ⇒ 2 for lower/upper). Optional: layers opt in. */
  rangeStat?(start: number, end: number): readonly RangeStat[];
}
```

Layers compute it directly on their columnar arrays: binary-search the
start/end indices into the sorted `time` column, then reduce the value
slice — `O(log N + points-in-range)`, no pond round-trip. (`crop` +
`aggregate` would also work but re-walks; the layer already holds the typed
arrays.)

## Interaction model

All gestures live on the existing `<Layers>` event surface, gated by
`rangeEdit`, reusing the `DRAG_SLOP = 4` px threshold already used to keep a
click from panning:

| Gesture    | Trigger                                         | Result                                                                                          |
| ---------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Create** | pointer-down on empty plot + drag ≥ slop        | new range `[downTime, curTime]`; commit on up (append via `onRangesChange`)                     |
| **Move**   | pointer-down on a band body + drag              | translate `start`/`end` by Δt; commit on up                                                     |
| **Resize** | pointer-down within an edge-grab (~6 px) + drag | move that edge; clamp/swap so `start ≤ end`; commit on up                                       |
| **Select** | pointer-down without a drag (< slop) on a band  | `onSelectRange(id)`                                                                             |
| **Clear**  | pointer-down without a drag on empty            | `onSelectRange(null)`                                                                           |
| **Delete** | `Delete` / `Backspace` with a selected range    | `onRangesChange` without it (optional; the consumer's table delete-button is the baseline path) |

Cursor affordances follow hover: edge → `col-resize`, body → `move`, empty
→ `crosshair`. Hit-test order prefers the selected range, then top-most by
render order, so an overlapped edge stays grabbable.

Ranges are stored as **timestamps**, so a window slide / zoom / resize
re-projects them through `xScale` correctly (the same reason the crosshair
stores a pixel and ranges store time — each stores what stays invariant
under the other's motion). v1 just doesn't allow that motion _during_ an
edit (exclusivity).

## Rendering

Range bands are **overlay chrome**, not draw layers — like the crosshair,
not like `<LineChart>`. Each row's `<Layers>` overlay canvas draws the
bands full-height using `container.ranges` + the shared `xScale`
(`barSpanPx`-style span math, no inset). The selected band draws with a
brighter border + edge handles. No new public component — consistent with
how pan/zoom and selection added container state + behaviour but no
component (the esnet "different overlay?" is an overlay _canvas pass_, not a
new element in the tree).

## Stats fan-in

Layers already register with the container as tracker sources
(`registerTrackerSource`). Widen the registered source to also carry the
optional `rangeStat` — **no second registry**. On any of {ranges change,
selection change, a registered source changes (data append / new layer)},
the container loops ranges × sources, calls `rangeStat(start, end)`,
flattens, and fires `onRangeStats`. Recompute is **not** per-frame — it's
edit/data-driven (drag-end, or throttled during a live drag), so the
windowed reduce cost stays off the render path.

## Reproducing the ESnet example

The static traffic areas already landed (the `TrafficAreas` story, #260:
`in` above the axis, `out` below). Range editing completes it:

```tsx
const [ranges, setRanges] = useState<RangeSpec[]>([]);
const [stats, setStats] = useState<RangeStats[]>([]);
const [sel, setSel] = useState<string | null>(null);

<ChartContainer
  timeRange={range}
  ranges={ranges}
  onRangesChange={setRanges}
  rangeEdit
  selectedRange={sel}
  onSelectRange={setSel}
  onRangeStats={setStats}
>
  <ChartRow height={200}>
    <Layers>
      <AreaChart series={inTraffic} as="in" />
      <AreaChart series={outTraffic} as="out" elevation="below" />
    </Layers>
  </ChartRow>
</ChartContainer>

<RangeTable rows={stats} selected={sel} onSelect={setSel}
            onDelete={(id) => setRanges(rs => rs.filter(r => r.id !== id))} />
```

The `RangeTable` is the consumer's — the fork. (The below-axis readout-flag
position the area note raised is a _tracker_ concern, tracked separately on
the area track, not here.)

## Sharp edges

- **Overlap is allowed.** Two ranges may overlap; stats compute
  independently per range. Only hit-testing needs an order (selected-first,
  then top-most).
- **Id minting.** Create mints `crypto.randomUUID()` (library runs in the
  browser). The consumer may rewrite ids in its `onRangesChange` handler;
  the chart only relies on ids being stable across renders.
- **Half-finite windows.** A range with no data (past the series, or all
  gaps inside) returns an empty `stats` array for that layer — the table
  row shows the range with no series rows, not zeros. `avg` over zero
  points is omitted, not `NaN`.
- **Cost.** Fan-in is `O(ranges × layers × log N + points-in-windows)`.
  Interactive range counts (a handful) keep this trivial; a pathological
  hundreds-of-ranges case is the consumer's call (it owns the list). We
  `log` no silent cap — there isn't one.
- **Live data.** Under a sliding window, a range can scroll off the visible
  domain. It still exists (timestamps); it just renders clipped/off-plot.
  Stats keep computing while the data covers it.

## Deferred / rejected

- **Uncontrolled ranges** (chart holds the list) — rejected for v1: the
  consumer renders the table, so it needs the list anyway; controlled is
  the honest shape. Revisit only if a display-only-no-table use appears.
- **Transient brush-to-zoom** (drag a region, release, zoom to it) — still
  no driver; a different gesture from persistent ranges. Deferred, not
  folded in.
- **Pan/zoom coexistence while editing** — deferred (exclusivity, locked
  decision 2). Clean to add later since ranges are timestamps.
- **Edge snapping** (to data points / time ticks) — v1 is free-pixel →
  timestamp. Snapping is a follow-up if the friction shows up.
- **Configurable stat set** — v1 ships the fixed full set; the consumer's
  table chooses columns. Per-series stat selection deferred (no driver).
- **Distance-domain ranges** — bars/areas are time-x only in v1 (charts RFC
  perf section); a value-axis range is gated on value-axis support.

## Phasing

Proposed as **M4.3** (the slot the perf RFC reserved and skipped), now
un-skipped:

1. `RangeSpec` / `RangeStat` types + `rangeStat?` on `RowLayer`; container
   state (`ranges`, `selectedRange`) + `onRangeStats` fan-in; band
   rendering (display-only). Lands the annotation-bands half.
2. `rangeEdit` gesture layer (create / move / resize / select / delete),
   exclusivity with pan/zoom, cursor affordances.
3. `rangeStat` impls on the value layers (line / area / band / bar); the
   `TrafficRangeEditing` story reproducing esnet end-to-end; unit tests for
   the windowed reduce + the gesture geometry; Playwright baselines.

## Open questions for use-case review

For the **dashboard agent** (does it want ranges at all, and for what?):

1. Is the use annotation (mark an incident window, read its stats) or
   selection-to-act (pick a window, drive a downstream query)? The former
   wants the fan-in table; the latter mostly wants `onRangesChange` and may
   not need stats — which is the real need?
2. Multi-row: should a range fan in stats across **all** rows (every series
   in the chart) or be scoped to one row? v1 fans in all — is that the
   right default for a multi-row dashboard?
3. Live data: do ranges anchor to wall-clock (scroll off as the window
   slides) or to the window (stay put relative to "now")? v1 anchors to
   wall-clock (timestamps).

For the **estela agent** (owns the esnet-style reference):

4. Which stats does the real traffic table show, and per-series or
   per-direction (in/out as one row or two)? Drives whether `rangeStat`
   returns 1 or 2 per area layer.
5. Labels/colours — auto-cycled or always consumer-named in your UI? Drives
   whether the band label-render is worth building in v1.
