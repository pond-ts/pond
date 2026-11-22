//! Errors, with the same `code` strings `@pond-ts/process` puts on its own.

use std::fmt;

/// What went wrong, as a stable code. Same spelling as the TypeScript
/// error classes, so a reply built in Rust reads like one built there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    /// Anything without a narrower code.
    Process,
    /// A spec named an op the registry does not have.
    UnknownOp,
    /// A param was missing, of the wrong type, or out of range.
    Param,
    /// A spec's input list does not match the op's inputs.
    Arity,
    /// An op demands an input unit its source does not carry.
    Unit,
    /// A spec names a column the bound series does not have.
    UnknownColumn,
    /// A slot request does not expand (a collision, a cycle, a bad name).
    Slot,
    /// A request names a dataset the host has not been given.
    UnknownDataset,
    /// A request names a source the source registry does not have.
    UnknownSource,
    /// Thrown by code outside the plan layer: an op, a fold or a loader.
    /// It carries no code, as in `@pond-ts/process`, which is itself the
    /// signal that the op failed rather than the plan.
    Thrown,
}

impl ErrorKind {
    /// The code string, such as `"ParamError"`; `None` for [`ErrorKind::Thrown`].
    pub fn code(self) -> Option<&'static str> {
        Some(match self {
            ErrorKind::Process => "ProcessError",
            ErrorKind::UnknownOp => "UnknownOpError",
            ErrorKind::Param => "ParamError",
            ErrorKind::Arity => "ArityError",
            ErrorKind::Unit => "UnitError",
            ErrorKind::UnknownColumn => "UnknownColumnError",
            ErrorKind::Slot => "SlotError",
            ErrorKind::UnknownDataset => "UnknownDatasetError",
            ErrorKind::UnknownSource => "UnknownSourceError",
            ErrorKind::Thrown => return None,
        })
    }

    /// The error's class name: the code, or `"Error"` for a thrown one.
    pub fn name(self) -> &'static str {
        self.code().unwrap_or("Error")
    }
}

/// An error from building ids, checking params or running a plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessError {
    /// What kind of error it is.
    pub kind: ErrorKind,
    /// The message, word for word what `@pond-ts/process` says.
    pub message: String,
}

impl ProcessError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        ProcessError {
            kind,
            message: message.into(),
        }
    }

    /// An error from an op's, fold's or loader's own code.
    pub fn thrown(message: impl Into<String>) -> Self {
        ProcessError::new(ErrorKind::Thrown, message)
    }

    /// The code string, such as `"ParamError"`; `None` for a thrown error.
    pub fn code(&self) -> Option<&'static str> {
        self.kind.code()
    }

    /// The class name: the code, or `"Error"`.
    pub fn name(&self) -> &'static str {
        self.kind.name()
    }
}

impl fmt::Display for ProcessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.name(), self.message)
    }
}

impl std::error::Error for ProcessError {}

/// Shorthand for results in this crate.
pub type Result<T> = std::result::Result<T, ProcessError>;
