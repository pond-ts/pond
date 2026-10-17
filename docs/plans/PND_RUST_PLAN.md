# PND_RUST_PLAN — pond-rs, a native Rust core

> Breakout plan for the **pond-rs** roadmap section in
> [PLAN.md](../../PLAN.md). Design context:
> [docs/rfcs/pond-rs.md](../rfcs/pond-rs.md).

_Opened 2026-10-17._

## Decisions

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

Behaviours the fixture already pins that a port could easily get wrong (worth
reading before R1): a time window over only-missing cells `sum`s to `0` but
`avg`s to missing; `aggregate` emits empty buckets (`count` 0, `sum` 0, others
missing); `diff`/`rate` against a missing neighbour give missing rather than
skipping back; rolling `stdev` is population (`ddof=0`), so a one-sample
window is `0`.

## Next

- **[PND-RUST-R1]** — Batch core: `Time` / `TimeRange` / `Interval`,
  `Sequence.every`, the columnar store (NaN-as-missing number columns), and the
  ops in the core fixture. Grow the fixture as ops are added (calendar
  sequences, `align`, `partitionBy`, `join`).
