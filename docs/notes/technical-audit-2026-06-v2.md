# Technical audit v2 — June 2026 (second pass)

Second full audit, conducted 2026-06-11/12 against `main` at
`a085b6f` (v0.21.0 + PR #200), by the Pond technical consultant agent
(Claude). Follows [`technical-audit-2026-06.md`](technical-audit-2026-06.md)
(2026-06-10, v0.20.0) and
[`columnar-arc-assessment-2026-06.md`](columnar-arc-assessment-2026-06.md).

**Method.** Deeper than the first pass: a recheck agent re-verified all
32 first-audit findings at HEAD; three reviewers adversarially read the
v0.21 wave (PRs #186–#200) including the PR comment trails; six
hands-on agents ran code against the built dist — live-hazard repro
scripts, a 1M-row pipeline bench, an aggregate/rolling bench, a
cold-start greenfield adoption build from the packed tarball, and a
TZ/DST probe (full suite under three timezones). Every high-severity
new finding was then passed to independent adversarial verifiers
prompted to refute it; **all three high-severity findings below
survived verification (the stdev pair by three verifiers, asTime by
two), each with an executable repro.** One planned agent (a dedicated
packed-vs-chunked parity fuzzer) was lost to an org spend limit; its
ground was substantially covered by the derive-wave reviewer's own
differential fuzz — **~11,800 randomized comparisons of v0.21.0
against published v0.20.0, zero mismatches on type-correct input**.
Repro/bench scripts referenced below live under `/tmp/pond-audit2/`
(per-machine, not committed; key outputs are quoted here).

---

## 0. Executive summary

The v0.21 wave did what it set out to do, and the hands-on numbers
prove it: **the pipeline materialization tax is fixed.** Every wave
operator runs at 0–69 ns/row of eager columnar cost; a realistic
slice→fill→diff→select chain on 1M rows costs about one extra
construction (~85 ms), where at v0.20 each link paid a ≥495 ms
event-materialization toll. Differential fuzzing found zero behavioral
regressions on type-correct input across ~11,800 cases. Operator
extraction genuinely started, the perf-script discipline was followed
in substance on all six derive ops, and PLAN.md tracks reality.

But the audit also confirmed, with executable repros, **exactly the
failure class both prior notes warned about**: the step-3B aggregate
fast path silently changed `stdev` results in a _released_ version,
made numeric output (and one crash) depend on unrelated mapping
columns, and the new `mapColumns` reopened the NaN intake hole the 3A
kernels assume closed. The recommended row/columnar parity suite —
flagged twice, still a backlog item — is no longer hygiene; it has a
confirmed incident to its name. Meanwhile **zero files changed in
`src/live/`, `packages/react/`, `.github/`, or `website/docs/`** since
the first audit, so 25 of its 32 findings stand verbatim — including
the live-layer listener hazards, which this audit upgraded from
suspected to empirically reproduced, in two cases worse than
originally stated.

---

## 1. Fix before the next release (P0)

### 1.1 `aggregate('stdev')` — silent numeric change + shape-dependent crash (released in v0.21.0)

Two defects, one root cause. The 3A `reduceColumn` kernels were
parity-matched to the row-API `reduce()` (two-pass stdev), but the row
path that #186 displaces inside `aggregateInternal` is **bucketState**
(one-pass `sq/n − mean²`, `reducers/stdev.ts:74–78`):

- **Silent numeric change**: bucket `[1e10, 1e10+1, 1e10+2, 1e10+3]` →
  fast path **1.118** (correct), row path **0** (cancellation). #186
  therefore changed released numeric output while its PR body claims
  "signature + semantics unchanged". Worse, the paths are selected
  per-mapping (all-or-nothing): adding an unrelated `count` over a
  string column flips the same series' stdev from 1.118 to 0.
- **Shape-dependent crash**: bucketState lacks the `Math.max(0, …)`
  clamp that rollingState has (`stdev.ts:77` vs `:103` — the comment
  at `:26–28` claims the guard exists; it doesn't on this path). For
  `[5e7+0.1, 5e7+0.2, 5e7+0.3]`, `sq/n − mean²` computes to exactly
  −1 → `sqrt(−1)` = NaN → the validating constructor throws
  `ValidationError: row 0 col 1: expected finite number`. The same
  data with a fast-path-qualifying mapping returns 0.0816 (correct).
  Pre-existing crash, but #186 made it appear/disappear based on
  unrelated mapping entries. `LiveAggregation` shares bucketState and
  likely emits the same NaN into the live path — worth checking in the
  same fix.
- **The test suite was shaped around the divergence**: stdev is
  excluded from the parity loop
  (`TimeSeries.aggregate-columnar.test.ts:11–12`) and #187 pinned
  empty buckets — the one case that was provably safe — while the
  real divergence classes went untested.

**Fix (small):** mirror the `Math.max(0, …)` clamp at `stdev.ts:77`;
decide the canonical stdev (two-pass everywhere is the defensible
answer for a numerics library); pin both cancellation cases in the
parity tests; add a CHANGELOG entry correcting #186's "semantics
unchanged" claim. Verified by three independent verifiers
(scripts: `/tmp/pond-audit2/verify/stdev-*.mjs`).

### 1.2 `asTime({at:'end'|'center'})` — loud error became silent corruption (PR #200, main-only, **not** in v0.21.0)

Pre-#200, only `at:'begin'` was trusted; `'center'`/`'end'` went
through the validating constructor, whose sort check throws on
non-monotonic results. The column-native path (#200) routes all three
anchors through `withKeyColumn` + `#fromTrustedStore`, which performs
**no sort-order check**. For overlapping timeRange/interval extents
(legal input — spans, sessions): rows `[[0,1000],[10,20],[30,40]]` →
`asTime({at:'end'})` silently yields key axis `[1000, 20, 40]`;
`bisect(25)` then returns the wrong index and `timeRange()` reports
`[1000,1000]`. The #200 commit message's claim that center/end "match
the old trusted-events path" is factually wrong (only `'begin'` was
trusted), the L2 review checked per-event parity only, and
`withKeyColumn`'s JSDoc omits the sort precondition. Two verifiers
confirmed end-to-end, including against published v0.21.0 (which
correctly throws).

**Fix (small):** an O(N) monotonicity scan over the new begin buffer
for `'center'`/`'end'` (throw, matching old behavior — or sort, as an
explicit decision); document the sort invariant on `withKeyColumn`.
**This blocks the next release** — it is the only confirmed regression
not yet published.

### 1.3 `mapColumns` reopened the NaN intake hole (PR #196 × #186 interaction)

The 3A kernels' NaN handling rests on "assertCellKind rejects NaN at
public intake" — but `mapColumns` writes mapper output into packed
columns with **no NaN guard** (`operators/map.ts:97`). Confirmed:
`s.mapColumns({v: x => x===2 ? NaN : x})` is accepted, after which
`aggregate(min)` returns **3 via the fast path and 1 via the row
path** on the same bucket. The "principled NaN + Welford" design doc —
parked since 3A, recommended before 3C — is now urgent: every new
columnar writer multiplies the inconsistency surface.

**Decision needed:** either `mapColumns` rejects/coerces NaN at write
(consistent with intake), or NaN-bearing columns become officially
supported and the reducers get one documented NaN policy. The current
state is the worst of both.

---

## 2. First-audit scoreboard (recheck at HEAD)

The wave touched zero files in `src/live/`, `packages/react/src/`,
`.github/workflows/`, and `website/docs/` — so the first audit's
findings in those areas stand verbatim. Full status:

| Status          | Count | Notes                                                                                                                                                                                                                                                                     |
| --------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Still open      | 25    | includes every live-layer, React, CI, and docs item                                                                                                                                                                                                                       |
| Partially fixed | 1     | §3 god-file: 6 operators extracted, `time-series.ts` 4,859 → 4,728                                                                                                                                                                                                        |
| Restated        | 3     | grace boundary (direction was backwards — boundary-equal is _accepted_; the untested-boundary gap is real), TZ (see §6), `validateAndNormalize` two-pass (it's **dead code** — exported, imported, invoked nowhere; the item is now a cleanup, not a perf concern)        |
| Invalidated     | 3     | snapshot-cache stale window (`#version` bumps before every fan-out), chunked cache-remap collision (fresh-Map rebuild; structurally impossible), rolling boundary semantics (already documented in JSDoc _and_ pinned by a boundary-exercising parity test at audit time) |

Corrections worth owning: three first-audit findings did not survive
verification and are withdrawn above. Also, the first audit's live-file
line counts (1,185/1,448) were stale PLAN.md numbers even at audit
date — actuals were already 1,499/1,580.

One regression on a recheck item: **§2 type-safety erosion got
marginally worse** — `as unknown as` in `time-series.ts` is 94 (was
90), plus 16 more across the six extracted operators. Extraction
formalized the cast pattern ("the single trust boundary") rather than
replacing it with typed schema helpers; #200 additionally added three
provably redundant self-casts (`time-series.ts:1378/1399/1457` cast a
value to its own declared type — delete in a follow-up).

---

## 3. Empirical results: what the wave bought, and the new hotspot map

### 3.1 Pipeline tax — fixed (1M rows, 4 cols, ~5% missing; median-of-5)

| Op (op-only cost) | ns/row |     | Op                  | ns/row |
| ----------------- | ------ | --- | ------------------- | ------ |
| rename            | ~0     |     | mapColumns          | 12     |
| select            | 3      |     | rate                | 15     |
| cumulative        | 4      |     | fill(linear, 1 col) | 18     |
| diff              | 7      |     | shift               | 19     |
| slice             | 10     |     | collapse            | 46     |

Comparator: first `.events` access = **495 ns/row + 238 MB heap** (the
v0.20 floor every transform paid). The 4-op chain
slice→fill→diff→select = 85 ns/row total, ~6× cheaper than a single
`.events` touch, allocating ~31 MB of off-heap column buffers and
~0.3 MB of V8 heap. Eagerness verified — work happens in the op, not
deferred to first read.

### 3.2 The new per-row cost ranking (100k rows; × = vs flat columnar fill at 17 ns/row)

| Op                                         | ns/row  | ×       |
| ------------------------------------------ | ------- | ------- |
| **partitionBy(host).fill(hold).collect()** | **923** | **54×** |
| join (outer, 100k+100k)                    | 878     | 52×     |
| smooth(ema)                                | 766     | 45×     |
| dedupe()                                   | 700     | 41×     |
| rolling('5m', avg)                         | 537     | 32×     |
| align(5s, hold)                            | 517     | 30×     |
| materialize(5s)                            | 446     | 26×     |

**The headline structural finding: `partitionBy().<op>().collect()` is
now the most expensive common operation in the batch layer — and it is
the library's own recommended pattern.** Every Multi-entity JSDoc
warning on fill/diff/cumulative/shift/dedupe/rolling tells users to
scope through `partitionBy`, which buckets via `source.events` and
rebuilds per-partition via `fromEvents` — silently re-paying the exact
tax the wave just removed. A columnar partition split (scatter by
group index over the store) is the highest-leverage next batch target,
ahead of 3C.

### 3.3 Aggregate 3B — delivered, with three confirmed asterisks

- **Honest win is 2.75×**, not the PR's 3.5–4.6× (that's against the
  inflated custom-fn baseline, not the states path 3B displaces).
  Parity on well-behaved data is exact (0/16,666 buckets mismatched).
- **Cold first call erases the win**: `aggregate()` defaults `range`
  to `series.timeRange()`, which reduces over `this.events` —
  materializing all 1M Events (430 ms) before the "zero events
  materialized" fast path runs. One-shot pipelines see ~1.09×.
  **Cheapest big fix in this report: columnar `timeRange()`**
  (`begins[0]..begins[n−1]` off the key column,
  `time-series.ts:3664`) — makes the cold path ~21× faster end-to-end
  and benefits every `timeRange()` caller.
- **Partitioned aggregate can never take the fast path**: the
  auto-injected `'first'` reducer for the partition column has no
  `reduceColumn`, so the all-or-nothing gate bails for every
  partitioned call, always — the flagship multi-host workload is
  silently excluded (measured: ~14× slower than 64 fast-path groups
  would cost). Fix: special-case partition-constant columns (read
  cell 0) or make the fallback per-column. The CLAUDE.md-mandated
  partitioned bench scenario was omitted from `perf-aggregate-range.mjs`
  — that omission is what hid this.
- **Small-N regression is real**: 19–37% slower than the states path
  at 1 event/bucket (the PR's "floor is neutral, no threshold needed"
  claim doesn't hold against the honest baseline; the PR body was
  never corrected after the L2 review surfaced it).

### 3.4 3C sizing (rolling)

`rolling('1m', avg)` = 221 ns/event vs 14 ns/event for fast aggregate —
**5.8–15.3× headroom**, ~200 ms/1M events recoverable. Larger than the
assessment's 3–10× estimate, but the stdev incident validates the
sequencing: principled-NaN/Welford design doc first, then 3C.

---

## 4. Live layer — now empirically proven, third consecutive flag

No live-layer code changed since the first audit. The repro agent
upgraded the suspected hazards to demonstrated ones
(`/tmp/pond-audit2/repro-live/`):

1. **Listener error isolation — worse than stated.** A throwing
   listener doesn't just skip later listeners: **retention is skipped
   entirely** (buffer at 5 with `maxEvents: 3` until the next push,
   undocumented), and a derived `filter()` view becomes **permanently
   desynced and never heals** (source gains events the view will
   never see).
2. **Re-entrancy — three distinct failures.** Non-monotonic emission
   order; on the chunked backing a re-entrant push is **spuriously
   rejected as out-of-order** against events the listener hasn't seen
   (outer fan-out then aborts); with a view attached, the view breaks
   permanently with a misleading error that interpolates as
   `[object Object]` (`live-view.ts:704`).
3. **Unbounded partitions.** 81.9 MB / 50k unique keys (~1.7 KB per
   partition); per-partition `maxAge` is **push-driven, so quiet
   partitions never evict** (a 10s-maxAge partition retained its event
   9,999s later); unknown options like `maxPartitions` are silently
   ignored, so JS callers get no signal.
4. **Chained dispose.** `live.filter().map()` — disposing the final
   view leaves the intermediate processing all 10k subsequent pushes
   into an unbounded orphan buffer, and in the idiomatic one-liner the
   intermediate is unreachable: **there is no way to dispose it.**
   `dispose()` carries no JSDoc.
5. **Grace boundary — not a bug** (first-audit claim was backwards);
   exactly-graceWindowMs-late is accepted, matching docs. Residual:
   no test pins the exact boundary.
6. **Evict-callback staleness — real but narrow**: only a source
   listener registered _before_ a view's creation observes the view
   stale (insertion-order fan-out). Undocumented, order-fragile.

These are now the oldest known-and-confirmed defects in the library,
with executable repros, untouched across two audit cycles of intensive
shipping elsewhere. Items 1, 2, and 4 are a contained fix (error
isolation + listener-set snapshot + chain-aware dispose) in one file
cluster.

---

## 5. Adoption audit (greenfield, strict TS, NodeNext, packed tarball)

The pipeline a senior engineer wants to write is expressible, correct,
and fast — and the cold-start experience undermines it in the first
hour. Ranked friction (full detail in the agent report; probes under
`/tmp/pond-audit2/greenfield/`):

- **F1 (P1) — Mixed aggregate/rolling/reduce mappings silently lose
  columns from the result type.** The docs bless mixing shorthand and
  `{from, using}` specs in one call; the type system resolves such
  mappings to the shorthand overload and **every spec-keyed output
  column vanishes from the schema** while the runtime emits it. It
  follows the docs, runs correctly, and poisons every downstream
  access with casts — teaching exactly the wrong lesson about the
  library's headline feature. (Undocumented workaround: all-spec
  form.)
- **F2 (P1) — Shipped d.ts fail under `skipLibCheck: false`.**
  `stripInternal` removes `@internal` `EMITS_EVICT` from
  `dist/schema/series.d.ts` but its by-name re-export survives in
  `dist/schema/index.d.ts` → every strict consumer build fails with
  TS2305 until they flip `skipLibCheck`. One-line fix.
- **F3 (P1/P2) — Batch constructors throw on unsorted rows**, the
  requirement is undocumented in the ingest/cleaning docs, the error
  doesn't suggest pre-sorting, and there's no `{sort: true}` option —
  for a library positioned at messy ingest, the front door rejects
  the mess (`fromEvents` sorts; the capability exists).
- **F4 (P2)** — `required: false` cells are unrepresentable in typed
  rows including `LiveSeries.push` (13 minors old; live has no
  fromJSON escape hatch, forcing the `as` casts the front page says
  you'll never write).
- **F5 (P2)** — partitioned `aggregate` auto-injects the partition
  column at runtime but not in the type; three different auto-inject
  behaviors across materialize/aggregate/live-rolling.
- **F6 (P3)** — the first code example in getting-started doesn't
  compile (`Time` has no `asString()`; three key types, three
  string-conversion conventions).
- **F7–F12** — aggregate→pivot dead-ends without an `asTime` pointer;
  `at(-1)` works live but not batch; CJS consumers get
  `ERR_PACKAGE_PATH_NOT_EXPORTED` instead of a clear ESM message;
  shipped source maps point at non-existent `../../src` (~half the
  2.8 MB tarball); two stale doc remnants; typed `fromJSON` revival
  needs one cast.

What worked well, for calibration: all-spec aggregate narrowing,
typed `pivotByGroup` with as-const groups, the partitioned
dedupe/fill pipeline, exact JSON round-trips including interval keys,
the live side end-to-end, `pond-ts/types`, blocked deep imports, and
zero issues under `exactOptionalPropertyTypes`.

---

## 6. Corrections to the first audit: TZ/DST

Empirically refuted in the main: **2,178/2,178 tests pass under
`Pacific/Apia`, `America/New_York`, and `Asia/Kolkata`**; calendar
code defaults to UTC and uses real Temporal zone math (DST probe: 23h
spring-forward and 25h fall-back days, 167h DST week, 721h November,
aggregation counts 24/23/24 and 24/25/24 — all exactly correct). A
dedicated spring-forward test existed before the first audit
(`Sequence.test.ts:152–179`). What stands: no TZ pinning/matrix in CI
(future TZ-dependence would land undetected), and fall-back /
half-hour-offset cases are untested. **New minor finding:**
`Sequence.calendar('hour')` is accepted at runtime with no unit
validation and silently produces garbage (the two unit dispatchers
have _mismatched_ fallback branches — week-aligned starts stepping by
months; probe got 0 buckets over a 4h range). A runtime throw on
unknown units closes it.

---

## 7. Wave review — remaining findings (medium/low, unverified-by-second-agent)

- **collapse: mixed-kind reducer results silently coerced to missing**
  on type-legal input (kind inferred from row 0; a row-0 `undefined`
  poisons inference and nukes later numeric results — `[42, 'str']`
  becomes `[42, undefined]`). The one derive-wave finding that wants a
  code fix (kind-scan, or document loudly). PR claims "parity is
  exact"; CHANGELOG silent.
- **fill: literal `undefined` now throws** where v0.20 no-op'd —
  plausible in conditional-strategy JS (`{cpu: cond ? 'hold' : undefined}`);
  skip undefined-valued entries during spec resolution or document.
- **slice() silently dropped cross-derivation event identity**
  (`parent.events[i] === slice.events[0]` no longer holds) — likely
  the right trade, but unrecorded in PR/CHANGELOG despite the repo's
  own "strictly additive claims that aren't" review criterion. Also:
  zero-copy slice/rekey results **pin the parent's full buffers**
  (subarray retention) — needs one doc sentence + a copy-out pointer.
- **NaN input class untested for fill/shift/collapse** (fuzz says
  current behavior matches v0.20, but nothing pins it); chunked
  coverage is one hand-picked scenario per op (fill-linear-on-chunked
  and rate-on-chunked unpinned) — the recommended parity matrix would
  close all of these in one pass.
- **Kind→builder dispatch triplicated** (fill/map/collapse), flagged
  as follow-up in three successive PRs and still shipped triplicated;
  inconsistent unknown-column handling across the six extracted ops
  (two silently skip, four crash with an unhelpful TypeError);
  `withKeyColumn` naming breaks its own `with<Noun><Participle>`
  family pattern; `asInterval`'s cast-bypassed label rejection works
  by accident with a misleading error.
- **Partitioned perf scenarios missing from all six derive perf
  scripts** despite the CLAUDE.md checklist requiring them — the same
  omission that hid the partitioned-aggregate exclusion (§3.3).
- **Bundle budget** (measured inline): columnar substrate now
  ~48.5 KB gzipped (concatenated-dist measure) vs the original
  <25 KB RFC pin; the promised size-optimization sub-step has not
  materialized. Re-pin or formally amend.

## 8. Process findings

The two-comment review protocol ran genuinely on #186 and caught the
perf-baseline flaw — the system works. Deviations worth tightening:

- #186's L2 was **medium confidence with an explicit Codex-pass
  recommendation and two decisions deferred to the human**; the PR
  merged 66 minutes later with no Codex comment, no human comment, and
  no committed record of either decision — exactly the
  context-preservation gap CLAUDE.md prohibits. The response comment
  also cites a fix commit by a hash that doesn't exist on the PR.
- #187 skipped Layer 2 as "test only" — a category not in CLAUDE.md's
  skip list, and an L2 pass plausibly would have challenged its wrong
  central premise (empty buckets were the provably-safe case).
- #186's PR description still carries the uncorrected "floor is
  neutral" table its own author conceded was wrong; the mandated
  before/after table is prose in the squash commit.
- Calibration note: the L2's medium-confidence flag was _accurate_ —
  the dimension it declared "cleared" (parity) is where all three
  verified findings live. The protocol's confidence machinery worked;
  the merge discipline around it didn't.

---

## 9. Recommendations, re-ranked (north star: performance with a consistent, clear API)

**P0 — before the next release:**

1. stdev clamp + canonical-formula decision + parity pins + CHANGELOG
   correction (§1.1).
2. asTime monotonicity guard (§1.2 — blocks release; it's unreleased
   today).
3. mapColumns NaN decision; pull the principled-NaN design doc forward
   (§1.3).

**P1 — next wave:** 4. **Live-layer robustness cluster** (§4): listener error isolation,
listener-set snapshot for re-entrancy, chain-aware dispose, partition
cap + idle reaping. Two audits, empirical repros, zero movement —
if the experiments' dashboards are the flagship, this is the
flagship's foundation. 5. **Columnar `timeRange()`** (§3.3) — trivial, unlocks 3B for
one-shot callers and speeds every `timeRange()` call. 6. **Partitioned aggregate fast path** (partition-constant column
special-case) and the **columnar partitionBy split** (§3.2) — the
measured top of the batch cost table, and the library's own
recommended pattern. 7. **Greenfield F1 + F2** (mixed-mapping overload hole; broken d.ts
under `skipLibCheck: false`) — both cheap, both first-hour
adoption killers. 8. **The parity matrix suite** — recommended twice, now with a
confirmed incident (§1.1). Packed × chunked × NaN × undefined ×
row-vs-columnar per operator, one shared helper.

**P2:** 9. 3C rolling (after the NaN doc; 5.8–15.3× measured headroom). 10. F3–F6 doc/type fixes; `Sequence.calendar` unit validation; bundle
re-pin; CI items from the first audit (all still open — perf-in-CI
would have caught the small-N regression and the cold-call cliff
automatically).

**Standing risks to keep visible:** dual-path drift (the stdev incident
is its first confirmed materialization — §1.1's mapping-shape
dependence _is_ regression class 5 from the assessment); the export
tax (`.events`/`toJSON` at 495/844 ns/row + ~240 MB heap at 1M rows)
remains unrecovered for snapshot-then-serialize consumers; casts are
growing, not shrinking, through extraction.

---

## Audit-method notes

- Verifier discipline: every high-severity wave finding was
  independently re-derived from source and executed against dist by
  agents prompted to refute it; severity adjustments they proposed are
  reflected (asTime tempered to "main-only, blocks next release").
- Three first-audit findings were invalidated by this pass and are
  withdrawn (§2) — recorded here per the same standard this audit
  applies to PR claims.
- The TZ/DST section corrects the first audit using empirical evidence
  rather than code reading; the original finding was directionally
  wrong about the suite and right about CI pinning.
- Line numbers reference `a085b6f`; treat as anchors, not live
  references.
