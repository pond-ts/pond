//! Huge bar counts in native study options (Codex review R13). A period no
//! window can fill gives gaps (as pond-ts, and as `huge_periods_give_gaps`
//! pins for the moving-average family); a few studies did signed index
//! arithmetic on the period first and panicked, and Ichimoku's offsets
//! flipped sign past i64::MAX. A sweep of every catalog bar option at
//! usize::MAX, isize::MAX + 1 and 2^53 + 2 (with the catalog's 2^53 cap
//! lifted) found these and no others.

use pond_rs::financial::{Aroon, Ichimoku, LinearRegression, Study};
use pond_rs::{Column, TimeSeries};

fn bars() -> TimeSeries {
    TimeSeries::new(
        "bars",
        vec![0, 1000, 2000],
        vec![
            Column::required("high", vec![2.0, 3.0, 4.0]),
            Column::required("low", vec![1.0, 1.5, 2.0]),
            Column::required("close", vec![1.5, 2.5, 3.0]),
        ],
    )
    .unwrap()
}

fn all_gaps(s: &TimeSeries, from: usize) -> bool {
    s.columns()[from..].iter().all(|c| {
        let v = c.numbers().unwrap();
        (0..s.len()).all(|i| v.get(i).is_none())
    })
}

#[test]
fn huge_periods_give_gaps_not_panics() {
    let b = bars();
    let start = b.columns().len();
    for p in [4, usize::MAX, (isize::MAX as usize) + 1, (1 << 53) + 1] {
        let outs = [
            b.linear_regression(LinearRegression::default().period(p)),
            b.time_series_forecast(Study::period(p)),
            b.chande_forecast_oscillator(Study::period(p)),
            b.aroon(Aroon::default().period(p)),
        ];
        for out in outs {
            assert!(all_gaps(&out.unwrap(), start), "{p}");
        }
    }
    // Aroon's window is period + 1 bars: period 2 fits three bars.
    assert!(!all_gaps(
        &b.aroon(Aroon::default().period(2)).unwrap(),
        start
    ));
}

#[test]
fn ichimoku_offsets_keep_their_signs() {
    let d = (1usize << 62) + 3;
    let offsets = Ichimoku::default().displacement(d).offsets().unwrap();
    assert_eq!(offsets[2].1, d as i64);
    assert_eq!(offsets[4].1, -(d as i64));
    for d in [usize::MAX, (isize::MAX as usize) + 1] {
        assert!(
            Ichimoku::default().displacement(d).offsets().is_err(),
            "{d}"
        );
        // The study's values don't depend on the displacement.
        assert!(bars().ichimoku(Ichimoku::default().displacement(d)).is_ok());
    }
}
