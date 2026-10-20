//! Exact `sum` and `difference` of decimal columns, for `aggregate`,
//! `reduce` and `rolling`.
//!
//! Running sums are held in 256 bits, so no sum of `i128` values a series
//! can hold overflows on the way; each result is then checked to fit
//! Arrow's widest decimal, 38 digits. Gaps are skipped and a sum of none is
//! 0, as for numbers.

use std::ops::Range;

use arrow_buffer::i256;

use crate::column::DecimalColumn;
use crate::error::{PondError, Result};
use crate::reducer::Input;
use crate::rolling::{Window, walk};
use crate::series::Column;

/// Arrow's widest decimal precision.
const MAX_PRECISION: u8 = 38;

/// The largest whole number with 38 digits, `10^38 - 1`.
fn max_value() -> i256 {
    i256::from_i128(10i128.pow(38) - 1)
}

/// The result as a 38-digit decimal, or an error naming the output row.
fn fit(call: &'static str, what: &str, output: &str, row: usize, sum: i256) -> Result<i128> {
    let max = max_value();
    if sum > max || sum < -max {
        return Err(PondError::InvalidData {
            call,
            message: format!(
                "decimal {what} '{output}' at row {row} has more than {MAX_PRECISION} digits"
            ),
        });
    }
    Ok(sum.as_i128())
}

fn result(
    call: &'static str,
    what: &str,
    output: &str,
    source: &DecimalColumn,
    sums: Vec<Option<i256>>,
) -> Result<Column> {
    let values = sums
        .into_iter()
        .enumerate()
        .map(|(row, s)| s.map(|s| fit(call, what, output, row, s)).transpose())
        .collect::<Result<Vec<_>>>()?;
    Ok(Column::from_data(
        output.to_string(),
        source.rebuild(values, MAX_PRECISION),
        false,
    ))
}

/// The exact sum of each row range (one per `aggregate` bucket).
pub(crate) fn sum_ranges(
    call: &'static str,
    output: &str,
    source: &DecimalColumn,
    ranges: &[Range<usize>],
) -> Result<Column> {
    let raw = source.raw();
    let nulls = source.nulls();
    let sums = ranges
        .iter()
        .map(|r| {
            let mut s = i256::ZERO;
            for i in r.clone() {
                if nulls.is_none_or(|n| n.is_valid(i)) {
                    s = s.wrapping_add(i256::from_i128(raw[i]));
                }
            }
            Some(s)
        })
        .collect();
    result(call, "sum", output, source, sums)
}

/// A running exact sum: values are added as they enter the window and
/// taken away as they leave. Exact, so it never drifts.
struct RollingSum<'a> {
    source: &'a DecimalColumn,
    sum: i256,
    out: Vec<i256>,
}

impl RollingSum<'_> {
    fn value(&self, row: usize) -> Option<i256> {
        self.source
            .nulls()
            .is_none_or(|n| n.is_valid(row))
            .then(|| i256::from_i128(self.source.raw()[row]))
    }
}

impl Window for RollingSum<'_> {
    fn enter(&mut self, row: usize) {
        if let Some(v) = self.value(row) {
            self.sum = self.sum.wrapping_add(v);
        }
    }
    fn leave(&mut self, row: usize) {
        if let Some(v) = self.value(row) {
            self.sum = self.sum.wrapping_sub(v);
        }
    }
    fn emit(&mut self, rows: Range<usize>) {
        self.out[rows].fill(self.sum);
    }
}

/// The exact sum of each row's trailing window (see `TimeSeries::rolling`).
pub(crate) fn rolling_sum(
    call: &'static str,
    output: &str,
    source: &DecimalColumn,
    times: &[i64],
    window_ms: i64,
) -> Result<Column> {
    let mut w = RollingSum {
        source,
        sum: i256::ZERO,
        out: vec![i256::ZERO; times.len()],
    };
    walk(times, window_ms, &mut w);
    result(
        call,
        "sum",
        output,
        source,
        w.out.into_iter().map(Some).collect(),
    )
}

/// The exact `difference` (largest minus smallest) for each output row,
/// given the smallest and largest of each as [`InputKind::Ranks`] values
/// (NaN where there were none, which gives a gap). At precision 38; a
/// spread past 38 digits is an error naming the row.
///
/// [`InputKind::Ranks`]: crate::reducer::InputKind::Ranks
pub(crate) fn difference(
    call: &'static str,
    output: &str,
    source: &DecimalColumn,
    input: &Input<'_>,
    lo: &[f64],
    hi: &[f64],
) -> Result<Column> {
    let spreads = lo
        .iter()
        .zip(hi)
        .map(|(&lo, &hi)| {
            (lo.is_finite() && hi.is_finite()).then(|| {
                i256::from_i128(input.raw_decimal(hi))
                    .wrapping_sub(i256::from_i128(input.raw_decimal(lo)))
            })
        })
        .collect();
    result(call, "difference", output, source, spreads)
}

#[cfg(test)]
mod tests {
    use crate::{
        Agg, Column, ColumnKind, Decimal, DecimalColumn, PondError, Reducer, Sequence, TimeSeries,
    };

    fn d(value: i128, scale: i8) -> Decimal {
        Decimal { value, scale }
    }

