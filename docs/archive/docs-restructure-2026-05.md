# Docs restructure plan

> **Archived 2026-11-17.** Every phase below is done (see Status). Moved here
> from the repo root `DOCPLAN.md`, which PLAN.md never linked; open docs work
> lives in PLAN.md's docs section and `docs/plans/PND_DOCS_PLAN.md`.

Restructure the website docs around the concepts a user is trying to
learn (windowing, triggers, late-data, partitioning) rather than the
features as they shipped (rolling, aggregate, sample, etc.). Three
post-v0.12 release waves (v0.13.0 / v0.13.1 / v0.13.2 / v0.14.0)
materially changed the streaming surface, and the docs grew by
accretion rather than by mental-model.

This file is the canonical execution plan. Status section at the
bottom tracks progress.

## Why now

- Streaming is now a peer to batch, not a sub-mode. Three of the last
  four releases were streaming-side; the trigger taxonomy is half the
  API surface. Doc framing still says "batch-first" in places.
- v0.13.0's `AggregateOutputMap` made multi-stat aggregation a single
  rolling pass; docs haven't fully integrated this.
- Triggers (v0.12 first-class concept; v0.13.1 `Trigger.every` sugar;
  v0.13.2 `Trigger.count`) are spread across `live-transforms.mdx` and
  the live section of `rolling.mdx` — incomplete in both, with no
  single place that walks the family.
- Late-data semantics (ordering modes, grace, the "data is the clock"
  principle vs wall-clock+watermark systems) deserve a dedicated
  conceptual page, especially for users coming from Beam/Flink.
- `LiveRollingAggregation` / `LiveAggregation` direct-construction
  examples in current docs leak internal shape — users would never
  write that, they'd use `live.rolling(...)` / `live.aggregate(...)`.

## Target state TOC

```
website/docs/
├── start-here/
│   ├── installation.mdx
│   ├── concepts/                          # split out from concepts.mdx
│   │   ├── index.mdx                      # 1-screen mental model + nav
│   │   ├── temporal-keys.mdx              # Time / TimeRange / Interval
│   │   ├── sequences.mdx                  # fixed-step / calendar; bounded vs unbounded
│   │   ├── series.mdx                     # Events / TimeSeries / LiveSeries; batch & streaming peers
│   │   ├── temporal-relations.mdx         # vocabulary + tail/first/last as concepts
│   │   ├── windowing.mdx                  # full / fixed / rolling / streaming
│   │   ├── triggers.mdx                   # event / clock / count
│   │   ├── partitioning.mdx               # partitionBy / per-partition state / fan-in
│   │   └── late-data.mdx                  # data-as-the-clock; ordering modes; grace
│   └── creating.mdx                       # renamed from ingest; batch + live siblings
│
├── pond-ts/
│   ├── queries.mdx                        # unchanged
│   ├── transforms/
│   │   ├── transformations.mdx            # renamed from eventwise-transformations
│   │   ├── windowing.mdx                  # NEW — operator-level (decide in Wave 3.3 if needed)
│   │   ├── aggregation.mdx                # restructured for symmetry; "Compared to alignment" footer
│   │   ├── alignment.mdx                  # renamed from sampling-overview; symmetric layout
│   │   ├── rolling.mdx                    # trimmed to operator reference
│   │   ├── reduce.mdx                     # trimmed to operator reference
│   │   ├── cleaning-data.mdx              # moved second-last position
│   │   └── reducer-reference.mdx          # unchanged, end-position
│   └── live/
│       ├── live-series.mdx                # trimmed; ordering modes link to creating
│       ├── live-transforms.mdx            # trimmed of trigger material
│       └── triggering.mdx                 # NEW — pulled from live-transforms + rolling.mdx live
│
└── recipes/
    ├── telemetry-reporting.mdx            # cross-link audit (Phase 3.6)
    └── ingesting-messy-data.mdx           # cross-link audit (Phase 3.6)
```

## Phase 1 — Direct-class-reference bug fix

Mechanical: anywhere docs show direct construction of internal
accumulators, swap to the user-facing form.

| Pattern                                                  | Should be                                       |
| -------------------------------------------------------- | ----------------------------------------------- |
| `new LiveRollingAggregation(live, '5m', { cpu: 'avg' })` | `live.rolling('5m', { cpu: 'avg' })`            |
| `new LiveAggregation(live, seq, mapping)`                | `live.aggregate(seq, mapping)`                  |
| `new LivePartitionedSyncRolling(...)`                    | `live.partitionBy(col).rolling(...)`            |

