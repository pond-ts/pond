//! `TimeSeries::aggregate`: reduce each bucket of a sequence to one row.

use crate::error::{PondError, Result};
use crate::reducer::{Agg, check_source_kind, kernel_inputs, output_column, reduce_range};
use crate::sequence::Sequence;
use crate::series::{IntervalKeys, Key, TimeSeries};

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
    /// assert_eq!(m.column("v_sum")?.numbers()?.get(0), Some(3.0));
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Buckets cover the series from its first row to its last, including
    /// the bucket holding the first row and empty buckets in between, so
    /// every bucket in that span appears once. The result is keyed by
    /// interval (`"interval"`), labelled by bucket start. Columns come out
    /// in the order of `aggs`. An empty series gives an empty result.
    ///
    /// An empty bucket gives `count` 0, `sum` 0, and a gap for every other
    /// reducer. Text and true/false columns take `count` (a number column),
    /// `first` and `last` (a column of the same kind); any other reducer on
    /// them is an error.
    pub fn aggregate(&self, sequence: &Sequence, aggs: &[Agg]) -> Result<TimeSeries> {
        let times = match self.key() {
            Key::Time(t) => t,
            Key::TimeRange(_) | Key::Interval(_) => {
                return Err(PondError::Unsupported {
                    call: CALL,
                    message: "aggregate over a series keyed by time ranges or intervals (pond-ts counts a row in every bucket it overlaps)".into(),
                });
            }
        };
        let mut sources = Vec::with_capacity(aggs.len());
        for (i, agg) in aggs.iter().enumerate() {
            let source = self.column_index(CALL, &agg.source)?;
            agg.reducer.check(CALL)?;
            check_source_kind(CALL, &self.columns()[source], agg.reducer)?;
            sources.push(source);
            if agg.output == "interval" || aggs[..i].iter().any(|a| a.output == agg.output) {
                return Err(PondError::DuplicateOutput {
                    call: CALL,
                    column: agg.output.clone(),
                });
            }
        }
        let buckets = match (times.first(), times.last()) {
            (Some(&first), Some(&last)) => sequence.buckets_overlapping(first, last)?,
            _ => IntervalKeys {
                label: Vec::<f64>::new().into(),
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

        let inputs = kernel_inputs(self.columns(), &sources);
        let plan: Vec<(&Agg, usize)> = aggs.iter().zip(sources).collect();
        let columns = crate::par::map(&plan, |&(agg, source)| {
            let data = self.columns()[source].data();
            let values = inputs[source].as_deref().expect("built for every source");
            let out: Vec<f64> = ranges
                .iter()
                .map(|r| reduce_range(agg.reducer, &values[r.clone()]).unwrap_or(f64::NAN))
                .collect();
            output_column(agg.output.clone(), data, agg.reducer, out)
        });
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            "interval".to_string(),
            Key::Interval(buckets),
            columns,
        ))
    }
}

#[cfg(test)]
mod tests {
    use crate::{Agg, Column, ColumnKind, PondError, Reducer, Sequence, TimeSeries};

    fn hosts() -> TimeSeries {
        TimeSeries::new(
            "h",
            vec![0, 1000, 2500, 6000, 7000, 16_000],
            vec![
                Column::optional("host", [Some("a"), None, Some("b"), None, Some("c"), None]),
                Column::optional(
                    "up",
                    [None, Some(false), Some(true), Some(true), None, None],
                ),
            ],
        )
        .unwrap()
    }

    #[test]
    fn text_and_booleans_take_count_first_last() {
        let aggs = [
            Agg::new("n", "host", Reducer::Count),
            Agg::new("first", "host", Reducer::First),
            Agg::new("last", "host", Reducer::Last),
            Agg::new("up_first", "up", Reducer::First),
            Agg::new("up_last", "up", Reducer::Last),
        ];
        let m = hosts()
            .aggregate(&Sequence::every("5s").unwrap(), &aggs)
            .unwrap();
        let kinds: Vec<_> = m.columns().iter().map(|c| c.kind()).collect();
        use ColumnKind::*;
        assert_eq!(kinds, [Number, String, String, Boolean, Boolean]);
        let text = |name| {
            m.column(name)
                .unwrap()
                .strings()
                .unwrap()
                .iter()
                .collect::<Vec<_>>()
        };
        let bools = |name| {
            m.column(name)
                .unwrap()
                .booleans()
                .unwrap()
                .iter()
                .collect::<Vec<_>>()
        };
        // Buckets [0,5s) [5s,10s) [10s,15s) (empty) [15s,20s) (only a gap).
        assert_eq!(
            m.column("n")
                .unwrap()
                .numbers()
                .unwrap()
                .iter()
                .collect::<Vec<_>>(),
            [Some(2.0), Some(1.0), Some(0.0), Some(0.0)]
        );
        assert_eq!(text("first"), [Some("a"), Some("c"), None, None]);
        assert_eq!(text("last"), [Some("b"), Some("c"), None, None]);
        assert_eq!(bools("up_first"), [Some(false), Some(true), None, None]);
        assert_eq!(bools("up_last"), [Some(true), Some(true), None, None]);

        let r = hosts()
            .rolling(
                "3s",
                &[
                    Agg::new("last", "host", Reducer::Last),
                    Agg::new("n", "up", Reducer::Count),
                ],
            )
            .unwrap();
        assert_eq!(
            r.column("last")
                .unwrap()
                .strings()
                .unwrap()
                .iter()
                .collect::<Vec<_>>(),
            [Some("a"), Some("a"), Some("b"), None, Some("c"), None]
        );
        assert_eq!(
            r.column("n")
                .unwrap()
                .numbers()
                .unwrap()
                .iter()
                .collect::<Vec<_>>(),
            [
                Some(0.0),
                Some(1.0),
                Some(2.0),
                Some(1.0),
                Some(1.0),
                Some(0.0)
            ]
        );
    }

    #[test]
    fn number_reducers_on_text_are_an_error() {
        let every = Sequence::every("5s").unwrap();
        for (source, reducer) in [
            ("host", Reducer::Sum),
            ("up", Reducer::Max),
            ("host", Reducer::Percentile(50.0)),
        ] {
            let aggs = [Agg::of(source, reducer)];
            for result in [
                hosts().aggregate(&every, &aggs),
                hosts().rolling("5s", &aggs),
            ] {
                let err = result.unwrap_err();
                assert!(matches!(err, PondError::WrongKind { .. }), "{err}");
                assert!(err.to_string().contains("count, first or last"), "{err}");
            }
        }
    }

    #[test]
    fn a_required_text_column_with_a_gap_is_refused() {
        let err = TimeSeries::new(
            "s",
            vec![0, 1],
            vec![Column::required("s", [Some("a"), None])],
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("gap at row 1"), "{err}");
    }
}
