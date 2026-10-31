//! pond-ts `rollingBivariateValues`: the population covariance of two
//! row-aligned columns and the variance of each, over each `period`-row
//! window.

use crate::par;

/// Covariance and the two variances of each window; a gap until the window
/// is full and wherever either column holds a gap (or an infinity) in it.
pub(crate) struct Bivariate {
    pub(crate) covariance: Vec<f64>,
    pub(crate) variance_x: Vec<f64>,
    pub(crate) variance_y: Vec<f64>,
}

/// A moment smaller than this share of the squares that passed through it
/// since the last rebuild is a residue: the window is fitted again.
const RELATIVE_MOMENT_FLOOR: f64 = 1e-3;
/// How far past `cov² = varX · varY` the co-moment may drift before the
/// window is fitted again.
const CAUCHY_SCHWARZ_SLACK: f64 = 1.0 + 1e-9;

/// pond-ts `rollingBivariateValues` (`period` at least 2). Welford-style
/// running moments in a frame shifted by the window's first complete pair,
/// rebuilt from the window at every row that is a multiple of `period`, and
/// again on demand where a moment is a residue or the co-moment breaks
/// Cauchy–Schwarz. A column that does not change across the window reads a
/// variance (and covariance) of exactly 0. Split across cores: each stretch
/// starts at a rebuild row, where only the counts of changes and gaps carry
/// over, so the same bits.
pub(crate) fn rolling_bivariate_values(x: &[f64], y: &[f64], period: usize) -> Bivariate {
    let n = x.len();
    let mut covariance = vec![0.0; n];
    let mut variance_x = vec![0.0; n];
    let mut variance_y = vec![0.0; n];
    let chunk = (1 << 16).max(period.saturating_mul(8));
    par::fill_chunks3(
        &mut covariance,
        &mut variance_x,
        &mut variance_y,
        chunk,
        |start, cov, vx, vy| bivariate_into(x, y, period, start, cov, vx, vy),
    );
    Bivariate {
        covariance,
        variance_x,
        variance_y,
    }
}

