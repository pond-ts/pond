//! pond-ts `linearRegressionValues`: a least-squares line through each
//! `period`-row window (x = 0 at the window's oldest row), as slope,
//! intercept and r².

use crate::par;

/// Slope, intercept and r² of each window's line; a gap until the window
/// is full and wherever it holds a gap.
pub(crate) struct Regression {
    pub(crate) slope: Vec<f64>,
    pub(crate) intercept: Vec<f64>,
    #[allow(dead_code)]
    pub(crate) r2: Vec<f64>,
}

/// pond-ts's floor on a window's spread, relative to the squares that
/// passed through its sums, below which the window is fitted again.
const RELATIVE_SPREAD_FLOOR: f64 = 1e-3;

/// pond-ts `linearRegressionValues` (`period` at least 2). Running sums in
/// a frame shifted by an anchor value, rebuilt from the window at every
/// row that is a multiple of `period`; a window whose values never change
/// reads slope 0 and its value; a window whose spread is tiny beside the
/// squares in its sums is fitted again in two passes. Split across cores:
/// each stretch starts at a rebuild row, so the same bits.
pub(crate) fn linear_regression_values(values: &[f64], period: usize) -> Regression {
    let n = values.len();
    let mut slope = vec![0.0; n];
    let mut intercept = vec![0.0; n];
    let mut r2 = vec![0.0; n];
    let chunk = (1 << 16).max(period.saturating_mul(8));
    par::fill_chunks3(
        &mut slope,
        &mut intercept,
        &mut r2,
        chunk,
        |start, slope, intercept, r2| regression_into(values, period, start, slope, intercept, r2),
    );
    Regression {
        slope,
        intercept,
        r2,
    }
}

/// pond-ts `linearRegressionAt`: each window's line read at `x`.
pub(crate) fn regression_at(fit: &Regression, x: f64) -> Vec<f64> {
    fit.intercept
        .iter()
        .zip(&fit.slope)
        .map(|(&b, &m)| b + m * x)
        .collect()
}

/// [`linear_regression_values`] for rows `start..start + slope.len()`. The
/// sweep begins at the last rebuild row at or before `start`, where every
/// sum is rebuilt from the window; only the count of changes in the window
/// is carried across a rebuild, so it is counted first.
fn regression_into(
    values: &[f64],
    period: usize,
    start: usize,
    slope: &mut [f64],
    intercept: &mut [f64],
    r2: &mut [f64],
) {
    let end = start + slope.len();
    let p = period as f64;
    let sum_x = (p * (p - 1.0)) / 2.0;
    let sum_xx = ((p - 1.0) * p * (2.0 * p - 1.0)) / 6.0;
    // n·Σx² − (Σx)² = n²(n² − 1)/12, positive for every period from 2.
    let denominator = p * sum_xx - sum_x * sum_x;
    let from = start / period * period;
    let changed = |k: usize| values[k] != values[k - 1];
    // Changes inside the window ending at `from - 1` (rows past 0 only).
    let mut changes = ((from + 1).saturating_sub(period).max(1)..from)
        .filter(|&k| changed(k))
        .count() as isize;
    let (mut anchor, mut sum_z, mut sum_xz, mut sum_zz, mut gross_zz) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut missing: isize = 0;
    for i in from..end {
        // The window is [low, i]; rows before 0 read as nothing.
        let low = i as isize - period as isize + 1;
        let entering = values[i];
        let entering_finite = entering.is_finite();
        let z_in = if entering_finite {
            entering - anchor
        } else {
            0.0
        };
        let mut z_out = 0.0;
        if low >= 1 {
            let leaving = values[(low - 1) as usize];
            if leaving.is_finite() {
                z_out = leaving - anchor;
            } else {
                missing -= 1;
            }
        }
        if !entering_finite {
            missing += 1;
        }
        // Σxz first: moving the origin costs the old Σz.
        sum_xz = sum_xz - sum_z + z_out + (p - 1.0) * z_in;
        sum_z = sum_z - z_out + z_in;
        sum_zz = sum_zz - z_out * z_out + z_in * z_in;
        gross_zz += z_out * z_out + z_in * z_in;
        if i >= 1 && changed(i) {
            changes += 1;
        }
        if low >= 1 && changed(low as usize) {
            changes -= 1;
        }
        if i % period == 0 {
            let at = values[i];
            anchor = if at.is_finite() { at } else { 0.0 };
            (sum_z, sum_xz, sum_zz, gross_zz) = (0.0, 0.0, 0.0, 0.0);
            missing = 0;
            let first = low.max(0) as usize;
            for (k, &y) in values[first..=i].iter().enumerate() {
                let k = first + k;
                if !y.is_finite() {
                    missing += 1;
                    continue;
                }
                let z = y - anchor;
                sum_z += z;
                sum_xz += (k as isize - low) as f64 * z;
                sum_zz += z * z;
                gross_zz += z * z;
            }
        }
        if i < start {
            continue;
        }
        let o = i - start;
        if i + 1 < period || missing > 0 {
            (slope[o], intercept[o], r2[o]) = (f64::NAN, f64::NAN, f64::NAN);
            continue;
        }
        if changes == 0 {
            // A flat window: slope 0, the value itself, no r².
            (slope[o], intercept[o], r2[o]) = (0.0, entering, f64::NAN);
            continue;
        }
        let numerator = p * sum_xz - sum_x * sum_z;
        let m = numerator / denominator;
        slope[o] = m;
        intercept[o] = anchor + (sum_z - m * sum_x) / p;
        let spread = p * sum_zz - sum_z * sum_z;
        if spread <= 0.0 || spread < RELATIVE_SPREAD_FLOOR * p * gross_zz {
            (slope[o], intercept[o], r2[o]) = refit(values, low as usize, i, p);
            continue;
        }
        let r = (numerator * numerator) / (denominator * spread);
        r2[o] = if r > 1.0 { 1.0 } else { r };
    }
}