    #[test]
    fn prints_as_a_decimal() {
        let cases = [
            (d(125, 2), "1.25"),
            (d(-5, 2), "-0.05"),
            (d(0, 3), "0.000"),
            (d(7, 0), "7"),
            (d(12, -3), "12000"),
            (d(0, -3), "0"),
            (d(-1, 1), "-0.1"),
            (d(i128::MIN, 0), "-170141183460469231731687303715884105728"),
        ];
        for (v, want) in cases {
            assert_eq!(v.to_string(), want);
        }
    }

    #[test]
    fn converts_to_the_nearest_float() {
        assert_eq!(d(125, 2).to_f64(), 1.25);
        assert_eq!(d(1, 1).to_f64(), 0.1);
        assert_eq!(d(-3, -2).to_f64(), -300.0);
        // Past 2^53 or past scale 22 the slow path still rounds correctly.
        let big = 10i128.pow(37) + 1;
        assert_eq!(d(big, 0).to_f64(), 1e37);
        assert_eq!(
            d(big, 30).to_f64(),
            "10000000.000000000000000000000000000001"
                .parse::<f64>()
                .unwrap()
        );
        assert_eq!(d(1, 30).to_f64(), 1e-30);
    }

    #[test]
    fn values_past_38_digits_or_bad_scales_are_refused() {
        let err = DecimalColumn::from_values(vec![10i128.pow(38)], 0).unwrap_err();
        assert!(matches!(err, PondError::InvalidData { .. }), "{err}");
        assert!(DecimalColumn::from_values(vec![10i128.pow(38) - 1], 0).is_ok());
        assert!(DecimalColumn::from_values(vec![1], 39).is_err());
    }

    fn series(values: Vec<Option<i128>>) -> TimeSeries {
        let times = (0..values.len() as i64).map(|i| i * 1000).collect();
        TimeSeries::new(
            "s",
            times,
            vec![Column::optional(
                "d",
                DecimalColumn::from_options(values, 2).unwrap(),
            )],
        )
        .unwrap()
    }

    #[test]
    fn sums_are_exact_and_other_reducers_give_numbers() {
        // 0.1 + 0.2 is exactly 0.3 here, not 0.30000000000000004.
        let s = series(vec![Some(10), Some(20), None, Some(-5)]);
        let aggs = [
            Agg::new("sum", "d", Reducer::Sum),
            Agg::new("min", "d", Reducer::Min),
            Agg::new("avg", "d", Reducer::Avg),
            Agg::new("n", "d", Reducer::Count),
        ];
        let m = s.aggregate(&Sequence::every("2s").unwrap(), &aggs).unwrap();
        let kinds: Vec<_> = m.columns().iter().map(|c| c.kind()).collect();
        use ColumnKind::*;
        assert_eq!(kinds, [Decimal, Decimal, Number, Number]);
        let sums: Vec<_> = m
            .column("sum")
            .unwrap()
            .decimals()
            .unwrap()
            .iter()
            .map(|v| v.unwrap().to_string())
            .collect();
        assert_eq!(sums, ["0.30", "-0.05"]);
        assert_eq!(m.column("sum").unwrap().decimals().unwrap().precision(), 38);
        let r = s.rolling("2s", &aggs).unwrap();
        let sums: Vec<_> = r
            .column("sum")
            .unwrap()
            .decimals()
            .unwrap()
            .iter()
            .map(|v| v.unwrap().to_string())
            .collect();
        assert_eq!(sums, ["0.10", "0.30", "0.20", "-0.05"]);
    }

    #[test]
    fn a_sum_past_38_digits_is_an_error() {
        let max = 10i128.pow(38) - 1;
        let s = series(vec![Some(max), Some(1), Some(-max)]);
        let sum = [Agg::new("total", "d", Reducer::Sum)];
        // max + 1 - max passes 38 digits on the way but ends at 0.01, so the
        // whole-bucket sum is fine...
        let m = s.aggregate(&Sequence::every("1m").unwrap(), &sum).unwrap();
        let total = m.column("total").unwrap().decimals().unwrap().get(0);
        assert_eq!(total.unwrap().to_string(), "0.01");
        let err = s.rolling("2s", &sum).unwrap_err().to_string();
        // ...but the window holding max and 1 alone does not.
        assert!(
            err.contains("'total' at row 1 has more than 38 digits"),
            "{err}"
        );
    }

    #[test]
    fn negative_scales_work_and_round_trip() {
        // 12 at scale -3 is 12000.
        let c = DecimalColumn::from_options([Some(12), None, Some(-5)], -3).unwrap();
        assert_eq!(c.get(0).unwrap().to_string(), "12000");
        assert_eq!(c.get(0).unwrap().to_f64(), 12000.0);
        let s = TimeSeries::new("s", vec![0, 1000, 2000], vec![Column::optional("d", c)]).unwrap();
        let mut bytes = Vec::new();
        s.write_ipc(&mut bytes).unwrap();
        let back = TimeSeries::from_ipc_bytes("s", bytes, "time").unwrap();
        let d = back.column("d").unwrap().decimals().unwrap();
        assert_eq!(d.scale(), -3);
        assert_eq!(d, s.column("d").unwrap().decimals().unwrap());
        let m = s
            .aggregate(
                &Sequence::every("1m").unwrap(),
                &[Agg::new("t", "d", Reducer::Sum)],
            )
            .unwrap();
        let total = m.column("t").unwrap().decimals().unwrap().get(0).unwrap();
        assert_eq!(total.to_string(), "7000");
        // Precision still counts digits stored: 10^38 is one too many.
        assert!(DecimalColumn::from_values(vec![10i128.pow(38)], -5).is_err());
    }
}
