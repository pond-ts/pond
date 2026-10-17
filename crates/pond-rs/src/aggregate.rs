//! `TimeSeries::aggregate`: reduce each bucket of a sequence to one row.

use crate::error::{PondError, Result};
use crate::reducer::{Agg, reduce_range};
use crate::sequence::Sequence;
use crate::series::{Column, IntervalKeys, Key, TimeSeries};

const CALL: &str = "aggregate";

impl TimeSeries {
    /// Reduce the rows falling in each bucket of `sequence` to one row. A row
    /// at time `t` belongs to the bucket with `begin <= t < end`.
    ///
    /// ```
    /// use pond_rs::{Agg, Column, Reducer, Sequence, TimeSeries};
    /// let s = TimeSeries::new("cpu", vec![0, 30_000, 60_000],
    ///     vec![Column::required("v", vec![1.0, 2.0, 4.0])])?;
    /// let m = s.aggregate(&Sequence::every("1m")?, &[Agg::new("v_sum", "v", Reducer::Sum)])?;
    /// assert_eq!(m.column("v_sum").unwrap().get(0), Some(3.0));
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Buckets cover the series from its first row to its last, including
    /// the bucket holding the first row and empty buckets in between, so
    /// every bucket in that span appears once. The result is keyed by
    /// interval (`"interval"`), labelled by bucket start. Columns come out
    /// in the order of `aggs`. An empty series gives an empty result.
    pub fn aggregate(&self, sequence: &Sequence, aggs: &[Agg]) -> Result<TimeSeries> {
        let times = match self.key() {
            Key::Time(t) => t,
            Key::Interval(_) => {
                return Err(PondError::Unsupported {
                    call: CALL,
                    message: "aggregate over an interval-keyed series".into(),
                });
            }
        };
        let mut sources = Vec::with_capacity(aggs.len());
        for (i, agg) in aggs.iter().enumerate() {
            sources.push(self.column_index(CALL, &agg.source)?);
            agg.reducer.check(CALL)?;
            if agg.output == "interval" || aggs[..i].iter().any(|a| a.output == agg.output) {
                return Err(PondError::DuplicateOutput {
                    call: CALL,
                    column: agg.output.clone(),
                });
            }
        }
        let buckets = match (times.first(), times.last()) {
            (Some(&first), Some(&last)) => sequence.buckets_overlapping(first, last),
            _ => IntervalKeys {
                label: vec![],
                begin: vec![],
                end: vec![],
            },
        };

        // Each bucket is a contiguous row range [start, end) on sorted time.
        let mut ranges = Vec::with_capacity(buckets.begin.len());
        let mut cursor = 0;
        for (&begin, &end) in buckets.begin.iter().zip(&buckets.end) {
            while cursor < times.len() && times[cursor] < begin {
                cursor += 1;
            }
            let start = cursor;
            while cursor < times.len() && times[cursor] < end {
                cursor += 1;
            }
            ranges.push(start..cursor);
        }

        let columns = aggs
            .iter()
            .zip(&sources)
            .map(|(agg, &source)| {
                let values = self.columns()[source].data().values();
                let out: Vec<f64> = ranges
                    .iter()
                    .map(|r| reduce_range(agg.reducer, &values[r.clone()]).unwrap_or(f64::NAN))
                    .collect();
                Column::optional_raw(agg.output.clone(), out)
            })
            .collect();
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            "interval".to_string(),
            Key::Interval(buckets),
            columns,
        ))
    }
}