Sweep `website/docs/`. Single small PR, lands the same day.
Self-review only (mechanical).

## Phase 2 — Existing reference-page sweep

Single audit pass for accuracy / staleness / cross-link gaps.
Post-v0.12 through v0.14, plenty has shifted under the docs.

Scope:

- **Accuracy** — every code example still compiles against current types.
- **API freshness** — live-trigger examples lead with `Trigger.every('30s')`
  (v0.13.1 sugar) instead of the verbose form; check for any
  references to removed `retention.maxBytes` (v0.14.0); `Trigger.count(n)`
  (v0.13.2) mentioned where appropriate.
- **Direct-construction patterns beyond Phase 1** — any other internal
  shape leaking through public examples.
- **Cross-link inconsistencies** — page A talks about a concept page B
  defines but doesn't link to B.
- **Stale prose** — "currently doesn't support X" claims that have
  shipped since.
- **Recipes audit** — telemetry-reporting + ingesting-messy-data; do
  pinned pond-ts versions need bumping?

Land as one PR. **Stop here for human review** before Phase 3 starts —
agree on the state-of-the-world before adding pages on top.

## Phase 3 — IA refactor (waves)

Doc-only PRs, no Layer 2 review per CLAUDE.md ("pure chore PRs"),
self-review for broken links + verified examples. Optional
`gh workflow run docs.yml --ref main` per wave to ship live without
waiting for a release.

### Wave 3.1: Concepts foundation (review tone)

Two pages, lands together:

- `start-here/concepts/temporal-keys.mdx` — Time / TimeRange / Interval; points & spans on the timeline
- `start-here/concepts/sequences.mdx` — fixed-step / calendar; bounded vs unbounded; grid definitions

Reference-tight, ~150-250 lines each. **Stop for human tone review
before Wave 3.2.** Once dialled in, the remaining seven concept pages
match the voice without per-page re-discussion.

### Wave 3.2: Remaining concept pages

Single PR (or 2-3 if size grows):

- `series.mdx` — Events / TimeSeries / LiveSeries; batch & streaming as peers (not "batch-first"); schema mentioned, details live in Creating
- `temporal-relations.mdx` — vocabulary (within / overlapping / trim / open-closed) + tail/first/last/at as timeline concepts (not API)
- `windowing.mdx` — full / fixed / rolling / streaming; the four-mode mental model
- `triggers.mdx` — event / clock / count; emission cadence as first-class
- `partitioning.mdx` — partitionBy / per-partition state / fan-in
- `late-data.mdx` — data-as-the-clock vs wall-clock+watermark systems; ordering modes; grace; trade-offs honestly named; Streaming 101/102 reference
- `index.mdx` — repurpose existing concepts.mdx as a 1-screen mental-model + nav page

Plus `_category_.json` / sidebar updates so the new structure renders.

### Wave 3.3: Operator-page reshapes

The new concept pages deserve clean operator-page reference docs that
lean on them.

- **`pond-ts/transforms/windowing.mdx` (NEW or skipped)** — operator-level
  windowing reference page (concept page covers the *mental model*, this
  page would cover *which operator does what*). May not be needed if
  the existing rolling/aggregate/reduce pages, slimmed, cover it.
  Decide after Wave 3.2.
- **`alignment.mdx` (renamed from sampling-overview.mdx)** — restructured
  for symmetry with aggregation. Diagram at top after a short
  description. "Compared to aggregation" footer.
- **`aggregation.mdx`** — same restructure for symmetry. "Compared to
  alignment" footer. Same parameter-shape language as alignment.mdx so
  a reader who knows one finds their way around the other in seconds.
- **`rolling.mdx`** — trimmed to operator reference; conceptual material
  that overlapped with windowing (concept) is removed or condensed.
- **`reduce.mdx`** — same: operator reference only.

### Wave 3.4: Renames + position moves

