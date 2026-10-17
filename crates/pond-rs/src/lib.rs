//! # pond-rs
//!
//! A native Rust implementation of [pond](https://github.com/pond-ts/pond),
//! the time series analytics library. See `docs/rfcs/pond-rs.md` in the
//! repository for the plan.
//!
//! **Status: R0 (scaffolding).** There is no public API yet. What exists is
//! the parity harness under `tests/`, which checks this crate against
//! pond-ts's own output (`packages/core/test/fixtures/parity.json`) and the
//! pandas oracle used for the financial studies
//! (`packages/financial/test/fixtures/study-oracle.json`). Each operation
//! joins the harness as it is implemented, and from then on must match.

/// The version of this crate.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
