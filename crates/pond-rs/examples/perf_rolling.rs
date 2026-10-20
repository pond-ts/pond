//! Timing for the rolling options: leading and centred time windows, a
//! minimum row count, windows counted in rows, and windows on a sequence's
//! grid. Same data as `bench/rolling_pond_ts.mjs` for the pond-ts side; both
//! print a checksum per case (present values and their sum) so the answers
//! can be compared.
//!
//!     cargo run --release -p pond-rs --example perf_rolling
//!
//! Cost, for N rows: a time or row window moves forward only, so each row
//! enters and leaves it once (O(N)) and the reducer's window state does the
//! rest (O(1) per row for sum / avg / count / stdev, amortised O(1) for
//! min / max, O(W) for a median over W rows). A grid window is found with
//! two cursors (O(N + B) for B buckets), then reduced as `aggregate`
//! reduces a bucket, so it costs the rows each window holds: O(B·W).
//! pond-ts scans every row for every bucket there (O(B·N)), so its grid
//! case runs on 100k rows here, not 1M.

use std::time::Instant;

use pond_rs::{Agg, Alignment, Column, Reducer, Rolling, RollingOver, Sequence, TimeSeries};

fn median_ms(mut f: impl FnMut() -> TimeSeries) -> (f64, TimeSeries) {
    let out = f();
    let mut t: Vec<f64> = (0..7)
        .map(|_| {
            let s = Instant::now();
            std::hint::black_box(f());
            s.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    t.sort_by(f64::total_cmp);
    (t[3], out)
}

/// Present values in column `out`, and their sum.
fn checksum(s: &TimeSeries) -> (usize, f64) {
    let v = s.column("out").unwrap().numbers().unwrap();
    let present: Vec<f64> = v.iter().flatten().collect();
    (present.len(), present.iter().sum())
}

fn make(rows: usize) -> TimeSeries {
    let time = (0..rows as i64).map(|i| i * 1000).collect();
    let v: Vec<Option<f64>> = (0..rows)
        .map(|i| (i % 17 != 5).then(|| ((i * 7919) % 10_007) as f64 / 8.0))
        .collect();
    let hosts: Vec<String> = (0..8).map(|h| format!("host-{h}")).collect();
    let host: Vec<&str> = (0..rows).map(|i| hosts[(i / 90) % 8].as_str()).collect();
    TimeSeries::new(
        "bench",
        time,
        vec![Column::optional("v", v), Column::required("host", host)],
    )
    .unwrap()
}

fn main() -> pond_rs::Result<()> {
    let only: Option<String> = std::env::args().nth(1);
    let big = make(1_000_000);
    let small = make(100_000);
    let avg = [Agg::new("out", "v", Reducer::Avg)];
    let stdev = [Agg::new("out", "v", Reducer::Stdev)];
    let at = |alignment, min_samples| Rolling {
        alignment,
        min_samples,
    };
    let minute = Sequence::every("1m")?;
    let second = Sequence::every("1s")?;
    type Case<'a> = (&'a str, Box<dyn Fn() -> TimeSeries + 'a>);
    let cases: Vec<Case> = vec![
        (
            "time 5m avg trailing",
            Box::new(|| big.rolling("5m", &avg).unwrap()),
        ),
        (
            "time 5m avg leading",
            Box::new(|| {
                big.rolling_with("5m", &avg, at(Alignment::Leading, 0))
                    .unwrap()
            }),
        ),
        (
            "time 5m avg centered",
            Box::new(|| {
                big.rolling_with("5m", &avg, at(Alignment::Centered, 0))
                    .unwrap()
            }),
        ),
        (
            "time 5m stdev centered",
            Box::new(|| {
                big.rolling_with("5m", &stdev, at(Alignment::Centered, 0))
                    .unwrap()
            }),
        ),
        (
            "time 5m avg min 300",
            Box::new(|| {
                big.rolling_with("5m", &avg, at(Alignment::Trailing, 300))
                    .unwrap()
            }),
        ),
        (
            "rows 20 avg",
            Box::new(|| {
                big.rolling_rows(20, &avg, at(Alignment::Trailing, 0))
                    .unwrap()
            }),
        ),
        (
            "rows 20 avg min 20",
            Box::new(|| {
                big.rolling_rows(20, &avg, at(Alignment::Trailing, 20))
                    .unwrap()
            }),
        ),
        (
            "rows 20 stdev",
            Box::new(|| {
                big.rolling_rows(20, &stdev, at(Alignment::Trailing, 0))
                    .unwrap()
            }),
        ),
        (
            "rows 300 avg centered",
            Box::new(|| {
                big.rolling_rows(300, &avg, at(Alignment::Centered, 0))
                    .unwrap()
            }),
        ),
        (
            "rows 20 avg by host",
            Box::new(|| {
                big.partition_by(&["host"])
                    .unwrap()
                    .rolling_rows(20, &avg, at(Alignment::Trailing, 0))
                    .unwrap()
                    .collect()
                    .unwrap()
            }),
        ),
        (
            "grid 1m, 5m avg, 100k rows",
            Box::new(|| {
                small
                    .rolling_over(&minute, "5m", &avg, RollingOver::default())
                    .unwrap()
            }),
        ),
        (
            "grid 1m, 5m avg, 1M rows",
            Box::new(|| {
                big.rolling_over(&minute, "5m", &avg, RollingOver::default())
                    .unwrap()
            }),
        ),
        (
            "grid 1s, 5m avg, 1M rows",
            Box::new(|| {
                big.rolling_over(&second, "5m", &avg, RollingOver::default())
                    .unwrap()
            }),
        ),
    ];
    println!("| Case | pond-rs | checksum |");
    println!("| --- | --- | --- |");
    for (name, f) in &cases {
        if only.as_deref().is_some_and(|o| !name.starts_with(o)) {
            continue;
        }
        let (ms, out) = median_ms(f);
        let (n, sum) = checksum(&out);
        println!("| {name} | {ms:.1} ms | {n} {sum:.6e} |");
    }
    Ok(())
}
