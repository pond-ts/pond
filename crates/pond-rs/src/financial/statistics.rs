//! The statistics family (pond-ts `catalog/statistics.ts`, the studies the
//! volatility family leaves): the linear regression line, the time series
//! forecast, and the two-column studies beta, correlation, price relative
//! and the performance index.

use super::Study;
use super::averages::positive;
use super::bivariate::rolling_bivariate_values;
use super::kernels::{js_atan, percent_change_at};
use super::regression::{linear_regression_values, regression_at};
use std::borrow::Cow;

use crate::column::ColumnData;
use crate::error::{PondError, Result};
use crate::par;
use crate::series::TimeSeries;

study_options! {
    /// Options for [`TimeSeries::linear_regression`]: a 14-bar least-squares
    /// line; writes `linregValue`, `linregSlope`, `linregIntercept`,
    /// `linregAngle` and `linregR2`.
    LinearRegression, prefix = "linreg" {
        /// The window in bars, at least 2 (default 14).
        period: usize = 14,
    }
}

study_options! {
    /// Options for [`TimeSeries::beta`]: the slope of 5 one-bar returns
    /// against the benchmark's; writes `beta`.
    Beta(benchmark), output = "beta" {
        /// The window in returns, at least 2 (default 5).
        period: usize = 5,
    }
}

study_options! {
    /// Options for [`TimeSeries::correlation`]: Pearson's r over 30 bars;
    /// writes `corr`.
    Correlation(benchmark), output = "corr" {
        /// The window in bars, at least 2 (default 30).
        period: usize = 30,
    }
}

study_options! {
    /// Options for [`TimeSeries::price_relative`]: the column divided by
    /// the benchmark; writes `priceRel`.
    PriceRelative(benchmark), output = "priceRel" {}
}

study_options! {
    /// Options for [`TimeSeries::performance_index`]: the column's growth
    /// over 20 bars divided by the benchmark's; writes `perf`.
    PerformanceIndex(benchmark), output = "perf" {
        /// How many bars back the growth is measured from (default 20).
        period: usize = 20,
    }
}

/// How far past ±1 a correlation may round before it is read as ±1.
const PIN_SLACK: f64 = 1e-9;

