//! Computations as data over pond-rs: a Rust port of `@pond-ts/process`.
//!
//! A plan is JSON naming ops from a registry. This crate checks it, names
//! every step with the same id `@pond-ts/process` gives it, and (as the
//! port grows) runs it and hands back facts. Every answer is checked
//! against a fixture the TypeScript package writes
//! (`packages/process/test/fixtures/parity.json`), so the two cannot drift
//! apart silently.
//!
//! The port is in progress ([PND-RUST-R5] in the pond plan). So far:
//! registries, op and fold definitions, param checks, spec ids, lineage
//! text and source ids.

pub mod basic_ops;
pub mod error;
pub mod folds;
pub mod identity;
pub mod js;
pub mod registry;
pub mod source;
pub mod summary_folds;

pub use basic_ops::basic_ops;
pub use error::{ErrorKind, ProcessError, Result};
pub use folds::standard_folds;
pub use identity::{esc, explain, output_key, spec_id};
pub use registry::{Def, InputDef, Label, OutputDef, ParamDef, Params, Registry, Shape};
pub use source::{SourceRef, source_id};
pub use summary_folds::summary_folds;
