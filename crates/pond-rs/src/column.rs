//! Number columns. A gap is stored as `NaN`, as in pond-ts ([PND-NANREP]):
//! any non-finite value in the buffer means "missing".

/// A column of `f64` values where any non-finite value (`NaN`, `±inf`) is a
/// gap. Reading a gap gives `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct Float64Column {
    values: Vec<f64>,
    /// True when every value is finite (no gaps). Only a speed hint: the
    /// results are the same either way.
    all_finite: bool,
}

impl Float64Column {
    /// Build from raw values; non-finite values become gaps.
    pub fn from_values(values: Vec<f64>) -> Self {
        let all_finite = values.iter().all(|v| v.is_finite());
        Self { values, all_finite }
    }

    /// Build from optional values; `None` is a gap.
    pub fn from_options(values: impl IntoIterator<Item = Option<f64>>) -> Self {
        Self::from_values(values.into_iter().map(|v| v.unwrap_or(f64::NAN)).collect())
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// The value at `i`, or `None` for a gap. Panics if `i` is out of range.
    pub fn get(&self, i: usize) -> Option<f64> {
        let v = self.values[i];
        v.is_finite().then_some(v)
    }

    /// The raw buffer: gaps are non-finite values.
    pub fn values(&self) -> &[f64] {
        &self.values
    }

    /// True when the column has no gaps.
    pub fn all_finite(&self) -> bool {
        self.all_finite
    }

    /// Number of gaps.
    pub fn missing_count(&self) -> usize {
        if self.all_finite {
            0
        } else {
            self.values.iter().filter(|v| !v.is_finite()).count()
        }
    }

    /// Iterate as `Option<f64>`.
    pub fn iter(&self) -> impl Iterator<Item = Option<f64>> + '_ {
        self.values.iter().map(|&v| v.is_finite().then_some(v))
    }
}
