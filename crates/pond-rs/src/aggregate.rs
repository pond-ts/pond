//! `TimeSeries::aggregate`: reduce each bucket of a sequence to one row.

use crate::column::{ColumnData, Decimal, Scalar, Value};
use crate::error::{PondError, Result};
use crate::reducer::{
    Agg, InputKind, Inputs, Reducer, check_source_kind, input_kind, output_column, reduce_range,
};
use crate::rows::as_call;
use crate::sequence::Sequence;
use crate::series::Column;
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
    /// them is an error. Decimal columns take every reducer: `first`,
    /// `last`, `min`, `max` and `sum` give exact decimals (`sum` at
    /// precision 38, an error past it; an empty bucket sums to 0), the rest
    /// give numbers.
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

        let used: Vec<(usize, Reducer)> = sources
            .iter()
            .zip(aggs)
            .map(|(&source, agg)| (source, agg.reducer))
            .collect();
        let inputs = Inputs::build(self.columns(), &used);
        let plan: Vec<(&Agg, usize)> = aggs.iter().zip(sources).collect();
        let columns = crate::par::map(&plan, |&(agg, source)| {
            let data = self.columns()[source].data();
            let kind = input_kind(data, agg.reducer);
            if let (ColumnData::Decimal(d), InputKind::ExactSum) = (data, kind) {
                return crate::decimal::sum_ranges(CALL, &agg.output, d, &ranges);
            }
            let input = inputs.get(source, kind);
            let out: Vec<f64> = ranges
                .iter()
                .map(|r| reduce_range(agg.reducer, &input.values[r.clone()]).unwrap_or(f64::NAN))
                .collect();
            Ok(output_column(
                agg.output.clone(),
                data,
                agg.reducer,
                input,
                out,
            ))
        })
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            "interval".to_string(),
            Key::Interval(buckets),
            columns,
        ))
    }
}

impl TimeSeries {
    /// The whole series reduced to one value per entry of `aggs`, as pond-ts
    /// `reduce({ out: { from, using } })`: the same reducers and rules as
    /// [`TimeSeries::aggregate`] with the whole series as one bucket (an
    /// empty series gives `count` 0, `sum` 0 and gaps). Read the values by
    /// output name from the [`Reduced`]. See [`TimeSeries::tail`] for an
    /// example.
    pub fn reduce(&self, aggs: &[Agg]) -> Result<Reduced> {
        const CALL: &str = "reduce";
        let mut sources = Vec::with_capacity(aggs.len());
        for (i, agg) in aggs.iter().enumerate() {
            let source = self.column_index(CALL, &agg.source)?;
            agg.reducer.check(CALL)?;
            check_source_kind(CALL, &self.columns()[source], agg.reducer)?;
            sources.push(source);
            if aggs[..i].iter().any(|a| a.output == agg.output) {
                return Err(PondError::DuplicateOutput {
                    call: CALL,
                    column: agg.output.clone(),
                });
            }
        }
        // One bucket: every row.
        let all = std::iter::once(0..self.len()).collect::<Vec<_>>();
        let used: Vec<(usize, Reducer)> = sources
            .iter()
            .zip(aggs)
            .map(|(&source, agg)| (source, agg.reducer))
            .collect();
        let inputs = Inputs::build(self.columns(), &used);
        let mut columns = Vec::with_capacity(aggs.len());
        for (agg, &source) in aggs.iter().zip(&sources) {
            let data = self.columns()[source].data();
            let kind = input_kind(data, agg.reducer);
            if let (ColumnData::Decimal(d), InputKind::ExactSum) = (data, kind) {
                columns.push(crate::decimal::sum_ranges(CALL, &agg.output, d, &all)?);
                continue;
            }
            let input = inputs.get(source, kind);
            let out = vec![reduce_range(agg.reducer, &input.values[..]).unwrap_or(f64::NAN)];
            columns.push(output_column(
                agg.output.clone(),
                data,
                agg.reducer,
                input,
                out,
            ));
        }
        Ok(Reduced(TimeSeries::from_parts(
            self.name().to_string(),
            "time".to_string(),
            Key::Time(vec![0]),
            columns,
        )))
    }
}

/// What [`TimeSeries::reduce`] gives: one value per output, read by name
/// with the same calls as a [`Row`](crate::Row), or as a [`Value`] with
/// [`Reduced::get`]. A name not among the outputs, or an output of another
/// kind, is an error; `Ok(None)` is a gap.
#[derive(Clone)]
pub struct Reduced(TimeSeries);

impl Reduced {
    /// The number output `name`, or `None` for a gap.
    pub fn number(&self, name: &str) -> Result<Option<f64>> {
        const CALL: &str = "Reduced::number";
        let c = self.column(CALL, name)?;
        c.numbers().map(|c| c.get(0)).map_err(|e| as_call(e, CALL))
    }

    /// The exact decimal output `name`, or `None` for a gap.
    pub fn decimal(&self, name: &str) -> Result<Option<Decimal>> {
        const CALL: &str = "Reduced::decimal";
        let c = self.column(CALL, name)?;
        c.decimals().map(|c| c.get(0)).map_err(|e| as_call(e, CALL))
    }

