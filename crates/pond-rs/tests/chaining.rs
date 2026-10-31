//! The chain-friendly forms: `rolling` with `append`, `diff`/`rate`/
//! `pct_change` with an `output`, the short `fill`/`diff` forms and the
//! one-value folds. Values against pond-ts are pinned by the shared parity
//! fixture (`rolling-append-*`, `*-output*`); these check the refusals and a
//! whole chain.

use pond_rs::financial::Study;
use pond_rs::{
    Agg, Change, Column, ColumnKind, DecimalColumn, Fill, FirstRow, Reducer, Rolling, TimeSeries,
    Value,
};

fn bars() -> TimeSeries {
    let time: Vec<i64> = (0..60).map(|i| i * 60_000).collect();
    let close: Vec<f64> = (0..60)
        .map(|i| {
            if i == 20 {
                f64::NAN
            } else {
                100.0 + (i % 7) as f64
            }
        })
        .collect();
    let host: Vec<&str> = (0..60)
        .map(|i| if i % 2 == 0 { "a" } else { "b" })
        .collect();
    TimeSeries::new(
        "bars",
        time,
        vec![
            Column::optional("close", close),
            Column::required("host", host),
        ],
    )
    .unwrap()
}

fn names(s: &TimeSeries) -> Vec<String> {
    s.schema().into_iter().map(|c| c.name).collect()
}

#[test]
fn a_whole_chain_keeps_every_column_it_names() {
    let out = bars()
        .fill(&[("close", Fill::Linear)])
        .unwrap()
        .rsi(Study::period(14))
        .unwrap()
        .diff_with(&["rsi"], Change::default().output("rsi_change"))
        .unwrap()
        .rolling_with(
            "10m",
            &[Agg::new("rsi_move", "rsi_change", Reducer::Avg)],
            Rolling {
                append: true,
                ..Rolling::default()
            },
        )
        .unwrap();
    assert_eq!(
        names(&out),
        ["time", "close", "host", "rsi", "rsi_change", "rsi_move"]
    );
    let last5 = out.tail("5m").unwrap();
    let avg = last5.reduce_number("rsi_move", Reducer::Avg).unwrap();
    let by_hand = last5
        .reduce(&[Agg::new("x", "rsi_move", Reducer::Avg)])
        .unwrap()
        .number("x")
        .unwrap();
    assert!(avg.is_some());
    assert_eq!(avg.map(f64::to_bits), by_hand.map(f64::to_bits));
}

#[test]
fn append_matches_the_plain_result_and_keeps_sources() {
    let s = bars();
    let aggs = [Agg::new("avg5", "close", Reducer::Avg)];
    for options in [
        Rolling::default(),
        Rolling {
            min_samples: 3,
            ..Rolling::default()
        },
    ] {
        let plain = s.rolling_rows(5, &aggs, options).unwrap();
        let appended = s
            .rolling_rows(
                5,
                &aggs,
                Rolling {
                    append: true,
                    ..options
                },
            )
            .unwrap();
        assert_eq!(names(&appended), ["time", "close", "host", "avg5"]);
        let a: Vec<_> = appended
            .column("avg5")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .collect();
        let p: Vec<_> = plain
            .column("avg5")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .collect();
        assert_eq!(a, p);
        assert_eq!(
            appended.column("host").unwrap().strings().unwrap().get(1),
            Some("b")
        );
    }
}

#[test]
fn append_refuses_a_taken_name() {
    let s = bars();
    let append = Rolling {
        append: true,
        ..Rolling::default()
    };
    for aggs in [
        vec![Agg::of("close", Reducer::Avg)],
        vec![Agg::new("host", "close", Reducer::Avg)],
        vec![Agg::new("time", "close", Reducer::Avg)],
    ] {
        // The key's own name was refused before append existed.
        let e = s.rolling_with("5m", &aggs, append).unwrap_err().to_string();
        assert!(
            e.contains("already exists") || e.contains("written twice"),
            "{e}"
        );
    }
}

#[test]
fn partition_append_keeps_partition_columns_once() {
    let s = bars();
    let out = s
        .partition_by(&["host"])
        .unwrap()
        .rolling_with(
            "5m",
            &[Agg::new("avg", "close", Reducer::Avg)],
            Rolling {
                append: true,
                ..Rolling::default()
            },
        )
        .unwrap()
        .collect()
        .unwrap();
    assert_eq!(names(&out), ["time", "close", "host", "avg"]);
}

