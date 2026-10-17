# RFC: pond-rs — a native Rust core

**Status:** building pond-rs is a **committed decision** (pjm17971,
2026-10-17). A phase is a commitment only when PLAN.md explicitly marks that
implementation task or phase adopted: today **R0 (done) and R1a**. Read the
original draft together with [Amendment 1](#amendment-1-response-to-the-codex-review-pond-ts-library-agent-claude--pjm17971-2026-10-17),
which corrects several of its claims.

**Relationship to PLAN.md:** pond-rs section; breakout plan
[`PND_RUST_PLAN.md`](../plans/PND_RUST_PLAN.md).

**Evidence base:**

- [`spikes/columnar-wasm/REPORT.md`](../../spikes/columnar-wasm/REPORT.md) —
  the Rust → WASM spike (one column kind, behind the JS API).
- [`docs/plans/PND_COLUMNAR_PLAN.md`](../plans/PND_COLUMNAR_PLAN.md)
  "External reference: polars" — pond-ts vs polars on 500k one-minute bars.
- [`docs/notes/agent-workloads-2026-07.md`](../notes/agent-workloads-2026-07.md)
  — the agent questions and the < 100 ms gate.

**Authorship:**

| Section                                 | Contributor                                           |
| --------------------------------------- | ----------------------------------------------------- |
| Original draft + decisions §3 confirmed | pond-ts library agent (Claude) + pjm17971, 2026-10-17 |
| Codex review                            | Codex, 2026-10-17 (relayed by pjm17971)               |
| Amendment 1 (response to Codex)         | pond-ts library agent (Claude) + pjm17971, 2026-10-17 |

---

## Original draft: pond-ts library agent (Claude) + pjm17971, 2026-10-17

### 1. Thesis

Build **pond-rs**: a native Rust implementation of pond's core and financial
studies, for **AI agents writing Rust**. Later, compile the same core to WASM
and offer it back to pond-ts where it measurably pays.

Three shapes were considered:

1. Native Rust library for Rust users.
2. Rust engine under pond-ts (WASM).
3. Both: one Rust core, used natively first, bridged to JS later.

**Chosen: (3), native first.** (2) alone was the spike, and it was close to a
wash: real wins on reductions, real losses elsewhere, and a heavy structural
price (§2). (1) is newly worth doing because the users are now agents, who
write Rust as readily as TypeScript and want the fastest thing available.

### 2. What the evidence already says

_(Amendment 1: these spike numbers are historical — the harness predates
[PND-NANREP] and no longer runs; re-measure before relying on them.)_

**The WASM spike (behind the JS API).** Bit-identical across 1,380 parity
checks. Measured ~2.2–2.6× on the reduce family (`aggregate`, `bin`,
`reduce`, `column().sum()`), but **slower** on `align` (0.82×) and `byValue`
(0.77×), and the row-shaped API got 2× slower. The case against was not speed
but price: data must live inside WASM memory to win, a 4 GB cap (wasm32),
manual `free()` in a garbage-collected library, and `toFloat64Array()` can no
longer hand back a stable array (REPORT §7).

**Almost none of that price applies to a native crate.** No boundary to cross,
no 4 GB cap, Rust owns its memory normally, and there is no row API to keep
cheap for a JS caller.

**pond-ts vs polars (Rust kernels), 500k one-minute bars:**

| shape                                    | result                                    |
| ---------------------------------------- | ----------------------------------------- |
| composite studies (5-study pass)         | pond-ts **0.83×** of polars single-thread |
| `ema(20)`                                | pond-ts **0.33×** (3× faster)             |
| whole-column `mean` / `stdev` / `minMax` | pond-ts **4–9× slower**                   |
| 5-study pass vs polars 10 threads        | pond-ts **3.39× slower**                  |

So pond's algorithms are already competitive; what pond-ts lacks is wide CPU
instructions (SIMD) on simple reductions and **threads**. A native core gets
both. (Blocked summation has since closed `mean` from 8.98× to ~3.8× in
TypeScript; the rest is still open.)

_(Amendment 1: the next paragraph overstates the gap — see point 2.)_

**Agent workloads.** The < 100 ms gate over 500k–1M points is already met for
the benchmarked questions in TypeScript. The open gap
([PND-AGENTBENCH]) is parallelism **across partitions**, which JS workers do
poorly (`withWorkers` measured 1.00× there) and Rust threads do well.

### 3. Decisions (confirmed by pjm17971, 2026-10-17)

1. **Lives in this monorepo**, as a Cargo workspace beside `packages/`
   (proposed: `crates/`). Shares PLAN.md, CI, and — most importantly — the
   test fixtures. The financial oracle (`packages/financial/test/fixtures/
study-oracle.json`, 220 cases, plain `{ meta, input, cases[{ study,
params, expected }] }` JSON) is readable from Rust unchanged.
2. **Schema checked at runtime, with errors that say exactly what to fix**
   (polars-style), not compile-time column typing. pond-ts tracks column names
   and types in TypeScript's type system; Rust generics cannot express "this
   series has a column called `close` of type number" without macros, and an
   agent is better served by a precise runtime error than by a generic-trait
   compile error. A typed layer (derive macro) can come later if asked for.
3. **pond's own simple columns, with Arrow import/export.** pond-ts now marks
   a number gap as `NaN` inside the column's own buffer ([PND-NANREP]); Arrow
   tracks gaps in a separate validity bitmap. Building directly on Arrow would
   fight that rule. Convert at the edge instead, as pond-ts already does
   (`toArrow` / `fromArrow`).
4. **Order:** batch core → financial studies → live layer → WASM bridge into
   pond-ts. Charts, React and `@pond-ts/process` are out of scope.

**How agents use it:** mostly by writing Rust that depends on the crate
(confirmed). A command-line or MCP tool on top is possible later, not planned.

### 4. Who the user is, and what that changes

The user is an agent writing Rust against the crate. That has consequences
beyond "make it fast":

- **Agents already know polars well.** pond-rs must win on what polars does
  not do natively: time-aware keys (`Time` / `TimeRange` / `Interval`),
  calendar-aware `Sequence` bucketing, explicit gap semantics, trading
  calendars, oracle-checked finance studies, and live/incremental updates.
  Generic dataframe work is not the pitch.
- **Correct on the first try matters more than terse.** Small surface; one
  obvious way to do each thing; method names matching pond-ts so an agent
  that knows one knows the other.
- **Errors are documentation.** Every error names the column, the expected
  vs actual kind, and the fix. Agents read error text and retry; a vague
  error costs a whole turn.
- **Examples compile.** Doc examples run as tests (`cargo test --doc`), so
  documentation an agent copies cannot drift from the code.

### 5. Scope, in phases

_(Amendment 1 splits R1 into R1a, a measured vertical slice, and R1b.)_

Sizes are today's pond-ts TypeScript, for scale only — a Rust port is not a
line-for-line translation.

| phase  | contents                                                                                                                                                                                                                      | pond-ts size today                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **R0** | Workspace skeleton, CI (`cargo test`, `clippy`, `fmt`), parity harness reading shared fixtures                                                                                                                                | —                                                                  |
| **R1** | Core values (`Time`, `TimeRange`, `Interval`, `Sequence`, time zones) + columnar store + batch `TimeSeries`: query, slice, select, `fill`, `align`, `aggregate`, `rolling`, `diff`/`rate`/`cumulative`, `partitionBy`, `join` | `core` 1.7k, `columnar` 6.7k, `reducers` 2.3k, `batch` 13.9k lines |
| **R2** | Financial studies against the pandas oracle; trading calendars                                                                                                                                                                | `@pond-ts/financial` 26.7k lines, 97 study files                   |
| **R3** | Live layer: `LiveSeries`, live rolling/aggregation, triggers                                                                                                                                                                  | `live` 9.7k lines                                                  |
| **R4** | WASM build of the same core, offered behind pond-ts where it pays — and only after re-asking the spike's question with fresh numbers                                                                                          | spike harness exists                                               |

Each phase ends with a parity gate: same input, same output as pond-ts.

### 6. Keeping two implementations honest

Two implementations of one library drift unless something mechanical stops
it.

- **Shared fixtures are the contract.** Financial studies already have one
  (the pandas oracle). Core operators need the same: a script in pond-ts that
  writes `{ input, op, params, expected }` JSON from pond-ts's own output,
  which both test suites read. pond-ts is the reference until 1.0.
- **Numerical agreement is defined, not assumed.** Blocked summation already
  makes pond-ts non-bit-identical to sequential summation (see
  `docs/notes/blocked-summation.md`). SIMD and threads in Rust will diverge
  further. Each fixture states its tolerance; exact cases stay exact.
- **Names follow pond-ts.** `snake_case` per Rust convention
  (`pct_change`, `partition_by`), otherwise identical. Renames happen in
  pond-ts first.

### 7. Risks

- **pond-ts is not at 1.0.** PLAN.md puts 1.0 three to six months out and says
  the API still moves. Porting a moving API doubles the cost of every change.
  Mitigation: port the parts that have been stable longest first (core values,
  columnar, reducers, `rolling`, `aggregate`); hold back areas still in flux.
- **Two maintenance surfaces.** Every pond-ts change now asks "and in Rust?".
  The shared fixtures make the gap visible; they do not close it.
- **The pitch versus polars.** If the time-aware primitives are not
  noticeably better for agents than polars' own, pond-rs is a slower polars.
  This should be tested with an agent experiment (CLAUDE.md "Multi-agent
  experiments") early, not argued.
- **R4 inherits the spike's costs.** Native-first defers them, it does not
  remove them.

### 8. Open questions

_(Amendment 1 corrects Q2 and replaces Q5.)_

1. **Crate name.** `pond` is taken on crates.io (an unrelated 2018 thread-pool
   crate). `pond-rs` and `pond-ts` are free (checked 2026-10-17). Proposed:
   publish as `pond-rs`, import as `pond_rs`.
2. **Time zones and dates.** pond-ts uses `Intl.DateTimeFormat`. Rust options
   are `chrono` + `chrono-tz` (most common) or `jiff` (newer, closer to
   JavaScript's Temporal). Needs a short comparison.
3. **Threads by default?** polars parallelises by default. Proposed: `rayon`
   across partitions and large columns, with a switch to turn it off for
   reproducible single-thread runs.
4. **Minimum Rust version** and release cadence: lock-step with the `v*` tag,
   or independent versions?
5. **First experiment.** Which agent workload is the R1 acceptance test? The
   [PND-AGENTBENCH] Q11 panel (500 symbols × 1000 bars, per-symbol `zScore`,
   rank across symbols) is the natural candidate: it is the one where threads
   across partitions should show up immediately. It needs `zScore` from R2
   pulled forward, plus a cross-partition rank ([PND-XSECT] is the same gap in
   pond-ts).

---

## Codex review, 2026-10-17

_Relayed verbatim by pjm17971. One link pointed at a Codex-internal URL and is
replaced by a plain section reference._

The PR is already merged and CI is green, but my RFC verdict is: **keep the
direction alive; do not adopt R0–R4 yet.** Adopt a disposable **R−1 validation
phase** first.

The strongest idea is pond's domain semantics in Rust—time-aware keys,
calendar bucketing, trading calendars, studies, and live updates. "Agents write
Rust and want the fastest option" is still an assumption, not evidence
sufficient to justify maintaining a second implementation.

### Adoption blockers

1. **The performance evidence needs rebaselining.**
   The RFC presents the WASM spike's 2.2–2.6× results as current evidence, but
   [PLAN.md says PND-NANREP changed the column representation and the spike's
   benchmark/parity harness now throws](https://github.com/pond-ts/pond/blob/8bf8ac741bd6be0aabe51b02b7f2612b17050b0e/PLAN.md#L679-L689).
   The TypeScript baseline also gained blocked summation and faster study
   paths. Repair and rerun the harness before using those numbers to adopt a
   native port. Rust enables SIMD and threads; it does not automatically make
   these operations faster.

2. **Q11 does not support the RFC's threading conclusion.**
   The RFC calls `[PND-AGENTBENCH]` an open gap and says threads should show up
   immediately. The current plan instead records Q11 at **39 ms/500k and 79
   ms/1M**, already inside the gate; 43–44% is serial partitioning, limiting
   study parallelism to roughly 2× and making split cost the first target
   ([PLAN.md](https://github.com/pond-ts/pond/blob/8bf8ac741bd6be0aabe51b02b7f2612b17050b0e/PLAN.md#L496-L509)).
   Moreover, the proposed R1 acceptance workload (§8 Q5) requires R2's
   `zScore` and a rank primitive pond-ts does not have. Choose an
   R1-contained workload and give it a numeric go/no-go threshold.

3. **The parity contract cannot work as currently described.**
   Ordinary JSON loses `NaN`, `±Infinity`, signed zero, and `undefined`—the
   exact cases that exposed the previous Rust/JS defects
   ([spike report](https://github.com/pond-ts/pond/blob/8bf8ac741bd6be0aabe51b02b7f2612b17050b0e/spikes/columnar-wasm/REPORT.md#L129-L171)).
   Define a tagged scalar/result format. Keep shapes, ordering, gaps, errors,
   non-finites, and signed zero exact; allow tolerances only for explicitly
   reassociative finite kernels. Also separate:
   - versioned compatibility tests against a named pond-ts commit;
   - independent correctness/property tests, so pond-ts bugs are not
     fossilized as the Rust specification.

4. **There is no falsifiable product or performance gate.**
   Every phase currently ends with parity, so the entire port could "succeed"
   while being slower, heavier, or no easier for agents than Polars. R1 is
   also far too broad for hypothesis validation—effectively most of core and
   batch. The Polars differentiation experiment mentioned in the risks belongs
   before R0, not after the port starts.

### The R−1 phase I would adopt

- Repair and rerun the current benchmark suite.
- Build one disposable native vertical slice, including realistic Arrow ingest
  and output.
- Compare current pond-ts, single-thread/all-core Rust, and Polars on:
  - one end-to-end analytical workload;
  - one pond-specific workload involving DST/trading-calendar/gap semantics.
- Predeclare thresholds for correctness, agent completion/retries, latency,
  memory, copying, and deterministic results.
- Stop if neither end-to-end performance nor agent success improves
  materially.

Before promising "the same core" for WASM, also keep a minimal
native/`wasm32` build in CI and feature-gate threading. Rayon's floating-point
reductions are not inherently deterministic across schedules
([Rayon documentation](https://docs.rs/rayon/latest/rayon/iter/trait.ParallelIterator.html)).

Minor factual fixes:

- The 220-case oracle shape is `{ study, params, input?, expected }`; 11 cases
  select `"long"` or `"session"` input.
- pond-ts time-zone behavior is implemented against the Temporal polyfill, not
  primarily `Intl.DateTimeFormat`; parity needs Temporal-compatible fold/gap
  rules and a tzdb-version policy.
- "Adopted when a section enters PLAN.md" is ambiguous because this PR adds
  such a section while calling it unadopted. Say "when an implementation task
  or phase is explicitly marked adopted."

The native-first ordering, monorepo placement, precise runtime errors,
domain-focused pitch, and decision to defer WASM are all strong calls. My
answer is **"prove the wedge with a narrow experiment," not "don't build
it."**

---

## Amendment 1: response to the Codex review — pond-ts library agent (Claude) + pjm17971, 2026-10-17

**Direction.** pjm17971 has made building pond-rs a committed decision; the
reasoning sits outside this record. So the R−1 _stop_ condition is not
adopted. Everything else in R−1 is: its measurements become the acceptance
criteria of a narrowed first build phase (R1a, below). Missing a threshold
means redesign before R1b, not abandonment. Each point was checked against the
repo before being accepted.

**1. Rebaselining — accepted.** Verified: the spike's benches still build
`Float64Column` with the pre-[PND-NANREP] signature, which now throws (PLAN.md
[PND-NANREP] follow-up 2). §2's spike figures are historical. Repairing the
spike harness and re-measuring pond-ts is the first step of R1a, and every
Rust speed claim is made against that fresh baseline.

**2. Q11 — accepted; §2 and §8 Q5 were wrong.** PLAN.md records Q11 inside the
gate (39 ms at 500k, 79 ms at 1M) with the serial split at 43–44%, so
parallelism across partitions caps near 2× and the split is the first target.
Q5's workload needed R2's `zScore` and a cross-partition rank that does not
exist. Replaced by the two R1a workloads below.

**3. Parity contract — accepted, and implemented in PR #763:**

- The core fixture tags `-0`, `NaN`, `±Infinity` as
  `{"f64": "-0" | "NaN" | "inf" | "-inf"}`. Exact comparison is bitwise (`-0`
  ≠ `0`). A tolerance applies only to finite values, and only on cases that
  declare one. New cases pin `-0`: `pctChange` of `-2 → -2` is `-0`, and
  `shift` must carry an input `-0` through unchanged. `undefined` has no
  separate meaning in pond-ts output: a missing cell is `null`, and since
  [PND-NANREP] any non-finite number in a number column _is_ missing, so a
  pond-ts series never holds `NaN` or `±Infinity` as a value. The tags exist
  for pond-rs's own outputs and for future non-number columns.
- Errors are cases too: `{ "error": { name, message } }` when pond-ts throws.
  Only "pond-rs also errors" is checked for now. pond-rs errors are meant to be
  more precise than pond-ts's, so matching messages would copy the wrong thing.
- **Versioning:** the fixture is committed in the same commit as the pond-ts
  source it describes, and the drift test fails if they disagree, so the commit
  _is_ the named version. A separate version field would only go stale.
- **Independent tests:** R1 adds property tests that are not derived from
  pond-ts (e.g. rolling `sum` equals a naive re-sum of each window; aggregate
  `count`s total the non-missing cells; `shift(n)` then `shift(-n)` restores
  the interior). When one disagrees with the fixture, the first step is a
  pond-ts bug report, not a fixture update. Building the error cases has
  already found two pond-ts error-message bugs: `diff('nope')` throws a raw
  `Cannot read properties of undefined (reading 'kind')`, and `rolling` with
  an unknown column says "aggregate mapping references unknown source column".

**4. A falsifiable gate — accepted.** R1 as drafted was most of core. It is
split:

- **R1a — measured vertical slice.** `Time` and `Interval` keys,
  `Sequence.every` and `Sequence.calendar(unit, { timeZone })`, NaN-as-missing
  number columns, Arrow IPC in and out, `rolling` and `aggregate`. Two
  workloads, each run on current pond-ts (Node 24), pond-rs on one thread and
  on all cores, and polars on one thread and on all cores:
  - **A, generic:** 1M rows of 1 s samples, 4 number columns, ~5% gaps. Arrow
    in → `aggregate(every 1m: avg/min/max/count)` and
    `rolling('5m', avg/stdev)` → Arrow out.
  - **B, pond-specific:** the same shape spanning a US DST change, bucketed by
    `Sequence.calendar('day', { timeZone: 'America/New_York' })`,
    with gaps. Here the question is whether the answer is right and easy to
    write, as much as how fast it runs.
- **Predeclared targets** (proposed; pjm17971 may revise before measurement):

  | dimension      | target                                                                                                                                                           |
  | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | correctness    | every slice fixture case passes; B matches pond-ts exactly                                                                                                       |
  | latency        | single-thread pond-rs ≥ 2× faster than pond-ts end to end, including Arrow in and out, on A and B                                                                |
  | vs polars      | all-core pond-rs within 1.25× of all-core polars on A                                                                                                            |
  | memory, copies | peak memory ≤ 2× the input Arrow size; at most one pass over each column for Arrow in and for Arrow out (gaps become `NaN`, so a zero-copy read is not possible) |
  | deterministic  | identical bits on 1 thread and N threads                                                                                                                         |
  | agent          | on B, an agent given pond-rs reaches the right answer at least as often as one given polars, with fewer retries (10 runs each side)                              |

  Correction after measuring (R1a step 1): the memory row cannot be met by
  any engine on A, since A's output alone is larger than 2× its input. A
  revision is proposed in `docs/plans/PND_RUST_PLAN.md`. Workload B originally
  also named an `'hour'` calendar unit; pond-ts has none (`day` through
  `year`), so B is `'day'` only.

- **R1b — the rest of batch core** (`align`, `partitionBy`, `join`, the
  remaining element-wise operators), adopted only after R1a's numbers are in.

**WASM and threads — accepted.** CI now also builds pond-rs for
`wasm32-unknown-unknown`, so native-only code cannot creep in un-gated.
Threading will sit behind a `parallel` feature, off for wasm32. Parallel
reductions must give the same bits as single-threaded ones (fixed chunk
boundaries, combined in order), because Rayon's own float reductions do not
guarantee that. Deterministic results are an R1a target above.

**Minor fixes — accepted.**

- The oracle shape is `{ study, params, input?, expected }`; 11 of 220 cases
  use `"long"` or `"session"` input. The harness already handles both.
- Time zones: pond-ts follows the Temporal polyfill, so parity means Temporal's
  rules for times that occur twice or not at all around a DST change. `jiff`
  (the R0 default) uses the same "compatible" default for those cases. tzdb
  policy: calendar fixtures record the time-zone database version pond-ts saw,
  and pond-rs pins its bundled tzdb to match in tests.
- Adoption wording fixed in the status line above.
