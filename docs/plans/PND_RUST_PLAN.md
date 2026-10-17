# PND_RUST_PLAN — pond-rs, a native Rust core

> Breakout plan for the **pond-rs** roadmap section in
> [PLAN.md](../../PLAN.md). Design context:
> [docs/rfcs/pond-rs.md](../rfcs/pond-rs.md).

_Opened 2026-10-17._

## Decisions

**Building pond-rs is a committed decision** (pjm17971, 2026-10-17; reasoning
outside this record). The Codex review's R−1 "stop if it doesn't pay" phase is
therefore not adopted, but its measurements are, as R1a's acceptance targets
(RFC Amendment 1).

Owner-confirmed 2026-10-17 (RFC §3): native Rust first, WASM bridge into
pond-ts last; lives in this monorepo as a Cargo workspace; schema checked at
runtime with precise errors; pond's own columns with Arrow import/export; order
batch core → financial studies → live → WASM. Users are agents writing Rust
against the crate. Charts, React and `@pond-ts/process` are out of scope.

Taken as defaults when R0 started (stated to the owner, revisit if wrong):

- **Crate name `pond-rs`**, imported as `pond_rs`. `pond` is taken on crates.io
  by an unrelated 2018 thread-pool crate; `pond-rs` was free on 2026-10-17.
  Not published until R1 has something usable (`publish = false`).
- **Time zones: `jiff`**, added when R1 first needs it. pond-ts does its zone
  math with the Temporal polyfill (`@js-temporal/polyfill`, see
  `packages/core/src/core/time-zone.ts`), and `jiff` is modelled on Temporal,
  so DST and "start of day" rules should line up with less translation than
  `chrono` + `chrono-tz`. Confirm against the calendar `Sequence` fixtures when
  they exist.
- **Edition 2024, minimum Rust 1.85** (the first release with edition 2024).
  CI tests on stable only; no separate minimum-version job yet.

## [PND-RUST-R0] — scaffolding and parity harness — DONE

What landed:

- Root `Cargo.toml` workspace (`crates/*`, `spikes/` excluded so the WASM
  spike keeps building standalone) and `crates/pond-rs` with no public API yet.
- **Core parity fixture.** `packages/core/scripts/parity/cases.mjs` records
  pond-ts's own output for 20 cases (rolling, aggregate, diff, rate,
  pctChange, cumulative, shift, fill) over two inputs — a gappy irregular
  series and a dense 1s grid of exact binary fractions — as
  `TimeSeries.toJSON()`. `generate.mjs` writes
  `packages/core/test/fixtures/parity.json`. All cases are exact except rolling
  `stdev` (1e-12).
- **Drift guard.** `packages/core/test/parity-fixture.test.ts` rebuilds the
  fixture from pond-ts source and fails if the committed file differs, so the
  Rust target cannot silently fall behind pond-ts. Checked by mutating one cell:
  the test fails.
- **Rust harness.** `crates/pond-rs/tests/core_parity.rs` and
  `tests/study_oracle.rs` read both fixtures (the 220-case financial oracle
  unchanged). Each has a `run` dispatch that returns `None` for anything not
  implemented; once an op gets an arm, every fixture case for it must match.
  Comparator self-tests prove a one-ulp change, a missing-vs-present cell, a
  shifted key and a dropped row are all caught. Study tolerance matches the TS
  oracle test (`toBeCloseTo(_, 9)`, i.e. < 5e-10).
- **CI**: `rust` job in `ci.yml` — `cargo fmt --check`, `clippy -D warnings`,
  `cargo test`. No Node needed.

**"Exact" means same operation order, not just same maths.** Most core cases
demand bit-identical output, so R1 must reproduce pond-ts's arithmetic step for
step: e.g. `fill-linear-hold` at 9000 is `0.666666666666667`, not the nearest
double to 2/3, and `rate` / `pctChange` depend on the exact formula. A one-ulp
mismatch there is a port that computes differently, not a harness bug; give the
case a `tolerance` only when pond-ts's own order is incidental (as with rolling
`stdev`).

Behaviours the fixture already pins that a port could easily get wrong (worth
reading before R1): a time window over only-missing cells `sum`s to `0` but
`avg`s to missing; `aggregate` emits empty buckets (`count` 0, `sum` 0, others
missing); `diff`/`rate` against a missing neighbour give missing rather than
skipping back; rolling `stdev` is population (`ddof=0`), so a one-sample
window is `0`.

### R0 follow-up from the Codex review (same PR)

- Fixture cells tag `-0` / `NaN` / `±Infinity` as `{"f64": …}`; exact
  comparison is bitwise (`-0` ≠ `0`); a tolerance applies to finite values only.
  New `signed` input pins `-0` through `pctChange`, `shift` and `cumulative`.
- Error cases: `{ "error": { name, message } }` where pond-ts throws; pond-rs
  must also error (messages are not matched). 26 cases now.
- CI also runs `cargo check --target wasm32-unknown-unknown`.
- Found while recording errors (pond-ts bugs, not fixed here):
  `diff('nope')` throws a raw `Cannot read properties of undefined (reading
'kind')`; `rolling` with an unknown column reports "aggregate mapping
  references unknown source column". Tracked as [PND-ERRMSG] in PLAN.md.

## R1a step 1 — baseline (DONE)