    /// The text output `name`, or `None` for a gap.
    pub fn string(&self, name: &str) -> Result<Option<&str>> {
        const CALL: &str = "Reduced::string";
        let c = self.column(CALL, name)?;
        c.strings().map(|c| c.get(0)).map_err(|e| as_call(e, CALL))
    }

    /// The true/false output `name`, or `None` for a gap.
    pub fn boolean(&self, name: &str) -> Result<Option<bool>> {
        const CALL: &str = "Reduced::boolean";
        let c = self.column(CALL, name)?;
        c.booleans().map(|c| c.get(0)).map_err(|e| as_call(e, CALL))
    }

    /// The array output `name`, or `None` for a gap.
    pub fn array(&self, name: &str) -> Result<Option<&[Scalar]>> {
        const CALL: &str = "Reduced::array";
        let c = self.column(CALL, name)?;
        c.arrays().map(|c| c.get(0)).map_err(|e| as_call(e, CALL))
    }

    /// The output `name` whatever its kind, or `None` for a gap.
    pub fn get(&self, name: &str) -> Result<Option<Value>> {
        Ok(value_at(self.column("Reduced::get", name)?.data()))
    }

    /// The outputs as columns of one row, in the order of `aggs`.
    pub fn columns(&self) -> &[Column] {
        self.0.columns()
    }

    fn column(&self, call: &'static str, name: &str) -> Result<&Column> {
        Ok(&self.0.columns()[self.0.column_index(call, name)?])
    }
}

/// Prints the outputs by name (`{"mean": Some(Number(12.5)), …}`).
impl std::fmt::Debug for Reduced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_map()
            .entries(
                self.columns()
                    .iter()
                    .map(|c| (c.name(), value_at(c.data()))),
            )
            .finish()
    }
}

fn value_at(data: &ColumnData) -> Option<Value> {
    match data {
        ColumnData::Number(c) => c.get(0).map(Value::Number),
        ColumnData::Decimal(c) => c.get(0).map(Value::Decimal),
        ColumnData::String(c) => c.get(0).map(|s| Value::String(s.to_string())),
        ColumnData::Boolean(c) => c.get(0).map(Value::Boolean),
        ColumnData::Array(c) => c.get(0).map(|v| Value::Array(v.to_vec())),
    }
}

#[cfg(test)]
mod tests {
    use crate::{Agg, Column, ColumnKind, PondError, Reducer, Sequence, TimeSeries, Value};

    #[test]
    fn reduced_values_are_read_by_name_and_kind() {
        let r = hosts()
            .reduce(&[
                Agg::new("n", "host", Reducer::Count),
                Agg::new("first_host", "host", Reducer::First),
                Agg::new("last_up", "up", Reducer::Last),
            ])
            .unwrap();
        assert_eq!(r.number("n").unwrap(), Some(3.0));
        assert_eq!(r.string("first_host").unwrap(), Some("a"));
        assert_eq!(r.boolean("last_up").unwrap(), Some(true));
        assert!(r.number("first_host").is_err()); // text, not a number
        assert!(r.number("nope").is_err());
        let names: Vec<&str> = r.columns().iter().map(|c| c.name()).collect();
        assert_eq!(names, ["n", "first_host", "last_up"]);
    }

    #[test]
    fn reduced_values_are_read_as_values_and_printed_by_name() {
        let r = hosts()
            .reduce(&[
                Agg::new("n", "host", Reducer::Count),
                Agg::new("first_host", "host", Reducer::First),
                Agg::new("first_up", "up", Reducer::First),
            ])
            .unwrap();
        assert_eq!(r.get("n").unwrap(), Some(Value::Number(3.0)));
        assert_eq!(
            r.get("first_host").unwrap(),
            Some(Value::String("a".into()))
        );
        assert_eq!(r.get("first_up").unwrap(), Some(Value::Boolean(false)));
        assert_eq!(
            format!("{r:?}"),
            r#"{"n": Some(Number(3.0)), "first_host": Some(String("a")), "first_up": Some(Boolean(false))}"#
        );
        // Errors name the call that was made, not `Row`.
        let e = r.number("first_host").unwrap_err().to_string();
        assert!(e.contains("Reduced::number"), "{e}");
        let e = r.get("nope").unwrap_err().to_string();
        assert!(e.contains("Reduced::get"), "{e}");
    }

    #[test]
    fn a_reduced_gap_is_none() {
        let empty = hosts().slice(0..0);
        let r = empty
            .reduce(&[Agg::new("first_host", "host", Reducer::First)])
            .unwrap();
        assert_eq!(r.get("first_host").unwrap(), None);
        assert_eq!(r.string("first_host").unwrap(), None);
    }

    #[test]
    fn reduce_refuses_a_repeated_output() {
        let e = hosts()
            .reduce(&[
                Agg::new("x", "host", Reducer::Count),
                Agg::new("x", "up", Reducer::Count),
            ])
            .unwrap_err();
        assert!(matches!(e, PondError::DuplicateOutput { .. }), "{e}");
    }

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
