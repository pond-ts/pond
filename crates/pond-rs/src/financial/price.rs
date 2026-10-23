//! The price family (pond-ts `catalog/price.ts`): the typical, median,
//! weighted-close and average prices of each bar, and the balance of
//! power.

use super::MaType;
use super::averages::positive;
use super::kernels::{median_price_values, moving_average_values, typical_price_values};
use crate::error::{PondError, Result};
use crate::series::TimeSeries;

study_options! {
    /// Options for [`TimeSeries::typical_price`]: writes `typicalPrice`.
    TypicalPrice, output = "typicalPrice", reads [high, low, close] {}
}

study_options! {
    /// Options for [`TimeSeries::median_price`]: writes `medianPrice`.
    MedianPrice, output = "medianPrice", reads [high, low] {}
}

study_options! {
    /// Options for [`TimeSeries::weighted_close`]: writes `weightedClose`.
    WeightedClose, output = "weightedClose", reads [high, low, close] {}
}

study_options! {
    /// Options for [`TimeSeries::average_price`]: writes `averagePrice`.
    AveragePrice, output = "averagePrice", reads [open, high, low, close] {}
}

/// Options for [`TimeSeries::balance_of_power`]: the raw per-bar ratio
/// unless a `period` is set, which smooths it with a moving average
/// (simple unless `ma` says otherwise); writes `bop`.
///
/// ```
/// use pond_rs::financial::{BalanceOfPower, MaType};
/// let raw = BalanceOfPower::default();
/// let smoothed = BalanceOfPower::default().period(14).ma(MaType::Ema);
/// ```
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BalanceOfPower {
    period: Option<usize>,
    ma: Option<MaType>,
    open: Option<String>,
    high: Option<String>,
    low: Option<String>,
    close: Option<String>,
    output: Option<String>,
}

impl BalanceOfPower {
    /// Smooth the ratio over this many bars.
    pub fn period(mut self, period: usize) -> Self {
        self.period = Some(period);
        self
    }

    /// The moving average that smooths it (default simple); needs a
    /// `period`.
    pub fn ma(mut self, ma: MaType) -> Self {
        self.ma = Some(ma);
        self
    }

    /// Read the open prices from this column instead of `open`.
    pub fn open(mut self, name: &str) -> Self {
        self.open = Some(name.to_string());
        self
    }

    /// Read the high prices from this column instead of `high`.
    pub fn high(mut self, name: &str) -> Self {
        self.high = Some(name.to_string());
        self
    }

    /// Read the low prices from this column instead of `low`.
    pub fn low(mut self, name: &str) -> Self {
        self.low = Some(name.to_string());
        self
    }

    /// Read the close prices from this column instead of `close`.
    pub fn close(mut self, name: &str) -> Self {
        self.close = Some(name.to_string());
        self
    }

    /// Name what the study writes with this output instead of `bop`.
    pub fn output(mut self, name: &str) -> Self {
        self.output = Some(name.to_string());
        self
    }
}

