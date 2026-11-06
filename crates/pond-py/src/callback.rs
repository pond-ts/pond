//! Calling a Python function from inside a pond-rs operation.
//!
//! Operations run with Python's lock released (and partitions on several
//! threads), so each call takes the lock back. The first Python exception
//! is kept and raised once the operation returns; calls after it are
//! skipped.

use std::sync::Mutex;

use pond_rs::PondError;
use pyo3::prelude::*;

pub struct Callback {
    pub f: Py<PyAny>,
    error: Mutex<Option<PyErr>>,
}

impl Callback {
    pub fn new(f: &Bound<'_, PyAny>) -> PyResult<Self> {
        if !f.is_callable() {
            return Err(pyo3::exceptions::PyTypeError::new_err(format!(
                "expected a function, got {}",
                f.get_type().name()?
            )));
        }
        Ok(Callback {
            f: f.clone().unbind(),
            error: Mutex::new(None),
        })
    }

    fn failed(&self) -> bool {
        self.error.lock().map(|e| e.is_some()).unwrap_or(true)
    }

    fn keep(&self, e: PyErr) {
        if let Ok(mut slot) = self.error.lock()
            && slot.is_none()
        {
            *slot = Some(e);
        }
    }

    /// Run `call` with the lock held. `None` when it (or an earlier call)
    /// raised.
    pub fn run<R>(
        &self,
        call: impl FnOnce(Python<'_>, &Bound<'_, PyAny>) -> PyResult<R>,
    ) -> Option<R> {
        if self.failed() {
            return None;
        }
        Python::attach(|py| match call(py, self.f.bind(py)) {
            Ok(r) => Some(r),
            Err(e) => {
                self.keep(e);
                None
            }
        })
    }

    /// As [`Callback::run`], for closures that return a pond-rs `Result`:
    /// a Python exception stops the operation.
    pub fn try_run<R>(
        &self,
        call: impl FnOnce(Python<'_>, &Bound<'_, PyAny>) -> PyResult<R>,
    ) -> pond_rs::Result<R> {
        self.run(call).ok_or_else(|| PondError::InvalidData {
            call: "python function",
            message: "raised an exception".into(),
        })
    }

    /// The operation's result, or the Python exception a call raised.
    pub fn finish<T>(self, result: pond_rs::Result<T>) -> PyResult<T> {
        if let Some(e) = self.error.into_inner().ok().flatten() {
            return Err(e);
        }
        result.map_err(crate::convert::err)
    }
}
