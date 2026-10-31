//! The one error type every pond-rs call returns.

use std::fmt;

/// What went wrong. Every message names the call and, where there is one, the
/// column, so the caller can fix the input without reading pond-rs source.
#[derive(Debug, Clone, PartialEq)]
pub enum PondError {
    /// A duration string that is not `<digits><ms|s|m|h|d>`.
    InvalidDuration {
        /// The text given.
        input: String,
        /// What is wrong with it.
        reason: &'static str,
    },
    /// A reducer name pond does not have (`"bogus"`).
    UnknownReducer {
        /// The name given.
        name: String,
    },
    /// A mapping or lookup names a column the series does not have.
    UnknownColumn {
        /// The call that failed (`"rolling"`, `"aggregate"`, …).
        call: &'static str,
        /// The column asked for.
        column: String,
        /// The columns the series has.
        available: Vec<String>,
    },
    /// Two mapping entries write the same output column.
    DuplicateOutput {
        /// The call that failed (`"rolling"`, `"aggregate"`, …).
        call: &'static str,
        /// The output column written twice.
        column: String,
    },
    /// Input data that breaks a series rule (unsorted keys, a gap in a
    /// required column, mismatched lengths, …).
    InvalidData {
        /// The call that failed (`"rolling"`, `"aggregate"`, …).
        call: &'static str,
        /// What is wrong with the data.
        message: String,
    },
    /// A column of the wrong kind for the call: text where numbers are
    /// needed, say.
    WrongKind {
        /// The call that failed (`"rolling"`, `"aggregate"`, …).
        call: &'static str,
        /// The column of the wrong kind.
        column: String,
        /// The column's kind: `"number"`, `"decimal"`, `"string"`,
        /// `"boolean"` or `"array"`.
        kind: &'static str,
        /// What the call needed instead.
        reason: String,
    },
    /// A value pond-rs cannot handle yet, rather than answer wrongly.
    Unsupported {
        /// The call that failed (`"rolling"`, `"aggregate"`, …).
        call: &'static str,
        /// What is not supported.
        message: String,
    },
}

impl PondError {
    /// The same error, naming `call` instead: for shared helpers that one
    /// call reuses from another.
    pub(crate) fn renamed(self, to: &'static str) -> Self {
        match self {
            PondError::UnknownColumn {
                column, available, ..
            } => PondError::UnknownColumn {
                call: to,
                column,
                available,
            },
            PondError::DuplicateOutput { column, .. } => {
                PondError::DuplicateOutput { call: to, column }
            }
            PondError::InvalidData { message, .. } => PondError::InvalidData { call: to, message },
            PondError::WrongKind {
                column,
                kind,
                reason,
                ..
            } => PondError::WrongKind {
                call: to,
                column,
                kind,
                reason,
            },
            PondError::Unsupported { message, .. } => PondError::Unsupported { call: to, message },
            other => other,
        }
    }
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
                "unknown reducer '{name}' (expected one of count, sum, avg, mean, min, max, first, last, median, stdev, difference, keep, unique, samples, topN like top3, or a percentile like p95)"
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
