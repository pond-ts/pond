//! `pond_rs.PartitionedSeries`: a series split by entity.

use std::sync::Arc;

use pond_rs::PartitionedSeries;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use crate::convert::{err, partition_key_to_py};
use crate::series::PyTimeSeries;
use crate::shared::shared_methods;

/// A series split by the values of some columns (a host, a symbol), from
/// `TimeSeries.partition_by`. Each operation runs per group, on several
/// cores, and returns another partitioned series; `collect()` merges the
/// groups back into one series, `to_dict()` hands them out.
#[pyclass(name = "PartitionedSeries", module = "pond_rs", frozen)]
pub struct PyPartitionedSeries {
    pub inner: Arc<PartitionedSeries>,
}

impl PyPartitionedSeries {
    pub fn wrap(p: PartitionedSeries) -> Self {
        PyPartitionedSeries { inner: Arc::new(p) }
    }
}

#[pymethods]
impl PyPartitionedSeries {
    /// The columns the series is split by.
    #[getter]
    fn by(&self) -> Vec<String> {
        self.inner.by().to_vec()
    }

    fn __len__(&self) -> usize {
        self.inner.len()
    }

    fn __repr__(&self) -> String {
        format!(
            "PartitionedSeries(by={:?}, {} groups)",
            self.inner.by(),
            self.inner.len()
        )
    }

    /// The groups merged back into one series.
    fn collect(&self, py: Python<'_>) -> PyResult<PyTimeSeries> {
        py.detach(|| self.inner.collect())
            .map(PyTimeSeries::wrap)
            .map_err(err)
    }

    /// `{key: series}` per group, in the order groups first appear; a key
    /// is the value, or a tuple of values when split by several columns.
    fn to_dict<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let d = PyDict::new(py);
        for (k, s) in self.inner.iter() {
            d.set_item(partition_key_to_py(py, k)?, PyTimeSeries::wrap(s.clone()))?;
        }
        Ok(d)
    }

    /// The group keys, in order.
    fn keys<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let keys = self
            .inner
            .iter()
            .map(|(k, _)| partition_key_to_py(py, k))
            .collect::<PyResult<Vec<_>>>()?;
        PyList::new(py, keys)
    }
}

shared_methods!(PyPartitionedSeries);
