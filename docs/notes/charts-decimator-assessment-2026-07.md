# Charts decimator — assessment + execution plan (July 2026)

Pre-build assessment of the decimator wave ("Remaining → the
decimator (next)" in PLAN.md's charts section), written 2026-07-07
against `main` at v0.41.0 by the Pond technical consultant agent
(Claude). The committed design lives in PLAN.md and the perf section
of [`docs/rfcs/charts.md`](../rfcs/charts.md) (§"Performance:
measuring the v1 bets, M4 decimation, and honest positioning" + the
dashboard review + synthesis + Q2 follow-up). This note does not
re-litigate those decisions — it assesses the plan against the chart
surface as it exists **today**, and lays out the execution plan the
assessment implies.

Sources: PLAN.md charts section, `docs/rfcs/charts.md` perf section
and its two-lens review, `packages/core/src/column.ts` (`bin` as
shipped, incl. its own JSDoc precondition), the Phase-1 bench
diagnosis (#256/#257), the gap-modes design record (#260), the cursor
model record (#265–#276), and the candlestick landing (#357).

---

## 1. What the plan commits to (recap)

- **Algorithm: M4** (Jugel et al., VLDB 2014) — pixel-bucket
  min/max **+ first/last**, pixel-identical lines from
  O(plot_width) points. LTTB rejected (smooths single-sample
  anomaly spikes away) — but see §2.5: that rejection is
  consumer-scoped, and this note reopens it as an opt-in mode.
- **Seam:** reducer math in pond — extend `column.bin` to emit
  first/last (`bin(N, 'minMaxFirstLast')`); the chart contributes
  only `plot_width` + the visible slice. `plot_width` never enters
  pond (the walked-back `TimeSeries.downsampleM4` stays walked
  back).
- **Order:** viewport culling + per-layer M4 decimation first (they
  hit the failing metric — pan 120 fps → 8 fps at 100k, #256);
  Path2D cache second.
- **Hints** (`DecimationHint`): `line: 'minmax'`; band paired
  (min lower / max upper) so the envelope never inverts;
  `scatter: preserveSparse` renders every point.
- **Decoupled from the value axis:** ship time-only on index-domain
  `Column.bin` first; the value axis later brings axis-domain
  `binByAxis`.
- **View-dependence ladder:** (i) cull-then-decimate per frame,
  (ii) cache per `(view, width)`, (iii) multi-resolution pyramid —
  escalate only on evidence.
- **Honesty rider:** the data-side ceiling (snapshot flush, React
  commit, GC) hits before the render ceiling for live consumers; M4
  must never be presented as "perf solved."

## 2. Assessment

**Verdict: the plan is sound where it was red-teamed, and its risks
sit where it wasn't.** The algorithm choice as the _default_, the
seam, and the ordering all survived a genuinely adversarial
multi-party review and none should change (§2.5 rescopes the LTTB
rejection without touching the default). But the perf section is
dated 2026-06-20 and the chart it describes no longer exists: since
then the library shipped five gap
modes (#260), the full five-phase cursor model (#265–#276),
bar hover-highlight, annotations (#306/#308), the value axis
(#283–#286), and candlestick (#357). The plan's one-line "per-layer"
now carries all of those integration seams silently. The six
findings below are, in order: one design correction, two unstated
decisions that need pinning before code exists, one priority signal,
one scoping correction to a rejected alternative, and a basket of
cheap-now items.

### 2.1 The index-domain decoupling contradicts a shipped feature

The plan ships time-only on **index-domain** `Column.bin` and defers
axis-domain binning to the value-axis wave. But Codex's objection —
"index-domain is wrong for gappy data" — is not a value-axis
problem: _time_ data is gappy, and gap rendering is a first-class,
five-mode feature of this chart. `column.ts`'s own JSDoc already
concedes the point: equal-width index bins match equal-width pixel
bins **only for uniformly spaced samples**; for irregular data `bin`
is "correct for uniform input, lying for non-uniform," with the
time-aware variant deferred. M4's entire claim is _pixel-identical_
output; on gappy data, index buckets smear across pixel columns and
the claim quietly becomes false for exactly the data the gap-modes
wave exists to render honestly.

And there is no performance excuse: bucketing a monotonic packed
key column by pixel is the same single O(visible) forward walk as
index bucketing — `floor((t − t0) / dt · W)` instead of
`i / stride`. The key column is already packed and monotonic.

**Correction: decouple from the value axis, not from time-domain
bucketing.** The M4 walk should be key-domain from day one; the
reducer kernels are shared either way. What this avoids is shipping
an approximation that a later wave has to un-bake from the
decimation cache and the pixel-identity e2e baselines. The same
key-domain primitive later _is_ `binByAxis` for `ValueSeries` — the
value-axis decoupling survives intact; only the bucketing domain
changes.

### 2.2 Gap modes × decimation is an unstated decision that will bite

The empty-bucket → `NaN` convention is genuinely elegant (`NaN`
breaks the canvas subpath — `'empty'` mode for free). But a
**partially missing** bucket is validity-blind under
min/max/first/last: it silently bridges a gap that `'empty'` mode
promises to break, and `dashed`/`step`/`fade` need gap-_edge_ values
(`collectGapEdges` walks the full-resolution series) that the
decimated set does not preserve.

**Pin now:** gap-edge detection stays a pre-decimation pass over the
visible full-resolution slice (an O(visible) walk the gap code
already does), and buckets are validity-aware. Concretely: the
bucket-edge list the decimator bins over is the **union of the pixel
edges and the gap edges**, so no bucket ever spans a gap edge — the
connector drawers then receive exact edge values, and all-missing
buckets keep the `NaN` convention. Without this, the first
gappy-data consumer at 100k points files it as a bug.

### 2.3 Pin the interaction invariant: interaction reads the source

Cursor `sampleAt`, `hitTest`, selection identity, and the flag that
"rides its data point" were all built against full-resolution data.
If any of them ever read the decimated arrays, hover readouts change
when the window resizes — a maddening bug class. The M4.1 invariant
("the overlay never touches the data canvas") earned its keep by
being written down and tested; this one deserves the same treatment:

> **Interaction reads the source series; rendering reads the
> decimated view.** Nothing user-facing (readout values, selection
> identity, hit targets) may depend on `plot_width` or DPR.

Corollary: the bar/candle hover-highlight _does_ repaint the data
canvas — that repaint must reuse the current frame's decimated
arrays, not re-scan.

### 2.4 Tidal strengthens the seam — and raises the priority

Two observations. First, `<Candlestick>` shipped (#357) and Tidal's
target is 70–100k points of 5m bars — squarely inside the 10k–100k
band the bench identified as the failing region. The decimator is
not just "next by bench order"; it has a named consumer waiting.
Second, **OHLC re-aggregation _is_ `minMaxFirstLast` applied per
column** — open = first(open), high = max(high), low = min(low),
close = last(close). The pond-side `bin` extension therefore gets
two real consumers on day one (line decimation and candle
re-bucketing), which validates the dashboard's "reducer math belongs
in pond" call harder than anything in the original review did.

But the `DecimationHint` set (`line`/`band`/`scatter`) predates
candlestick: a decimated candle is semantically an **aggregate
candle**, a different render than min/max verticals. Add a candle
hint mode to the spec before building, not after — and coordinate
the semantics with the Tidal agent (a re-bucketed candle is a
_statement about the data_; Tidal may prefer "decimation off,
pre-aggregate upstream" as the financial-correctness default).

### 2.5 The LTTB rejection is consumer-scoped — offer it as a mode

The M4-vs-LTTB call was made by **one consumer**: the dashboard
agent, judging its anomaly-detection workload, where LTTB's
triangle-area selection silently drops the single-sample σ-band
spikes the chart exists to show. For that consumer — and as the
**default** — the verdict is right: M4 is visually lossless, which
is what makes auto-on defensible.

But the rejection shouldn't be global. LTTB is arguably the most
widely deployed downsampling algorithm in the ecosystem (uPlot,
Plotly, Grafana-adjacent tooling all offer or discuss it), and
consumers rendering **smooth continuous signals** — estela-style
rolling activity averages, fit curves — may prefer W
shape-preserving points over M4's per-pixel min/max verticals,
which can read "hairy" on noisy data at wide zoom. The cost of
keeping it is low: the `BinOutput` JSDoc already anticipates
multi-point reducers ("e.g. LTTB") with their own `{ keys, values }`
output shape — the seam was designed for this.

**Scope it as: M4 is the default and the only auto-on mode; LTTB is
an explicit opt-in per layer.** Caveats that must ship with it:

- LTTB is **lossy by design** — it is excluded from the
  pixel-identity e2e (that test is M4's contract, not LTTB's) and
  gets its own visual baselines instead.
- It is a **joint (x, y) selection**, not a per-column reducer: it
  needs the key column (so it lives on the keyed `binBy` path), and
  it does not compose per-column — band envelopes (paired
  lower/upper) and OHLC stay M4-family only, since independent
  per-column LTTB picks misaligned x positions.
- The docs carry the anomaly caveat as the stated reason it isn't
  the default — the dashboard's finding becomes the documented
  warning, not a burial.

### 2.6 Cheap-now items

- **Device pixels, not CSS pixels.** The `bin` JSDoc example buckets
  by `cssWidth`; at 2× DPR that halves horizontal resolution and
  visibly flat-tops extremes. The bucket grid is
  `devicePlotWidth = plot_width × DPR`. Check the Linux-baseline e2e
  workflow pins a DPR, or pixel-identity baselines will disagree
  with local runs.
- **Decide the on/off policy.** The positioning is "no
  pre-decimation required" — that implies decimation is
  **automatic** above a threshold (visible points >
  k · devicePlotWidth) with an opt-out, not a prop someone must
  discover. A knob nobody sets isn't a moat.
- **The M4 claim is directly testable — exploit it.** Render
  decimated vs. full-resolution at fixed size/DPR and pixel-diff.
  That e2e _is_ the regression net, and per the Storybook doctrine
  the feature fan-out should include it.
- **Don't over-climb the ladder.** Dashboard traces say real
  consumers sit below where M4 matters, and the `(view, width)`
  cache invalidates on every live append anyway. Rung (i) —
  cull-then-decimate per frame — is likely the terminal rung, not
  the first. Build it, bench it, stop unless the numbers object.

## 3. Execution plan

Five PRs plus a spec amendment, ordered so each lands independently
and the bench gates each step. Per-PR process obligations
(CLAUDE.md): perf check with `scripts/perf-*.mjs` + before/after
table for anything that walks events; Layer 1 self-review; Layer 2
adversarial agent review; prettier.

> **Implementation status (2026-07-07).** Phase 1 core primitives are
> BUILT:
>
> - **Item 1 — `minMaxFirstLast` fused reducer.** MERGED as
>   [PR #362](https://github.com/pjm17971/pond-ts/pull/362) (`fd8265a`
>   on main). Four-channel `{ lo, hi, first, last }`, validity-aware,
>   chunked-delegating; Layer 2 high-confidence; first/last channels
>   land within noise of plain `minMax`.
> - **Item 2 — key-domain `binBy(key, edges, reducer)`.** BUILT, up as
>   [PR #363](https://github.com/pjm17971/pond-ts/pull/363) on branch
>   `feat/charts-decimator-binby`. pjm17971 chose the
>   `column.binBy(key, edges, reducer)` shape (over `binnedByTime` /
>   an `edges` option). Buckets by explicit pixel-aligned edges over a
>   monotonic key so empty pixel columns surface as `NaN` (the §2.1
>   gappy-data fix); `bin` + `binBy` share one `reduceFloat64ByBounds`
>   engine (all 41 `bin` tests unchanged = refactor safety net); +16
>   tests; perf ≈ `bin` + one O(n) key scan. Layer 2 in flight.
>
> **Not yet built:** everything chart-side (Phases 2–5) — viewport
> culling, the decimator stage (device-pixel edges + gap-edge union +
> the interaction-reads-source invariant), re-bench, candlestick. The
> pond-side reducer math (both `bin` families) is now in place for the
> chart to call.

### Phase 0 — spec amendment (no code)

Amend the charts RFC perf section (layered as a new attributed
section, per RFC convention) and the PLAN.md decimator bullet with
the corrections above: key-domain bucketing from day one (§2.1),
gap-edge union + validity-aware buckets (§2.2), the
interaction-reads-source invariant (§2.3), the candle hint + Tidal
coordination (§2.4), LTTB rescoped from rejected to opt-in mode
(§2.5), device-pixel grid + auto-on threshold (§2.6). Small PR;
this note is the source material.

**Open design calls to put to pjm17971 in this PR:** the core
method's name and shape (§ Phase 1 below); the auto-on default and
its threshold k; whether a decimated candle is an aggregate candle
or "candles don't decimate" (with Tidal's voice in the thread);
whether LTTB lands in this wave's PRs or as a fast-follow once the
M4 spine is proven (the API reserves the mode either way).

### Phase 1 — pond core: the bin extension (PR 1)

1. **`'minMaxFirstLast'` fused reducer** on `Float64Column.bin` —
   four-channel output `{ lo, hi, first, last }`, one walk,
   validity-aware (defined values only; all-empty bucket → `NaN` on
   all four channels, preserving the subpath-break convention).
2. **Key-domain binning** — bin by explicit bucket edges over a
   monotonic companion column, e.g.
   `column.binBy(keyColumn, edges, reducer)` (name/shape =
   pjm17971's call in Phase 0; alternatives: `binnedByTime` at
   series level, or an `edges` option on `bin`). Single forward
   walk, O(visible + W·C). This is the same machinery the value-axis
   wave later exposes as `binByAxis` — build once here.
3. **Perf script** `packages/core/scripts/perf-bin-m4.mjs` per
   convention. Analytical complexity written first (O(N + W·C)).
   Scenarios: 100k and 1M uniform; gappy (30% missing); sparse
   source on dense grid; W = 800 and 2400 (DPR 1 vs 3); index `bin`
   vs key-domain `binBy` head-to-head (pin that key-domain costs
   ~nothing extra).
4. **`'lttb'` multi-point reducer** (§2.5 — in this PR or the
   fast-follow, per the Phase 0 call): lives on the keyed `binBy`
   path (it needs x), returns the `{ keys, values }` W-point shape
   the `BinOutput` JSDoc already reserves; validity-aware (skips
   missing samples). Not fused with `minMaxFirstLast` — separate
   kernel, same walk complexity O(visible).
5. **Tests:** reducer math incl. first/last, validity handling,
   empty and partially-empty buckets, uniform-input equivalence of
   `bin` and `binBy` (the honesty check for §2.1), non-uniform
   divergence pinned as the motivating case. If LTTB lands: a
   known-fixture selection test, plus a **spike-drop test that pins
   the caveat** — a single-sample spike M4 preserves and LTTB
   drops, asserted in both directions, so the documented warning
   stays true.

Additive extension of an existing public column method — flag in
the PR body for the human-approval question, but this does not
touch `TimeSeries`/`LiveSeries`/hook signatures.

### Phase 2 — charts: viewport culling (PR 2)

Bisect the packed key column to the visible range (+1 point each
side) per layer per frame, before any drawing — all layer types,
independent of decimation semantics. Re-run the pan-FPS bench at
100k/1M; report before/after. This is the "do it even if M4 slips"
win and it de-risks Phase 3 by isolating the slice plumbing.

### Phase 3 — charts: the decimator stage (PR 3, the core of the wave)

The per-layer viewport/decimator, per the RFC pipeline:

- **Mechanics:** visible slice (Phase 2) → device-pixel bucket
  edges from `(xScale, plot_width, DPR)` → union with gap edges
  (§2.2) → `binBy(key, edges, 'minMaxFirstLast')` per channel →
  M4 polyline draw (enter at `first`, min/max vertical, exit at
  `last`).
- **Auto-on:** decimate when visible points > k · devicePlotWidth
  (propose k = 2); escape hatch
  `decimate?: boolean | { threshold?: number }` on the layer.
- **Per-layer hints:** line — `minMaxFirstLast` by default, with
  `'lttb'` as the explicit opt-in mode (§2.5; never auto-selected);
  area — `minMaxFirstLast` on the outline, fill follows the
  decimated outline (fill honesty rules from #260 unchanged); band —
  paired (min lower / max upper), M4-family only (LTTB doesn't
  compose per-column); scatter — `preserveSparse` (culling only,
  every visible point drawn); bar/box — culling only
  (interval-keyed, typically pre-aggregated; decimating them is a
  semantic change, not a render optimization); candle — deferred to
  Phase 5.
- **Gap integration** per §2.2: `collectGapEdges` runs on the
  full-res visible slice; edges injected into the bucket-edge list;
  connector drawers receive exact edge values.
- **Interaction invariant** per §2.3, written into the RFC and
  enforced by test; hover-highlight repaints reuse the frame's
  decimated arrays.
- **Caching:** rung (i) only — cull-then-decimate per frame.
  Measure. Escalate only if the pan bench at 1M says so.

**Test surface:** the pixel-identity e2e (decimated vs full-res
pixel diff at fixed size + pinned DPR) as the headline regression
net — **M4 modes only**; LTTB is lossy by design, so it gets its own
visual baselines instead of the identity diff (§2.5); gap-mode ×
decimation stories + e2e (all five modes over gappy 100k data);
interaction-stability e2e (hover readout and selection identity
unchanged across two container widths); the live-append invariant
(sustain 10 Hz for 5 min, no heap growth / FPS decay) at
dashboard-real sizes; Storybook feature-axis group
(`Performance/Decimation`: `AutoThreshold`, `Off`, `Lttb`,
`GappyData`, `SparseScatter`, `BandPaired`, …) per the
systematic-coverage doctrine — the `Lttb` story renders M4 and LTTB
side-by-side over spiky data, making the documented tradeoff
visible.

### Phase 4 — re-bench + positioning (PR 4)

Re-run the Playwright bench (#256 harness) across the full matrix;
before/after table into the commit message and PLAN.md; target ~1M
line points at 60 fps pan. Update the PLAN decimator bullet to
"shipped" with the decisions log. Carry the honesty rider: name the
data-side ceiling wherever the numbers are published. The uPlot
head-to-head + how-to guide remains its own optional follow-up (not
gating).

### Phase 5 — candlestick decimation (PR 5, with Tidal)

Aggregate-candle re-bucketing via the same `binBy` kernels
(first(open) / max(high) / min(low) / last(close)), behind the
candle hint semantics agreed in Phase 0. Run it against Tidal's
real 70–100k bar workload; the friction notes feed back through the
constellation bridge. This is the second-consumer proof of the
pond-side seam.

### Deferred (unchanged from the plan, restated so this note is complete)

Path2D chunked cache (only if the Phase 4 pan bench still misses);
cache rungs (ii)/(iii); LTTB as a fast-follow if the Phase 0 call
keeps it out of this wave's PRs (the hint mode and `binBy` output
shape are reserved either way); `binByAxis` as public `ValueSeries`
surface (value-axis wave — the machinery ships in Phase 1); M4.3
brush (no drivers); SciChart one-off (optional);
dense-scatter/heatmap WebGL parity (conceded).

---

_Posted by the Pond technical consultant agent (Claude)._
