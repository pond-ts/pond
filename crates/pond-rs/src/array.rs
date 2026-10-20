//! Array columns: keeping rows whose array holds a value
//! (`array_contains` / `_all` / `_any`), reducing each array to one value
//! (`array_aggregate`) and one row per element (`array_explode`), as
//! pond-ts's `arrayContains` / `arrayContainsAll` / `arrayContainsAny` /
//! `arrayAggregate` / `arrayExplode`.
//!
//! Where pond-ts quietly answers a call that cannot mean anything (a
//! number column given to `arrayContains`, say), pond-rs returns an error;
//! each method lists the differences.

use crate::column::{ArrayColumn, BooleanColumn, ColumnData, Scalar, StringColumn};
use crate::error::{PondError, Result};
use crate::reducer::{Reducer, clamp_at_zero, percentile_of_sorted};
use crate::series::{Column, ColumnKind, TimeSeries};

/// Where [`TimeSeries::array_aggregate`] and [`TimeSeries::array_explode`]
/// write, and what kind of column they write (pond-ts's `{ as, kind }`).
/// `ArrayOptions::default()` replaces the array column in place and works
/// the kind out from the values.
///
/// ```
/// # use pond_rs::{ArrayOptions, ColumnKind};
/// let options = ArrayOptions {
///     output: Some("tag".into()),
///     kind: Some(ColumnKind::String),
/// };
/// # let _ = options;
/// ```
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ArrayOptions {
    /// A new column of this name, added after the others, with the array
    /// column kept. `None`, or the array column's own name, replaces the
    /// array column where it stands.
    pub output: Option<String>,
    /// The output column's kind: `Number`, `String` or `Boolean`. `None`:
    /// the kind of the values written (`String` when there are none).
    pub kind: Option<ColumnKind>,
}

