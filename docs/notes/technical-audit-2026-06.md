# Technical audit — June 2026

Full-project gap-and-weakness review, conducted 2026-06-10 against
`main` at v0.20.0 (post-#183). Five parallel read-only audit passes
(batch layer, live + columnar layer, React package, tests/CI/packaging,
docs/API surface), with load-bearing claims spot-checked against source
before inclusion. This is an internal-robustness complement to the
multi-agent experiment loop — experiments surface user-facing API
friction; this audit targets the issues experiments route around rather
than report.

Findings are ranked by severity. File references are to the tree at
the audit date.

---

## Context: what the audit found healthy

The weaknesses below are real, but the baseline is strong:

- ~2,100 tests passing, essentially **zero TODO/FIXME debt markers**
  anywhere in `packages/core/src/`.
- Known type-level limitations are already honestly logged in
  ARCHITECTURE.md's decision log (`toJSON()` variance, `RowForSchema`
  vs `required: false`).
- CHANGELOG, PLAN.md, ARCHITECTURE.md, and RFC discipline are well
  above typical for a project this age.
- The columnar validity bitmap and `series-store.ts` adapter audited
  clean.

---

## 1. Live-layer robustness (highest production relevance)

### 1.1 No listener error isolation

Every fan-out loop is a bare `for (const fn of listeners) fn(event)`:
`live-series.ts:503`, `:519–521`, `:595–605`, `:643`, `:658–671`, and
the same pattern in `LiveView` and `LiveAggregation`. One throwing
subscriber silently skips all remaining listeners — including
**eviction** listeners, which can leave downstream views permanently
inconsistent. For a library whose pitch includes multi-subscriber
dashboards, this is the top correctness gap.

**Suggested fix:** wrap each listener call in try/catch, surface the
error (rethrow after the loop, or an `onListenerError` hook), continue
iteration.

### 1.2 Re-entrancy is undefined

A listener that calls `push()` on its own source mutates the listener
`Set` mid-iteration — undefined behavior, no queue, no guard, no
documented contract. Feedback-loop pipelines can silently drop events.

**Suggested fix:** snapshot the listener set before iterating, and/or
queue re-entrant pushes and drain after the loop. At minimum, document
the contract.

### 1.3 Unbounded partition growth

