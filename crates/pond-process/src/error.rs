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
}

impl ErrorKind {
    /// The code string, such as `"ParamError"`.
    pub fn code(self) -> &'static str {
        match self {
            ErrorKind::Process => "ProcessError",
            ErrorKind::UnknownOp => "UnknownOpError",
            ErrorKind::Param => "ParamError",
            ErrorKind::Arity => "ArityError",
        }
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
    pub(crate) fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        ProcessError {
            kind,
            message: message.into(),
        }
    }

    /// The code string, such as `"ParamError"`.
    pub fn code(&self) -> &'static str {
        self.kind.code()
    }
}

impl fmt::Display for ProcessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.message)
    }
}

impl std::error::Error for ProcessError {}

/// Shorthand for results in this crate.
pub type Result<T> = std::result::Result<T, ProcessError>;