impl TimeSeries {
    /// The rows whose array in `column` holds `value` (pond-ts
    /// `arrayContains`). Elements match as JavaScript's `includes` matches
    /// them: `0` matches `-0`, and kinds never mix (`1` does not match
    /// `"1"`). Rows with a gap or an empty array are dropped. The schema is
    /// unchanged.
    ///
    /// pond-ts answers an empty series for a column that is not an array or
    /// does not exist; pond-rs returns an error.
    ///
    /// ```
    /// # use pond_rs::{Column, Scalar, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1, 2], vec![Column::optional("tags", vec![
    ///     Some(vec![Scalar::from("web"), "eu".into()]),
    ///     None,
    ///     Some(vec!["db".into()]),
    /// ])])?;
    /// assert_eq!(s.array_contains("tags", "web")?.key().begin(), &[0]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn array_contains(&self, column: &str, value: impl Into<Scalar>) -> Result<TimeSeries> {
        let value = value.into();
        self.keep_arrays("TimeSeries::array_contains", column, |cell| {
            cell.contains(&value)
        })
    }

    /// The rows whose array holds every one of `values` (pond-ts
    /// `arrayContainsAll`). With no `values`, every row with an array (an
    /// empty one too) is kept; rows with a gap are dropped. Matching is as in
    /// [`TimeSeries::array_contains`].
    pub fn array_contains_all(&self, column: &str, values: &[Scalar]) -> Result<TimeSeries> {
        self.keep_arrays("TimeSeries::array_contains_all", column, |cell| {
            values.iter().all(|v| cell.contains(v))
        })
    }

    /// The rows whose array holds at least one of `values` (pond-ts
    /// `arrayContainsAny`). With no `values`, no row is kept. Matching is as
    /// in [`TimeSeries::array_contains`].
    pub fn array_contains_any(&self, column: &str, values: &[Scalar]) -> Result<TimeSeries> {
        self.keep_arrays("TimeSeries::array_contains_any", column, |cell| {
            values.iter().any(|v| cell.contains(v))
        })
    }

    fn keep_arrays(
        &self,
        call: &'static str,
        column: &str,
        keep: impl Fn(&[Scalar]) -> bool,
    ) -> Result<TimeSeries> {
        let arrays = self.array_column(call, column)?;
        let rows: Vec<usize> = (0..self.len())
            .filter(|&i| arrays.get(i).is_some_and(&keep))
            .collect();
        Ok(self.take_rows(&rows))
    }

    /// Reduce each row's array to one value (pond-ts `arrayAggregate`): the
    /// array is treated as a bucket of values. A gap stays a gap; the output
    /// column is always optional.
    ///
    /// - `Count` counts every element (an empty array gives 0).
    /// - `Sum`, `Avg`, `Min`, `Max`, `Median`, `Stdev` and percentiles use
    ///   the array's numbers only, skipping text and true/false elements.
    ///   With no numbers, `Sum` gives 0 and the rest give a gap. Sums add
    ///   left to right, as pond-ts's do; on a tie, `Min` and `Max` keep the
    ///   first (so `-0` or `0`, whichever came first).
    /// - `First` and `Last` give the first or last element, of whatever
    ///   kind; an empty array gives a gap.
    ///
    /// See [`ArrayOptions`] for where the result goes. The output kind is
    /// `Number` for every reducer but `First` and `Last`, whose output takes
    /// the kind of the elements found (`String` when there are none) unless
    /// [`ArrayOptions::kind`] names one.
    ///
    /// ```
    /// # use pond_rs::{ArrayOptions, Column, Reducer, Scalar, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1], vec![Column::required("ms", vec![
    ///     vec![Scalar::from(12.0), 30.0.into()],
    ///     vec![],
    /// ])])?;
    /// let options = ArrayOptions { output: Some("worst".into()), ..ArrayOptions::default() };
    /// let worst = s.array_aggregate("ms", Reducer::Max, &options)?;
    /// let got: Vec<_> = worst.column("worst")?.numbers()?.iter().collect();
    /// assert_eq!(got, [Some(30.0), None]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Differences from pond-ts, each where pond-ts gives an error or a
    /// result that cannot be meant:
    ///
    /// - A column that is not an array, or does not exist, is an error
    ///   (pond-ts quietly writes a column of gaps, or nothing).
    /// - `First` and `Last` without a kind take the elements' kind; pond-ts
    ///   writes a string column and so throws on numbers or true/false.
    ///   Elements of more than one kind across rows are an error either
    ///   way, since a column holds one kind.
    /// - A kind other than `Number` for a number reducer, or an output
    ///   named after another column, is an error up front.
    pub fn array_aggregate(
        &self,
        column: &str,
        reducer: Reducer,
        options: &ArrayOptions,
    ) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::array_aggregate";
        reducer.check(CALL)?;
        let arrays = self.array_column(CALL, column)?;
        let picks = matches!(reducer, Reducer::First | Reducer::Last);
        if !picks && options.kind.is_some_and(|k| k != ColumnKind::Number) {
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!(
                    "{reducer:?} gives numbers, so the output kind must be number, not {}",
                    options.kind.expect("checked").as_str()
                ),
            });
        }
        let data: ColumnData = if picks {
            let picked: Vec<Option<&Scalar>> = arrays
                .iter()
                .map(|cell| {
                    let cell = cell?;
                    if reducer == Reducer::First {
                        cell.first()
                    } else {
                        cell.last()
                    }
                })
                .collect();
            scalar_column(CALL, &format!("{reducer:?}"), &picked, options.kind)?
        } else {
            arrays
                .iter()
                .map(|cell| cell.and_then(|cell| reduce_elements(reducer, cell)))
                .collect::<Vec<Option<f64>>>()
                .into()
        };
        self.put_output(CALL, column, options, |name| {
            Column::from_data(name, data, false)
        })
    }

    /// One row per array element (pond-ts `arrayExplode`): each element of
    /// row `i`'s array becomes a row with row `i`'s key and other values, in
    /// order, so keys repeat. Rows with a gap or an empty array give no
    /// rows. See [`ArrayOptions`] for where the elements go; with
    /// [`ArrayOptions::output`] each new row also keeps the whole array.
    ///
    /// The element column takes [`ArrayOptions::kind`], or else the kind of
    /// the elements (`String` when there are none). Every element must be
    /// of that kind: arrays that mix kinds cannot be exploded into one
    /// column. The column is always optional.
    ///
    /// ```
    /// # use pond_rs::{ArrayOptions, Column, Scalar, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 5], vec![Column::required("tags", vec![
    ///     vec![Scalar::from("a"), "b".into()],
    ///     vec!["c".into()],
    /// ])])?;
    /// let rows = s.array_explode("tags", &ArrayOptions::default())?;
    /// assert_eq!(rows.key().begin(), &[0, 0, 5]);
    /// let tags: Vec<_> = rows.column("tags")?.strings()?.iter().collect();
    /// assert_eq!(tags, [Some("a"), Some("b"), Some("c")]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Differences from pond-ts: a column that is not an array is an error
    /// (pond-ts gives no rows), and without a kind the elements' kind is
    /// used, where pond-ts uses `String` and so throws on numbers.
    pub fn array_explode(&self, column: &str, options: &ArrayOptions) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::array_explode";
        let arrays = self.array_column(CALL, column)?;
        let mut rows = Vec::new();
        let mut elements = Vec::new();
        for (i, cell) in arrays.iter().enumerate() {
            for e in cell.unwrap_or(&[]) {
                rows.push(i);
                elements.push(Some(e));
            }
        }
        let data = scalar_column(CALL, "element", &elements, options.kind)?;
        self.take_rows(&rows)
            .put_output(CALL, column, options, |name| {
                Column::from_data(name, data, false)
            })
    }

    /// The array column `name`; an error for any other kind.
    fn array_column(&self, call: &'static str, name: &str) -> Result<&ArrayColumn> {
        let c = &self.columns()[self.column_index(call, name)?];
        match c.data() {
            ColumnData::Array(a) => Ok(a),
            other => Err(PondError::WrongKind {
                call,
                column: name.to_string(),
                kind: other.kind().as_str(),
                reason: "this call needs an array column".into(),
            }),
        }
    }

    /// This series with `build(name)` replacing `source` in place, or added
    /// at the end under [`ArrayOptions::output`].
    fn put_output(
        &self,
        call: &'static str,
        source: &str,
        options: &ArrayOptions,
        build: impl FnOnce(String) -> Column,
    ) -> Result<TimeSeries> {
        let c = self.column_index(call, source)?;
        let mut columns = self.columns().to_vec();
        match options.output.as_deref() {
            None => columns[c] = build(source.to_string()),
            Some(name) if name == source => columns[c] = build(source.to_string()),
            Some(name) => {
                if name == self.key_name() || columns.iter().any(|c| c.name() == name) {
                    return Err(PondError::InvalidData {
                        call,
                        message: format!("output column '{name}' already exists"),
                    });
                }
                columns.push(build(name.to_string()));
            }
        }
        Ok(self.with_value_columns(columns))
    }
}