/// pond-ts's two-pass fit of one window `[low, i]`, for a window that
/// changes but whose spread is lost in the running sums: deviations from
/// the window's own first value and mean, in units of the largest one.
fn refit(values: &[f64], low: usize, i: usize, p: f64) -> (f64, f64, f64) {
    let window = &values[low..=i];
    let local = window[0];
    let mut mean_z = 0.0;
    for &v in window {
        mean_z += v - local;
    }
    mean_z /= p;
    let mean_xc = (p - 1.0) / 2.0;
    let mut scale: f64 = 0.0;
    for &v in window {
        let a = (v - local - mean_z).abs();
        if a > scale {
            scale = a;
        }
    }
    if scale == 0.0 {
        return (0.0, local + mean_z, f64::NAN);
    }
    let (mut sxx, mut sxz, mut szz) = (0.0, 0.0, 0.0);
    for (k, &v) in window.iter().enumerate() {
        let dx = k as f64 - mean_xc;
        let dz = (v - local - mean_z) / scale;
        sxx += dx * dx;
        sxz += dx * dz;
        szz += dz * dz;
    }
    let mc = (scale * sxz) / sxx;
    let b = local + mean_z - mc * mean_xc;
    if szz <= 0.0 {
        return (mc, b, f64::NAN);
    }
    let rc = (sxz * sxz) / (sxx * szz);
    (mc, b, if rc > 1.0 { 1.0 } else { rc })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stretches started anywhere give the bits of one sweep, on data with
    /// gaps, flat runs and a large offset.
    #[test]
    fn stretches_give_the_same_bits_as_one_sweep() {
        let values: Vec<f64> = (0..3_000)
            .map(|i| match i % 97 {
                5 => f64::NAN,
                20..=40 => 7.0,
                _ => 1e9 + ((i * 7919) % 101) as f64 / 7.0,
            })
            .collect();
        for period in [2, 3, 14, 50] {
            let n = values.len();
            let (mut s, mut b, mut r) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
            regression_into(&values, period, 0, &mut s, &mut b, &mut r);
            for chunk in [1, 7, 64, 1000] {
                let (mut s2, mut b2, mut r2) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
                for start in (0..n).step_by(chunk) {
                    let e = (start + chunk).min(n);
                    regression_into(
                        &values,
                        period,
                        start,
                        &mut s2[start..e],
                        &mut b2[start..e],
                        &mut r2[start..e],
                    );
                }
                let bits = |v: &[f64]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
                assert_eq!(bits(&s), bits(&s2), "slope {period} {chunk}");
                assert_eq!(bits(&b), bits(&b2), "intercept {period} {chunk}");
                assert_eq!(bits(&r), bits(&r2), "r2 {period} {chunk}");
            }
        }
    }
}
