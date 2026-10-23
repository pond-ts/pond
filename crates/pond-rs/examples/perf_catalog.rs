//! Every catalog study at its defaults (the catalog's examples where an
//! option has none) on 1M bars, timed (median of 7) and hashed (every bit
//! of every number column, a gap as one fixed value), one JSON line per
//! study. `bench/catalog_pond_ts.mjs` is the pond-ts side, same data;
//! `bench/catalog_table.py` joins the two.
//!
//!     cargo run --release -p pond-rs --example perf_catalog [name prefix]
//!     RAYON_NUM_THREADS=1 cargo run --release ...   (one core)

use std::time::Instant;

use pond_rs::financial::catalog::{ParamKind, STUDIES, StudyAnchor, StudyDescriptor};
use pond_rs::financial::{SessionAnchor, SessionRules, TradingCalendar};
use pond_rs::{Column, TimeSeries};
use serde_json::{Map, Value, json};

fn price(i: usize) -> f64 {
    100.0 + ((i * 7919) % 10_007) as f64 / 800.0
}

fn bars(rows: usize) -> TimeSeries {
    let spread = |i: usize| ((i * 31) % 97) as f64 / 100.0 + 0.1;
    let col = |f: &dyn Fn(usize) -> f64| (0..rows).map(f).collect::<Vec<f64>>();
    TimeSeries::new(
        "bars",
        (0..rows as i64).map(|i| i * 60_000).collect(),
        vec![
            Column::required("open", col(&|i| price(i + 1))),
            Column::required("high", col(&|i| price(i) + spread(i))),
            Column::required("low", col(&|i| price(i) - spread(i))),
            Column::required("close", col(&|i| price(i))),
            Column::required("volume", col(&|i| 1000.0 + ((i * 7919) % 997) as f64)),
            Column::required(
                "bench",
                col(&|i| 50.0 + ((i * 104_729) % 10_009) as f64 / 400.0),
            ),
        ],
    )
    .unwrap()
}

/// Defaults, plus the catalog's example for each option that has none.
fn options(d: &StudyDescriptor) -> Map<String, Value> {
    let mut o = Map::new();
    for input in d.inputs {
        if input.default.is_none() {
            o.insert(input.role.into(), json!("bench"));
        }
    }
    for p in d.params {
        if p.optional {
            continue;
        }
        match p.kind {
            ParamKind::Number {
                default: None,
                example: Some(e),
                ..
            } => {
                o.insert(p.name.into(), json!(e));
            }
            ParamKind::Enum {
                default: None,
                example: Some(e),
                ..
            } => {
                o.insert(p.name.into(), json!(e));
            }
            _ => {}
        }
    }
    if d.anchor == Some(StudyAnchor::Time) {
        o.insert("anchor".into(), json!(500_000i64 * 60_000));
    }
    o
}

/// FNV-1a over every row of every number column (the same hash as the
/// pond-ts side).
fn bits_hash(s: &TimeSeries) -> u64 {
    const GAP: u64 = 0x7ff8_dead_0000_0000;
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for column in s.columns() {
        let Ok(numbers) = column.numbers() else {
            continue;
        };
        for i in 0..numbers.len() {
            h ^= numbers.get(i).map_or(GAP, f64::to_bits);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

fn main() -> pond_rs::Result<()> {
    let only = std::env::args().nth(1);
    let bars = bars(1_000_000);
    let nyse = SessionRules::new("America/New_York", "09:30", "16:00");
    let calendar = TradingCalendar::from_rules(&nyse, "1969-12-31", "1971-12-31")?;
    for d in STUDIES {
        if only.as_deref().is_some_and(|o| !d.name.starts_with(o)) {
            continue;
        }
        let o = options(d);
        let run = || match d.anchor {
            Some(StudyAnchor::Session) => d.run_with(&bars, &o, SessionAnchor::from(&calendar)),
            _ => d.run(&bars, &o),
        };
        let mut out = run()?;
        let mut t: Vec<f64> = (0..7)
            .map(|_| {
                let s = Instant::now();
                out = std::hint::black_box(run().unwrap());
                s.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        t.sort_by(f64::total_cmp);
        println!(
            "{}",
            json!({ "study": d.name, "ms": t[3], "hash": format!("{:x}", bits_hash(&out)) })
        );
    }
    Ok(())
}