/// A column of one kind from picked elements (`None` is a gap): `kind`, or
/// else the kind of the first element, `String` when there is none. An
/// element of another kind is an error naming its row.
fn scalar_column(
    call: &'static str,
    what: &str,
    values: &[Option<&Scalar>],
    kind: Option<ColumnKind>,
) -> Result<ColumnData> {
    let kind = match kind {
        Some(k @ (ColumnKind::Number | ColumnKind::String | ColumnKind::Boolean)) => k,
        Some(k) => {
            return Err(PondError::InvalidData {
                call,
                message: format!(
                    "the output kind must be number, string or boolean, not {}",
                    k.as_str()
                ),
            });
        }
        None => values
            .iter()
            .flatten()
            .next()
            .map_or(ColumnKind::String, |e| e.kind()),
    };
    if let Some((row, e)) = values
        .iter()
        .enumerate()
        .find_map(|(i, v)| v.filter(|e| e.kind() != kind).map(|e| (i, e)))
    {
        return Err(PondError::InvalidData {
            call,
            message: format!(
                "output row {row}: {what} is a {}, but the output column is {}; a column holds one kind",
                e.kind().as_str(),
                kind.as_str(),
            ),
        });
    }
    Ok(match kind {
        ColumnKind::Number => values
            .iter()
            .map(|v| v.and_then(Scalar::as_f64))
            .collect::<Vec<Option<f64>>>()
            .into(),
        ColumnKind::String => {
            StringColumn::from_options(values.iter().map(|v| v.and_then(Scalar::as_str))).into()
        }
        _ => BooleanColumn::from_options(values.iter().map(|v| v.and_then(Scalar::as_bool))).into(),
    })
}

