# PND_ECOSYSTEM_PLAN — Ecosystem and adapters (Phase 6)

> Breakout plan for the **Ecosystem** roadmap section in [PLAN.md](../../PLAN.md).
> Tasks: [PND-SERVER], [PND-NODE], [PND-FITPUB]. Moved from PLAN.md (Phase 6)
> on 2026-07-20; the content below is the original phase plan, unchanged except
> this header and the PND-FITPUB section appended at the end.

Status: not started.

Goal: make Pond easier to adopt in real products before committing to a full
first-party charting system.

Scope:

- `pond-ts/node` — Node stream adapters (`Readable`/`Writable`); views and live
  aggregations also expose `.toReadable()`
- `pond-ts/adapters` — bridge helpers such as `toRecharts`, `toObservablePlot`
- improved docs and examples for integrating with existing chart libraries

Later, only after the previous phases are stable:

- **`@pond-ts/server`** — first-party server package extracted from the gRPC
  experiment's aggregator + WebSocket fan-out shape. Owns the
  WS-snapshot-then-deltas pattern, `WireMsg<T>` envelope versioning,
  heartbeat / slow-client policy, server-side backpressure, and schema-to-
  wire coordination. Depends on Phase 4.5 milestones C
  (`AggregateEmission` + stable IDs) and D (`keyBy/window/aggregate`)
  landing first. Will likely pull emission-history snapshots forward from
  RFC phase 5 when the snapshot-on-connect pattern needs them. Core stays
  connector-light per the streaming RFC; the server package owns the
  deployment shape.
