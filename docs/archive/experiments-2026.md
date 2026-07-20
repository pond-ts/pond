# Archive: multi-agent experiment histories (through 2026-07)

> **Archived from PLAN.md on 2026-07-20** as part of the PLAN reorganization.
> Frozen historical record — do not update. The current roadmap lives in
> [PLAN.md](../../PLAN.md); per-area breakout plans live in [docs/plans/](../plans/).

## Active experiments

Pond is battle-tested through parallel multi-agent experiments — see
[CLAUDE.md "Multi-agent experiments and the feedback model"](../../CLAUDE.md#multi-agent-experiments-and-the-feedback-model)
for the philosophy. This section is the canonical roster: who's
working on what, what each has driven into the library, where each
track is now.

### Internal robustness audits

Complementing the experiment loop (which surfaces _user-facing_ API
friction), a fresh model periodically does a full-project read-only
audit targeting _internal_ robustness — the issues experiments route
around rather than report. As the available model improves, re-run.

- **2026-06-10 (fable, against v0.20.0):**
  [`docs/notes/technical-audit-2026-06.md`](../notes/technical-audit-2026-06.md).
  Healthy baseline (~2,100 tests, ~zero debt markers, honest decision
  log). Top findings triaged into the backlog: live-layer listener
  error isolation + re-entrancy contract; partition-cardinality cap
  (double-signalled with the metric-agent review); perf-scripts-in-CI
  - coverage; React `useSyncExternalStore` migration; operator
    extraction + type-safe schema helpers. Two findings cross-validated
    independent signals (partition OOM; the "which aggregation style"
    doc gap), which bumped their rank.
- **2026-06-12 (opus, against v0.21.0):**
  [`docs/notes/technical-audit-2026-06-v2.md`](../notes/technical-audit-2026-06-v2.md).
  Confirmed the Step-4 column-native wave goal empirically (pipeline tax
  fixed; ~11.8k differential-fuzz cases, zero mismatches on type-correct
  input). Surfaced **three P0s — all fixed for v0.22.0:** §1.2 `asTime`
  monotonicity guard ([#201](https://github.com/pjm17971/pond-ts/pull/201));
  §1.3 `mapColumns` rejects non-finite numeric results at write, consistent
  with intake ([#202](https://github.com/pjm17971/pond-ts/pull/202)); §1.1
  `aggregate('stdev')` silent numeric change + NaN crash, fixed by unifying
  `reduce` / `reduceColumn` / `bucketState` on one **Welford** recurrence
  ([#203](https://github.com/pjm17971/pond-ts/pull/203) — a Codex pass caught
  that bucketState-only Welford still diverged from the two-pass `reduceColumn`
  ~8.7% at 2^52; Welford chosen over buffered two-pass to keep the shared live
  path O(1), at the cost of `reduceColumn` stdev ~3× a divisionless scan).
  **Open follow-up (not gating 0.22.0):** the computed columnar writers
  (`cumulative` / `diff` / `shift` / `collapse` via `float64ColumnFromArray`)
  can still pack non-finite (overflow → Inf, 0/0 → NaN) — the §1.3 sibling; the
  candidate fix is a principled reducer NaN policy (consistent fast/row/bucket/
  rolling for all inputs), not a blanket builder throw. Perf P1s still open:
  partitioned `aggregate` never takes the 3B fast path; cold `aggregate()`
  materializes via `timeRange()` (columnar `timeRange` is the cheap fix);
  `partitionBy().op().collect()` (~920 ns/row) is the top batch hotspot.

  **v2 backlog beyond the P0s** (full detail in the linked doc; this is the
  actionable integration so the findings aren't stranded in the note):
  - **P1 — live robustness cluster** (§4; empirically reproduced, third audit)
    — ⏳ **STILL OPEN; the standing live-correctness P1** (#114/#98/#99). The
    one piece of non-speculative core debt left from this audit — confirmed
    wrong-answer behavior under code already in flight, not an optimization.
    Travels with the reorder+retention windowed-extrema bug from the
    live-columnar assessment (`docs/notes/live-columnar-assessment-2026-06.md`).
    listener error isolation (a throw skips retention entirely + a derived
    `filter()` view desyncs permanently), re-entrancy (3 failures incl. the
    `[object Object]` error at `live-view.ts:704`), unbounded partitions
    (push-driven `maxAge` never evicts quiet keys; `maxPartitions` silently
    ignored), **chained dispose** (`live.filter().map()` orphans the
    intermediate — no way to dispose it; `dispose()` has no JSDoc). Items 1–3 →
    tasks #98/#99; chained-dispose + evict-staleness + the empirical upgrade →
    new task #114.
  - **P1 — columnar `timeRange()`** (§3.3) — ✅ **SHIPPED #214 (v0.24.0)**: cold `aggregate()` defaults `range`
    to `series.timeRange()`, materializing all events (430 ms/1M) before the
    fast path runs (one-shot callers see ~1.09×). `begins[0]..begins[n−1]` off
    the key column (`time-series.ts:3664`) → ~21× faster cold path, every
    caller benefits → new task #115.
  - **P1 — partitioned-aggregate fast path + columnar partitionBy split**
    (§3.2/§3.3) — ✅ **SHIPPED #215 + #216 (v0.24.0)**: the auto-injected `'first'` partition reducer had no
    `reduceColumn`, so the all-or-nothing gate bails for _every_ partitioned
    aggregate (~14× slower than it should be); and `partitionBy().<op>()` buckets
    via `source.events` + rebuilds via `fromEvents`, re-paying the tax — the top
    batch hotspot and the library's own recommended pattern. Columnar partition
    split (scatter by group index) is the highest-leverage next batch target,
    ahead of 3C → new task #116.
  - **P1 — greenfield adoption killers** (§5) — ✅ **SHIPPED #206 + #211 (v0.23.0)**: F1 — mixed shorthand+`{from,
using}` aggregate mappings resolved to the shorthand overload and silently
    drop every spec-keyed output column from the result _type_ (runtime emits
    it); F2 — shipped `.d.ts` fail under `skipLibCheck: false` (`EMITS_EVICT`
    stripped from `series.d.ts` but its re-export survives in `index.d.ts` →
    TS2305). Both first-hour killers, both cheap → new task #117.
  - **P2 — wave mediums** (§7): `collapse` mixed-kind → silent missing (row-0
    inference); `fill` literal `undefined` now throws; `slice`/rekey dropped
    cross-derivation identity + zero-copy results pin the parent's full buffers
    (subarray retention — doc + copy-out pointer); inconsistent unknown-column
    handling across the 6 ops (2 skip, 4 crash); `kind→builder` triplicated
    (fill/map/collapse); `withKeyColumn` breaks `with<Noun><Participle>`;
    `asInterval` cast-bypassed label rejection works by accident → fold into
    #104 (papercuts) + #106 (parity matrix covers NaN-untested).
  - **P2 — smaller** (new task #118): `Sequence.calendar('hour')` accepted with
    no unit validation → silent garbage (runtime throw, §6); `validateAndNormalize`
    is dead code — cleanup (§2); #200's three redundant self-casts at
    `time-series.ts:1378/1399/1457` (§2); F3–F12 doc/type (unsorted-rows
    `{sort:true}` + ingest doc, `Time.asString`, CJS error, source maps, §5).
  - **Carried, already tracked:** CI TZ matrix + perf-in-CI (§3.3/§6 → #100),
    cast growth + schema helpers (§2 → #102), parity matrix (§1.1/§7 → #106),
    bundle re-pin 48.5 KB vs <25 KB RFC (§7 → #108), 3C rolling after the NaN
    doc (§3.4).
  - **Process (§8), discipline note not a task:** #186 merged 66 min after a
    medium-confidence L2 that recommended Codex + deferred two decisions, with
    no committed record — the exact gap this wave's stdev re-fix _avoided_ by
    actually running the Codex pass. The confidence machinery was accurate (the
    dimension it "cleared," parity, is where all three P0s lived); hold the
    merge discipline around it.

### CSV-cleaner (complete; v0.9.x)

Three-agent run (Claude, Codex, Gemini) on a real per-host metrics
CSV with mixed timestamp formats, four spellings of "missing,"
duplicate-retry rows, and gap-from-missed-scrapes. Each agent
produced an independent friction report; library responded with a
coordinated v0.9.x wave.

- **Drove:** `partitionBy`/`PartitionedTimeSeries` (cross-entity
  correctness), `dedupe({ keep })`, `fill(maxGap)` + all-or-nothing
  fill semantics, `**Multi-entity series:**` JSDoc warnings on every
  stateful operator.
- **Writeup:** `website/docs/how-to-guides/ingesting-messy-data.mdx`.
- **Source folder:** `experiments/csv-cleaner/` (PROMPT.md, RUBRIC.md,
  SPEC.md, generate.ts, messy.csv, results/).
- **Notable:** Gemini escaped its sandbox, found the experiment
  folder, cheated. We laughed.

### Dashboard (ongoing as reviewer; drove v0.10-v0.11.0)

Built a full webapp at
[`pjm17971/pond-ts-dashboard`](https://github.com/pjm17971/pond-ts-dashboard).
The dashboard agent stays involved as the React/charting domain
expert and reviews PRs touching that surface. **`@pond-ts/charts` has now
extracted (M0–M4.2 + chart types + value-axis), so the next move is dashboard
ADOPTION** — swap our charts in for its hand-rolled canvas charts and report the
gaps + any perf slips vs its own. That comparison is the honest test of whether
the package earns its place (and one of the inputs that should drive the chart
roadmap).

- **Drove:** v0.11.0 `LivePartitionedSeries` (named explicitly as the
  "obvious next step" in round-2 feedback), `useCurrent` reference
  stability, `pivotByGroup` typed `groups`, `useEventRate` /
  `LiveView.eventRate()`, `useCurrent` value narrowing.
- **Writeup:** `website/docs/how-to-guides/dashboard-guide.mdx`.

**Current wave (2026-06): per-render cost at 256-host stress.** The
dashboard now stress-tests at 256 hosts × 250–500 ev/s, which surfaced a
cluster of allocation/rebuild friction (three reports in
`~/Notes/Projects/Pond/`: snapshot-side `partitionBy.toMap` gather, snapshot
flush cost, wide-schema metrics). The library response, ranked by
value-per-surface (surface-area sensitivity is now an explicit constraint —
no hard-to-explain toggles):

- **Shipped:** [#180](https://github.com/pjm17971/pond-ts/pull/180) —
  `LiveView.toTimeSeries()` memoized by a mutation counter (the flush-cost
  report's issue #1). Back-to-back identical-state snapshots return by
  reference: >1 s React commits → ~0 (44 ms → 0.0001 ms at 262k events).
  **Zero public surface.**
- **Queue** (surface-minimal first): NaN-as-missing error nudge (wide-schema
  #3, zero surface); `push` × N vs `pushMany` jsdoc warning (90,000× gap,
  zero surface); **`TimeSeries.partitionBy().toMap()` gather-only** — the
  snapshot dual of increment 1's `LiveView` column gather, the dashboard's
  biggest validated ask (workaround already bought 218 ms → 300 μs at 256
  hosts); `column.dropMissing()` (wide-schema #7, the only correctness item).

**Live zero-copy arc — explored, measured, DEFERRED (2026-06-03).** The
"column-native output" arc (chunk `collect()`/rolling output for zero-copy
per-partition reads) was scoped and sized, then parked. Two measurements
killed it at realistic scale: `perf-band-gather.mjs` showed the per-partition
band gather is **<6% of a frame at ≤64 hosts** (hot only at the 256-host /
fast-clock ceiling), and the synchronized rolling output is
partition-**interleaved** (not per-partition contiguous), so a zero-copy
windowed read doesn't even apply without a hard-to-explain opt-in mode. The
real friction is the snapshot-side cluster above, not the arc. #175 (its P0)
stays merged on its own gRPC-OOM merits. Detailed briefs + the
`windowColumn` spike + `perf-baseline-memo-split.mjs` /
`perf-liveview-structural.mjs` live on branch `spike/structural-window`;
`docs/briefs/collect-output-columnar-arc.md` is the arc's design record.
Revisit only if a 256-host-class dashboard becomes a committed target.

### gRPC pipeline (M3.5 done; **V5 columnar re-bench wave queued 2026-05-28**)

Claude agent. Three-process gRPC + WebSocket stack: producer
(`@pond-ts/dev-producer` candidate) → aggregator (`@pond-ts/server`
candidate, runs a server-side `LiveSeries`) → web dashboard (the read
side, `useRemoteLiveSeries` candidate). Targeting M5 extraction
sweep producing three RFC-style design docs.

**Active wave: V5 columnar re-bench.** Per Phase 4.7's "Next wave"
sequencing, the experiment re-benches against the matured substrate
(v0.17.1 vs the V4 baseline at v0.14.0) to surface which substrate
step earns library work next (Step 7 LiveSeries ring buffer vs
Step 3 Phase C rolling fast path). Plan:
[`columnar-rebench.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/columnar-rebench.md).

- **Drove so far:** v0.11.3 (`pond-ts/types` subpath export — schema-
  as-contract without runtime dep), v0.11.4 (`LiveSeries.toJSON` /
  `pushJson` / `pushMany` / `Event.toJsonRow` — codec-agnostic
  snapshot+append primitives), v0.11.5 (packaging fix — README/
  LICENSE/CHANGELOG in tarballs), v0.11.6 (count() doc clarification
  on duplicate keys; the M3 friction notes confirmed this fixed M1's
  misdiagnosed stagger workaround), v0.12.0 (Trigger
  primitive — M3.5's `HostAggregator` motivated the synchronised
  partitioned-rolling shape; webapp telemetry's `.sample()` use case
  folded into the same redesign).
- **Milestone files:** `experiments/grpc-pipeline/{PLAN,LINKS,M0..M3.5}.md`.
  - M3 (PR #8) — throughput-characterisation friction report, gRPC
    framing-bound at 73k events/sec, captured in PLAN under
    "Performance expectations and the bench-vs-real-world gap."
  - M3 phase A (PR #9) — `EventBatch` wire batching, 22k → 486k
    events/sec at the saturation cell; pond is genuinely under
    pressure now (~30% wall-clock minor GC). Confirmed bench numbers
    are real-world-validated.
  - M3.5 (PR #11, PR #13) — server-side aggregation slice; surfaced
    that pond had no synchronised-partitioned-tick primitive,
    forcing a hand-rolled `HostAggregator`. Resolved by the v0.12
    Trigger redesign (RFC: `docs/rfcs/triggers.md`).
- **Carry-forwards to `@pond-ts/server` RFC:** coalesce strategy with
  tested default windowMs, reference EventBatch-style proto in
  examples, snapshot-cache design, slow-client policy defaults,
  per-phase metrics histograms (`pushManyTotalMs`, `fanoutRecordMs`,
  `fanoutSerializeMs`, `fanoutBroadcastMs`) as opt-in defaults.
- **V4 validation (2026-05-01).** After v0.14.0 shipped, the
  experiment re-profiled and produced a four-way bench (V1 manual
  `HostAggregator` → V2 v0.12 trial → V3 v0.13.0 → V4 v0.14.0).
  Every CHANGELOG-claimed delta from the v0.14.0 wave shows up in
  the bench: heap −17% to −50% across moderate loads, ceiling
  throughput +23% (208k → 256k/s), tick fps +30%, p99 1.91ms →
  1.15ms. The two profile-flagged hot spots
  (`estimateEventBytes` + `Event → row → Event` round-trips) are
  gone or reduced as advertised. **The remaining ~38% ceiling gap
  to V1 is now isolated to one operator:**
  `LivePartitionedSyncRolling.ingest` per-event reducer-state
  work (8.2% self time at V4 ceiling, larger share than V3's 4.1%
  only because more events are processed per second — the per-event
  cost is roughly unchanged). Reducer batching is the natural
  next lever IF a future user pushes near ceiling; production
  target is 100k/s (V4 hits 256k/s = 2.56× headroom), so it
  doesn't earn its API surface yet. PR #14 on
  `pond-grpc-experiment` carries the four-way story; the
  experiment is now considered fully realized for the M3.5
  scope and ready for its writeup.

### Charts experiment (kicked off 2026-05-26; validates Phase 4.7 substrate against chart use case)

> **Superseded 2026-06-17** by the committed canvas wave — see
> [Current focus → `@pond-ts/charts`](charts-wave-2026.md#current-focus--pond-tscharts-canvas-wave-kicked-off-2026-06-17)
> at the top. This experiment (a paused, raw-canvas validation harness)
> remains the source of the substrate-access friction notes the wave builds
> on; it is no longer the live charts track.

Claude agent at
[`pjm17971/pond-ts-charts-experiment`](https://github.com/pjm17971/pond-ts-charts-experiment).
Pulled forward from the planned step-8 chart-extraction alignment
because pre-step-3 was the right moment to validate that the
substrate ACTUALLY serves the chart use case it was strategically
motivated by. Steps 3–7 are downstream of that justification; if
the chart adapter can't consume the substrate cleanly, the
back-half of the columnar roadmap is mis-targeted.

The pond-ts side already shipped:

- **Spike PR #152** — `series.column(name)` + `series.keyColumn()`
  experimental accessors. Measured **~9× faster per-frame walk**
  via typed arrays vs the row-API path at N=1M.
- **Friction notes** at
  [`docs/notes/chart-spike-friction.md`](../notes/chart-spike-friction.md)
  capturing 7 design questions for steps 3–8.

The experiment repo's job is to **validate the spike's claims in a
real browser environment** with an interactive chart (pan / zoom /
range-select). Five workloads in priority order: (1) single-column
line chart scaling 100k → 1M → 10M; (2) multi-column overlay;
(3) chunked-column rendering after `concatSorted`;
(4) range slicing for zoom; (5) interval-keyed heatmap.

- **Will drive:** step 8 (chart-extraction alignment) scope
  refinement based on real friction. May also drive step 4
  (derived transforms) if windowing / slicing surfaces gaps.
- **Stack:** Vite + React + TypeScript + raw Canvas (no chart
  library — pond-ts friction in foreground).
- **Status (updated 2026-06-28):** M1 + M2 shipped (single-column line chart
  100k→10M; multi-column overlay — substrate access validated, 60 fps at N=10M;
  M3/M5 chunked/heatmap deferred). The repo has since **pivoted from raw-canvas
  validation to being the first `@pond-ts/charts` _package_ consumer**: a
  network-traffic dashboard exercising the annotation API end-to-end (toolbar +
  synced legend + inspector + all three interaction modes;
  `friction-notes/annotations-consumer.md`, which drove the `AnnotationKind` /
  `CreateSpec` barrel export). No longer paused — it's now the charts-adoption +
  friction dogfood.

### Webapp telemetry (ongoing; drove v0.11.8)

Codex agent. Frontend telemetry-stats reporting (collect latency
events, sample percentiles to a backend every 30 s, display live in
React). Real production code in a trading-platform app.

**Status (2026-06-28): shipping to PRODUCTION the week of 2026-06-29** — pond's
first production deployment with live user data (rolling stats on real front-end
performance telemetry). The validation that the live rolling-stats path holds up
under real load + messy real-world telemetry.

- **Drove:** v0.11.8 `rolling.sample(sequence)` (later subsumed by
  v0.12.0 triggers). The first design attempt was an
  overload (`live.rolling(Sequence, '1m', mapping)`) mirroring the
  batch shape; closed PR #92 walked that back after implementation
  surfaced a hidden-ownership leak and locked-away rolling state.
  v0.11.8 (PR #93) shipped `.sample()` as a separate composition step.
  Then the gRPC experiment's M3.5 work surfaced that `.sample()` was
  itself overly specific — the deeper factoring is `Source × Trigger
× Aggregation`, with `.sample()` collapsing into "rolling with a
  clock trigger." v0.12.0 ships `Trigger.clock(seq)`
  as a first-class concept; `.sample()` and `LiveSequenceRollingAggregation`
  are deleted. The webapp telemetry agent migrates from `.sample()`
  to `{ trigger: Trigger.clock(seq) }` as part of v0.12 adoption.
- **Surfaced as next deferred:** the `AggregateOutputMap` overload
  on `LiveSeries.rolling()`. The Codex code duplicates the same
  numeric value into four columns named `p50`/`p75`/`p95`/`count` to
  satisfy `AggregateMap`'s "one reducer per column" constraint —
  exactly the gap PLAN's deferred section predicted.

### estela (geo + power; drives `@pond-ts/fit`; kicked off 2026-06-14)

estela — "a story-first record of long journeys" (sibling repo) — is the
use-case experiment driving **`@pond-ts/fit`**, the activity-analytics umbrella
(reframe from `@pond-ts/geo`, adopted 2026-06-15:
[`docs/rfcs/fit.md`](../rfcs/fit.md)). Two milestones, both validated against
Strava's own numbers on real files, both built entirely on pond's public
surface (zero core changes — the geo-RFC thesis held; of a 4.2 ms M1 pipeline,
<0.3 ms touches pond):

- **M1 (geo):** a 123 km / 15,207-pt ride — distance / elevation / splits /
  profile / polyline; +0.2% distance vs Strava, exact elapsed.
- **M2 (power):** a power-meter FIT — NP / FTP zones / mean-maximal curve /
  work / TSS; **exact** zone split + work vs Strava.

**`@pond-ts/fit` LANDED on main 2026-06-28.** The library extracted from estela's
proven copy into its canonical home: **#288** (`a73456a`) the base package
(quantities, canonical activity series, geo/power/zones/profile/summary, Activity/
Section façade; 143 tests), then **#290** (`d2f60a6`) `Profile` + `usingProfile()` →
`ProfiledActivity`/`ProfiledSection` (façade-first slice 1, + an RFC at
`packages/fit/docs/rfc-facade-first.md`), then **#293** (`2d0f815`, **MERGED
2026-06-28**) the release-prep consolidation: quantity `.format()` (slice 2), a `Track`
value object (slice 3), `windowChannels` as a method, and barrel curation (drop the
four blanket `export *` for a single curated flat barrel — demoting the operator
surface to the Activity / Section / Track / Profile façade). The standalone slice PRs
(#289 barrel, #291 slice 2, #292 slice 3) were **closed in favour of #293**.
**Publish-time flag (from the #293 review):** the curation left a few geo analytics
with no public path — neither barrel nor façade — `simplify`, `elevationProfile`,
`profileByDistance`, `rollingSpread` (the last likely superseded by core
`rollingByColumn`); fine while `private` / unpublished, but the export list earns a
deliberate pass at first publish (power analytics stay reachable via `PowerSummary` +
the façade — verified, not affected). **Still sequenced:** (1) the units-preference
home + any remaining façade demotion of the operator surface; (2) **estela's own
adoption is NOT done** —
estela still consumes its local copy and **has not adopted the shipped value-axis
primitives** (`scan` / `byValue`); `geo.segmentsInRange` etc. are still hand-rolled
(`split = scan + byColumn` is the available-but-unadopted path); (3) publish, then
estela swaps to the npm package (adopting **both** `@pond-ts/fit` + `@pond-ts/charts`)
and deletes its local copy. **Docs gap:** the website docs lag the value-series wave
(`scan`/`ValueSeries`/`byValue`) — status currently only legible from the code (see
Documentation backlog).

Docs: [`docs/rfcs/fit.md`](../rfcs/fit.md),
[`docs/rfcs/geo.md`](../rfcs/geo.md) §10–§13 (use-case feedback + library
ruling), estela's `docs/pond-friction.md`.

**Core-bound carry-forwards.** The gating sequence (NaN-policy → byColumn) has
**shipped**; the remaining items are sequenced behind the next estela milestone:

- **`byColumn` value-axis aggregation** — ✅ **SHIPPED v0.27.0** (#227, docs
  #229). Bucket `aggregate` over any column: monotonic → contiguous ranges
  (splits / profile, `{ width, origin? }`), non-monotonic → histogram (power
  distribution / FTP zones, `{ edges }`). Returns an ordered array of
  `{ start, end, ...aggregates }` bin records (owner decision: value-bins aren't
  time-indexed, so not a `TimeSeries` — `docs/notes/bycolumn-value-axis.md`).
  Was queued behind the NaN-policy (#218, shipped) → rolling-stdev stability
  (#222, shipped); both cleared, then byColumn landed. **Open watch:** the
  design note flagged composition friction (e.g. `rolling` over the bins) as the
  thing to surface on real adoption — estela adopting it is the validation.
- **`rollingByColumn` value-axis windowing** — ✅ **SHIPPED v0.28.0 (#231, estela
  wave 1/3).** The sliding-window sibling of `byColumn`: a centered `±radius`
  window over a non-decreasing numeric column, reduced per row. Addresses the #1
  instance of estela's "window/scan over a derived monotonic axis" digest (4
  votes) — `geo.rollingSpread`, the zoom-stable variance band. The other two
  instances of that digest stay deferred: the extremal-window **sweep**
  (best-efforts / power curve, low urgency) and the stateful **scan** (splits,
  out of scope per estela). Design note: `docs/notes/rolling-by-column.md`.
- **`withColumn`** — ✅ **SHIPPED v0.28.0 (#232, estela wave 2/3).** Attach a
  computed `Float64Array` / `(number | undefined)[]` as a new `number` column
  (schema type widens); the seam that lets a derived array re-enter the pipeline
  as a real column `aggregate` / `byColumn` / `rollingByColumn` / `column(name)`
  can see. Validated attach (re-asserts the numeric intake contract — non-finite
  rejected). Double-signalled with the chart carry-forwards (#107); serves estela
  _and_ the chart feed.
  - **`fromTrustedColumns`** — deferred sibling: the bulk-construction path that
    builds a series straight from columns and **skips** the finite scan (the perf
    escape hatch). Build when a perf-critical consumer earns it; `withColumn`'s
    validated attach covers the estela need today.
- **DX bundle (estela wave 3/3)** — 🚧 **in flight (PR #234, unreleased).** Three
  small, confirmed papercuts in one PR: `byColumn({ edges, inclusive: '(]' })`
  (upper-inclusive zone bins, removes the ε-nudge — F-geo-2 zone inclusivity);
  `'mean'` reducer alias for `'avg'` (F-reducer-naming); `RowForSchema` honoring
  `required: false` so an optional tuple cell accepts `undefined` with no cast
  (the known greenfield F4 / ARCHITECTURE §4 limitation, F-geo-row-optional,
  confirmed ×4).
  - **`F-schema-key-name` (key column must be named `time`) — structural fix
    DEFERRED.** Accepting any name for a `kind:'time'` key widens `FirstColumn`,
    which `SeriesSchema` and key-name assumptions across the codebase depend on —
    structural blast radius, not a cheap-bundle item. Workaround (name the key
    `time`) is trivial; revisit if it recurs. **Action taken:** a clarifying
    JSDoc on `FirstColumn` (the key column's name must equal its kind) so the
    opaque `'"at"' is not assignable to '"time"'` error doesn't cost a debug
    cycle.
- **Data point against opening the kind system:** a packed geo column earned
  nothing on perf at GPS scale (reinforces `geo.md` §7).

### Tidal (financial charts; drives `@pond-ts/financial`; kicking off ~week of 2026-06-29)

A charts use-case experiment — the financial counterpart of estela. Where estela
drives `@pond-ts/fit` and adopts `@pond-ts/charts` for activity data, **Tidal** is a
financial-charts consumer that drives **`@pond-ts/financial`** (the market-analytics
sibling of `@pond-ts/fit`) and adopts `@pond-ts/charts`. A **dedicated Tidal agent**
runs it, the same way the estela agent runs estela (and drove `@pond-ts/fit`).
**It's just a charts use case for now** — earliest stage, pre-RFC, not a committed
library phase; the RFC→PLAN discipline applies (only adopted work becomes a
commitment).

- **`@pond-ts/financial` shape:** a **toolkit of analytics operators** over core
  (volatility, returns, OHLC roll-ups, …), deliberately distinct in API shape from
  `@pond-ts/fit`'s façade — each domain package's surface stands on its own, no
  precedent carried over. Batch first; real-time is a later horizon leaning on the
  same live layer the gRPC + webapp-telemetry tracks stress.
- **Substrate is largely already in place.** The value-axis wave (`scan`, `byValue`
  / `ValueSeries`, `byColumn` / `rollingByColumn`, chart x-on-value) shipped for the
  estela / charts work and hands the financial analytics their non-time-axis
  substrate close to free. The likely _new_ core sibling is an RLE / segmentation
  primitive (`runs` / segment-by-predicate) — the same gap fit hand-rolls — rather
  than net-new value-axis work.
- **Charts gaps it surfaces (candidate roadmap items, driven by adoption):**
  (1) **candlestick / OHLC marks** — ✅ SHIPPED (`<Candlestick>`, PR #357,
  financial-charts RFC Phase 1).
  (2) a **trading-calendar x-axis** that skips weekends / non-trading days (and
  overnight gaps for intraday bars) — a non-wall-clock x adjacent to the value-axis
  machinery, so the very first axis requirement already pushes past a naive
  continuous `TimeAxis`. **Now an RFC + active build wave — see below.**

#### Trading-calendar wave — ADOPTED (RFC `docs/rfcs/trading-calendar.md`)

The disjoint-time-axis RFC (drafted #366, promoted to an RFC #368, red-teamed by
Tidal + a Codex pass #370) was built as a wave. **Phase 1 (the calendar engine —
pure data) and Phase 2 (charts `scaleTradingTime`) are both COMPLETE and PLAN
commitments.** Phase 2 was **built ahead of Tidal's adoption** (a deliberate
get-ahead-of-the-consumer move, user-directed): rather than wait for Tidal to
source real gappy data and drive the friction loop, we validated the axis
against our own real data (daily EODHD + intraday SPY fixtures) so Tidal
inherits a working scale instead of a draft. The design was validated — Tidal
independently built the same `calendar.bars → BoundedSequence` seam.

- **`@pond-ts/financial` BOOTSTRAPPED** — the package now exists (scaffolded off
  `@pond-ts/fit`; peer-deps `pond-ts`; browser+Node, no React). First inhabitant
  is the calendar engine; the indicator corpus
  (`docs/notes/financial-indicators-assessment-2026-07.md`) follows on the same
  substrate. **Not yet published** (new-package OIDC bootstrap is a later step —
  see [[npm new-package publish bootstrap]] in the release notes).
- **Phase 1 build — COMPLETE (PRs #371–#374, unreleased):**
  - ✅ **`DiscontinuityProvider`** (#371) — the d3fc-style 5-method axis primitive
    (`clampUp`/`clampDown`/`distance`/`offset`/`copy`) + `identityDiscontinuity()`
    - the bundled `weekendSkip()` reference provider (UTC weekends, closed-form
      O(1) trading-ms math). Charts will consume this structurally in Phase 2.
  - ✅ **Session model + both construction paths** (#372) — `Session`/`SessionBreak`
    - `normalizeSessions`; `TradingCalendar.fromSessions` (explicit schedule, the
      first-class path — Tidal Ask 1) and `.fromRules` (weekmask/holidays/half-days/
      breaks, DST-correct via Temporal); query surface (`sessionOn`, `isTradingDay`,
      `sessionContaining`, `isOpen`, `sessionsInRange`, `next`/`previousSession`).
      Overnight sessions deferred (explicit-list only for now).
  - ✅ **`sessionSequence`/`barSequence` → `BoundedSequence`** (#373) — the core
    bucketing seam; force-close truncation + break-splitting; flows through
    `aggregate`/`materialize` **with no core edits** (`BoundedSequence` IS
    `SequenceLike`). The RFC's zero-core-edit claim, proven.
  - ✅ **`tagSessions(series)`** (#374) — appends a numeric session-id column
    (session `open` id; `undefined` in closed time), O(n+sessions) merge walk.
    The `partitionBy('session')` stopgap (Tidal Ask 2, pulled to Phase 1) so
    `fill`/`rolling` don't bridge closures — proven in-test (a hold-fill that
    bridges the overnight gap plainly, but not when partitioned by session).
  - **Core asks kept independent + ahead:** G1 count-based `rolling` windows (the
    top indicator-track ask; decouples the K1 family from the calendar).
    `align`/`rolling` are NOT calendar-correct via `BoundedSequence` (they bridge
    session gaps) — that's the `partitionBy(sessionId)` / G1 / span-hook set, not
    the zero-edit seam.
- **Phase 2 build — COMPLETE (PRs #377–#379, #384; unreleased):**
  - ✅ **`TradingCalendar.discontinuities()`** (#377) — the **proportional**
    trading-time provider (sessions minus breaks → `segmentDiscontinuity`,
    O(log n)). The Phase-1-deferred piece: the calendar now _produces_ a provider.
  - ✅ **`scaleTradingTime`** (#378, `@pond-ts/charts`) — a d3-scale-shaped
    discontinuous time scale on a **structural** `DiscontinuityProvider` (charts
    never imports `@pond-ts/financial`; RFC §6.1). Callable/`invert`/`ticks`/
    `tickFormat`/`domain`/`range`/`copy`; interior ticks even in trading time.
  - ✅ **`ChartContainer discontinuities` prop** (#379) — pass
    `calendar.discontinuities()` → trading-time x axis (gaps collapse, proportional
    within sessions). Pan/zoom move in **trading time** (`panRangeTrading`/
    `zoomRangeTrading`, boundary-safe after a Codex pass fixed span-preservation +
    the value-axis gate). Public-API PR — human-approved.
  - ✅ **Feature-axis stories** (#384) — `Charts/TradingTimeAxis` (weekend skip,
    holiday, half-day, intraday, continuous-vs-trading), render-smoke-tested.
  - ✅ **Session-aware axis** (#387–#389) — `DiscontinuityProvider.boundaries()`
    enumerates collapse points; charts draws a **session divider** at each
    (`theme.axis.sessionDivider` token) and labels the axis with a **date at each
    session open** (two-tier `tickFormat`: date at opens, time elsewhere) instead
    of repeated times. The collapsed axis now reads like a trading terminal.
  - ✅ **Follow-up wave — SHIPPED (PRs #391–#394, unreleased):** the four
    "ready to build" follow-ups, each Layer1+Layer2-reviewed. - ✅ **`stamped:'open'|'close'` on `tagSessions`** (#391) — a feed's bar-stamp
    convention: `'close'` bins a bar stamped at the close into its closing
    session (`(open, close]`) instead of dropping it to closed time. Resolves
    the real-fixture 16:00 close-boundary finding. Scoped to binning; point
    queries stay half-open. - ✅ **Uniform-spacing metric** (#392) — `segmentDiscontinuity(segs, { spacing:
'uniform' })` + `TradingCalendar.discontinuities({ spacing, period })`. Each
    session (or period-bar) equal width (Q7's TradingView metric); proportional
    stays default. `discontinuities` now takes an options object. - ✅ **Calendar-grain ticks + aligned dividers** (#393) — `scaleTradingTime`
    coarsens session opens to week/month/quarter/year starts (`coarsenCalendar`);
    `tickFormat` labels dates or the year at year grain. Dividers now draw at the
    axis ticks that are collapse points, so grid + dividers + labels align. Dense
    → coarse rhythm (terminal look); sparse → every collapse marked (unchanged). - ✅ **`calendar` + `spacing` props** (#394, public API, human-approved) — the
    high-level sugar over the low-level `discontinuities` prop:
    `<ChartContainer calendar={cal} spacing="uniform" />`. `calendar` is a
    structural `TradingCalendarLike` (charts still never imports financial);
    `spacing` is Q7's explicit prop, default proportional.
  - ✅ **Interaction stories + annotation-drag fix (PRs #404, #405).** Seven
    `Charts/TradingTimeAxis/Interactions` stories (cursors, annotations-across-gaps,
    snapping, pan/zoom) over a shared `tradingAxis.fixture.ts` (#404). The walk
    verified cursor-snap / region-across-gap / pan-zoom correct **and surfaced the
    deferred annotation-drag-delta bug** — the region body-move applied a shared
    epoch-ms delta to both edges, distorting a box dragged across a collapsed gap.
    #405 fixes it: `moveRegionByPixels` shifts each edge equal **pixels** through the
    scale (rigid pixel translation), an affine no-op on continuous axes; edge-resize
    and marker drags were already correct.
  - ✅ **Charts interaction feature batch (PRs #407–#410, unreleased).** Five
    requests off the zones-chart + trading-axis context, each Layer-2-reviewed:
    - **#407** — made the `CrosshairSnap` story interactive (it pinned
      `trackerPosition`; the snap path was already correct).
    - **#408 `binColors`** — per-bin colour for single-series band bars (the
      zones / value-band look; `colors` is per-group, this is per-bin). The
      horizontal ordinal bar + band axis already shipped, so the zones chart is
      buildable today; the multi-column zone _table_ is consumer HTML.
    - **#409 region cursor** — `cursor="region"` + `cursorSequence` (a pond
      `Sequence` — duration or calendar-aware — or a `BoundedSequence` like a
      calendar's `sessionSequence`) shades the bucket under the pointer, cropped
      to live time through `xScale`.
    - **#410 snap-to-disjoints** — annotation drags snap to session boundaries;
      the collapsed close/open share a pixel, so `snapToGuides` picks the side by
      pointer position (left → close, right → open).
  - ✅ **Width-derived tick count (PR #447, unreleased)** — Tidal 0.44 friction
    report: the trading scale's `ticks(count)` caps **calendar buckets**, so the
    fixed count of 5 coarsened a 1-year daily view to year grain (2 ticks on a
    900px plot). The container now derives the x-side count from plot width on a
    trading axis (~65px/tick → month grain at 900px) and shares one `xTickCount`
    through the frame — `<XAxis>`, x gridlines, session dividers, and
    `formatTime` agree by construction (previously three hardcoded 5s by
    convention, and `formatTime` got _no_ count, anchoring labels at grain 10 vs
    ticks at 5 — the report's date-labelled year ticks). Continuous axes keep
    the fixed 5. **Deliberately no `tickCount` prop** — the failure was the
    default; a knob waits for real friction (the vol-smile `YAxis` tickCount
    itch is the sibling to watch).
  - ✅ **Logical tick ladder + two-tier axis labels
    (`feat/two-tier-axis-ticks`, unreleased)** — a Tidal screenshot (year of
    daily data, continuous axis) showed d3's multi-scale default mixing
    `"Jun 23"` / bare `"Sep"` labels; owner directed a proper ladder instead of
    a format patch. `tickLadder.ts` walks second/minute/hour clock rungs
    (1s…30s, 1m…30m, 1h…12h) →day→week→month→quarter→year, finest grain
    fitting the width-derived cap; clock anchors generate in **live** time (clock-aligned per session, never in a
    collapsed gap / lunch break / early close, no new provider surface).
    Labels are **two rows**: first row at the tick grain (`14:00` / `Feb 02` /
    `Feb` / `2026`), second **boundary row** carrying the omitted coarser unit
    (`Jan 05` under clock ticks, `2026` under day/week/month ticks — never a
    unit the first row already shows; owner flagged `Jan 2026` under a
    `Jan 05` tick as redundant, 2026-07-14) under
    the first tick of each period + the first tick shown (owner-confirmed
    anchoring). **Plain continuous time axes now run the same ladder** through
    an internal gap-free `identityProvider()` (calendar days as sessions) —
    one algorithm, both axis kinds; the frame's `discontinuities` stays
    undefined so pan/zoom keep continuous math. `TradingTimeScale.tickBoundaries(count)`
    is the new scale surface; `coarsenCalendar` moved to `tickLadder.ts`
    ('session' grain renamed 'day'). A cramped leading partial-period anchor
    (< half a period from the next tick, in live time) is dropped — the
    screenshot's `"Jun 23Jul 07"` pile-up. Design rules: an hour rung must add
    intraday anchors beyond the opens (else it's day grain); boundary row is
    where coarser context lives, so month boundaries format `%b %Y`.
    Systematic story matrix `Charts/TimeAxisTicks` (one story per rung,
    trading + continuous, narrow variants). **Boundary context pinned to the
    left edge (2026-07-14, owner-directed after the live-window walk):** the
    original owner-confirmed first-tick anchoring made the context label hop
    tick-to-tick on a live sliding window, so it now pins at x=0 showing the
    _domain start's_ period, with crossing labels pushing it off as they
    approach (sticky-header behavior; no knob — first-tick anchoring is
    strictly worse live and near-identical static). Crossing detection seeds
    from the domain start's bucket so a first tick past a period turn still
    flags, even when the cramped-lead drop removed its predecessor.
  - ✅ **Dual x-axes — two tick layouts on one shared scale
    (`feat/dual-x-axes`, unreleased).** Owner-directed (Tidal / legacy
    ChartTool parity, reference screenshots 2026-07-14): a second `<XAxis>`
    stacks by declaration order (proven + pinned — was supported by
    construction but never exercised), and the new `transform` prop
    (`{ to, from }` monotonic inverses, may be **nonlinear**) relabels an
    axis into a derived unit: strike↔moneyness top axis, BS-delta strip
    under a σ chart. Tick selection = pixel-aware multi-resolution fill
    (`derivedTicks.ts`): 1-2-5 steps coarsest→finest, admitted where ≥48px
    of room remains — a compressed span gets coarse ticks, a stretched span
    finer ones (delta wings pick up 0.45/0.48 while the middle stays at
    0.10). Design rules: **label honesty** (a tick whose formatted label
    parses back to a different pixel is dropped — the fill may descend past
    the format's resolution, and "+0.50" at u=0.498 is a lie), an empty
    ladder level does NOT stop the walk (nonlinear gaps have tiny u-spans;
    three consecutive empty levels do), gridlines stay on the primary axis,
    one domain so pan/zoom moves both layouts for free. Resolves the
    vol-smile relabelled-axis friction item.
  - ✅ **Pan/zoom + grid polish (2026-07-16, owner-driven live walk of the
    DateStylePanZoom story; uncommitted on `worktree-flat-time-axis`).** Three
    fixes, each verified live in Storybook:
    1. **Zoom drift with weekends hidden** — the story's demo `weekendSkip`
       provider broke the `offset`-inverts-`distance` contract across DST
       (`liveMs` anchored to local midnights, `offset` mapped back with raw
       `START + di·DAY` = 01:00 local in summer): +1h per offset round-trip →
       ~1.6h window drift per wheel tick in Apr–Oct regions. Fixed by
       constructing the local midnight through the calendar. Library providers
       were never affected (they derive both directions from shared helpers) —
       the provider contract is what the viewport math leans on.
    2. **Session-line fade curve** — the `'all'`-divider linear fade
       (`alpha = gap/6`) mathematically cannot clear: perceived wash =
       `alpha/gap` = constant, so zooming out pinned a permanent gray veil
       (plus alpha-stacking on shared pixel columns). Now a two-anchor
       quadratic ramp (full ≥ 28px, gone ≤ 6px) whose wash → 0; regression
       test pins "total ink strictly falls and reaches exactly 0".
    3. **Hierarchical fading calendar grid** (owner-directed design): vertical
       gridlines are now the **full grain populations** — every day / month /
       aligned clock instant in view — not the label algorithm's thinned picks
       ("the labels decorate the grid, they don't define it"). Each grain
       fades **as a unit by its calendar density** — nominal gap-free spacing
       `width × grainStep / wallSpan`, NOT the measured on-screen gaps — on
       the same wash-aware quadratic ramp (full ≥ 15px ≈ day lines at a
       ~1.5-month window, gone ≤ 5px). Zoom-out dissolves fine grain into
       coarse with no pop at label-rung switches, and the look is
       **mode-invariant**: collapsing weekends draws fewer day lines at the
       same strength (owner's same-zoom, different-weight screenshots —
       measured-gap fading had jumped the surviving lines to full). New scale
       surface `TradingTimeScale.gridLevels(minGapPx)` (nested populations +
       nominal spacing, memoized, enumeration capped at width/gone so
       over-dense grains are never built); levels nest (no week rung),
       consumers dedupe coarsest-first.
    4. **`sessionDividers` default `'labeled'` → `'none'`** (owner report:
       with weekends hidden, labeled-tick dividers rendered as quasi-grid
       even with `grid={false}`, "layer on top and confuse things"). The
       hierarchical grid now owns calendar structure at every zoom; dividers
       are opt-in emphasis (`'all'` = TradingView separators; `'labeled'` =
       only under labelled collapse points). The label stride is a rendering
       choice, not calendar structure — solid lines shouldn't ride it by
       default.
    5. **Dividers mark collapse _seams_, not the session roster** (owner:
       "why are session lines on each day when we're removing the
       weekends?"). `boundaries()` is overloaded by design — the tick ladder
       and grid consume every session open as a date anchor (the identity
       provider even reports every midnight), while a divider means _time was
       removed here_. The two coincide on real exchange calendars (every
       open follows an overnight gap) but diverge on contiguous-session
       calendars (the story's 24h weekday demo). The draw path now keeps
       only true seams — `distance(b−1, b) ≈ 0` — so the demo seams only at
       Monday opens; real calendars are unchanged. Contract docs updated on
       both `DiscontinuityProvider.boundaries` declarations (charts +
       financial) to name the roster/seam dual role.
    6. **The window edge is never ticked unless genuine** (owner: "remove
       the sticky one at the end on flat mode… sort of misleading"). The
       ladder injected `opens[0]` (the raw domain start) as an anchor, so a
       mid-period edge became a tick pinned at x=0 relabelling itself as the
       window panned (a half-spaced `8`, a `15:23` under an hour grain); the
       old cramped-lead heuristic only dropped it when crowded. Now the lead
       tick survives only when **live** and either a true session open
       (dead-before/live-after probe — includes the calendar's absolute
       start) or **exactly on a grain instant** (`alignedToGrain`: midnight /
       month start / clock multiple) — the alignment arm is how a gap-free
       continuous axis, with no dead time to probe, keeps a window cut
       exactly on a boundary (a Jan-1 year fixture keeps its `2026`).
       TradingView-matching: the first real calendar anchor leads. Story
       controls also reworked (Grid / Sessions / Session markers switches
       below the chart, `labels center|left` control on the `align` prop).
  - ✅ **Stacked date style → segmented band row (`feat/stacked-band-axis`,
    2026-07-16, owner design from reference frames).** Redesigned
    `dateStyle="stacked"` from the ride-a-tick boundary row + pinned context
    into a **segmented band row**: a terse top row (the grain's bare unit) over
    zebra-shaded bands of the **next-coarser** period — day bands under
    intraday ticks, **month** bands under day ticks (one step finer than the
    old day→year boundary jump), year bands under month/quarter ticks. Each
    band left-aligns its label, draws a divider at its turn, and the partial
    left band pins its label at x=0 (replacing `boundaryContext`). **Zebra by
    absolute calendar parity** (year %2, months-since-epoch %2, UTC-day %2 —
    pan/zoom-stable, DST-immune), not a live/current-cell rule (owner
    correction: "it does zebra"). The top-row **turn tick** is bold + takes the
    divider colour so tick + rule + divider read as one boundary line — matched
    by **pixel**, not instant, so on a trading axis the session-open tick at the
    collapsed-midnight seam is the one emphasized. New scale surface
    `TradingTimeScale.bands(count)` + `baseFormat(count)`; new `bandGrainFor` /
    `bandShaded` / `bandStartOf` / `bandNext` ladder helpers; new
    `theme.axis.band` tokens (`fill` / `divider` / `label` — the shade is a
    themeable background, "could be a background color for some people"). **Flat
    (the shipped default) also picks up the boundary emphasis** (owner: "style
    the band boundary in the non-layered case too, so it matches"): a tick
    whose label was promoted to a coarser period (`Feb`, `2026`) now renders
    **bold**, so a period boundary reads the same in flat and stacked — a
    default-path behaviour shift, pinned by a test. The old
    `tickBoundaries` / `boundaryContext` scale methods stay for external
    consumers but the axis no longer renders them.
  - ✅ **Grain-aware cursor readout + `cursorFormat` channel
    (`fix/cursor-readout-grain`, 2026-07-17, Tidal F-charts-7 escalation via
    PR #484).** 0.47.0's flat default regressed the crosshair x-pill to a bare
    time-of-day (`02 AM`) on daily bars: the readout fell to d3's multi-scale
    default, and the only prior fix — a day-floor `timeFormat` — disqualifies
    the `dateStyle` ladder by design ("a custom format owns the labels"). One
    knob, two concerns. Fix, per the owner's steer (grain-aware default **+**
    independent per-channel control, RTC-style): (1) **default** cursor /
    marker / annotation readout now formats at the axis **grain**
    (`TradingTimeScale.readoutFormat` / `readoutFormatFor`) — day-or-coarser →
    a date, sub-day → date + clock, never a foreign-tz time-of-day; (2) a new
    **`cursorFormat`** container prop shapes _only_ the readout, independent of
    the label `timeFormat` / `format`, and does **not** set `xFormatCustom`, so
    a consumer keeps flat/stacked **and** shapes the pill. Tick labels
    unchanged. **Callback shape (owner-decided pre-merge, "do I know the
    grain?"):** the function form is `(epochMs, { grain, defaultText }) =>
string` — the library hands over the resolved coarse **`TimeGrain`**
    (`year`…`second`, strides collapsed via `coarseUnitOf`; new
    `TradingTimeScale.grain(count)`) and the grain-aware default text, so a
    consumer branches on zoom and passes the default through rather than
    re-deriving the ladder from the range. New public types `CursorFormat` /
    `TimeGrain`. **Timezone control is the deferred follow-on** the owner
    flagged — the grain-aware default sidesteps the common daily-bar case, but
    true exchange-/display-tz handling (cf. the deferred exchange-tz tick
    grain) is its own conversation, not attempted here.
  - **Still deferred (documented, none blocking):** `neighbourSpans` point-key slot
    widths on the discontinuous axis (interval-keyed bars from
    `aggregate(barSequence)` — the primary path — are immune); exact **exchange-tz**
    tick grain (the current grain buckets by runtime-local calendar). Validated
    against real data: daily EODHD (#375) + intraday SPY fixtures (#376), incl. a
    half-day, holidays, overnight gaps, and a dirty (duplicated) session.
  - ✅ **RELEASED v0.42.0 (2026-07-10).** All five packages on npm together. The
    new-package bootstrap: `@pond-ts/financial` was manually token-published at
    `0.41.0` to claim the name + OIDC trusted publisher (per
    [[npm new-package publish bootstrap]]), then the `v0.42.0` tag OIDC-published all
    five (financial's first OIDC release). The charts publish auto-wakes the Tidal
    adoption agent via the CHANGELOG.
- **Indicator / studies track — the `@pond-ts/financial` analytics layer.**
  Grounded in the corpus assessment
  (`docs/notes/financial-indicators-assessment-2026-07.md`): 124 ChartIQ studies
  reduce to ~11 kernels, ~80% expressible on core primitives today. Kicked off by
  the study-primitives report (issue #449, triaged 2026-07-13). **Dispositions
  (owner-acked):**
  - **Item 1 (static trailing-window transform)** — the reducer set (`avg`/`stdev`/
    `min`/`max`/`median`/`p{q}`) ships today on `rolling(duration, …)`; the real
    gap is a **count-based (N-bar) window** (G1) — the only correct window across
    session gaps. **→ built (see below).**
  - **Item 2 (EWMA)** — `smooth('ema', { alpha })` ships; gap is the `span`
    parameterization (α = 2/(span+1)). **→ PLAN** (public option-type change,
    human-approval gate).
  - **Item 3 (warmup/alignment convention)** — `rolling` `minSamples` keeps length
    (emits `undefined`), ema `warmup` slices length. **→ PLAN**: document one
    length-preserving convention; reconcile ema toward it. Too small for an RFC.
  - **Decision (owner):** land **G1 in core first** (gap-correct from the first
    studies release), then the **#449 first-batch studies** (SMA, EMA-span,
    Bollinger®, MA-envelope, z-score, rolling stdev/min/max/percentile,
    percent-change) in `@pond-ts/financial` — package shape per assessment §7
    (`kernels/`/`studies/`/`contract/`, `column`/`output` on every fn, shared
    `maType`, bar-count `period` in the public API from day 1).
  - ✅ **G1 count-based rolling window — BUILT (unreleased).** `TimeSeries.rolling`
    now takes `{ count: N }` in place of a duration: reduces the last/next/centered
    `N` **rows** by position, so an N-bar window is correct across session gaps
    (where `N` bars ≠ `N × barSize` of time). Honours `alignment` + `minSamples`
    (`minSamples: N` = the conventional first-`N-1`-`undefined` warmup); per-row
    only (throws with a sequence). Same amortized-O(1)-per-row sweep as the duration
    path (perf: linear, ~16ms/100k rows, tracks the duration numbers). Adds an
    overload to `TimeSeries` → human-approval gate before merge. 10 tests +
    `perf-rolling.mjs` count scenario.
  - ✅ **`span` + `minSamples` on `smooth('ema')` — BUILT (unreleased).** ema now
    takes the financial `span` rate (`α = 2/(span+1)`) as an alternative to
    `alpha`, and a **length-preserving** `minSamples` warm-up (emit `undefined`
    for the first `N` present values, keep the row count) — mirroring `rolling`'s
    `minSamples`, so **one** warm-up convention holds across primitives. The
    existing length-changing `warmup` is untouched (documented as the drop-the-
    head counterpart) — item 3 reconciled additively, no breaking change. Adds
    options on `smooth` → human-approval gate. 8 tests.
  - ✅ **First studies — BUILT (unreleased):** `@pond-ts/financial` now ships
    `sma` / `ema` / `bollinger` on the assessment §7 package shape — `contract/`
    (`OhlcvColumns` + `DEFAULT_OHLCV`), `kernels/` (`rollingValues` count-window
    read-and-append + `assertPeriod`/`assertNoColumn`), `studies/` (one file per
    study, `column`/`output` on every fn, bar-count `period`, length-preserving
    warm-up). SMA/Bollinger compose on core's `rolling({ count })`; EMA on
    `smooth('ema', { span, minSamples })`. Core `AppendColumn` exported so study
    returns name their appended column (typed composition — a study over another
    study's output). 8 tests. Adds `@pond-ts/financial` public API + a core type
    export → human-approval gate.
  - ✅ **Pandas oracle — cross-validation harness (unreleased):** every study is
    checked bar-for-bar against a **pandas** reference (`scripts/oracle/generate.py`
    → committed golden `test/fixtures/study-oracle.json` → `study-oracle.test.ts`).
    CI needs no Python (JSON is committed; regenerate via a venv on definition
    change). Conventions pinned to match (ema `adjust=False`; Bollinger σ `ddof=0`
    = population, TA-Lib's). **Phase-2 named indicators (RSI/MACD/ATR) add TA-Lib**
    to the same harness, documenting deltas (vendor bar-parity is a non-goal).
    This is the "fully trust the numbers" gate for the whole studies track.
  - ✅ **Fan-out — #449 first batch COMPLETE (unreleased):** `rollingStdev` /
    `rollingMin` / `rollingMax` / `rollingPercentile`, `zScore`, `envelope`
    (MA ± percent, `maType` sma/ema), `percentChange` (n-bar) — all on the shipped
    `rollingColumns`/`columnValues`/`emaValues` kernel, each with a fluent method
    and a pandas-oracle case (13 oracle cases now). The whole first batch (SMA,
    EMA, Bollinger + these) is built, fluent, and pandas-verified.
  - **Next:** assessment §7.4 **Phase-1 breadth** — RSI, MACD, ATR(+bands),
    stochastics, %R, Donchian, OBV, VWAP, Historical Volatility, momentum/ROC.
    These add **TA-Lib** alongside pandas in the oracle (named-indicator
    convention deltas documented). The core substrate (G1 count windows +
    span/minSamples EMA + the reducer set) is complete; a few need the K6
    stateful-fold shim (PSAR/SuperTrend etc., Phase 3).
- **Cross-repo coordination — the constellation bridge (live since 2026-07-03).**
  Handoffs between this repo and Tidal are automated; Peter no longer hand-relays
  them. **Inbound:** a Tidal→pond PR with `Tidal` in the title wakes a headless,
  budget-capped pond-agent session (disposable worktree of `~/Code/pond`) to triage
  it per the normal process — read, respond on the PR, merge acceptable notes, fold
  into PLAN, implement or queue. **Outbound (release signal):** an `@pond-ts/charts`
  npm publish auto-wakes a Tidal agent that reads the CHANGELOG and PRs the adoption
  — so keep CHANGELOG entries wave-shaped, they're a machine-read payload now.
  **Outbound (everything else — asks, canaries, RFC feedback, deprecations):** file
  a GitHub issue on `tidal-app/tidal` titled `[pond] <ask>`. Neither watcher touches
  a live checkout; both sides' normal review processes still apply. Full contract:
  [docs/notes/constellation-bridge.md](../notes/constellation-bridge.md) (pond#327).
  **Outbound (RFC feedback via Discussions — pond#332):** open a GitHub Discussion
  per RFC (title `RFC: <name>`, body linking `docs/rfcs/*.md`) and mention `tidal`
  in the title/body to summon a one-shot consumer-perspective comment from a Tidal
  agent (grounded in the terminal's code); generalizes to `consumers: tidal, estela`
  as more consumers get watchers. Fire-once per discussion; a fresh discussion or a
  `[pond]` issue drives a second round. Discussions is enabled on the repo, so this
  works today. **Queued (not auto-fired):** open discussions for the living-examples
  RFC (#285) and the range-editing RFC (#261) — Tidal has real consumer positions on
  both. Left as a deliberate act rather than fired inside an autonomous triage run,
  since summoning a consumer spends budget on the other side of the bridge.