/// pond-ts's row-path reducers (`reduce(defined, numeric)`) over one array:
/// `defined` is every element, `numeric` its numbers. A non-finite result
/// (an overflowing sum) is a gap.
fn reduce_elements(reducer: Reducer, cell: &[Scalar]) -> Option<f64> {
    let numeric: Vec<f64> = cell.iter().filter_map(Scalar::as_f64).collect();
    let out = match reducer {
        Reducer::Count => Some(cell.len() as f64),
        Reducer::Sum => Some(numeric.iter().fold(0.0, |s, v| s + v)),
        Reducer::Avg => (!numeric.is_empty())
            .then(|| numeric.iter().fold(0.0, |s, v| s + v) / numeric.len() as f64),
        // `reduce((a, b) => (a <= b ? a : b))`: the first of equals.
        Reducer::Min => numeric
            .iter()
            .copied()
            .reduce(|a, b| if a <= b { a } else { b }),
        Reducer::Max => numeric
            .iter()
            .copied()
            .reduce(|a, b| if a >= b { a } else { b }),
        Reducer::Median => sorted_percentile(numeric, 50.0),
        Reducer::Percentile(q) => sorted_percentile(numeric, q),
        Reducer::Stdev => {
            // Welford, as pond-ts's `welfordStdev`.
            let (mut n, mut mean, mut m2) = (0.0f64, 0.0f64, 0.0f64);
            for &v in &numeric {
                n += 1.0;
                let delta = v - mean;
                mean += delta / n;
                m2 += delta * (v - mean);
            }
            (n != 0.0).then(|| clamp_at_zero(m2 / n).sqrt())
        }
        Reducer::First | Reducer::Last => unreachable!("picked, not reduced"),
    };
    out.filter(|v| v.is_finite())
}

