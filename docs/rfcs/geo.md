# Geospatial time series (`@pond-ts/geo`)

**Status:** planning note (original draft — awaiting use-case agent feedback).

**Relationship to PLAN.md:** This RFC is strategic context, not a commitment.
[PLAN.md](../../PLAN.md) is the binding source of truth for what is actually
being built; items adopted into PLAN are commitments, and the rest of this
document is forward-looking. See [CLAUDE.md → Strategic RFCs](../../CLAUDE.md)
for the layering. In particular: **do not treat this RFC as a roadmap to march
through.** It exists so the geo experiment has a shared contract to push
against, and so the one strategic question it raises — _should pond's column
kind system become extensible?_ — can be red-teamed before any code commits to
opening it.

**Authorship:** developed across contributors; each section carries inline
attribution. This table is the index for cold readers.

| Section                                      | Contributor                                         |
| -------------------------------------------- | --------------------------------------------------- |
| Original draft (all sections, this revision) | pjm17971 (framing) + pond-ts library agent (Claude) |
| Use-case agent feedback (estela experiment)  | estela experiment agent (Claude) — §10, M1 + M2     |
| Library agent response to use-case feedback  | _pending_                                           |

**Audience:** the **estela** experiment agent and future pond-ts contributors
deciding how a geospatial layer should sit relative to core — and whether the
closed column-kind system should ever open.

**Thesis:** pond should not become a GIS engine. A GPS track is already a
first-class pond object — a **time-keyed series of number columns** — and the
geospatial value lives in _operators and reducers over those columns_, not in a
new storage primitive. `@pond-ts/geo` is therefore a **sibling library on the
public surface**, not a change inside core. Build it on what exists, run the
friction-driven cycle, and let friction — not anticipation — earn any core
extension. The column-kind system is closed by design (a 4-member union with
~61 exhaustive dispatch sites); opening it is a real architecture commitment
that should clear a high, multi-consumer bar, which geo alone does not.

---

## 1. North star: estela, a Strava-style activity analyzer

The reference use case is **estela** (Spanish for _wake_ — the trail a moving
body leaves behind), a Strava-style activity analyzer whose early stages live
in the sibling `estela` repo. It is the use-case experiment that drives
`@pond-ts/geo`, in the same friction-driven relationship the dashboard and
gRPC experiments have with the core library. estela ingests GPS activities
(rides, runs) and answers the questions Strava-class apps answer:

- **Per-activity metrics:** total distance, moving time, elevation gain/loss,
  average/normalized power, average pace, bounding box.
- **Derived series:** instantaneous speed/pace, gradient, cumulative distance,
  smoothed elevation, distance-from-start.
- **Domain transforms:** per-kilometre / per-mile **splits**, the
  **elevation-vs-distance** profile, the speed-vs-distance curve.
- **Cleaning:** GPS dropout interpolation, spike removal, pause detection.
- **Visualization extraction:** downsampled `(lat, lng)` for the map polyline,
  `(distance, elevation)` for the profile chart — the column-API draw path.

Many of these are _the same shapes pond already does for telemetry_ (rolling
averages, cumulative sums, aggregation, downsampling) — applied to a spatial
domain. That overlap is exactly why geo should ride on the existing surface.

## 2. Data model — a track is number columns

A GPS activity:

```ts
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'lat', kind: 'number' },
  { name: 'lng', kind: 'number' },
  { name: 'ele', kind: 'number', required: false },
  { name: 'hr', kind: 'number', required: false },
  { name: 'power', kind: 'number', required: false },
  { name: 'cadence', kind: 'number', required: false },
] as const;
```

This is all packed `Float64Column`s today — fast, idiomatic, **zero core
changes**. The temporal key is the activity timeline; no geospatial _key_ kind
is needed (a track is keyed by time, not by position).

**The composite-point spectrum** (for "is a point one thing?"):

| Option                              | Status                 | Cost                                                                                                           |
| ----------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Two `number` columns (lat, lng)** | **Recommended, today** | Packed, fast, idiomatic. Read together via the column API.                                                     |
| One `array` column `[lat, lng]`     | Works today            | `ArrayColumn` is **boxed** (JS arrays, not packed) — fine for correctness, a perf cliff at millions of points. |
| A packed `latlng` column kind       | **Deferred** (§7)      | Requires opening the closed kind system. Only if the two-column form proves genuinely inadequate.              |

Default to two number columns. The ergonomics of "treating a point as one
value" belong in `@pond-ts/geo`'s _API_ (functions that take `lat`/`lng` column
names), not in a new storage kind.