/// The statistics family.
impl TimeSeries {
    /// Linear regression (pond-ts `linearRegression`): the least-squares
    /// line through each `period`-bar window, with x = 0 at the window's
    /// oldest bar. Writes five columns, in order: the line's value at the
    /// newest bar (`{prefix}Value`), its slope per bar, its intercept, the
    /// slope as an angle in degrees, and r². A gap until the window is full
    /// and wherever it holds a gap.
    pub fn linear_regression(&self, options: LinearRegression) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::linear_regression";
        positive(CALL, "period", options.period)?;
        regression_period(CALL, "linearRegression", options.period)?;
        let prefix = options.name();
        let names = ["Value", "Slope", "Intercept", "Angle", "R2"].map(|s| format!("{prefix}{s}"));
        self.free_names(CALL, &names)?;
        let values = self.study_source(CALL, options.source())?;
        let fit = linear_regression_values(&values, options.period);
        let value = regression_at(&fit, (options.period - 1) as f64);
        let degrees_per_radian = 180.0 / std::f64::consts::PI;
        // The slope as an angle, split across cores.
        let mut angle = vec![0.0; fit.slope.len()];
        par::fill_chunks(&mut angle, &mut [], 1 << 16, |start, out, _| {
            for (a, &m) in out.iter_mut().zip(&fit.slope[start..]) {
                *a = js_atan(m) * degrees_per_radian;
            }
        });
        let [value_name, slope_name, intercept_name, angle_name, r2_name] = names;
        self.study_outputs(
            CALL,
            [
                (value_name, value),
                (slope_name, fit.slope),
                (intercept_name, fit.intercept),
                (angle_name, angle),
                (r2_name, fit.r2),
            ],
        )
    }

    /// Time series forecast (pond-ts `timeSeriesForecast`), output `tsf`:
    /// each `period`-bar window's least-squares line carried one bar past
    /// the window. The period must be at least 2. pond-ts's default period
    /// is 14.
    pub fn time_series_forecast(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::time_series_forecast";
        positive(CALL, "period", study.period)?;
        regression_period(CALL, "timeSeriesForecast", study.period)?;
        let (values, output) = self.study_input(CALL, &study, "tsf")?;
        let fit = linear_regression_values(&values, study.period);
        self.study_output(CALL, output, regression_at(&fit, study.period as f64))
    }

    /// Beta (pond-ts `beta`): the slope of the column's one-bar returns
    /// against the benchmark's over `period` returns, their covariance
    /// over the benchmark's variance. A gap until `period` returns are in
    /// the window, wherever a return in it is a gap (a gap price, or a zero
    /// price before it), and where the benchmark's returns do not change.
    pub fn beta(&self, options: Beta) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::beta";
        positive(CALL, "period", options.period)?;
        at_least_two(
            CALL,
            options.period,
            "beta period must be at least 2 (a single return has no variance, so every reading would be 0/0)",
        )?;
        let (values, benchmark, output) = self.pair_input(
            CALL,
            "beta",
            &options,
            "a column has a beta of exactly 1 against itself",
        )?;
        // Both columns' returns in one pass, split across cores.
        let (mut returns, mut benchmark_returns) =
            (vec![0.0; values.len()], vec![0.0; values.len()]);
        par::fill_chunks(
            &mut returns,
            &mut benchmark_returns,
            1 << 16,
            |start, a, b| {
                for (k, (a, b)) in a.iter_mut().zip(b).enumerate() {
                    *a = percent_change_at(&values, 1, start + k);
                    *b = percent_change_at(&benchmark, 1, start + k);
                }
            },
        );
        let moments = rolling_bivariate_values(&returns, &benchmark_returns, options.period);
        let out = moments
            .covariance
            .iter()
            .zip(&moments.variance_y)
            .map(|(&c, &v)| c / v)
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Correlation (pond-ts `correlation`): Pearson's r between the column
    /// and the benchmark over `period` bars. A gap until the window is
    /// full, wherever either column holds a gap in it, and where either
    /// column does not change across it. A value that rounds past ±1 by
    /// no more than 1e-9 reads ±1.
    pub fn correlation(&self, options: Correlation) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::correlation";
        positive(CALL, "period", options.period)?;
        at_least_two(
            CALL,
            options.period,
            "correlation period must be at least 2 (a one-bar window has no variance, so every reading would be 0/0)",
        )?;
        let (values, benchmark, output) = self.pair_input(
            CALL,
            "correlation",
            &options,
            "a column correlates with itself at exactly 1",
        )?;
        let moments = rolling_bivariate_values(&values, &benchmark, options.period);
        let out = moments
            .covariance
            .iter()
            .zip(moments.variance_x.iter().zip(&moments.variance_y))
            .map(|(&c, (&vx, &vy))| {
                // The product can underflow to 0 or overflow to infinity
                // where the two roots do not.
                let mut denominator = (vx * vy).sqrt();
                if denominator == 0.0 || denominator == f64::INFINITY {
                    denominator = vx.sqrt() * vy.sqrt();
                }
                let r = c / denominator;
                if r > 1.0 && r <= 1.0 + PIN_SLACK {
                    1.0
                } else if (-1.0 - PIN_SLACK..-1.0).contains(&r) {
                    -1.0
                } else {
                    r
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Price relative (pond-ts `priceRelative`): the column divided by the
    /// benchmark, bar by bar; a gap where the benchmark is 0.
    pub fn price_relative(&self, options: PriceRelative) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::price_relative";
        let (values, benchmark, output) = self.pair_input(
            CALL,
            "priceRelative",
            &options,
            "the ratio would be 1 on every bar",
        )?;
        let out = values
            .iter()
            .zip(benchmark.iter())
            .map(|(&v, &b)| if b == 0.0 { f64::NAN } else { v / b })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Performance index (pond-ts `performanceIndex`): the column's growth
    /// over `period` bars divided by the benchmark's,
    /// `(value / value period bars back) · (benchmark then / benchmark
    /// now)`. A gap for the first `period` bars and where any of the three
    /// divisors is 0.
    pub fn performance_index(&self, options: PerformanceIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::performance_index";
        positive(CALL, "period", options.period)?;
        let (values, base, output) = self.pair_input(
            CALL,
            "performanceIndex",
            &options,
            "the reading would be 1 on every bar",
        )?;
        let period = options.period;
        let out = (0..values.len())
            .map(|i| {
                if i < period {
                    return f64::NAN;
                }
                let (value_previous, base_previous, base_now) =
                    (values[i - period], base[i - period], base[i]);
                if value_previous == 0.0 || base_previous == 0.0 || base_now == 0.0 {
                    f64::NAN
                } else {
                    (values[i] / value_previous) * (base_previous / base_now)
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// The checks every two-column study runs, in pond-ts's order (the
    /// benchmark is not the column, is on the series and holds numbers; the
    /// output is free), then both columns' numbers.
    fn pair_input<O: PairOptions>(
        &self,
        call: &'static str,
        study: &str,
        options: &O,
        same_reason: &str,
    ) -> Result<PairInput<'_>> {
        let (column, benchmark) = (options.source(), options.benchmark_name());
        if benchmark == column {
            return Err(PondError::InvalidData {
                call,
                message: format!(
                    "{study} benchmark '{benchmark}' is the same column as 'column'; {same_reason}"
                ),
            });
        }
        let found = self.columns().iter().find(|c| c.name() == benchmark);
        match found.map(|c| c.data()) {
            None => {
                return Err(PondError::InvalidData {
                    call,
                    message: format!(
                        "benchmark column '{benchmark}' is not on the series; join the comparison series in first (align + joinMany) or pass a different 'benchmark'"
                    ),
                });
            }
            Some(ColumnData::Number(_)) => {}
            Some(other) => {
                return Err(PondError::InvalidData {
                    call,
                    message: format!(
                        "benchmark column '{benchmark}' is a {} column, not a number column",
                        other.kind().as_str()
                    ),
                });
            }
        }
        let output = options.output_name().to_string();
        self.free_names(call, &[&output])?;
        let values = self.study_source(call, column)?;
        let benchmark = self.study_source(call, benchmark)?;
        Ok((values, benchmark, output))
    }
}

/// Both columns' numbers and the output's name.
type PairInput<'a> = (Cow<'a, [f64]>, Cow<'a, [f64]>, String);

/// What [`TimeSeries::pair_input`] reads from a two-column study's options.
trait PairOptions {
    fn source(&self) -> &str;
    fn benchmark_name(&self) -> &str;
    fn output_name(&self) -> &str;
}

macro_rules! pair_options {
    ($($name:ident),*) => {
        $(
            impl PairOptions for $name {
                fn source(&self) -> &str {
                    $name::source(self)
                }
                fn benchmark_name(&self) -> &str {
                    $name::benchmark_name(self)
                }
                fn output_name(&self) -> &str {
                    $name::name(self)
                }
            }
        )*
    };
}

pair_options!(Beta, Correlation, PriceRelative, PerformanceIndex);

/// pond-ts `assertRegressionPeriod`.
fn regression_period(call: &'static str, study: &str, period: usize) -> Result<()> {
    at_least_two(
        call,
        period,
        &format!(
            "{study} period must be at least 2 (a one-bar window has no slope: the regression denominator n²(n²−1)/12 is 0 at n = 1)"
        ),
    )
}

fn at_least_two(call: &'static str, period: usize, message: &str) -> Result<()> {
    if period < 2 {
        return Err(PondError::InvalidData {
            call,
            message: message.to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::series::Column;

    fn series(columns: Vec<Column>) -> TimeSeries {
        TimeSeries::new("s", (0..3).collect(), columns).unwrap()
    }

    fn message(result: Result<TimeSeries>) -> String {
        result.unwrap_err().to_string()
    }

    /// pond-ts checks the benchmark (same column, on the series, a number
    /// column) before the output name, and the output before the source
    /// column.
    #[test]
    fn two_column_checks_run_in_pond_ts_order() {
        let s = series(vec![
            Column::required("close", vec![1.0, 2.0, 3.0]),
            Column::required("spy", vec![1.0, 2.0, 4.0]),
            Column::required("name", vec!["a", "b", "c"]),
        ]);
        let same = message(s.beta(Beta::new("close").output("close")));
        assert!(same.contains("same column as 'column'"), "{same}");
        let missing = message(s.correlation(Correlation::new("qqq").output("close")));
        assert!(
            missing.contains("benchmark column 'qqq' is not on the series"),
            "{missing}"
        );
        let text = message(s.price_relative(PriceRelative::new("name").output("close")));
        assert!(
            text.contains("is a string column, not a number column"),
            "{text}"
        );
        let output = message(
            s.performance_index(PerformanceIndex::new("spy").column("nope").output("close")),
        );
        assert!(
            output.contains("collides with an existing column"),
            "{output}"
        );
        let period = message(s.beta(Beta::new("close").period(1)));
        assert!(
            period.contains("beta period must be at least 2"),
            "{period}"
        );
    }
}