#[test]
fn change_output_keeps_the_source() {
    let s = bars();
    for (op, plain, added) in [
        (
            "diff",
            s.diff(&["close"]),
            s.diff_with(&["close"], Change::default().output("c2")),
        ),
        (
            "rate",
            s.rate(&["close"]),
            s.rate_with(&["close"], Change::default().output("c2")),
        ),
        (
            "pct",
            s.pct_change(&["close"]),
            s.pct_change_with(&["close"], Change::default().output("c2")),
        ),
    ] {
        let (plain, added) = (plain.unwrap(), added.unwrap());
        assert_eq!(names(&added), ["time", "close", "host", "c2"], "{op}");
        assert!(!added.column("c2").unwrap().is_required());
        let a: Vec<_> = added
            .column("c2")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .collect();
        let p: Vec<_> = plain
            .column("close")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .collect();
        assert_eq!(a, p, "{op}");
        let kept: Vec<_> = added
            .column("close")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .collect();
        let orig: Vec<_> = s
            .column("close")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .collect();
        assert_eq!(kept, orig, "{op}");
    }
    let dropped = s
        .diff_with(
            &["close"],
            Change::default().output("c2").first(FirstRow::Drop),
        )
        .unwrap();
    assert_eq!(dropped.len(), s.len() - 1);
}

#[test]
fn change_output_refusals() {
    let s = bars();
    let e = s
        .diff_with(&["close"], Change::default().output("host"))
        .unwrap_err()
        .to_string();
    assert!(e.contains("already exists"), "{e}");
    let e = s
        .diff_with(&["close"], Change::default().output("time"))
        .unwrap_err()
        .to_string();
    assert!(e.contains("already exists"), "{e}");
    let two = s.with_column(Column::required("x", vec![1.0; 60])).unwrap();
    let e = two
        .rate_with(&["close", "x"], Change::default().output("r"))
        .unwrap_err()
        .to_string();
    assert!(e.contains("exactly one source column"), "{e}");
}

#[test]
fn one_value_folds() {
    let s = bars();
    assert_eq!(
        s.reduce_number("close", Reducer::Count).unwrap(),
        Some(59.0)
    );
    assert_eq!(
        s.reduce_value("host", Reducer::First).unwrap(),
        Some(Value::String("a".into()))
    );
    let e = s
        .reduce_number("host", Reducer::First)
        .unwrap_err()
        .to_string();
    assert!(e.contains("reduce_number"), "{e}");
    let empty = s.within(-10, -5).unwrap();
    assert_eq!(empty.reduce_number("close", Reducer::Avg).unwrap(), None);
}

#[test]
fn decimal_diff_output_stays_decimal() {
    // As for the in-place diff, a decimal source gives an exact decimal
    // change (pond-ts has no decimal columns); rate and pct_change give numbers.
    let s = TimeSeries::new(
        "d",
        vec![0, 1_000, 2_000],
        vec![Column::optional(
            "p",
            DecimalColumn::from_options([Some(105), None, Some(110)], 1).unwrap(),
        )],
    )
    .unwrap();
    let d = s.diff_with(&["p"], Change::default().output("dp")).unwrap();
    assert_eq!(d.column("dp").unwrap().kind(), ColumnKind::Decimal);
    let source = s.column("p").unwrap().decimals().unwrap().get(2);
    assert_eq!(d.column("p").unwrap().decimals().unwrap().get(2), source);
    let r = s.rate_with(&["p"], Change::default().output("rp")).unwrap();
    assert_eq!(r.column("rp").unwrap().kind(), ColumnKind::Number);
}

#[test]
fn empty_series_keep_every_column() {
    let empty = bars().within(-10, -5).unwrap();
    let rolled = empty
        .rolling_with(
            "5m",
            &[Agg::new("avg", "close", Reducer::Avg)],
            Rolling {
                append: true,
                ..Rolling::default()
            },
        )
        .unwrap();
    assert_eq!(rolled.len(), 0);
    assert_eq!(names(&rolled), ["time", "close", "host", "avg"]);
    let changed = empty
        .diff_with(
            &["close"],
            Change::default().output("dc").first(FirstRow::Drop),
        )
        .unwrap();
    assert_eq!(names(&changed), ["time", "close", "host", "dc"]);
}