`LivePartitionedSeries` without declared `groups` spawns and retains a
`LiveSeries` per unique key forever
(`live-partitioned-series.ts:226`, `:1045`). Given the
partition-retention OOM already fixed once (#175), high-cardinality
partition keys are a known hazard with no cap, eviction policy, or
warning.

**Suggested fix:** a `maxPartitions` option (throw or evict-LRU), or
at minimum a documented warning threshold.

### 1.4 Chained-view disposal leaks intermediates

`LiveView.dispose()` exists, but in a `.filter().map()` chain only the
final view's subscription is torn down — intermediate views stay
subscribed to the source for its lifetime.

### 1.5 Dual row/columnar path maintenance

`LiveSeries` now carries two parallel implementations of ordering,
retention, and fan-out (chunked columnar vs per-row Event;
`live-series.ts:235–236`, `:309–320`, `:484–486`). This is the
structural risk of the in-flight Phase 4.7 migration: a fix to one
path won't automatically reach the other, and `partitionBy()` can
place a sub-series on a different path than its parent. Worth
extracting the shared logic (`#applyOrdering` / `#applyRetention` /
`#fanOut`) before the paths drift further.

### 1.6 Smaller live-layer items

- Snapshot caches keyed by mutation counter have a stale-read window
  if a listener calls `toTimeSeries()` _during_ an eviction callback
  (`live-view.ts:163–166` vs `:523–530`).
- Grace-window check uses strict `>` (`live-series.ts:1440–1446`), so
  an event exactly at the boundary is rejected; inclusivity isn't
  pinned by a test.
- Chunked-storage event-cache remap after `evictPrefix` can collide
  indices (`live-chunked-storage.ts:417–440`).

---

## 2. Type-safety erosion in the batch layer

~73 `as unknown as` casts in `batch/time-series.ts` alone, clustering
at every schema-transforming operator boundary (representative:
`:1367`, `:3453–3455`, `:4081`), plus ~45 `as any` in the live layer.
The compiler validates each operator's _declared_ output schema type,
but the implementations rebuild schemas as plain literals and cast —
nothing checks the implementation actually produces the declared
shape. The type-level story is the library's headline feature; the
internal transforms are largely unchecked. This also raises the risk
of the planned operator extraction.

**Suggested direction:** type-safe schema-construction helpers that
carry the result schema through, introduced incrementally as operators
are extracted (see §3).

---

## 3. The god-file problem (acknowledged, but growing)

- `batch/time-series.ts` — **4,859 lines** (PLAN.md notes 4,524;
  it has grown since)
- `live/live-partitioned-series.ts` — 1,448 lines
- `live/live-series.ts` — 1,185 lines

Operator extraction is marked "still aspirational" in PLAN.md. Every
operator independently rebuilds and freezes its output schema (~29
copy-pasted `Object.freeze([...])` sites). The longer extraction
waits, the more there is to extract, and the more entrenched the §2
cast pattern becomes.

---

## 4. CI / infrastructure gaps

These undercut the project's own stated discipline — the perf policy
in CLAUDE.md is strong at PR-authoring time and then evaporates.

| Gap                                 | Detail                                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Perf benchmarks never run in CI** | 23 `perf-*.mjs` scripts exist; none execute in `.github/workflows/ci.yml`. No baseline tracking; regressions are only caught by manual re-runs.                                     |
| **No coverage measurement**         | Zero instrumentation (no `vitest --coverage` / c8 / threshold). Coverage gaps are invisible.                                                                                        |
| **Release tag provenance**          | `release.yml` triggers on any `v*` tag push with no check that the tag is on `main` (it does run `verify` first, which is good). A `git merge-base --is-ancestor` step closes this. |
| **No ESLint**                       | Prettier only — `describe.only`, unused vars, floating promises can land.                                                                                                           |
| **No dependabot / `npm audit`**     | Dependency updates and security patches are manual.                                                                                                                                 |
| **Single-OS CI**                    | ubuntu-latest only (Node 18.x / 24.x matrix is good).                                                                                                                               |
| **No TZ pinning in tests**          | Calendar/DST-sensitive code (`core/calendar.ts`) has no dedicated DST-boundary tests and the suite assumes the machine TZ (CI is UTC; dev machines aren't).                         |
| **React package pack check**        | `npm pack --dry-run` runs only for `pond-ts`; the react manifest is never validated in CI.                                                                                          |

---

## 5. React package: concurrent-rendering correctness

- **Tearing risk:** `useSnapshot` (`useSnapshot.ts:44`), `useLatest`
  (`useLatest.ts:26`), and `useEventRate` use `useEffect` + `useState`
  rather than `useSyncExternalStore` — a tearing vulnerability under
  React 18/19 concurrent rendering. `useLiveVersion`
  (`useLiveVersion.ts:124–128`) already does it right, so the
  in-repo template exists.
- **Test coverage:** only ~1 of 12 hooks has a StrictMode
  double-mount test; no concurrent-mode tests; no high-frequency
  stress tests.
- **No sub-throttle batching:** with `throttle: 0`, every push is a
  `setState` — render storms at high event rates. Microtask batching
  would cap this without API change.
- Minor: `useEventRate` has a dead `sourceRef` (`useEventRate.ts:63`)
  and creates-then-disposes a throwaway view during `useState` init.

---

## 6. Documentation drift at the edges

- `useEventRate` and `useLiveVersion` are exported but absent from
  `website/docs/react/hooks.mdx` (including the "when to pick which"
  table).
- `LiveFusedRolling`, `LivePartitionedFusedRolling`, `LiveReduce`,
  `LiveColumnGroup` are public exports with no prose page.
- Experimental flags (`LiveView.column()`, `useLiveVersion`, …) live
  only in the CHANGELOG, not on the docs pages users read.
- **The pre-1.0 breaking-change policy is stated nowhere a user would
  see it** (only CHANGELOG.md:8), despite breaking minors in
  v0.16–v0.18.
  _Addressed (2026-10): a "Versioning" section in the root README and
  each package README, and a docs page at `reference/versioning`, now
  state the 0.x policy, lock-step releases, semver from 1.0, and what
  counts as the public API._
- With six-plus live accumulator classes, there is no "which
  aggregation style do I use" decision page.

---

## 7. Smaller correctness items

- Rolling-window boundary semantics are asymmetric across
  `trailing`/`leading`/`center` alignment modes
  (`time-series.ts:3098–3106`) — possibly intentional, but
  undocumented and unpinned.
- `validate.ts:238–239` shallow-freezes array cells — nested arrays
  remain mutable through the "immutable" Event.
- Option objects aren't validated for unknown keys (`aliignment:` is
  silently ignored); strategy strings like align's `sample` values
  aren't validated either.
- Custom reducers have no documented contract for all-`undefined`
  windows — NaN can propagate silently into downstream `diff`/`rate`.
- `validateAndNormalize` does a second full pass for the sort-order
  check that the columnar variant already folds into one pass
  (`validate.ts:206–254`).

---

## Top five, if forced to choose

1. **Listener error isolation + a re-entrancy contract** in the live
   layer — cheapest fix, highest production payoff, protects every
   downstream experiment.
2. **Partition-cardinality cap (or warning) on
   `LivePartitionedSeries`** — the OOM class has already bitten once
   (#175).
3. **Perf scripts in CI with thresholds, plus coverage reporting** —
   make the written perf discipline survive the PR that introduced it.
4. **Migrate `useSnapshot` / `useLatest` / `useEventRate` to
   `useSyncExternalStore`** — silent data-integrity bug on modern
   React, with a working in-repo template.
5. **Start operator extraction from `time-series.ts`** — every wave it
   waits, the cast pattern entrenches and the live dual-path
   divergence gets harder to unify.

---

## Audit-method notes

- One agent finding was **rejected** during spot-checking: a claim
  that the `"types"`-before-`"import"` ordering in `package.json`
  `exports` maps is wrong. It is in fact the TypeScript-recommended
  order; no change needed.
- Claims verified directly against source before inclusion: bare
  listener fan-out loops, `useState`-based hooks vs
  `useSyncExternalStore`, CI matrix/steps, release workflow trigger
  and verify step.
- Line numbers will drift; treat them as anchors for the audit date,
  not live references.