/// The price family.
impl TimeSeries {
    /// Typical price (pond-ts `typicalPrice`): `(high + low + close) / 3`
    /// for each bar. A gap where any of the three is.
    pub fn typical_price(&self, options: TypicalPrice) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::typical_price";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        self.study_output(CALL, output, typical_price_values(&high, &low, &close))
    }

    /// Median price (pond-ts `medianPrice`): `(high + low) / 2` for each
    /// bar. (pond-ts also takes a `close` it never reads; pond-rs leaves
    /// it out.)
    pub fn median_price(&self, options: MedianPrice) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::median_price";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low] =
            self.price_columns(CALL, [&options.high, &options.low], ["high", "low"])?;
        self.study_output(CALL, output, median_price_values(&high, &low))
    }

    /// Weighted close (pond-ts `weightedClose`): `(high + low + 2 · close)
    /// / 4` for each bar.
    pub fn weighted_close(&self, options: WeightedClose) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::weighted_close";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let out = (0..high.len())
            .map(|i| (high[i] + low[i] + close[i] * 2.0) / 4.0)
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Average price (pond-ts `averagePrice`): `(open + high + low +
    /// close) / 4` for each bar.
    pub fn average_price(&self, options: AveragePrice) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::average_price";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [open, high, low, close] = self.price_columns(
            CALL,
            [&options.open, &options.high, &options.low, &options.close],
            ["open", "high", "low", "close"],
        )?;
        let out = (0..high.len())
            .map(|i| (high[i] + low[i] + close[i] + open[i]) / 4.0)
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Balance of power (pond-ts `balanceOfPower`): each bar's `(close -
    /// open) / (high - low)`, 0 on a bar with no range (a gap if the open
    /// or close is); with a `period`, that smoothed by the `ma` average.
    pub fn balance_of_power(&self, options: BalanceOfPower) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::balance_of_power";
        if let Some(period) = options.period {
            positive(CALL, "period", period)?;
        }
        if options.ma.is_some() && options.period.is_none() {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "balanceOfPower maType needs a period — without one the study is the raw per-bar ratio and there is nothing to smooth".into(),
            });
        }
        let output = options.output.as_deref().unwrap_or("bop").to_string();
        self.free_names(CALL, &[&output])?;
        let [open, high, low, close] = self.price_columns(
            CALL,
            [&options.open, &options.high, &options.low, &options.close],
            ["open", "high", "low", "close"],
        )?;
        let raw: Vec<f64> = (0..high.len())
            .map(|i| {
                let range = high[i] - low[i];
                let body = close[i] - open[i];
                if range == 0.0 {
                    if body.is_nan() { f64::NAN } else { 0.0 }
                } else {
                    body / range
                }
            })
            .collect();
        let out = match options.period {
            None => raw,
            Some(period) => moving_average_values(&raw, period, options.ma.unwrap_or(MaType::Sma)),
        };
        self.study_output(CALL, output, out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bars() -> TimeSeries {
        let price = |k: f64| (0..4).map(|i| 10.0 + k * f64::from(i)).collect::<Vec<_>>();
        TimeSeries::new(
            "s",
            (0..4).collect(),
            vec![
                crate::Column::required("open", price(0.5)),
                crate::Column::required("high", price(1.5)),
                crate::Column::required("low", price(0.2)),
                crate::Column::required("close", price(1.0)),
            ],
        )
        .unwrap()
    }

    /// Which error wins when several apply, as in pond-ts (the parity
    /// check only sees that both sides fail).
    #[test]
    fn errors_come_in_pond_ts_order() {
        let s = bars();
        let message = |r: Result<TimeSeries>| r.unwrap_err().to_string();
        let mp = message(s.median_price(MedianPrice::default().high("h?").low("l?")));
        assert!(mp.contains("h?"), "{mp}");
        // Then high, low, close.
        let tp = message(s.typical_price(TypicalPrice::default().high("h?").low("l?")));
        assert!(tp.contains("h?"), "{tp}");
        let tp = message(s.typical_price(TypicalPrice::default().low("l?").close("c?")));
        assert!(tp.contains("l?"), "{tp}");
        let wc = message(s.weighted_close(WeightedClose::default().high("h?").low("l?")));
        assert!(wc.contains("h?"), "{wc}");
        let wc = message(s.weighted_close(WeightedClose::default().low("l?").close("c?")));
        assert!(wc.contains("l?"), "{wc}");
        let ap = message(s.average_price(AveragePrice::default().high("h?").low("l?")));
        assert!(ap.contains("h?"), "{ap}");
        let ap = message(s.average_price(AveragePrice::default().low("l?").close("c?")));
        assert!(ap.contains("l?"), "{ap}");
        let bop = message(s.balance_of_power(BalanceOfPower::default().low("l?").close("c?")));
        assert!(bop.contains("l?"), "{bop}");
        // The open is read first.
        let ap = message(s.average_price(AveragePrice::default().open("o?").high("h?")));
        assert!(ap.contains("o?"), "{ap}");
        let bop = message(s.balance_of_power(BalanceOfPower::default().open("o?").high("h?")));
        assert!(bop.contains("o?"), "{bop}");
        // The period, then a type without one, then the output name.
        let bop = message(
            s.balance_of_power(
                BalanceOfPower::default()
                    .period(0)
                    .ma(MaType::Ema)
                    .output("close"),
            ),
        );
        assert!(bop.contains("period must be"), "{bop}");
        let bop =
            message(s.balance_of_power(BalanceOfPower::default().ma(MaType::Sma).output("close")));
        assert!(bop.contains("maType needs a period"), "{bop}");
        let tp = message(s.typical_price(TypicalPrice::default().output("close").high("h?")));
        assert!(tp.contains("collides"), "{tp}");
    }
}