## 3. The geo operator/reducer surface to build first (v0)

All of this is a library **on top of** pond — functions that take a
`TimeSeries` (+ column names) and return a derived `TimeSeries` or a scalar:

- `distance(track)` — haversine between consecutive points → a `dist` column.
- `cumulativeDistance(track)` — running total.
- `speed(track)` / `pace(track)` — Δdistance / Δtime.
- `gradient(track)` — Δele / Δdistance.
- `elevationGain(track)` / `elevationLoss(track)` — reductions.
- `bounds(track)` — `[[minLat,minLng],[maxLat,maxLng]]` bbox reduction.
- `simplify(track, tolerance)` — Douglas–Peucker for polyline downsampling.
- `totalDistance(track)`, `movingTime(track, threshold)` — scalar reductions.
- (later) `geofence` / `contains`, pause detection, spike removal.

These compose the existing primitives (`diff`, `shift`, `cumulative`, rolling,
aggregate, sample) over lat/lng/ele number columns.

## 4. Extension points pond exposes **today** (geo builds on these, no core change)

- **Zero-copy packed reads** — `series.column('lat').toFloat64Array()` returns
  the raw `Float64Array`. Haversine over two aligned `Float64Array`s is tight;
  this is the supported way to reach packed data without deep imports into the
  internal columnar layer.
- **Custom-function reducers** — `aggregate(seq, { gain: (vals) => … })`
  accepts arbitrary functions (`CustomAggregateReducer`). Geo reductions work
  today; they just don't get the columnar fast path (a _named_ reducer would —
  see F-geo-3).
- **Neighbour-based derived columns** — `shift` + `diff` + `cumulative` +
  `mapColumns` cover "compute from the previous point" (distance, speed,
  gradient) without leaving the public API.
- **Compose as functions, not prototype augmentation** — `geo.distance(track)`,
  not `TimeSeries.prototype.distance`. Keeps the seam clean and avoids
  declaration-merging into a class core owns.
- **`array` kind** — available as a boxed escape hatch for a composite point if
  ever wanted (with the perf caveat above).

## 5. Predicted friction → library PR list

The heart of this RFC. These are the items the geo experiment is _likely_ to
drive into core. Each is a hypothesis to confirm with a real friction note —
not a commitment.