/// [`rolling_bivariate_values`] for rows `start..start + cov.len()`. The
/// sweep begins at the last rebuild row at or before `start`; the moments
/// are rebuilt there from the window, so only the counts of changes and of
/// incomplete pairs in the window before it are worked out first.
fn bivariate_into(
    x: &[f64],
    y: &[f64],
    period: usize,
    start: usize,
    cov: &mut [f64],
    var_x: &mut [f64],
    var_y: &mut [f64],
) {
    let end = start + cov.len();
    let from = start / period * period;
    let complete = |k: usize| x[k].is_finite() && y[k].is_finite();
    // The window [window_start, window_end) as the sweep finds it when it
    // reaches row `from`.
    let mut window_start = from.saturating_sub(period);
    let mut window_end = from;
    let mut changes_x = (window_start + 1..window_end)
        .filter(|&k| x[k - 1] != x[k])
        .count() as isize;
    let mut changes_y = (window_start + 1..window_end)
        .filter(|&k| y[k - 1] != y[k])
        .count() as isize;
    let mut incomplete = (window_start..window_end).filter(|&k| !complete(k)).count() as isize;
    let (mut anchor_x, mut anchor_y) = (0.0, 0.0);
    let mut count = 0usize;
    let (mut mean_x, mut mean_y, mut m2x, mut m2y, mut cxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut gross_x, mut gross_y) = (0.0, 0.0);
    for i in from..end {
        let lo = (i + 1).saturating_sub(period);
        while window_end <= i {
            let (u, v) = (x[window_end], y[window_end]);
            if window_end > window_start {
                if x[window_end - 1] != u {
                    changes_x += 1;
                }
                if y[window_end - 1] != v {
                    changes_y += 1;
                }
            }
            if u.is_finite() && v.is_finite() {
                let su = u - anchor_x;
                let sv = v - anchor_y;
                gross_x += su * su;
                gross_y += sv * sv;
                count += 1;
                let c = count as f64;
                let dx = su - mean_x;
                let dy = sv - mean_y;
                mean_x += dx / c;
                mean_y += dy / c;
                m2x += dx * (su - mean_x);
                m2y += dy * (sv - mean_y);
                cxy += dx * (sv - mean_y);
            } else {
                incomplete += 1;
            }
            window_end += 1;
        }
        while window_start < lo {
            let (u, v) = (x[window_start], y[window_start]);
            if window_start + 1 < window_end {
                if x[window_start + 1] != u {
                    changes_x -= 1;
                }
                if y[window_start + 1] != v {
                    changes_y -= 1;
                }
            }
            if u.is_finite() && v.is_finite() {
                let su = u - anchor_x;
                let sv = v - anchor_y;
                gross_x += su * su;
                gross_y += sv * sv;
                if count <= 1 {
                    count = 0;
                    (mean_x, mean_y, m2x, m2y, cxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
                } else if count == 2 {
                    // Down to one pair: the moments are exactly 0 and the
                    // mean is exactly the survivor.
                    count = 1;
                    mean_x = mean_x * 2.0 - su;
                    mean_y = mean_y * 2.0 - sv;
                    (m2x, m2y, cxy) = (0.0, 0.0, 0.0);
                } else {
                    let (old_x, old_y) = (mean_x, mean_y);
                    count -= 1;
                    let c = count as f64;
                    mean_x = old_x - (su - old_x) / c;
                    mean_y = old_y - (sv - old_y) / c;
                    m2x -= (su - mean_x) * (su - old_x);
                    m2y -= (sv - mean_y) * (sv - old_y);
                    cxy -= (su - mean_x) * (sv - old_y);
                    if m2x < 0.0 {
                        m2x = 0.0;
                    }
                    if m2y < 0.0 {
                        m2y = 0.0;
                    }
                }
            } else {
                incomplete -= 1;
            }
            window_start += 1;
        }
        let mut rebuild = i % period == 0;
        loop {
            if rebuild {
                // Every moment again from the window, anchored on its first
                // complete pair.
                (anchor_x, anchor_y) = (window_start..window_end)
                    .find(|&k| complete(k))
                    .map_or((0.0, 0.0), |k| (x[k], y[k]));
                count = 0;
                (mean_x, mean_y, m2x, m2y, cxy) = (0.0, 0.0, 0.0, 0.0, 0.0);
                (gross_x, gross_y) = (0.0, 0.0);
                for k in window_start..window_end {
                    if !complete(k) {
                        continue;
                    }
                    let su = x[k] - anchor_x;
                    let sv = y[k] - anchor_y;
                    gross_x += su * su;
                    gross_y += sv * sv;
                    count += 1;
                    let c = count as f64;
                    let dx = su - mean_x;
                    let dy = sv - mean_y;
                    mean_x += dx / c;
                    mean_y += dy / c;
                    m2x += dx * (su - mean_x);
                    m2y += dy * (sv - mean_y);
                    cxy += dx * (sv - mean_y);
                }
            }
            if window_end - window_start < period || incomplete > 0 {
                if i >= start {
                    let k = i - start;
                    (cov[k], var_x[k], var_y[k]) = (f64::NAN, f64::NAN, f64::NAN);
                }
                break;
            }
            // A column that never changes has moments of exactly 0.
            let flat_x = changes_x == 0;
            let flat_y = changes_y == 0;
            if !rebuild
                && ((!flat_x && m2x < RELATIVE_MOMENT_FLOOR * gross_x)
                    || (!flat_y && m2y < RELATIVE_MOMENT_FLOOR * gross_y)
                    || cxy * cxy > m2x * m2y * CAUCHY_SCHWARZ_SLACK)
            {
                // Ill-conditioned, not flat: fit this window again.
                rebuild = true;
                continue;
            }
            // Rows before the stretch only set up the state (an on-demand
            // rebuild there carries forward, so it runs above as well).
            if i < start {
                break;
            }
            let k = i - start;
            let c = count as f64;
            cov[k] = if flat_x || flat_y { 0.0 } else { cxy / c };
            var_x[k] = if flat_x { 0.0 } else { m2x / c };
            var_y[k] = if flat_y { 0.0 } else { m2y / c };
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stretches started at any row give the bits of one sweep, on columns
    /// with gaps, flat runs, plateau steps and a large offset.
    #[test]
    fn stretches_give_the_same_bits_as_one_sweep() {
        let n = 3_000;
        let wave = |i: usize, k: usize| match i % 89 {
            7 => f64::NAN,
            20..=35 => 1e9,
            36..=50 => 5.0,
            _ => 1e9 + ((i * k) % 101) as f64 / 7.0,
        };
        let x: Vec<f64> = (0..n).map(|i| wave(i, 7919)).collect();
        let y: Vec<f64> = (0..n).map(|i| wave(i + 3, 6007) * 0.5).collect();
        let bits = |v: &[f64]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        for period in [2, 3, 14, 50] {
            let whole = {
                let (mut c, mut a, mut b) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
                bivariate_into(&x, &y, period, 0, &mut c, &mut a, &mut b);
                (c, a, b)
            };
            for chunk in [1, 7, 64, 1000] {
                let (mut c, mut a, mut b) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
                for s in (0..n).step_by(chunk) {
                    let e = (s + chunk).min(n);
                    bivariate_into(&x, &y, period, s, &mut c[s..e], &mut a[s..e], &mut b[s..e]);
                }
                assert_eq!(bits(&whole.0), bits(&c), "cov {period} {chunk}");
                assert_eq!(bits(&whole.1), bits(&a), "varX {period} {chunk}");
                assert_eq!(bits(&whole.2), bits(&b), "varY {period} {chunk}");
            }
        }
    }
}
