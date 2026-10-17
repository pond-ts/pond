# RFC: pond-rs — a native Rust core

**Status:** draft, **not adopted.** Nothing here is a commitment until a
section is adopted into [`PLAN.md`](../../PLAN.md). Red-team it first.

**Relationship to PLAN.md:** tracked as an RFC entry ([PND-RUSTRFC]). No
build tasks yet.

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