/// `numeric.slice().sort((a, b) => a - b)` then `percentileOfSorted`. The
/// sort is stable in both languages, so `0` and `-0` keep their order.
fn sorted_percentile(mut numeric: Vec<f64>, q: f64) -> Option<f64> {
    if numeric.is_empty() {
        return None;
    }
    numeric.sort_by(|a, b| a.partial_cmp(b).expect("elements are finite"));
    Some(percentile_of_sorted(&numeric, q))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Agg, Fill, FillLimits, Value};

    fn series() -> TimeSeries {
        TimeSeries::new(
            "s",
            vec![0, 1, 2, 3],
            vec![
                Column::optional(
                    "tags",
                    vec![
                        Some(vec![Scalar::from("a"), "b".into()]),
                        Some(vec![]),
                        None,
                        Some(vec![Scalar::from(-0.0), true.into()]),
                    ],
                ),
                Column::required("v", vec![1.0, 2.0, 3.0, 4.0]),
            ],
        )
        .unwrap()
    }

    fn err(r: Result<TimeSeries>) -> String {
        r.unwrap_err().to_string()
    }

    #[test]
    fn wrong_columns_are_errors_not_empty_results() {
        let s = series();
        let e = err(s.array_contains("v", 1.0));
        assert!(e.contains("column 'v' is a number column"), "{e}");
        assert!(err(s.array_contains("nope", 1.0)).contains("no column named 'nope'"));
        let e = err(s.array_aggregate("v", Reducer::Count, &ArrayOptions::default()));
        assert!(e.contains("needs an array column"), "{e}");
        assert!(s.array_explode("v", &ArrayOptions::default()).is_err());
    }

    #[test]
    fn contains_matches_zero_of_either_sign_and_keeps_the_schema() {
        let s = series();
        let got = s.array_contains("tags", 0.0).unwrap();
        assert_eq!(got.key().begin(), &[3]);
        assert_eq!(got.schema(), s.schema());
        assert_eq!(s.array_contains("tags", "a").unwrap().len(), 1);
        assert_eq!(s.array_contains("tags", 1.0).unwrap().len(), 0);
        assert_eq!(s.array_contains_all("tags", &[]).unwrap().len(), 3);
        assert_eq!(s.array_contains_any("tags", &[]).unwrap().len(), 0);
    }

    #[test]
    fn first_and_explode_take_the_elements_kind() {
        let s = TimeSeries::new(
            "s",
            vec![0, 1],
            vec![Column::required(
                "flags",
                vec![vec![Scalar::from(true), false.into()], vec![false.into()]],
            )],
        )
        .unwrap();
        let first = s
            .array_aggregate("flags", Reducer::First, &ArrayOptions::default())
            .unwrap();
        let got: Vec<_> = first
            .column("flags")
            .unwrap()
            .booleans()
            .unwrap()
            .iter()
            .collect();
        assert_eq!(got, [Some(true), Some(false)]);
        assert!(!first.column("flags").unwrap().is_required());
        let rows = s.array_explode("flags", &ArrayOptions::default()).unwrap();
        assert_eq!(rows.key().begin(), &[0, 0, 1]);
        assert_eq!(rows.column("flags").unwrap().kind(), ColumnKind::Boolean);

        // Mixed kinds cannot share a column; the message names the row.
        let e = err(series().array_explode("tags", &ArrayOptions::default()));
        assert!(
            e.contains("output row 2: element is a number, but the output column is string"),
            "{e}"
        );
        // A kind no element has, given explicitly.
        let as_number = ArrayOptions {
            kind: Some(ColumnKind::Number),
            ..ArrayOptions::default()
        };
        let e = err(series().array_aggregate("tags", Reducer::First, &as_number));
        assert!(e.contains("output row 0: First is a string"), "{e}");
        // Nothing to infer from: string, as pond-ts.
        let gaps = series().slice(1..3);
        let first = gaps
            .array_aggregate("tags", Reducer::First, &ArrayOptions::default())
            .unwrap();
        assert_eq!(first.column("tags").unwrap().kind(), ColumnKind::String);
    }

    #[test]
    fn options_are_checked_up_front() {
        let s = series();
        let text = ArrayOptions {
            kind: Some(ColumnKind::String),
            ..ArrayOptions::default()
        };
        assert!(s.array_aggregate("tags", Reducer::Count, &text).is_err());
        let array = ArrayOptions {
            kind: Some(ColumnKind::Array),
            ..ArrayOptions::default()
        };
        let e = err(s.array_explode("tags", &array));
        assert!(e.contains("must be number, string or boolean"), "{e}");
        for taken in ["v", "time"] {
            let o = ArrayOptions {
                output: Some(taken.into()),
                ..ArrayOptions::default()
            };
            let e = err(s.array_aggregate("tags", Reducer::Count, &o));
            assert!(e.contains("already exists"), "{e}");
        }
        assert!(
            s.array_aggregate("tags", Reducer::Percentile(200.0), &ArrayOptions::default())
                .is_err()
        );
    }

    #[test]
    fn arrays_through_other_calls() {
        let s = series();
        // Non-finite elements are refused when a series is built.
        let bad = TimeSeries::new(
            "s",
            vec![0],
            vec![Column::required("a", vec![vec![Scalar::from(f64::NAN)]])],
        );
        let e = bad.unwrap_err().to_string();
        assert!(
            e.contains("column 'a' row 0: array element 0 must be"),
            "{e}"
        );
        // Not as a partition key, not to Arrow.
        let e = s.partition_by(&["tags"]).unwrap_err().to_string();
        assert!(e.contains("partitioning by an array column"), "{e}");
        let e = s.to_arrow().unwrap_err().to_string();
        assert!(e.contains("column 'tags' is an array column"), "{e}");
        assert!(s.select(&["v"]).unwrap().to_arrow().is_ok());
        // Rows and reduce read arrays.
        let row = s.row(0).unwrap();
        assert_eq!(row.array("tags").unwrap().map(<[Scalar]>::len), Some(2));
        assert!(row.array("v").is_err());
        let r = s.reduce(&[Agg::of("tags", Reducer::Last)]).unwrap();
        assert_eq!(r.array("tags").unwrap().map(<[Scalar]>::len), Some(2));
        assert!(matches!(r.get("tags").unwrap(), Some(Value::Array(_))));
        // A reducer that needs numbers is refused, as on text.
        assert!(s.reduce(&[Agg::of("tags", Reducer::Sum)]).is_err());
        // Fill: a literal array; a non-finite one is an error.
        let f = s
            .fill(
                &[("tags", Fill::Value(Value::Array(vec!["x".into()])))],
                &FillLimits::none(),
            )
            .unwrap();
        assert_eq!(
            f.column("tags").unwrap().arrays().unwrap().get(2),
            Some(&["x".into()][..])
        );
        let nan = Fill::Value(Value::Array(vec![f64::INFINITY.into()]));
        assert!(s.fill(&[("tags", nan)], &FillLimits::none()).is_err());
        // map_arrays checks what it is given back.
        let e = s
            .map_arrays("tags", |_| vec![f64::NAN.into()])
            .unwrap_err()
            .to_string();
        assert!(e.contains("row 0 of 'tags'"), "{e}");
        let lens = s
            .map_arrays("tags", |a| vec![(a.len() as f64).into()])
            .unwrap();
        let tags = lens.column("tags").unwrap().arrays().unwrap();
        assert_eq!(tags.get(1), Some(&[Scalar::from(0.0)][..]));
        assert_eq!(tags.get(2), None);
    }

    #[test]
    fn equal_columns_compare_zeros_by_sign() {
        let a = ArrayColumn::from_options([Some(vec![Scalar::from(0.0)])]);
        let b = ArrayColumn::from_options([Some(vec![Scalar::from(-0.0)])]);
        assert_ne!(a, b);
        assert_eq!(a, a.clone());
        // A slice shares the cells.
        let c = ColumnData::from(ArrayColumn::from_options([None, Some(vec![]), None]));
        let tail = c.slice(1..3);
        assert_eq!(tail.len(), 2);
        assert!(tail.is_present(0) && !tail.is_present(1));
        assert_eq!(tail.missing_count(), 1);
    }

    fn s(f: f64) -> Scalar {
        Scalar::Number(f)
    }

    #[test]
    fn reducers_follow_pond_ts_row_path() {
        let mixed = [s(-0.0), s(0.0), s(2.0), s(3.5)];
        assert_eq!(reduce_elements(Reducer::Count, &mixed), Some(4.0));
        assert_eq!(reduce_elements(Reducer::Sum, &mixed), Some(5.5));
        assert_eq!(reduce_elements(Reducer::Avg, &mixed), Some(1.375));
        let min = reduce_elements(Reducer::Min, &mixed).unwrap();
        assert!(min == 0.0 && min.is_sign_negative());
        let min = reduce_elements(Reducer::Min, &[s(0.0), s(-0.0)]).unwrap();
        assert!(min.is_sign_positive());
        assert_eq!(
            reduce_elements(Reducer::Stdev, &mixed),
            Some(1.4737282653189494)
        );
        let text = [Scalar::from("a")];
        assert_eq!(reduce_elements(Reducer::Sum, &text), Some(0.0));
        assert_eq!(reduce_elements(Reducer::Avg, &text), None);
        assert_eq!(reduce_elements(Reducer::Count, &[]), Some(0.0));
        // An overflowing sum is a gap.
        assert_eq!(
            reduce_elements(Reducer::Sum, &[s(f64::MAX), s(f64::MAX)]),
            None
        );
    }
}