- `@pond-ts/charts` — first-party chart components built directly on the
  `pond-ts` data model, successor to `react-timeseries-charts`. Strategic
  positioning: **the visualization end of pond** — `data → pond → charts`
  with zero friction, where the pond pipeline is the moat. Scope is
  **timeseries only** (line, band, bar, scatter, box); not pie, treemap,
  or generic visualization.

  **v1 does not depend on Phase 4.5 milestone C.** Only the final
  `fromAggregateEmission` adapter does — v1 ships earlier with a loose
  pre-milestone-C wire shape contained inside the adapter layer. The
  sequencing reason is bandwidth: streaming-RFC work earns more leverage
  until milestone C is in flight.

  **Full design** in [`docs/rfcs/charts.md`](../rfcs/charts.md). Covers
  the layered-engine architecture (pond source → adapter → typed-array
  store → viewport/decimator → chunked Path2D cache → canvas renderer
  → React shell), the `ChartDataSource` interface, the v1 component
  reduction (rendering spine + `LineChart` + `BandChart` only;
  `BarChart` / `ScatterChart` / `BoxChart` as v1.1 layer implementations),
  the 9 implementation traps from the gRPC experiment, the uPlot
  technique inventory reweighted for the library's scale, and the
  perf-invariant test surface. Authorship trail: original gRPC-experiment
  RFC + pjm17971 strategic frame + Codex architectural review + library
  agent amendment.

  **Cross-references:**
  - Working canvas implementation:
    [pond-grpc-experiment#37](https://github.com/pjm17971/pond-grpc-experiment/pull/37)
    (merged; 50 MB plateau vs Recharts OOM at 1–5 min).
  - Original friction-note RFC:
    [`canvas-chart-primitive.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/rfcs/canvas-chart-primitive.md).
  - Layout-primitive design template:
    [react-timeseries-charts](https://github.com/esnet/react-timeseries-charts).

- **gRPC stream processor experiment** — in progress at
  [pjm17971/pond-grpc-experiment](https://github.com/pjm17971/pond-grpc-experiment).
  Three-tier setup: producer (Node, gRPC) → aggregator (Node,
  WebSocket fanout) → React app, all sharing one `as const` schema
  via `pond-ts/types`. Exploratory: characterizes the single-thread
  aggregator's operating envelope, surfaces the friction notes that
  drive library follow-ups (already shipped: `pond-ts/types`
  subpath in v0.11.3; queued: snapshot/append primitives on
  `LiveSeries` — see Phase 4). Real high-throughput workload would
  also surface routing-overhead bottlenecks with actual data
  (currently the partition routing path is ~0.8 µs/event due to
  row revalidation in `LiveSeries.push`; we deferred the
  optimization for v0.11 because synthetic measurements weren't
  enough signal). Becomes a reference deployment shape for users
  who want pond-ts pipelines in their own services; M5's extraction
  sweep should yield three RFCs (`@pond-ts/server`,
  `useRemoteLiveSeries` for `@pond-ts/react`, `@pond-ts/dev-producer`)
  and — once two codecs exist in working code (JSON on the WS hop,
  protobuf on the gRPC hop) — likely an `Adaptor` interface in a
  separate `@pond-ts/adaptors` package. Separate repo, not part of
  the npm packages.

### Package structure

Monorepo with npm workspaces (`packages/*`):

```
pond-ts              -> packages/core — batch + live library
@pond-ts/react       -> packages/react — React hooks
@pond-ts/charts      -> future — first-party chart components
```

Subpath entry points within `pond-ts`:

```
pond-ts              -> core batch library
pond-ts/live         -> LiveSeries, subscriptions, retention, live transforms
pond-ts/node         -> Node stream adapters (Readable/Writable, future)
pond-ts/adapters     -> bridge adapters for third-party chart libs (future)
```

Browser-safe by default. Node-specific APIs go behind a separate entry point.

Definition of done:

- Node-specific APIs stay out of the browser-safe default entry point
- adapters solve common "how do I graph this?" questions in the docs
- a chart package remains an intentional future decision, not implied scope creep

---

## [PND-FITPUB] — `@pond-ts/fit` first-publish pass

**Status 2026-09-23:** `@pond-ts/fit` is now `private: false` and publishes
lock-step with the other packages (0.70.0 on npm), so "first publish" has
happened by default. The deliberate pass below is still undone — none of
`simplify`, `elevationProfile`, `profileByDistance` or `rollingSpread` is
exported from `src/index.ts` today.

`@pond-ts/fit` landed on main (#288/#290/#293) but is still `private` /
unpublished. Before first publish:

- **Export-list pass** (flagged in the #293 review): the barrel curation left
  a few geo analytics with no public path — neither barrel nor façade —
  `simplify`, `elevationProfile`, `profileByDistance`, `rollingSpread` (the
  last likely superseded by core `rollingByColumn`). Decide deliberately which
  get a public door. Power analytics stay reachable via `PowerSummary` + the
  façade (verified, not affected).
- **Units-preference home** + any remaining façade demotion of the operator
  surface.
- Then publish (new-package OIDC bootstrap per the release notes'
  `npm new-package publish bootstrap` memory), and the estela agent swaps to
  the npm package (adopting both `@pond-ts/fit` and `@pond-ts/charts`) and
  deletes its local copy — tracked on the experiments roster
  ([PND_EXPERIMENTS_PLAN.md](PND_EXPERIMENTS_PLAN.md)).

Context: [docs/rfcs/fit.md](../rfcs/fit.md),
[docs/rfcs/geo.md](../rfcs/geo.md) §10–§13, estela's `docs/pond-friction.md`,
and the estela section of
[docs/archive/experiments-2026.md](../archive/experiments-2026.md).

## [PND-FITSWIM] — swims (part of [PND-FITESTELA])

**Shipped.** `ImportedActivity.swim` (`SwimData`, `SwimLength`), `activity.swim`,
`swimMovingSeconds(laps)`; the summary's moving time is the swim time when an
import carries one (finite and above 0), else the sample estimate. Lifted from
Estela's `packages/core/src/swim/index.ts` and the general half of `fitSwim`
(`packages/ingest/src/fit.ts`). Reading the pool and lengths from a FIT file
comes with the readers. Not done: a range or lap inside a swim still takes its
moving time from samples; per-length sections. Cropping a swim (the cutting
step) will have to share the swim time out too.

## [PND-FITFILES] — file readers (part of [PND-FITESTELA])

**Shipped.** `@pond-ts/fit/files`: `parseFit` / `parseGpx` / `parseTcx` and
the FIT helpers, from Estela's `packages/ingest` (fit.ts, gpx.ts, tcx.ts,
recovery.ts). Decisions:

- **A subpath entry, not `Activity.fromFit`.** The `fromStreams` comment
  promised `fromFit` etc.; putting them on `Activity` would load the FIT
  decoder for every consumer of the façade. `Activity.fromStreams(parseFit(b))`
  is one line.
- **`fit-file-parser` as a dependency** (MIT; pulls `buffer` for browsers).
  Typed locally (`fitParser.ts`) so the published types don't lean on the
  parser's `any`-typed ones or an ambient module declaration.
- **Device names stay with the app.** The readers report what the file says
  (`creator`: FIT maker + product number + product name; TCX / GPX creator
  string). Estela's Garmin product → model-name table comes from the Garmin
  FIT SDK profile under the FIT Protocol License, which is not MIT; keeping it
  out of a public MIT package avoids the question. Estela keeps
  `device.ts` + `fitProfile.data.ts` and names devices from `creator`.
- **`'file'` source.** Estela stamped files `source: 'manual'`, the same as
  hand-entered activities (its 2026-10 review flagged the double meaning).
  The readers default to `'file'`; `options.source` keeps old behaviour.
- **GPS lock included.** A FIT file keeps records with no fix as `null`
  positions plus the watch's distance — Peter's call (2026-10-21), pairing
  with #801. On Estela's real fixtures this is the only output change (27–45
  records on three Garmin files).
- **Fixtures are synthetic.** Estela's test files are real people's
  activities and this repo is public, so the tests use FIT files written with
  the Garmin FIT SDK (`test/fixtures/make-fit-fixtures.mjs`) and inline
  GPX / TCX. The real-file checks stay in Estela, run against these readers.

Not moved: Estela's Strava-export and RunningAhead readers, its ids, its
device naming.

## [PND-FITBREAKS] — stops, walk breaks, heart rate recovery (part of [PND-FITESTELA])

**Built.** Estela's `recovery/breaks.ts` and the generic half of
`recovery/index.ts`, ported to `packages/fit/src/recovery`. Same algorithm and
constants; output identical to Estela's on its three real test runs (city
stops, two run/walk runs), checked locally against Estela's copy and not
committed (personal recordings). Pond's tests use made-up runs, including a
run/walk with wavering walking pace in place of Estela's canal fixture.

Changes from Estela's copy: `null` samples and fixes are accepted (a missing
distance carries the last one; a missing fix adds no distance); GPS distance
uses pond's `haversineMeters` (Earth radius 6,371,008.8 m vs Estela's
6,371,000, about 1 part in a million). The Apple Watch record reader
(`recoveryFromWatch`) stays in Estela since its record format is Estela's;
its core is `recoveryFromReadings`. `recoverySummary` keeps any extra fields
(Estela adds Apple's one-minute figure) and no longer returns undefined.
`looksForBreaks` and `pastRecoveries` stay in Estela: both depend on its
sport-family table. `RECOVERY_MAX_SECONDS` now lives here and the FIT reader
imports it.