- **F-geo-1 — public "attach a computed column from a typed array."** When a
  geo function computes a `Float64Array` (cumulative distance, speed) it needs
  to attach it as a new column without round-tripping through rows. There's no
  public `fromTrustedColumns` / `withColumn(name, Float64Array)` today. **This
  friction is already double-signalled** — the chart carry-forwards
  ([PLAN #107]) want `fromTrustedColumns` too. Likely the first PR and an easy
  yes; serves geo _and_ charts.

- **F-geo-2 — distance-domain bucketing (the deep one).** Pond aggregates over
  a **temporal** `Sequence` (per-minute). Strava also wants **per-km splits**
  and **elevation-vs-distance** profiles — bucketing over a _derived
  cumulative-distance axis_, not time. Pond keys are temporal by design. The
  options (rekey to a synthetic distance axis? a generalized "bucket over any
  monotonic derived column"?) are an open design question (§8) and probably the
  highest-value, most architecturally interesting geo primitive.

- **F-geo-3 — named reducer registration.** If custom-fn geo aggregations show
  up hot in profiles, that pressures the closed reducer registry
  (`resolveReducer`). A `registerReducer(name, def)` with a `reduceColumn` hook
  would let geo reducers take the columnar fast path. Contained and
  friction-gated — but it _is_ an opening of a closed registry, so it earns its
  way in via measured hotness, not anticipation.

- **F-geo-4 — geo-aware gap handling.** GPS dropouts and HR gaps are pervasive.
  Pond has `fill` (hold/linear/zero), but position interpolation across a gap
  is _great-circle_, not linear-in-lat/lng. Whether that's a geo-package
  concern (likely) or surfaces a pond `fill` extension is friction to watch.

- **F-geo-5 — a packed geo column kind (the big one).** Only if F-geo-1/2 show
  that two parallel number columns are genuinely awkward or too slow at scale.
  This is the "plugin column type" question proper — §7.

## 6. Non-goals (deliberate, this revision)

`@pond-ts/geo` is a geospatial **time-series** layer, not a GIS:

- **No map rendering / tiles.** Like charts, rendering is a downstream consumer
  of extracted columns, not pond's job.
- **No routing / navigation / map-matching to road networks.**
- **No general GIS** — polygons, spatial joins, R-trees, arbitrary projections.
  Tracks need WGS84 + haversine/Vincenty + simple bbox/geofence, not a
  projection engine.
- **No CRS/datum machinery beyond what tracks require.**

If a real use case pushes on these, that's a separate conversation — flagged,
not pre-built.

## 7. The column-kind extensibility question (red-team this)

**Current reality.** `ScalarKind = 'number' | 'string' | 'boolean' | 'array'`
is a closed union with ~61 exhaustive `switch` / `kind ===` sites across
`validate.ts`, the columnar `builder`/`view`/`concat`/`ring-buffer`, the
operators, and the schema _type-level_ mapping. There is no kind registry —
dispatch is hard-coded. `ARCHITECTURE.md §3` keeps columnar **internal** (not
re-exported; deep imports unsupported), and §4's decision log shows pond
deliberately resists premature generalization.

**What opening it would mean.** Turning the closed enum into a registry /
interface: a kind supplies its packed storage class (read / slice / gather /
validity), a `kind → TS type` mapping, and reducer hooks — and the ~61 switches
become polymorphic dispatch. That is a real, doable architecture evolution, but
a **large** one, and it widens the public type surface in a way that's hard to
walk back.

**When it's worth it.** When **multiple** plugin kinds want it — geo, plus
(say) units/currency or complex numbers — i.e. when the demand is _broad_, not
geo-specific. For geo alone, two `number` columns + an operator library is both
faster to ship and faster at runtime than a boxed composite, so the
packed-kind payoff has to clear a high bar. **Recommendation: do not open the
kind system for geo alone.** Exhaust the lighter options (two columns; the
`array` escape hatch; F-geo-1's typed-column constructor) first. If a packed
geo column still earns its place, it graduates to its own RFC
(`plugin-column-kinds.md`) red-teamed on its own merits.

## 8. Open questions (red-team targets)

1. **Distance-domain axis (F-geo-2).** Is "bucket/aggregate over an arbitrary
   monotonic derived column" a general pond primitive, or a geo-specific
   transform that rekeys to a synthetic axis? This is the most consequential
   design call and the one most worth getting right early.
2. **Does a packed geo column ever earn its place?** What concrete
   metric/scale from the experiment would flip §7's recommendation?
3. **Named-reducer registry shape** — if F-geo-3 fires, what's the minimal
   safe surface (and how does it interact with the non-finite policy + the
   parity-matrix contract)?
4. **Multi-activity / segments + `partitionBy`.** A user with many activities,
   or segment analysis within one — does geo compose cleanly over
   `partitionBy`, or does it surface friction there?

## 9. Sequencing — the friction-driven loop

1. **Build `@pond-ts/geo` v0 on the existing public surface** (§3–§4). No core
   changes required to get a working Strava-style analyzer — which is exactly
   what makes the friction signal honest.
2. **Friction notes** drive the library PRs (§5), starting with F-geo-1 (the
   typed-column constructor — already double-signalled).
3. **Each milestone lands as a how-to guide** in `website/docs/how-to-guides/`
   ("Building a Strava-style activity analyzer with pond-ts + @pond-ts/geo"),
   per the experiment-as-guide discipline.
4. **If F-geo-2 or F-geo-5 prove themselves**, the design graduates to a
   committed PLAN item (and, for the kind system, its own red-teamed RFC).

The contract for the geo agent: build on the public surface first, report
friction where it actually falls, and don't reach for a core column-kind change
until the lighter paths are exhausted and the friction is measured.

---

## 10. Use-case agent feedback — estela, M1

> _Posted by the estela experiment agent (Claude)_

First friction pass from the estela side. **M1 scope:** ingest one _real_
activity end-to-end and build the journey view on pond's public surface —
distance, moving/elapsed time, elevation gain/loss, per-km splits, the map
polyline, and the elevation-vs-distance profile. Built as documented (§3–§4):
two `number` columns for lat/lng, `column().toFloat64Array()` reads, column
reductions, no core changes. Reference impl lives in the estela repo
(`packages/core/src/geo`, `packages/core/src/journey`,
`packages/ingest/src/gpx.ts`); full friction log in estela's
`docs/pond-friction.md`.

**The activity:** "Queen K to Hwy 19", a real 123 km / 15,207-point Big Island
ride from a Strava export. Validated against Strava's own recorded numbers:
distance 123.57 vs 123.32 km (+0.2%), elapsed exact, moving 4h37 vs 4h46, gain
987 vs 887 m (threshold-sensitive). The geo model produces correct,
ground-truth-close results with zero core changes — **the §0 thesis holds.**

### 10.1 Positive control — what pond made easy

Recording this first because it calibrates everything below. On 15,207 points:

| step                                                        | time       |
| ----------------------------------------------------------- | ---------- |
| `column('lat').toFloat64Array()`                            | 0.02 ms    |
| `stepDistances` (haversine ×n over the two `Float64Array`s) | 0.20 ms    |
| `column('lat').min()/.max()` (bbox)                         | 0.03 ms    |
| `new TimeSeries({schema, rows})` (15k×5)                    | 1.06 ms    |
| **`computeJourney` end-to-end**                             | **4.2 ms** |

The pond-touching parts total <0.3 ms; the remaining cost is GPX parsing and
Douglas–Peucker, both estela-side. The zero-copy read path (§4) and "geo is
reductions over number columns" (§0) deliver exactly as designed.

### 10.2 Friction, keyed to §5

- **F-geo-2 — distance-domain bucketing — CONFIRMED, and it's the one that
  matters.** Per-km splits and the elevation-vs-distance profile both bucket
  over _cumulative distance_, a derived monotonic column, but `aggregate`/
  `rolling` bucket only over the temporal key. No public "aggregate over an
  arbitrary monotonic column", so `track.aggregate(distanceSequence, …)`
  doesn't exist and both transforms are hand-rolled array walks. **Crucially:
  the hand-rolled versions run in 0.05 ms — so this is an _expressiveness_ gap,
  not a perf one.** The cost is that every distance-domain transform is bespoke
  imperative code instead of composing the aggregate machinery (custom
  reducers, the parity matrix, the non-finite policy). Answering open-question
  §8.1 from the use-case side, two shapes seen:
  1. **Rekey to a synthetic axis** — `track.rekey('cumDist')` then
     `aggregate(Sequence.every(1000))`. Maximises reuse of the aggregate
     machinery but needs a non-temporal / numeric key; biggest blast radius.
  2. **A distance-bucket operator** — `aggregate(byColumn('cumDist', 1000), …)`
     where the bucket boundaries come from a monotonic column instead of a
     `Sequence`. Smaller surface.
     **Recommendation: shape 2 as the first step.** estela would adopt it
     immediately for splits, the elevation profile, and speed-vs-distance. It also
     composes with F-geo-1 (you'd want to attach `cumDist` as a column first).

- **F-geo-1 — `withColumn(name, Float64Array)` — CONFIRMED, lower urgency at
  M1.** Derived series (`cumDist`, `speed`, `gradient`) had nowhere to live _as
  pond columns_: `mapColumns` only transforms existing columns (mapper can't
  see neighbours), `map` is a row-by-row rebuild, and there's no public typed-
  array column constructor. We sidestepped it by computing over raw arrays and
  returning scalars/plain arrays — fine for M1 because nothing downstream
  needed the derived columns _inside_ pond. But it blocks composition: you
  can't compute `cumDist` then feed it to a distance-bucket aggregate (F-geo-2).
  The two are a pair; F-geo-2 is much more useful once F-geo-1 lands.

- **F-geo-3 / F-geo-4 — not yet exercised.** No custom-reducer hot path showed
  up (reductions are cheap and array-side), and the Queen K track has no GPS
  dropouts. Both await messier data.

- **F-geo-5 — packed geo column kind — no support from M1.** The two-number-
  column model is fast enough (table above) that a packed kind earns _nothing_
  on perf at this scale. First concrete data point for §7's "do not open the
  kind system for geo alone."

### 10.3 New friction not in §5 (row construction)

Surfaced from building a track whose optional `ele`/`hr` cells may be missing.

- **F-geo-row-optional — the tuple-row constructor can't express a missing
  optional cell** (the one genuine new finding here). Three-way mismatch:
  - The **type** `RowForSchema` types every cell strictly by kind and _ignores_
    `required: false` — `null`/`undefined` in a row tuple doesn't typecheck
    (only the JSON object-row input allows `null`).
  - At **runtime** the constructor rejects both `null` **and `NaN`**
    (`ValidationError: row N col M: expected finite number`).
  - `undefined` _is_ accepted at runtime — and sets the validity bit correctly
    (see 10.4) — but the type forbids it.
  - So the lossless path is `undefined` + a cast. estela casts the rows
    (`rows: points as never`). It works and is lossless; the only residue is the
    **type-level** mismatch.
  - **Proposed:** make `RowForSchema` honour `required: false`
    (`… | null | undefined` for optional cells) so the type matches the
    runtime's `undefined` acceptance, and document the intended tuple-row
    missing sentinel.

### 10.4 Refuted predictions (verified before claiming)

Two assumptions checked against pond's actual types and **retracted** — flagged
so the friction list stays honest (and as a reminder to grep the public surface
first):

- **"No typed-array accessor for the key/time column."** False —
  `track.keyColumn().begin` returns the `Float64Array` of ms timestamps, clean
  and fast. (An initial `toArray()` + per-event walk was both wrong and slow;
  corrected.)
- **"`toFloat64Array()` flattens missing to `0` irrecoverably"** (an earlier
  draft of this section claimed this as `F-geo-validity` and asked for a new
  `validityMask()`). Also false: pond already exposes validity publicly —
  `column.hasMissing()`, `column.validity` (`ValidityBitmap.isDefined(i)`), and
  `column.scan(fn, { skipInvalid })`; `count()` is validity-aware. The
  `0`-flattening of `toFloat64Array()` is by design, with validity available
  alongside (its own JSDoc says so). estela now reads missing cells back as
  `NaN` via `column.validity` — **no library change needed.** Caught in the
  estela-side adversarial review before it reached you; recording it here rather
  than silently dropping it.

### 10.5 Open questions still open after M1

- **§8.1 (distance axis):** answered with a recommendation (10.2 shape 2) —
  needs a library-side design pass.
- **§8.2 (does a packed kind ever earn its place?):** M1 says _not on perf_.
  The metric that would flip it remains unidentified.
- **§8.4 (multi-activity / `partitionBy`):** untested — M1 is one activity. The
  next milestone (many activities, or segment analysis within one) is where
  this gets exercised.

## 11. Use-case agent feedback — estela, M2 (power)

> _Posted by the estela experiment agent (Claude)_

M2 went past geo into **power analytics** on a real power-meter ride ("IM
Vineman: Bike", 26,318 1 Hz FIT records): normalized power, the power
distribution + FTP zones, the mean-maximal power curve, work, training load —
again on pond's public surface. Validated vs Strava: work 3230/3232 kJ (exact),
max 477 W (exact), **zone split 30/25/19/11/6/7/3 (exact)**. (avg and NP diverge
for definitional reasons — Strava's avg is work÷moving-time, NP smoothing
varies — recorded estela-side, not pond's problem.) The reason it belongs in
this RFC: it produced a **second, independent confirmation of the deepest
finding.**

### 11.1 F-geo-2 is not about distance — it's value-axis bucketing

M1 wanted to bucket over _cumulative distance_ (splits, elevation profile). M2
wants to bucket over _power_: an even-width histogram (25 W bins) **and** an
FTP-relative-edges histogram (the 7 Coggan zones). Same missing primitive, a
different derived column, a different binning rule. That's **three independent
value-axis bucketings across two experiments**, which sharpens the §8.1
recommendation:

- The operator should bucket over **any value column**, not distance
  specifically — `aggregate(byColumn(col, { width }))` for even bins **and**
  `aggregate(byColumn(col, { edges: [...] }))` for explicit (e.g. FTP-relative)
  edges.
- It composes with **F-geo-1** (attach the derived column first, then bucket
  over it).
- This raises F-geo-2's priority: it's now the single most-requested primitive
  from the experiment, wanted by splits, elevation profile, power distribution,
  zones, and (next) speed-vs-distance.

### 11.2 New, lower-urgency

- **F-power-curve — mean-maximal over many windows.** The power curve is a
  rolling-mean-then-max swept across ~15 durations. `rolling` does one window
  per call, so the curve is N calls; estela used a cumulative-work prefix sum +
  two-pointer scan (O(n) per duration) instead. A `meanMaximal(col,
durations[])` (or multi-window rolling) would be the native expression — but
  the workaround is fast and this is low priority.

### 11.3 Minor + a win

- **`'avg'` vs `.mean()`.** NP's 30 s smoothing is `rolling('30s', { watts:
'avg' })` — but the first attempt used `'mean'` (the column-API spelling) and
  threw inside `normalizeAggregateColumns`. The aggregate/rolling reducer is
  `'avg'`; the column reduction is `.mean()`. Aligning the names (or accepting
  both) would remove a small stumble.
- **Win:** that one call — `rolling('30s', { watts: 'avg' })` then read the
  smoothed column via `toFloat64Array()` — is the whole NP smoothing step, and
  it's clean. The timeseries-native metric (NP) is exactly where pond shines;
  the value-axis ones (distribution/zones) are exactly where it doesn't yet.
