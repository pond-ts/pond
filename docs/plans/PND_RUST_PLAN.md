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

## Next

- **[PND-RUST-R1A]** — Measured vertical slice (adopted). Steps:
  1. Repair the WASM spike's benches for the NaN-as-missing `Float64Column`
     ([PND-NANREP] follow-up 2) and re-measure the pond-ts baseline.
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
- **[PND-RUST-R1B]** — Rest of batch core (`align`, `partitionBy`, `join`,
  remaining element-wise ops). Not adopted until R1a reports.
- Threading: behind a `parallel` feature, off for wasm32; parallel reductions
  must give the same bits as one thread (fixed chunks, ordered combine).