Shipped `crates/pond-rs/bench/`: a fixed-seed 1M-row Arrow file, pond-ts and
polars runners for workloads A and B (Arrow in → compute → Arrow out, median
of 7 runs, memory growth for one run), and a script that checks both give the
same answers. Full table and method in `crates/pond-rs/bench/README.md`.

Numbers (4-core cloud machine, Node 22.22, polars 2.0.0; ranges over three
repeats):

| workload | pond-ts total | polars 1 thread | polars 4 threads |
| -------- | ------------- | --------------- | ---------------- |
| A        | 1885–1930 ms  | 421–429 ms      | 208–222 ms       |
| B        | 92–102 ms     | 28–31 ms        | 20–23 ms         |

What that makes the R1a speed targets on this machine: pond-rs one thread
≤ ~940–965 ms on A and ≤ ~46–51 ms on B (2× pond-ts); pond-rs all cores
≤ ~260–280 ms on A (1.25× polars, four cores here). Polars on one thread is
already ~4.5× faster than pond-ts on A, well past the 2× bar, so the polars
target is the hard one. (pond-ts A is slower than it would be on gap-free
windows; see [PND-ROLLGAP] below. Without the outages it is ~1250–1300 ms.)

Decisions and findings:

- **Step 1 changed from what was planned.** The plan said "repair the WASM
  spike's benches and re-measure pond-ts". Those benches time the spike's own
  kernels run as WASM behind JS, not the R1a workloads, so their numbers could
  not be compared with any R1a target. The baseline the targets need is
  pond-ts and polars on workloads A and B, so that is what step 1 built. The
  spike repair moves to R4, whose RFC row already says it re-asks the spike's
  question with fresh numbers.
- **pond-ts and polars agree on bucketing**: every key, count and gap match,
  and bucket averages are within 5e-13. The data has three 10-minute outages
  (all columns missing) so empty buckets and empty rolling windows are
  actually exercised; the first draft had none, which an adversarial review
  caught.
- **pond-ts rolling results drift, and near outages the error is large.**
  pond-ts keeps a running sum and a running stdev (Welford add/remove), updated
  as each value enters and leaves the window, and clears the built-up rounding
  error only when the window empties completely. On dense stretches that is
  small: up to ~5e-9 off an exact stdev and ~1e-9 off an exact average
  (polars: ~1e-12), growing along the series. As a window drains towards an
  outage, the stdev gets small but the error does not: the worst row has two
  values, 126.31951 and 126.32022, true stdev 0.000354, pond-ts 0.000442 (25%
  wrong), polars exact. A single-value window gives an average 9.4e-10 off the
  value itself. Logged as [PND-ROLLSTD]; it is a pond-ts bug in its own right,
  not only a pond-rs concern. For pond-rs: copying pond-ts's order of
  operations exactly would copy this, so rolling `sum`/`avg`/`stdev` parity
  should be "within tolerance of an exact answer", not "same bits as pond-ts".
  Workload B (the exact-match target) has no rolling, so R1a is not blocked.
- **pond-ts rolling slows down ~60% when some windows are empty**: three
  10-minute outages (0.18% of rows) take `rolling('5m', avg)` from ~400 to
  ~650 ms. Profile: the extra time is in writing results to the output
  (`writeGroup`) and in garbage collection; the cause is not established yet.
  Logged as [PND-ROLLGAP].
- **The memory target needs revising**; proposal above in Next.
- The RFC said pond-ts runs on Node 24; this machine has Node 22.22, recorded
  with the numbers.

## Next

- **[PND-RUST-R1A]** — Measured vertical slice (adopted). Steps:
  1. ~~Baseline~~ — done, see "R1a step 1 — baseline (DONE)" above.
  2. `Time` / `Interval` keys, `Sequence.every` and
     `Sequence.calendar(unit, { timeZone })` (with `jiff`), NaN-as-missing
     number columns, Arrow IPC in/out, `rolling`, `aggregate`; grow the
     fixture with calendar cases that record the tzdb version.
  3. Property tests independent of pond-ts (rolling `sum` = naive window
     re-sum; aggregate `count`s total the non-missing cells; …). A
     disagreement with the fixture is a pond-ts bug report first.
  4. Benchmarks A (generic, 1M rows) and B (DST calendar buckets) against
     pond-ts, pond-rs 1-thread / all-core, polars 1-thread / all-core, plus
     an agent trial on B — targets in RFC Amendment 1. A miss means redesign
     before R1b.
- **R1a memory target — proposed revision (awaiting pjm17971).** The target
  as written, "peak memory ≤ 2× the input Arrow size", cannot be met by any
  engine on workload A: input plus output is already ~110 MB (38.6 + 71)
  against a 2× limit of ~77 MB, and polars on one thread grows by ~256 MB
  (6.6× the input) doing it. Proposed:
  **one-run memory growth no more than polars on one thread, on A and on B**,
  measured as `run_mem_mb` in `crates/pond-rs/bench/`. That keeps the target
  relative to the same competitor as the speed targets. The "one pass per
  column for Arrow in and out" half stands. Caveat: for pond-ts the number is
  the growth during the first (warm-up) run, so it includes JIT work and
  garbage not yet collected; it is indicative only. For pond-rs and polars
  (no garbage collector) it is a clean measure, which is what the target
  compares.
- **[PND-RUST-R1B]** — Rest of batch core (`align`, `partitionBy`, `join`,
  remaining element-wise ops). Not adopted until R1a reports.
- Threading: behind a `parallel` feature, off for wasm32; parallel reductions
  must give the same bits as one thread (fixed chunks, ordered combine).
