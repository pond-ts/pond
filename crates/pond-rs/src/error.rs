//! The one error type every pond-rs call returns.

use std::fmt;

/// What went wrong. Every message names the call and, where there is one, the
/// column, so the caller can fix the input without reading pond-rs source.
#[derive(Debug, Clone, PartialEq)]
pub enum PondError {
    /// A duration string that is not `<digits><ms|s|m|h|d>`.
    InvalidDuration { input: String, reason: &'static str },
    /// A reducer name pond does not have (`"bogus"`).
    UnknownReducer { name: String },
    /// A reducer pond-ts has that pond-rs does not implement yet.
    UnsupportedReducer { name: String },
    /// A mapping or lookup names a column the series does not have.
    UnknownColumn {
        call: &'static str,
        column: String,
        available: Vec<String>,
    },
    /// Two mapping entries write the same output column.
    DuplicateOutput { call: &'static str, column: String },
    /// Input data that breaks a series rule (unsorted keys, a gap in a
    /// required column, mismatched lengths, …).
    InvalidData { call: &'static str, message: String },
    /// A column of the wrong kind for the call: text where numbers are
    /// needed, say.
    WrongKind {
        call: &'static str,
        column: String,
        /// The column's kind: `"number"`, `"decimal"`, `"string"`,
        /// `"boolean"` or `"array"`.
        kind: &'static str,
        reason: String,
    },
    /// A value pond-rs cannot handle yet, rather than answer wrongly.
    Unsupported { call: &'static str, message: String },
}

impl fmt::Display for PondError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PondError::InvalidDuration { input, reason } => write!(
                f,
                "invalid duration '{input}': {reason} (expected a whole number followed by ms, s, m, h or d, e.g. '5m')"
            ),
            PondError::UnknownReducer { name } => write!(
                f,
                "unknown reducer '{name}' (expected one of count, sum, avg, mean, min, max, first, last, median, stdev, or a percentile like p95)"
            ),
            PondError::UnsupportedReducer { name } => write!(
                f,
                "reducer '{name}' exists in pond-ts but is not implemented in pond-rs yet"
            ),
            PondError::UnknownColumn {
                call,
                column,
                available,
            } => write!(
                f,
                "{call}: no column named '{column}' (columns: {})",
                available.join(", ")
            ),
            PondError::DuplicateOutput { call, column } => {
                write!(f, "{call}: output column '{column}' is written twice")
            }
            PondError::InvalidData { call, message } => write!(f, "{call}: {message}"),
            PondError::WrongKind {
                call,
                column,
                kind,
                reason,
            } => {
                let a = if kind.starts_with('a') { "an" } else { "a" };
                write!(
                    f,
                    "{call}: column '{column}' is {a} {kind} column; {reason}"
                )
            }
            PondError::Unsupported { call, message } => {
                write!(f, "{call}: not supported in pond-rs yet: {message}")
            }
        }
    }
}

impl std::error::Error for PondError {}

/// Shorthand for `Result<T, PondError>`.
pub type Result<T> = std::result::Result<T, PondError>;
