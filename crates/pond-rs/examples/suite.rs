//! pond-rs side of the six-engine benchmark suite in `bench/suite/`.
//!
//!     cargo run --release -p pond-rs --example suite [rows]
//!
//! The data and the cases are described in `bench/suite/README.md`; every
//! runner there builds the same series from the same formulas and makes the
//! same calls. One line is printed per case:
//!
//!     RESULT <tab> case id <tab> median ms <tab> rows out <tab> sum
//!
//! where `sum` is the total of every present value in the result's number
//! columns. `bench/suite/collect.py` compares rows and sums across engines.
//!
//! Timing: one warm-up call, then the median of 7.

use std::time::Instant;

use pond_rs::{
    Agg, Align, AlignMethod, Alignment, Column, ColumnData, Fill, FillLimits, Join, JoinType, Keep,
    Pivot, Reducer, Rolling, RollingOver, Sequence, TimeSeries, col,
};

fn value(i: usize) -> Option<f64> {
    (i % 17 != 5).then(|| ((i * 7919) % 10_007) as f64 / 8.0)
}

fn hosts() -> Vec<String> {
    (0..8).map(|h| format!("host-{h}")).collect()
}

/// `v` and `host` on the given times: the series most cases use.
fn series(name: &str, rows: usize, time: impl Fn(i64) -> i64) -> TimeSeries {
    let names = hosts();
    TimeSeries::new(
        name,
        (0..rows as i64).map(time).collect(),
        vec![
            Column::optional("v", (0..rows).map(value).collect::<Vec<_>>()),
            Column::required(
                "host",
                (0..rows)
                    .map(|i| names[(i / 90) % 8].as_str())
                    .collect::<Vec<_>>(),
            ),
        ],
    )
    .unwrap()
}

fn checksum(s: &TimeSeries) -> (usize, f64) {
    let mut sum = 0.0;
    for c in s.columns() {
        if let ColumnData::Number(v) = c.data() {
            sum += v.iter().flatten().sum::<f64>();
        }
    }
    (s.len(), sum)
}

fn main() -> pond_rs::Result<()> {
    let rows: usize = std::env::args()
        .nth(1)
        .map_or(1_000_000, |s| s.parse().expect("rows"));
    let only: Option<String> = std::env::args().nth(2);

    // Even one-second steps.
    let even = series("even", rows, |i| i * 1000);
    // The same rows a few milliseconds off the second, for `align`.
    let uneven = series("uneven", rows, |i| i * 1000 + (i % 7) * 13);
    // Every tenth time repeated, for `dedupe`.
    let repeats = series("repeats", rows, |i| (i - i / 10) * 1000);
    // The right-hand side of the join: every third time matches.
    let names = hosts();
    let other = TimeSeries::new(
        "other",
        (0..rows as i64).map(|i| i * 1500).collect(),
        vec![
            Column::optional("w", (0..rows).map(|i| value(i + 1)).collect::<Vec<_>>()),
            Column::required(
                "tag",
                (0..rows)
                    .map(|i| names[((i + 1) / 90) % 8].as_str())
                    .collect::<Vec<_>>(),
            ),
        ],
    )?;
    // 100 hosts per time, two number columns: for `pivot` and the sum of
    // two columns.
    let wide = TimeSeries::new(
        "wide",
        (0..rows).map(|i| (i / 100) as i64 * 1000).collect(),
        vec![
            Column::required(
                "host",
                (0..rows)
                    .map(|i| format!("h{}", ((i % 100) * 37) % 100))
                    .collect::<Vec<String>>(),
            ),
            Column::optional("v", (0..rows).map(value).collect::<Vec<_>>()),
            Column::optional("w", (0..rows).map(|i| value(i + 3)).collect::<Vec<_>>()),
        ],
    )?;

    let avg = [Agg::new("out", "v", Reducer::Avg)];
    let stdev = [Agg::new("out", "v", Reducer::Stdev)];
    let minute = Sequence::every("1m")?;
    let second = Sequence::every("1s")?;
    let trailing = || Rolling {
        alignment: Alignment::Trailing,
        ..Rolling::default()
    };
    let linear = || Align {
        method: AlignMethod::Linear,
        ..Align::default()
    };
    let none = FillLimits::none();
    let add = col("v").add(col("w"));

    type Case<'a> = (&'a str, Box<dyn Fn() -> TimeSeries + 'a>);
    let cases: Vec<Case> = vec![
        (
            "agg_1m",
            Box::new(|| even.aggregate(&minute, &avg).unwrap()),
        ),
        ("roll_5m", Box::new(|| even.rolling("5m", &avg).unwrap())),
        (
            "roll_20",
            Box::new(|| even.rolling_rows(20, &avg, trailing()).unwrap()),
        ),
        (
            "roll_20_sd",
            Box::new(|| even.rolling_rows(20, &stdev, trailing()).unwrap()),
        ),
        (
            "roll_20_host",
            Box::new(|| {
                even.partition_by(&["host"])
                    .unwrap()
                    .rolling_rows(20, &avg, trailing())
                    .unwrap()
                    .collect()
                    .unwrap()
            }),
        ),
        (
            "roll_grid",
            Box::new(|| {
                even.rolling_over(&second, "5m", &avg, RollingOver::default())
                    .unwrap()
            }),
        ),
        ("diff", Box::new(|| even.diff(&["v"]).unwrap())),
        (
            "fill",
            Box::new(|| even.fill_all_with(Fill::Linear, &none).unwrap()),
        ),
        (
            "cumsum",
            Box::new(|| even.cumulative(&[("v", Reducer::Sum)]).unwrap()),
        ),
        (
            "filter",
            Box::new(|| even.filter_expr(&col("v").gt(500)).unwrap()),
        ),
        (
            "add",
            Box::new(|| wide.with_column_expr("out", &add).unwrap()),
        ),
        (
            "align_hold",
            Box::new(|| uneven.align(&second, Align::default()).unwrap()),
        ),
        (
            "align_linear",
            Box::new(|| uneven.align(&second, linear()).unwrap()),
        ),
        ("dedupe", Box::new(|| repeats.dedupe(Keep::Last).unwrap())),
        (
            "join_left",
            Box::new(|| {
                even.join(
                    &other,
                    Join {
                        how: JoinType::Left,
                        ..Join::default()
                    },
                )
                .unwrap()
            }),
        ),
        (
            "pivot",
            Box::new(|| wide.pivot_by_group("host", "v", &Pivot::default()).unwrap()),
        ),
    ];

    for (id, f) in &cases {
        if only.as_deref().is_some_and(|o| o != *id) {
            continue;
        }
        let out = f();
        let (n, sum) = checksum(&out);
        drop(out);
        let mut t: Vec<f64> = (0..7)
            .map(|_| {
                let s = Instant::now();
                std::hint::black_box(f());
                s.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        t.sort_by(f64::total_cmp);
        println!("RESULT\t{id}\t{:.3}\t{n}\t{sum}", t[3]);
    }
    Ok(())
}
