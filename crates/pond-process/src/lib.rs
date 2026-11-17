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
//! registries, param checks, spec ids, lineage text, the basic ops, the
//! standard and summary folds, the run engine (nested and slot requests,
//! every error policy) and the long-lived [`Host`] with async sources.
//! Not yet: the studies, joins.

pub mod basic_ops;
pub mod context;
pub mod error;
pub mod folds;
pub mod graph;
pub mod host;
pub mod identity;
pub mod js;
pub mod registry;
pub mod run;
pub mod slots;
pub mod source;
pub mod summary_folds;

pub use basic_ops::basic_ops;
pub use context::{FoldContext, FoldFn, OpContext, RunFn};
pub use error::{ErrorKind, ProcessError, Result};
pub use folds::standard_folds;
pub use graph::BoundGraph;
pub use host::{DatasetInfo, Host, LoadFn, LoadFuture, LoadedSource, SourceRegistry};
pub use identity::{esc, explain, output_key, spec_id};
pub use registry::{Def, InputDef, Label, OutputDef, ParamDef, Params, Registry, Shape};
pub use run::{RunResult, run};
pub use slots::expand_slots;
pub use source::{SourceRef, source_id};
pub use summary_folds::summary_folds;