- **`start-here/ingest.mdx` → `start-here/creating.mdx`** — restructured
  around Batch vs Live as siblings. Schema-as-contract details land
  here (per Wave 3.1's split). Forward-references to cleaning-data for
  messy-data flows.
- **`pond-ts/transforms/eventwise-transformations.mdx` → `pond-ts/transforms/transformations.mdx`** —
  page intro must explicitly scope: "operations that preserve the
  event grid; for operations that change the grid see Windowing."
  Without that scope statement the rename loses precision.
- **`pond-ts/transforms/cleaning-data.mdx` → second-last position** (above
  `reducer-reference`) — possibly rehome under a new `data-quality/`
  directory or just leave under transforms with a sidebar reorder.

### Wave 3.5: Live triggering page

- **`pond-ts/live/triggering.mdx` (NEW)** — pull trigger material out of
  `live-transforms.mdx` and the live section of `rolling.mdx`. Walk
  through `event` / `clock` / `every` / `count`, the partitioned-clock-trigger
  story, telemetry pattern. Cross-link from `recipes/telemetry-reporting.mdx`.
- **`live-transforms.mdx` and `rolling.mdx`** trimmed of the now-extracted
  trigger material; left with cross-references.

### Wave 3.6: Cross-link audit + sidebar finalisation

After 3.1–3.5, run a final pass:

- All internal links resolve (broken-link check).
- Sidebar / `_category_.json` reflects the new structure.
- Each concept page's "Where this shows up" cross-reference closer
  points at the right operator pages.
- Run docs build locally, eyeball the result.
- Run `gh workflow run docs.yml --ref main` to ship live.

## Cross-cutting tweaks (apply across all phases)

- **Streaming as peer to batch** — replace any "batch-first" language
  with "two peer modes of the same model." This shows up across the
  index, ingest, concepts, and likely scattered prose. Catch in Phase 2
  for existing pages, build into Wave 3.x for new pages.
- **Reference-tight tone** — concept pages hold to definitional clarity
  over walkthrough; operator pages do walkthroughs. Each concept page
  closes with a "Where this shows up" cross-reference list to operator
  pages. Length target ~150-250 lines per concept page.
- **Honesty footnotes preserved** — pondjs lineage, Apache Beam
  comparison, the "we are not a general streaming engine" framing —
  all keep their place. The late-data page is where most of these
  honesty moments concentrate.
- **`Trigger.clock` naming wrinkle remains parked** per PLAN.md
  ("Deferred from this wave"). Don't rename in docs work; the deferral
  conditions hold.

## Sequencing

| When                         | What                                       | Approval                                      |
| ---------------------------- | ------------------------------------------ | --------------------------------------------- |
| Today                        | Phase 1: direct-class-reference fix        | Self (mechanical)                             |
| Today (after P1 lands)       | Phase 2: existing-page sweep               | **Human review before Phase 3**               |
| After P2 review              | Wave 3.1: temporal-keys + sequences        | **Human tone review before Wave 3.2**         |
| After 3.1 review             | Waves 3.2 → 3.6 in order                   | Self per CLAUDE.md (pure chore)               |

## Status

Update this section as work lands. Use ✅ done, 🔄 in flight, ⏸ paused.

- ✅ Phase 1 — direct-class-reference bug fix (PR #100, merged)
- ✅ Phase 2 — existing reference-page sweep (PR #101, merged 2026-05-02; human-reviewed and approved)
- ✅ Wave 3.1 — temporal-keys.mdx + sequences.mdx (PR #102, merged 2026-05-02; tone approved)
- ✅ Wave 3.2 — remaining concept pages (PR #103, merged 2026-05-02; full concepts/ structure live)
- ✅ Wave 3.3 — operator-page reshapes (PR #104, merged 2026-05-02)
- ✅ Wave 3.4 — renames + position moves (PR #105, merged 2026-05-02)
- ✅ Wave 3.5 — live triggering page (PR #106, merged 2026-05-02)
- ✅ Wave 3.6 — cross-link audit + sidebar finalisation (PR #107, merged 2026-05-02)
- ✅ Docs deployed live — initial deploy failed on relative-path
  rot from Waves 3.4/3.5 file moves (Docusaurus
  `onBrokenLinks: 'throw'`); fixed in commit `5db5ba5`, redeploy
  succeeded 2026-05-02 13:12.

## Lesson for future doc moves

The `verify` CI (`npm run verify`) does **not** run the docs build —
it covers format-check, TypeScript build, and tests. Broken-link
detection only runs in the `docs.yml` workflow which fires on `v*`
tag pushes or manual `workflow_dispatch`. After any wave that
moves or renames doc files, run `gh workflow run docs.yml --ref main`
**before declaring the wave done**, not after the merge train. This
catches relative-path rot that sed-driven bulk updates miss
(typically: `../X` paths that were correct before a file moved
levels and need an extra `../`).
