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
| Use-case agent feedback (estela experiment)  | _pending_                                           |
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
