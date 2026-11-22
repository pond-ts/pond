//! What an op or fold is handed when it runs, and the small helpers every
//! fold reports through (rounding, time stamps, `{ value, at }`).

use std::sync::Arc;

use pond_rs::TimeSeries;
use serde_json::{Value, json};

use crate::error::ProcessError;
use crate::registry::{Params, number};

/// A cell is missing when it is NaN or ±Infinity, as in `@pond-ts/process`
/// (`x - x !== 0`).
#[inline]
pub fn present(x: f64) -> bool {
    x.is_finite()
}

/// What an op's code reads: its inputs by role, already lined up with the
/// source rows, and its resolved params.
pub struct OpContext<'a> {
    pub(crate) roles: &'a [String],
    pub(crate) inputs: Vec<&'a [f64]>,
    /// The resolved params.
    pub params: &'a Params,
    /// The spec id, which is also the output column's name.
    pub id: &'a str,
    /// The row times (milliseconds since 1970, UTC).
    pub times: &'a [i64],
    /// The bound data, whose key an op can share rather than copy.
    pub series: &'a TimeSeries,
}

impl<'a> OpContext<'a> {
    /// The input with this role. Panics on a role the op did not declare,
    /// which is a mistake in the op's own code.
    pub fn input(&self, role: &str) -> &'a [f64] {
        let i = self
            .roles
            .iter()
            .position(|r| r == role)
            .unwrap_or_else(|| panic!("op has no input role '{role}'"));
        self.inputs[i]
    }

    /// A number param.
    pub fn number(&self, key: &str) -> f64 {
        self.params
            .get(key)
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN)
    }

    /// A string param.
    pub fn text(&self, key: &str) -> &str {
        self.params.get(key).and_then(Value::as_str).unwrap_or("")
    }

    /// The number of rows.
    pub fn len(&self) -> usize {
        self.times.len()
    }

    /// True when there are no rows.
    pub fn is_empty(&self) -> bool {
        self.times.is_empty()
    }
}

/// What a fold's code reads: the same as an op, ending in a fact.
pub type FoldContext<'a> = OpContext<'a>;

impl OpContext<'_> {
    /// The time of row `i` in milliseconds.
    pub fn at(&self, i: usize) -> i64 {
        self.times[i]
    }
}

/// An op's code: one column per declared output, each as long as the
/// input, NaN for a gap. An `Err` is the op's failure as the caller will
/// see it: [`ProcessError::thrown`] for a plain failure (no `code`, like
/// a thrown `Error` in `@pond-ts/process`), or any other kind to report a
/// code such as `ParamError`.
pub type RunFn = Arc<dyn Fn(&OpContext) -> Result<Vec<Vec<f64>>, ProcessError> + Send + Sync>;

/// A fold's code: the fact, as JSON. Errors as for [`RunFn`].
pub type FoldFn = Arc<dyn Fn(&FoldContext) -> Result<Value, ProcessError> + Send + Sync>;

/// JavaScript's `Math.round`: halves go up (toward +∞).
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let r = x.floor();
    if x - r >= 0.5 { r + 1.0 } else { r }
}

/// Six decimal places, as every fold reports (`round` in `folds.ts`).
pub fn round6(v: f64) -> f64 {
    js_round(v * 1e6) / 1e6
}

/// A rounded number as JSON.
pub fn fact_number(v: f64) -> Value {
    number(round6(v))
}

const DAY_MS: i64 = 86_400_000;

/// How a fold prints row times: the UTC day for a daily series (first and
/// last rows on midnight UTC, first step whole days), the UTC instant for
/// anything finer (`stamper` in `folds.ts`).
pub fn stamper(ctx: &FoldContext, len: usize) -> fn(i64) -> String {
    let first = if len > 0 { ctx.at(0) } else { 0 };
    let daily = len == 0
        || (first % DAY_MS == 0
            && ctx.at(len - 1) % DAY_MS == 0
            && (len < 2 || (ctx.at(1) - first) % DAY_MS == 0));
    if daily { day_text } else { instant_text }
}

/// `{ value, at }` for row `i`.
pub fn value_at(ctx: &FoldContext, v: &[f64], fmt: fn(i64) -> String, i: usize) -> Value {
    json!({ "value": fact_number(v[i]), "at": fmt(ctx.at(i)) })
}

/// Row of the first present value.
pub fn first_present(v: &[f64]) -> Option<usize> {
    v.iter().position(|x| present(*x))
}

/// Row of the last present value.
pub fn last_present(v: &[f64]) -> Option<usize> {
    v.iter().rposition(|x| present(*x))
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn year_text(y: i64) -> String {
    if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{y:06}")
    }
}

/// `toISOString().slice(0, 10)`.
fn day_text(ms: i64) -> String {
    let (y, m, d) = civil(ms.div_euclid(DAY_MS));
    format!("{}-{m:02}-{d:02}", year_text(y))
}

/// `toISOString()` without a `.000` millisecond part.
fn instant_text(ms: i64) -> String {
    let day = ms.div_euclid(DAY_MS);
    let rest = ms.rem_euclid(DAY_MS);
    let (y, m, d) = civil(day);
    let (h, rest) = (rest / 3_600_000, rest % 3_600_000);
    let (min, rest) = (rest / 60_000, rest % 60_000);
    let (s, milli) = (rest / 1000, rest % 1000);
    let base = format!("{}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}", year_text(y));
    if milli == 0 {
        format!("{base}Z")
    } else {
        format!("{base}.{milli:03}Z")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_follows_javascript() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-2.6), -3.0);
        assert_eq!(round6(1.23456789), 1.234568);
    }

    #[test]
    fn iso_text() {
        assert_eq!(day_text(0), "1970-01-01");
        assert_eq!(instant_text(1_700_000_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(instant_text(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(day_text(-1), "1969-12-31");
        assert_eq!(day_text(951_782_400_000), "2000-02-29");
    }
}
