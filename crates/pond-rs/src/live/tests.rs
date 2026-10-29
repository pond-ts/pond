//! What the replay fixture (`tests/live_parity.rs`) does not reach: the
//! lookups, JSON, handles and the errors.

use super::*;
use crate::column::{Float64Column, StringColumn};
use crate::series::{IntervalKeys, TimeRangeKeys};
use crate::{Fill, FirstRow, Reducer, Sample};

fn schema() -> Vec<ColumnDef> {
    vec![
        ColumnDef::required("time", ColumnKind::Time),
        ColumnDef::optional("host", ColumnKind::String),
        ColumnDef::optional("cpu", ColumnKind::Number),
    ]
}

fn row(host: &str, cpu: f64) -> Vec<Option<Value>> {
    vec![Some(host.into()), Some(cpu.into())]
}

fn series(options: LiveOptions) -> LiveSeries {
    LiveSeries::with_options("cpu", schema(), options).unwrap()
}

fn begins(events: impl Iterator<Item = LiveEvent>) -> Vec<i64> {
    events.map(|e| e.begin()).collect()
}

#[test]
fn handles_are_copy_and_send() {
    fn send<T: Send>() {}
    fn sync<T: Sync>() {}
    send::<LiveSeries>();
    send::<Node<LiveView>>();
    sync::<Node<LiveAggregation>>();
    send::<Output>();
}

#[test]
fn lookups_on_the_root_and_a_view() {
    let mut live = series(LiveOptions::new());
    for (t, cpu) in [(0, 1.0), (1000, 5.0), (1000, 6.0), (4000, 2.0)] {
        live.push(t, row("a", cpu)).unwrap();
    }
    assert_eq!(live.len(), 4);
    assert_eq!(live.at(-1).map(|e| e.begin()), Some(4000));
    assert_eq!(live.at(4), None);
    assert_eq!(live.at(-5), None);
    assert_eq!(live.bisect(1000), 1);
    assert_eq!(live.bisect(1001), 3);
    assert!(live.includes_key(1000));
    assert!(!live.includes_key(2000));
    assert_eq!(live.at_or_before(2000).map(|e| e.begin()), Some(1000));
    assert_eq!(
        live.at_or_before(1000).unwrap().number("cpu").unwrap(),
        Some(5.0)
    );
    assert_eq!(live.at_or_before(-1), None);
    assert_eq!(live.at_or_after(2000).map(|e| e.begin()), Some(4000));
    assert_eq!(live.at_or_after(4001), None);
    let busy = |e: &LiveEvent| e.number("cpu").ok().flatten() > Some(4.0);
    assert_eq!(live.find(busy).map(|e| e.begin()), Some(1000));
    assert!(live.some(busy));
    assert!(!live.every(busy));
    assert_eq!(live.time_range(), 4000);
    assert_eq!(live.event_rate(), 1.0);

    let v = live.filter(live.root(), busy).unwrap();
    let view = &live[v];
    assert_eq!(begins(view.events()), [1000, 1000]);
    assert_eq!(view.at(-1).unwrap().number("cpu").unwrap(), Some(6.0));
    assert!(view.includes_key(1000));
    assert_eq!(view.at_or_after(0).map(|e| e.begin()), Some(1000));
    assert!(view.every(busy));
    assert_eq!(view.to_time_series().unwrap().len(), 2);

    let one = series(LiveOptions::new());
    assert_eq!((one.time_range(), one.event_rate()), (0, 0.0));
    assert!(one.every(|_| false));
}

#[test]
fn event_values_by_name_and_kind() {
    let mut live = series(LiveOptions::new());
    live.push(0, [Some("a".into()), None]).unwrap();
    let e = live.first().unwrap();
    assert_eq!(e.string("host").unwrap(), Some("a"));
    assert_eq!(e.number("cpu").unwrap(), None);
    assert!(e.number("host").is_err()); // a text column
    assert!(e.value("nope").is_err());
    assert_eq!(e.values().len(), 2);
    assert_eq!(e.schema()[0].name, "time");
}

#[test]
fn a_bad_row_refuses_the_whole_batch_in_every_mode() {
    for mode in [
        OrderingMode::Strict,
        OrderingMode::Drop,
        OrderingMode::Reorder,
    ] {
        let mut live = series(LiveOptions::new().ordering(mode).max_events(2));
        live.watch(live.root(), OutputKind::Event).unwrap();
        live.push(0, row("a", 1.0)).unwrap();
        let bad = live.push_many([
            (1000, row("a", 2.0)),
            (2000, vec![Some("a".into()), Some(f64::NAN.into())]),
        ]);
        assert!(bad.is_err(), "{mode:?}");
        assert_eq!(live.len(), 1, "{mode:?}");
        assert_eq!(live.stats().ingested, 1, "{mode:?}");
    }
}

#[test]
fn rows_are_checked() {
    let mut live = series(LiveOptions::new());
    assert!(live.push(0, [Some("a".into())]).is_err()); // one value short
    assert!(live.push(0, [Some(1.0.into()), None]).is_err()); // number for text
    assert!(
        live.push(EventKey::time_range(0, 5).unwrap(), row("a", 1.0))
            .is_err()
    );
    assert!(live.push(MAX_TIME_MS + 1, row("a", 1.0)).is_err());
    let mut req = LiveSeries::new(
        "r",
        vec![
            ColumnDef::required("time", ColumnKind::Time),
            ColumnDef::required("v", ColumnKind::Number),
        ],
    )
    .unwrap();
    assert!(req.push(0, [None]).is_err());
    assert!(req.push(0, [Some(Value::Number(f64::INFINITY))]).is_err());
    assert!(req.push(0, [Some(1.0.into())]).is_ok());
    assert!(!req.is_empty());
}

#[test]
fn interval_labels_keep_one_kind() {
    let mut live = LiveSeries::new(
        "i",
        vec![
            ColumnDef::required("interval", ColumnKind::Interval),
            ColumnDef::optional("v", ColumnKind::Number),
        ],
    )
    .unwrap();
    live.push(EventKey::interval("a", 0, 10).unwrap(), [None])
        .unwrap();
    assert!(
        live.push(EventKey::interval(1.0, 10, 20).unwrap(), [None])
            .is_err()
    );
    live.push(EventKey::interval("b", 10, 20).unwrap(), [None])
        .unwrap();
    let ts = live.to_time_series().unwrap();
    assert_eq!(ts.len(), 2);
}

#[test]
fn schemas_and_options_are_checked() {
    let decimal = vec![
        ColumnDef::required("time", ColumnKind::Time),
        ColumnDef::optional("d", ColumnKind::Decimal),
    ];
    assert!(LiveSeries::new("x", decimal).is_err());
    assert!(LiveSeries::new("x", vec![ColumnDef::required("v", ColumnKind::Number)]).is_err());
    assert!(LiveSeries::new("x", vec![]).is_err());
    let twice = vec![
        ColumnDef::required("time", ColumnKind::Time),
        ColumnDef::optional("v", ColumnKind::Number),
        ColumnDef::optional("v", ColumnKind::Number),
    ];
    assert!(LiveSeries::new("x", twice).is_err());
    let opts = |o: LiveOptions| LiveSeries::with_options("x", schema(), o).is_ok();
    assert!(!opts(LiveOptions::new().grace_window("1s")));
    assert!(!opts(
        LiveOptions::new()
            .ordering(OrderingMode::Reorder)
            .grace_window("1x")
    ));
    assert!(!opts(
        LiveOptions::new()
            .ordering(OrderingMode::Reorder)
            .grace_window("10s")
            .max_age("5s")
    ));
    assert!(opts(
        LiveOptions::new()
            .ordering(OrderingMode::Reorder)
            .grace_window("5s")
            .max_age("5s")
    ));
}

#[test]
fn handles_belong_to_one_owner() {
    let mut live = series(LiveOptions::new());
    let mut other = series(LiveOptions::new());
    let f = live.filter(live.root(), |_| true).unwrap();
    let g = other.filter(other.root(), |_| true).unwrap();
    assert!(live.get(g).is_err());
    assert!(live.filter(other.root(), |_| true).is_err());
    assert!(live.watch(f, OutputKind::Batch).is_err()); // views have no batch
    assert!(live.watch(f, OutputKind::Event).is_ok());
    assert!(live.watch(f, OutputKind::Event).is_ok()); // twice is once
    let out = live.push(0, row("a", 1.0)).unwrap();
    assert_eq!(out.len(), 1);
    live.unwatch(f, OutputKind::Event).unwrap();
    assert!(live.push(1, row("a", 1.0)).unwrap().is_empty());
    assert!(live.remove(live.root()).is_err());
    live.remove(f).unwrap();
    assert!(live.get(f).is_err());
    assert!(live.remove(f).is_err());
    assert!(live.filter(f, |_| true).is_err());
}

#[test]
#[should_panic(expected = "removed")]
fn indexing_a_removed_node_panics() {
    let mut live = series(LiveOptions::new());
    let f = live.filter(live.root(), |_| true).unwrap();
    live.remove(f).unwrap();
    let _ = &live[f];
}

#[test]
fn removing_a_node_freezes_what_was_built_on_it() {
    let mut live = series(LiveOptions::new());
    let f = live.filter(live.root(), |_| true).unwrap();
    let g = live.filter(f, |_| true).unwrap();
    live.watch(g, OutputKind::Event).unwrap();
    live.push(0, row("a", 1.0)).unwrap();
    live.remove(f).unwrap();
    assert!(live.push(1, row("a", 1.0)).unwrap().is_empty());
    assert_eq!(live[g].len(), 1); // frozen, still readable
    live.remove(g).unwrap(); // its source is already gone
}

#[test]
fn a_late_event_reaches_views_in_key_order() {
    // Both libraries store it at its key position ([PND-LATE]).
    let mut live = series(LiveOptions::new().ordering(OrderingMode::Reorder));
    let f = live.filter(live.root(), |_| true).unwrap();
    live.watch(f, OutputKind::Event).unwrap();
    live.push(0, row("a", 1.0)).unwrap();
    live.push(2000, row("a", 2.0)).unwrap();
    let out = live.push(1000, row("a", 3.0)).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(begins(live[f].events()), [0, 1000, 2000]);
    assert_eq!(begins(live.events()), [0, 1000, 2000]);
}

#[test]
fn clear_empties_views_but_not_buckets() {
    let mut live = series(LiveOptions::new());
    let f = live.filter(live.root(), |_| true).unwrap();
    let a = live
        .aggregate(
            live.root(),
            &Sequence::every("1s").unwrap(),
            &[Agg::of("cpu", Reducer::Sum)],
        )
        .unwrap();
    for t in [0, 500, 1500] {
        live.push(t, row("a", 1.0)).unwrap();
    }
    live.watch(f, OutputKind::Evict).unwrap();
    let out = live.clear();
    assert!(matches!(&out[..], [Output::Evict { events, .. }] if events.len() == 3));
    assert!(live.is_empty() && live[f].is_empty());
    assert_eq!(live[a].len(), 1);
    assert!(live[a].has_open_bucket());
    assert_eq!(live.stats().evicted, 3);
    assert!(live.clear().is_empty());
    let stats = live[a].stats();
    assert_eq!((stats.events_observed, stats.buckets_closed), (3, 1));
    assert_eq!(stats.open_bucket_start, Some(1000));
}

#[test]
fn aggregate_mappings_are_checked() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let every = Sequence::every("1s").unwrap();
    assert!(
        live.aggregate(root, &every, &[Agg::of("nope", Reducer::Sum)])
            .is_err()
    );
    assert!(
        live.aggregate(root, &every, &[Agg::of("host", Reducer::Avg)])
            .is_err()
    );
    let dup = [
        Agg::of("cpu", Reducer::Sum),
        Agg::new("cpu", "cpu", Reducer::Max),
    ];
    assert!(live.aggregate(root, &every, &dup).is_err());
    assert!(
        live.aggregate(root, &every, &[Agg::of("cpu", Reducer::Percentile(101.0))])
            .is_err()
    );
    let a = live
        .aggregate(
            root,
            &every.with_anchor(250),
            &[Agg::of("host", Reducer::Last)],
        )
        .unwrap();
    assert_eq!(live[a].schema()[1].kind, ColumnKind::String);
    live.push(0, row("a", 1.0)).unwrap();
    live.push(300, row("b", 1.0)).unwrap();
    let closed = live[a].closed().unwrap();
    assert_eq!(closed.key().begin(), [-750]); // anchored at 250
    assert_eq!(live[a].snapshot().unwrap().len(), 2);
}

#[test]
fn extreme_anchors_are_refused_or_handled() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let sum = [Agg::new("cpu", "cpu", Reducer::Sum)];
    // Bucket edges that do not fit an i64 are refused up front.
    let far = Sequence::every("1s").unwrap().with_anchor(i64::MIN);
    assert!(live.aggregate(root, &far, &sum).is_ok());
    // The earliest supported time would fall in a bucket starting one
    // i64::MAX step before the anchor, below i64::MIN.
    let huge = Sequence::every_ms(i64::MAX)
        .unwrap()
        .with_anchor(-MAX_TIME_MS + 1);
    assert!(live.aggregate(root, &huge, &sum).is_err());
    // An extreme but representable anchor puts events in the right bucket.
    let a = live.aggregate(root, &far, &sum).unwrap();
    live.push(1_500, row("a", 2.0)).unwrap();
    live.push(2_300, row("a", 3.0)).unwrap();
    // i64::MIN ends in ...808, so bucket edges sit 192 ms past each second.
    assert_eq!(live[a].len(), 1);
    assert_eq!(live[a].at(0).unwrap().begin(), 1_192);
}

#[test]
fn json_in_and_out() {
    let mut live = series(LiveOptions::new());
    live.watch(live.root(), OutputKind::Batch).unwrap();
    let out = live
        .push_json(
            r#"[[0, "a", 1], {"time": "1970-01-01T00:00:01Z", "cpu": 2}, [2000, null, null]]"#,
        )
        .unwrap();
    assert!(matches!(&out[..], [Output::Batch { events, .. }] if events.len() == 3));
    assert_eq!(live.at(1).unwrap().string("host").unwrap(), None);
    assert!(live.push_json(r#"[[3000, 5, 1]]"#).is_err());
    assert!(live.push_json(r#"{"rows": []}"#).is_err());
    assert!(live.push_json("not json").is_err());
    assert_eq!(live.len(), 3);
    let text = live.to_json(RowFormat::Array).unwrap();
    let back = LiveSeries::from_json(&text, LiveOptions::new().max_events(2)).unwrap();
    assert_eq!(back.name(), "cpu");
    assert_eq!(back.schema(), live.schema());
    assert_eq!(begins(back.events()), [1000, 2000]);
    assert!(back.to_json(RowFormat::Array).unwrap().len() < text.len());
}

#[test]
fn view_arguments_are_checked() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let err = |r: Result<Node<LiveView>>| r.unwrap_err().to_string();
    // Unknown, repeated and wrong-kind columns.
    assert!(err(live.diff(root, &["nope"])).contains("nope"));
    assert!(err(live.diff(root, &["cpu", "cpu"])).contains("twice"));
    assert!(err(live.rate(root, &["host"])).contains("host"));
    assert!(err(live.pct_change(root, &[])).contains("at least one"));
    assert!(err(live.cumulative(root, &[("host", Reducer::Sum)])).contains("host"));
    assert!(err(live.cumulative(root, &[("cpu", Reducer::Avg)])).contains("sum, max, min"));
    assert!(err(live.cumulative_with(root, "nope", |a, b| a + b)).contains("nope"));
    assert!(err(live.select(root, &["nope"])).contains("nope"));
    // Fills a live view cannot do, or of the wrong kind.
    assert!(err(live.fill(root, &[("cpu", Fill::Linear)])).contains("later events"));
    assert!(err(live.fill_all(root, Fill::Bfill)).contains("later events"));
    assert!(err(live.fill(root, &[("host", Fill::Zero)])).contains("host"));
    assert!(err(live.fill(root, &[("cpu", Fill::Value("x".into()))])).contains("cpu"));
    assert!(err(live.fill(root, &[("cpu", Fill::Value(f64::NAN.into()))])).contains("cpu"));
    assert!(err(live.fill_all(root, Fill::Value(1.0.into()))).contains("per column"));
    // Samples and windows.
    assert!(err(live.sample(root, Sample::Stride(0))).contains("at least 1"));
    let reservoir = Sample::Reservoir { size: 2, seed: 1 };
    assert!(err(live.sample(root, reservoir)).contains("Stride"));
    assert!(err(live.window_rows(root, 0)).contains("at least 1"));
    assert!(live.window(root, "soon").is_err());
}

#[test]
fn deltas_and_running_values() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let d = live.diff(root, &["cpu"]).unwrap();
    let r = live.rate(root, &["cpu"]).unwrap();
    let p = live
        .pct_change_with(root, &["cpu"], FirstRow::Drop)
        .unwrap();
    let c = live.cumulative(root, &[("cpu", Reducer::Max)]).unwrap();
    let mul = live.cumulative_with(root, "cpu", |a, v| a * v).unwrap();
    live.push(0, row("a", 0.0)).unwrap();
    live.push(0, row("a", 2.0)).unwrap(); // same time: rate gap
    live.push(500, vec![Some("a".into()), None]).unwrap();
    live.push(1000, row("a", 5.0)).unwrap();
    let cpu = |n: Node<LiveView>, live: &LiveSeries| -> Vec<Option<f64>> {
        live[n].events().map(|e| e.number("cpu").unwrap()).collect()
    };
    assert_eq!(cpu(d, &live), [None, Some(2.0), None, None]);
    assert_eq!(cpu(r, &live), [None, None, None, None]);
    // The first row is dropped; 0 before gives a gap.
    assert_eq!(cpu(p, &live), [None, None, None]);
    assert_eq!(cpu(c, &live), [Some(0.0), Some(2.0), Some(2.0), Some(5.0)]);
    assert_eq!(
        cpu(mul, &live),
        [Some(0.0), Some(0.0), Some(0.0), Some(0.0)]
    );
    // The changed columns become optional numbers.
    assert!(!live[d].schema()[2].required);
}

#[test]
fn fills_and_maps() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let zero = live.fill_all(root, Fill::Zero).unwrap();
    let held = live.fill_all_with(root, Fill::Hold, 1).unwrap();
    let text = live
        .fill(root, &[("host", Fill::Value("?".into()))])
        .unwrap();
    let m = live
        .map(root, |e| {
            let cpu = e.number("cpu").unwrap().map(|v| (v / 0.0).into());
            vec![e.value("host").unwrap().cloned(), cpu]
        })
        .unwrap();
    live.push(0, row("a", 1.0)).unwrap();
    live.push(1000, vec![None, None]).unwrap();
    live.push(2000, vec![None, None]).unwrap();
    let col = |n: Node<LiveView>, name: &str, live: &LiveSeries| -> Vec<Option<Value>> {
        live[n]
            .events()
            .map(|e| e.value(name).unwrap().cloned())
            .collect()
    };
    // Zero skips the text column.
    assert_eq!(
        col(zero, "cpu", &live),
        [Some(1.0.into()), Some(0.0.into()), Some(0.0.into())]
    );
    assert_eq!(col(zero, "host", &live), [Some("a".into()), None, None]);
    // A limit of 1 fills the first gap of a run, not the second.
    assert_eq!(
        col(held, "cpu", &live),
        [Some(1.0.into()), Some(1.0.into()), None]
    );
    assert_eq!(col(text, "host", &live)[2], Some("?".into()));
    // map stores an infinite number as a gap.
    assert_eq!(col(m, "cpu", &live), [None, None, None]);
}

#[test]
#[should_panic(expected = "one cell per value column")]
fn a_map_returning_the_wrong_width_panics() {
    let mut live = series(LiveOptions::new());
    live.map(live.root(), |_| vec![None]).unwrap();
    live.push(0, row("a", 1.0)).unwrap();
}

#[test]
fn windows_and_rates() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let w = live.window(root, "2s").unwrap();
    let rows = live.window_rows(root, 2).unwrap();
    let f = live.filter(w, |_| true).unwrap();
    let s = live.select(w, &["cpu"]).unwrap();
    let t = live.sample(root, Sample::Stride(2)).unwrap();
    for t in [0, 1000, 2500, 3000] {
        live.push(t, row("a", 1.0)).unwrap();
    }
    assert_eq!(begins(live[w].events()), [1000, 2500, 3000]);
    assert_eq!(begins(live[rows].events()), [2500, 3000]);
    assert_eq!(begins(live[t].events()), [1000, 3000]);
    // 3 events over a 2 s window.
    assert_eq!(live[w].event_rate().unwrap(), 1.5);
    assert_eq!(live[w].count(), 3);
    // filter and select on a time window keep its span (not its trimming).
    assert_eq!(live[f].event_rate().unwrap(), 4.0 / 2.0);
    assert_eq!(live[s].schema().len(), 2);
    assert!(live[rows].event_rate().is_err());
}

/// Column storage with everything that moves cells around at once: interval
/// keys with text labels, late events inserted mid-buffer, retention, and a
/// two-level view chain mirroring the evictions.
#[test]
fn column_store_keeps_late_interval_events_aligned_through_evictions() {
    let mut live = LiveSeries::with_options(
        "s",
        vec![
            ColumnDef::required("interval", ColumnKind::Interval),
            ColumnDef::optional("cpu", ColumnKind::Number),
        ],
        LiveOptions::new()
            .ordering(OrderingMode::Reorder)
            .max_events(4),
    )
    .unwrap();
    let all = live.filter(live.root(), |_| true).unwrap();
    let up = live
        .filter(all, |e| e.number("cpu").ok().flatten() > Some(0.0))
        .unwrap();
    live.watch(up, OutputKind::Evict).unwrap();
    let key = |l: &str, b: i64| EventKey::interval(l, b, b + 10).unwrap();
    let push = |live: &mut LiveSeries, l: &str, b: i64, cpu: Option<f64>| {
        live.push(key(l, b), [cpu.map(Value::Number)]).unwrap()
    };
    push(&mut live, "a", 0, Some(1.0));
    push(&mut live, "b", 20, Some(-0.0));
    push(&mut live, "c", 40, Some(2.0));
    push(&mut live, "d", 10, Some(3.0)); // late: a, d, b, c
    let labels = |events: Vec<LiveEvent>| -> Vec<String> {
        events
            .iter()
            .map(|e| match e.key().label() {
                Some(Label::String(s)) => s.clone(),
                other => panic!("{other:?}"),
            })
            .collect()
    };
    assert_eq!(labels(live.events().collect()), ["a", "d", "b", "c"]);
    // A fifth event evicts `a`; the chain drops it and says so.
    let out = push(&mut live, "e", 60, None);
    let evicted: Vec<_> = out
        .iter()
        .filter_map(|o| match o {
            Output::Evict { events, .. } => Some(labels(events.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(evicted, [vec!["a".to_string()]]);
    // Late again, between `d` and `b`; the root then evicts `d`.
    let out = push(&mut live, "f", 15, Some(5.0));
    let evicted: Vec<_> = out
        .iter()
        .filter_map(|o| match o {
            Output::Evict { events, .. } => Some(labels(events.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(evicted, [vec!["d".to_string()]]);
    assert_eq!(labels(live.events().collect()), ["f", "b", "c", "e"]);
    assert_eq!(labels(live[all].events().collect()), ["f", "b", "c", "e"]);
    assert_eq!(labels(live[up].events().collect()), ["f", "c"]);
    // Cells stayed with their keys: a gap and a -0 included.
    let ts = live.to_time_series().unwrap();
    let cpu = ts.column("cpu").unwrap().numbers().unwrap();
    let got: Vec<Option<f64>> = (0..4).map(|i| cpu.get(i)).collect();
    assert_eq!(got, [Some(5.0), Some(0.0), Some(2.0), None]);
    assert!(cpu.get(1).unwrap().is_sign_negative());
    assert_eq!(ts.key().begin(), &[15, 20, 40, 60]);
    let at = live.at_or_before(key("c", 40)).unwrap();
    assert_eq!(at.number("cpu").unwrap(), Some(2.0));
    assert!(live.includes_key(key("b", 20)));
    assert!(!live.includes_key(key("a", 0)));
}

#[test]
fn rolling_and_reduce_arguments_are_checked() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let sum = [Agg::of("cpu", Reducer::Sum)];
    let day = Sequence::calendar("day", "UTC").unwrap();
    assert!(Trigger::count(0).is_err());
    assert!(Trigger::every("soon").is_err());
    assert!(Trigger::clock(&day).is_err()); // calendar steps vary in length
    assert!(live.rolling(root, "soon", &sum).is_err());
    assert!(
        live.rolling(root, "5s", &[Agg::of("nope", Reducer::Sum)])
            .is_err()
    );
    assert!(
        live.rolling(root, "5s", &[Agg::of("host", Reducer::Avg)])
            .is_err()
    );
    let opts = RollingOptions::default();
    assert!(live.rolling_rows(root, 0, &sum, &opts).is_err());
    assert!(live.rolling_windows(root, &[], &opts).is_err());
    let dup = [
        RollingWindow::new("1s", &sum),
        RollingWindow::new("2s", &[Agg::of("cpu", Reducer::Max)]),
    ];
    assert!(live.rolling_windows(root, &dup, &opts).is_err());
    let none = History::Limit {
        max_events: Some(0),
        max_age: None,
    };
    assert!(
        live.rolling_with(root, "5s", &sum, &opts.clone().history(none))
            .is_err()
    );
    let bad_age = History::Limit {
        max_events: None,
        max_age: Some("soon".into()),
    };
    assert!(
        live.rolling_with(root, "5s", &sum, &opts.clone().history(bad_age))
            .is_err()
    );
    assert!(live.reduce(root, &[Agg::of("nope", Reducer::Sum)]).is_err());

    // A clock trigger keys its emissions by bucket start, a time: refused
    // on a source keyed by interval (pond-ts emits time keys under the
    // interval schema).
    let mut intervals = LiveSeries::new(
        "i",
        vec![
            ColumnDef::required("interval", ColumnKind::Interval),
            ColumnDef::optional("v", ColumnKind::Number),
        ],
    )
    .unwrap();
    let iroot = intervals.root();
    let v = [Agg::of("v", Reducer::Sum)];
    let clock = Trigger::every("1s").unwrap();
    assert!(intervals.reduce_with(iroot, &v, clock).is_err());
    let clocked = RollingOptions::default().trigger(clock);
    assert!(intervals.rolling_with(iroot, "5s", &v, &clocked).is_err());
    assert!(
        intervals
            .reduce_with(iroot, &v, Trigger::count(2).unwrap())
            .is_ok()
    );
}

#[test]
fn rolling_and_reduce_take_the_sources_pond_ts_allows() {
    // pond-ts: `rolling` on a series, view or aggregation; `reduce` on a
    // series or view; nothing on a reduce or fused rolling windows.
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let sum = [Agg::of("cpu", Reducer::Sum)];
    let opts = RollingOptions::default();
    let view = live.filter(root, |_| true).unwrap();
    let agg = live
        .aggregate(root, &Sequence::every("1s").unwrap(), &sum)
        .unwrap();
    let roll = live.rolling(root, "5s", &sum).unwrap();
    let fused = live
        .rolling_windows(root, &[RollingWindow::new("5s", &sum)], &opts)
        .unwrap();
    let red = live.reduce(root, &sum).unwrap();
    assert!(live.rolling(view, "5s", &sum).is_ok());
    assert!(live.rolling(agg, "5s", &sum).is_ok());
    assert!(live.rolling(roll, "5s", &sum).is_err());
    assert!(live.reduce(view, &sum).is_ok());
    for from in [NodeId::from(agg), roll.into(), fused.into(), red.into()] {
        assert!(live.reduce(from, &sum).is_err());
    }
    assert!(live.filter(roll, |_| true).is_ok());
    assert!(live.filter(fused, |_| true).is_err());
    assert!(live.filter(red, |_| true).is_err());
    assert!(live.window(red, "5s").is_err());
    assert!(
        live.aggregate(fused, &Sequence::every("1s").unwrap(), &sum)
            .is_err()
    );
}

#[test]
fn rolling_and_reduce_counters() {
    let mut live = series(LiveOptions::new().max_events(3));
    let root = live.root();
    let sum = [Agg::of("cpu", Reducer::Sum)];
    let r = live
        .rolling_with(
            root,
            "2s",
            &sum,
            &RollingOptions::default().trigger(Trigger::count(2).unwrap()),
        )
        .unwrap();
    let d = live.reduce(root, &sum).unwrap();
    live.push_many((0..5).map(|i| (i * 1000, row("a", 1.0))))
        .unwrap();
    let rs = live[r].stats();
    assert_eq!(rs.events_observed, 5);
    assert_eq!(rs.emissions, 2);
    assert_eq!(rs.window_size, 3); // 2000, 3000, 4000: [now - 2s, now]
    assert_eq!(live[r].len(), 2);
    let ds = live[d].stats();
    assert_eq!(ds.events_observed, 5);
    assert_eq!(ds.evictions, 2); // root keeps 3
    assert_eq!(ds.buffer_size, 3);
    assert_eq!(ds.emissions, 1); // one per push
    assert_eq!(live[d].value(), vec![Some(Value::from(3.0))]);
}

#[test]
fn calendar_aggregations_keep_times_in_jiff_range() {
    let (lo, hi) = crate::sequence::CALENDAR_RANGE_MS;
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let sum = [Agg::of("cpu", Reducer::Sum)];
    let day = Sequence::calendar("day", "Pacific/Kiritimati").unwrap();
    live.push(lo - 1, row("a", 1.0)).unwrap(); // no calendar node yet
    // Built over an event outside the range: refused.
    assert!(live.aggregate(root, &day, &sum).is_err());
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let d = live.aggregate(root, &day, &sum).unwrap();
    assert!(live.push(lo - 1, row("a", 1.0)).is_err());
    live.push(lo, row("a", 1.0)).unwrap();
    assert!(live.push(hi, row("a", 1.0)).is_err());
    live.push(hi - 1, row("a", 1.0)).unwrap();
    live.remove(d).unwrap();
    live.push(hi, row("a", 1.0)).unwrap(); // the guard goes with the node
}

#[test]
fn a_push_the_partitions_refuse_is_refused_whole() {
    // A value outside the declared groups: pond-ts stores the row in the
    // root and then throws; pond-rs stores nothing.
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let p = live
        .partition_by(root, "host", &PartitionOptions::new().groups(&["a", "b"]))
        .unwrap();
    let err = live
        .push_many([(0, row("a", 1.0)), (1000, row("c", 2.0))])
        .unwrap_err();
    assert!(err.to_string().contains("declared groups"), "{err}");
    assert_eq!(live.len(), 0);
    let a = live[p].partition("a").unwrap();
    assert_eq!(live[a].len(), 0);

    // A partition stricter than the root.
    let mut live = series(LiveOptions::new().ordering(OrderingMode::Reorder));
    let root = live.root();
    let p = live
        .partition_by(
            root,
            "host",
            &PartitionOptions::new().ordering(OrderingMode::Strict),
        )
        .unwrap();
    live.push(1000, row("a", 1.0)).unwrap();
    live.push(500, row("b", 1.0)).unwrap();
    assert!(live.push(800, row("a", 2.0)).is_err());
    assert_eq!(live.len(), 2);
    assert_eq!(live[p].keys(), ["a", "b"]);
    assert_eq!(live[p].stats().events_routed, 2);
}

#[test]
fn declared_groups_alone_are_checked_on_every_row() {
    // Groups and nothing else to check (strict root and partitions; a
    // drop root): each row is tested against the groups, a late row a
    // drop root skips is not.
    for ordering in [OrderingMode::Strict, OrderingMode::Drop] {
        let mut live = series(LiveOptions::new().ordering(ordering));
        let root = live.root();
        let p = live
            .partition_by(
                root,
                "host",
                &PartitionOptions::new()
                    .groups(&["a", "b"])
                    .ordering(OrderingMode::Strict),
            )
            .unwrap();
        live.push_many([(0, row("a", 1.0)), (1000, row("b", 2.0))])
            .unwrap();
        let err = live
            .push_many([(2000, row("b", 3.0)), (3000, row("z", 4.0))])
            .unwrap_err();
        assert!(err.to_string().contains("row 1"), "{err}");
        assert_eq!(live.len(), 2);
        if ordering == OrderingMode::Drop {
            // Late, so skipped before its value is looked at.
            live.push_many([(500, row("z", 5.0)), (4000, row("a", 6.0))])
                .unwrap();
            assert_eq!(live.len(), 3);
            let a = live[p].partition("a").unwrap();
            assert_eq!(live[a].len(), 2);
        }
    }
}

#[test]
fn partition_by_is_checked() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let view = live.filter(root, |_| true).unwrap();
    assert!(
        live.partition_by(view, "host", &PartitionOptions::new())
            .is_err()
    );
    assert!(matches!(
        live.partition_by(root, "nope", &PartitionOptions::new()),
        Err(PondError::UnknownColumn { .. })
    ));
    let empty: [&str; 0] = [];
    for bad in [
        PartitionOptions::new().groups(&empty),
        PartitionOptions::new().groups(&["a", "a"]),
        PartitionOptions::new().grace_window("1s"),
        PartitionOptions::new()
            .ordering(OrderingMode::Reorder)
            .grace_window("5s")
            .max_age("1s"),
    ] {
        assert!(live.partition_by(root, "host", &bad).is_err(), "{bad:?}");
    }
    let p = live
        .partition_by(root, "host", &PartitionOptions::new())
        .unwrap();
    // Built on with per_partition / collect / apply only.
    assert!(live.filter(p, |_| true).is_err());
    assert!(
        live.remove(live[p].partition("a").map_or(root, |n| n.id()))
            .is_err()
    );
}

#[test]
fn typed_lookup_checks_the_node_type() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    assert!(live.node::<SubSeries>(root).is_ok());
    assert!(live.node::<LiveView>(root).is_err());
    let view = live.filter(root, |_| true).unwrap();
    assert_eq!(live.node::<LiveView>(view.id()).unwrap().id(), view.id());
}

#[test]
fn partition_values_are_written_as_pond_ts_writes_them() {
    let schema = vec![
        ColumnDef::required("time", ColumnKind::Time),
        ColumnDef::optional("n", ColumnKind::Number),
    ];
    let mut live = LiveSeries::new("n", schema).unwrap();
    let root = live.root();
    let p = live
        .partition_by(root, "n", &PartitionOptions::new())
        .unwrap();
    for (t, n) in [
        (0, Some(1.0)),
        (1, Some(0.1 + 0.2)),
        (2, None),
        (3, Some(1e21)),
    ] {
        live.push(t, vec![n.map(Value::from)]).unwrap();
    }
    assert_eq!(
        live[p].keys(),
        ["1", "0.30000000000000004", " undefined", "1e+21"]
    );
}

#[test]
fn a_gathered_series_reports_an_order_it_refuses_after_the_push() {
    // Partitions keep reorder (from the root); the gathered series is
    // strict, so a late event reaching it fails the push, but only after
    // the root and its partition took it (as pond-ts throws mid-delivery).
    let mut live = series(LiveOptions::new().ordering(OrderingMode::Reorder));
    let root = live.root();
    let p = live
        .partition_by(root, "host", &PartitionOptions::new())
        .unwrap();
    let all = live
        .collect(p, &CollectOptions::new().ordering(OrderingMode::Strict))
        .unwrap();
    live.push(1000, row("a", 1.0)).unwrap();
    assert!(live.push(500, row("b", 2.0)).is_err());
    assert_eq!(live.len(), 2);
    assert_eq!(live[all].len(), 1);
    // The next push goes through.
    live.push(2000, row("b", 3.0)).unwrap();
    assert_eq!(begins(live[all].events()), [1000, 2000]);
}

#[test]
fn partition_rolling_is_checked() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let p = live
        .partition_by(root, "host", &PartitionOptions::new())
        .unwrap();
    let sum = [Agg::new("cpu", "cpu", Reducer::Sum)];
    let every = RollingOptions::new().trigger(Trigger::every("5s").unwrap());
    // A clock trigger only.
    assert!(
        live.partition_rolling(p, "5s", &sum, &RollingOptions::new())
            .is_err()
    );
    // Not on the root, and not over the partition column.
    assert!(live.partition_rolling(root, "5s", &sum, &every).is_err());
    let clash = [Agg::new("host", "cpu", Reducer::Sum)];
    assert!(matches!(
        live.partition_rolling(p, "5s", &clash, &every),
        Err(PondError::DuplicateOutput { .. })
    ));
    assert!(live.partition_rolling_rows(p, 0, &sum, &every).is_err());
    let r = live.partition_rolling(p, "5s", &sum, &every).unwrap();
    assert!(live.filter(r, |_| true).is_err());
    assert_eq!(live[r].schema()[1].kind, ColumnKind::String);
}

#[test]
fn removing_partition_rolling_unhooks_it() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let p = live
        .partition_by(root, "host", &PartitionOptions::new())
        .unwrap();
    let held = live
        .per_partition(p, |live, part| {
            live.fill(part, &[("cpu", Fill::Hold)]).map(|n| n.id())
        })
        .unwrap();
    let every = RollingOptions::new().trigger(Trigger::every("5s").unwrap());
    let sum = [Agg::new("cpu", "cpu", Reducer::Sum)];
    let r = live.partition_rolling(held, "5s", &sum, &every).unwrap();
    live.watch(r, OutputKind::Event).unwrap();
    live.push(0, row("a", 1.0)).unwrap();
    let out = live.push(5000, row("b", 2.0)).unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(live[r].stats().partitions, 2);
    let nodes = live.slots.len();
    live.remove(r).unwrap();
    assert!(live.get(r).is_err());
    // The fill chains it built went with it; a new partition builds none.
    let removed = live.slots[..nodes]
        .iter()
        .filter(|s| matches!(s.state, State::View(_)))
        .count();
    assert_eq!(removed, 0);
    assert!(live.push(10000, row("c", 3.0)).unwrap().is_empty());
    assert_eq!(live.slots.len(), nodes + 1);
}

#[test]
fn removing_a_partitioned_node_removes_its_chains() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let p = live
        .partition_by(root, "host", &PartitionOptions::new())
        .unwrap();
    let view = live
        .per_partition(p, |live, part| live.filter(part, |_| true).map(|n| n.id()))
        .unwrap();
    live.push(0, row("a", 1.0)).unwrap();
    live.remove(p).unwrap();
    assert!(live.collect(view, &CollectOptions::new()).is_err());
    assert!(live.partition_outputs(view).is_err());
    assert!(
        live.per_partition(view, |live, part| live
            .filter(part, |_| true)
            .map(|n| n.id()))
            .is_err()
    );
    let every = RollingOptions::new().trigger(Trigger::every("5s").unwrap());
    let sum = [Agg::new("cpu", "cpu", Reducer::Sum)];
    assert!(live.partition_rolling(view, "5s", &sum, &every).is_err());
}

#[test]
fn a_push_after_clear_is_checked_against_the_partitions() {
    // The partitions keep what a clear drops from the root, so an event
    // before their latest is refused (pond-ts throws after storing it in
    // the root; pond-rs stores nothing).
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let p = live
        .partition_by(root, "host", &PartitionOptions::new())
        .unwrap();
    live.push(10000, row("a", 1.0)).unwrap();
    live.clear();
    let err = live.push(5000, row("a", 2.0)).unwrap_err();
    assert!(err.to_string().contains("strict order"), "{err}");
    assert_eq!(live.len(), 0);
    let a = live[p].partition("a").unwrap();
    assert_eq!(live[a].len(), 1);
    // Another partition, and later times, still go through.
    live.push(6000, row("b", 2.0)).unwrap();
    live.push(20000, row("a", 3.0)).unwrap();
    assert_eq!(live[a].len(), 2);
    assert_eq!(live.len(), 2);
}

#[test]
fn a_failing_hook_drops_only_its_row() {
    // pond-ts `#routeChunk`: the row whose partition could not be built is
    // dropped, the rest routed, and the push then fails.
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let p = live
        .partition_by(root, "host", &PartitionOptions::new())
        .unwrap();
    live.push(0, row("a", 1.0)).unwrap();
    let gathered = live
        .apply(
            p,
            |live, part| {
                let name = live.node::<SubSeries>(part)?;
                if live[name].name().ends_with("/b") {
                    return Err(PondError::InvalidData {
                        call: "test",
                        message: "no b".into(),
                    });
                }
                live.filter(part, |_| true).map(|n| n.id())
            },
            &CollectOptions::new(),
        )
        .unwrap();
    let err = live
        .push_many([
            (1000, row("a", 2.0)),
            (2000, row("b", 3.0)),
            (3000, row("a", 4.0)),
        ])
        .unwrap_err();
    assert!(err.to_string().contains("no b"), "{err}");
    assert_eq!(live.len(), 4);
    let a = live[p].partition("a").unwrap();
    assert_eq!(live[a].len(), 3);
    assert_eq!(live[gathered].len(), 3);
    // The partition stays, so its later rows reach it.
    let b = live[p].partition("b").unwrap();
    assert_eq!(live[b].len(), 0);
    live.push(4000, row("b", 5.0)).unwrap();
    assert_eq!(live[b].len(), 1);
}

#[test]
fn removing_partition_rolling_removes_its_whole_chain() {
    let mut live = series(LiveOptions::new());
    let root = live.root();
    let p = live
        .partition_by(root, "host", &PartitionOptions::new())
        .unwrap();
    let chain = live
        .per_partition(p, |live, part| {
            let kept = live.filter(part, |_| true)?;
            live.fill(kept, &[("cpu", Fill::Hold)]).map(|n| n.id())
        })
        .unwrap();
    let every = RollingOptions::new().trigger(Trigger::every("5s").unwrap());
    let sum = [Agg::new("cpu", "cpu", Reducer::Sum)];
    let r = live.partition_rolling(chain, "5s", &sum, &every).unwrap();
    live.push(0, row("a", 1.0)).unwrap();
    live.push(1000, row("b", 2.0)).unwrap();
    let views = |live: &LiveSeries| {
        live.slots
            .iter()
            .filter(|s| matches!(s.state, State::View(_)))
            .count()
    };
    assert_eq!(views(&live), 4);
    live.remove(r).unwrap();
    assert_eq!(views(&live), 0);
}

fn numbers(values: Vec<Option<Value>>) -> Vec<Option<f64>> {
    values
        .into_iter()
        .map(|v| match v {
            Some(Value::Number(x)) => Some(x),
            None => None,
            other => panic!("not a number: {other:?}"),
        })
        .collect()
}

#[test]
fn reduce_removes_what_a_window_trims() {
    // Codex review R01: a reduce on a window kept every value the window
    // had ever taken.
    let sum_count = [
        Agg::new("s", "cpu", Reducer::Sum),
        Agg::new("n", "cpu", Reducer::Count),
        Agg::new("lo", "cpu", Reducer::Min),
    ];
    let mut live = series(LiveOptions::new().max_events(3));
    let root = live.root();
    let rows = live.window_rows(root, 2).unwrap();
    let span = live.window(root, "1500ms").unwrap();
    let by_rows = live.reduce(rows, &sum_count).unwrap();
    let by_span = live.reduce(span, &sum_count).unwrap();
    for (t, cpu) in [(1000, 1.0), (2000, 2.0), (3000, 3.0)] {
        live.push(t, row("a", cpu)).unwrap();
    }
    assert_eq!(
        numbers(live[by_rows].value()),
        [Some(5.0), Some(2.0), Some(2.0)]
    );
    assert_eq!(live[by_rows].stats().buffer_size, 2);
    assert_eq!(
        numbers(live[by_span].value()),
        [Some(5.0), Some(2.0), Some(2.0)]
    );
    // The emitted events agree with value().
    let last = live[by_rows].at(-1).unwrap();
    assert_eq!(last.number("s").unwrap(), Some(5.0));
    // Root retention after trims: the root drops 1000 and 2000, the
    // windows had already trimmed 1000 and only lose 2000.
    live.push_many([(4000, row("a", 4.0)), (5000, row("a", 5.0))])
        .unwrap();
    assert_eq!(
        numbers(live[by_rows].value()),
        [Some(9.0), Some(2.0), Some(4.0)]
    );
    assert_eq!(live[by_rows].stats().buffer_size, 2);
    assert_eq!(
        numbers(live[by_span].value()),
        [Some(9.0), Some(2.0), Some(4.0)]
    );
    // Clear empties everything.
    live.clear();
    live.push(6000, row("a", 6.0)).unwrap();
    assert_eq!(
        numbers(live[by_rows].value()),
        [Some(6.0), Some(1.0), Some(6.0)]
    );
    assert_eq!(
        numbers(live[by_span].value()),
        [Some(6.0), Some(1.0), Some(6.0)]
    );
}

#[test]
fn reduce_on_a_window_of_a_reorder_series_removes_late_trims() {
    // A late event older than the window's cutoff is trimmed straight
    // away: the reduce adds and removes it.
    let mut live = series(LiveOptions::new().ordering(OrderingMode::Reorder));
    let root = live.root();
    let w = live.window(root, "1s").unwrap();
    let red = live
        .reduce(
            w,
            &[
                Agg::new("s", "cpu", Reducer::Sum),
                Agg::new("hi", "cpu", Reducer::Max),
                Agg::new("l", "cpu", Reducer::Last),
            ],
        )
        .unwrap();
    for (t, cpu) in [(1000, 1.0), (2000, 2.0), (2500, 3.0), (100, 50.0)] {
        live.push(t, row("a", cpu)).unwrap();
    }
    assert_eq!(begins(live[w].events()), [2000, 2500]);
    assert_eq!(
        numbers(live[red].value()),
        [Some(5.0), Some(3.0), Some(3.0)]
    );
}

#[test]
fn reduce_through_a_view_of_a_reorder_series() {
    // Codex review R02: a reduce on a view of a reorder series used
    // states that only remove the oldest arrival.
    let mut live = series(
        LiveOptions::new()
            .ordering(OrderingMode::Reorder)
            .max_events(2),
    );
    let root = live.root();
    let f = live.filter(root, |_| true).unwrap();
    let g = live.filter(f, |_| true).unwrap();
    let mapping = [
        Agg::new("hi", "cpu", Reducer::Max),
        Agg::new("lo", "cpu", Reducer::Min),
        Agg::new("first", "cpu", Reducer::First),
        Agg::new("last", "cpu", Reducer::Last),
    ];
    let on_f = live.reduce(f, &mapping).unwrap();
    let on_g = live.reduce(g, &mapping).unwrap();
    for (t, cpu) in [(1000, 10.0), (2000, 20.0), (500, 100.0)] {
        live.push(t, row("a", cpu)).unwrap();
    }
    assert_eq!(begins(live[f].events()), [1000, 2000]);
    let want = [Some(20.0), Some(10.0), Some(10.0), Some(20.0)];
    assert_eq!(numbers(live[on_f].value()), want);
    assert_eq!(numbers(live[on_g].value()), want);
}

#[test]
fn reduce_on_windows_over_history_and_rolling() {
    // A window built over history, then a reduce on it.
    let mut live = series(LiveOptions::new());
    let root = live.root();
    for t in [1000, 2000, 3000, 4000] {
        live.push(t, row("a", (t / 1000) as f64)).unwrap();
    }
    let w = live.window_rows(root, 2).unwrap();
    let sum = [Agg::new("s", "cpu", Reducer::Sum)];
    let r = live.reduce(w, &sum).unwrap();
    assert_eq!(numbers(live[r].value()), [Some(7.0)]);
    live.push(5000, row("a", 5.0)).unwrap();
    assert_eq!(numbers(live[r].value()), [Some(9.0)]);
    // A filter on a window keeps what the window trims.
    let f = live.filter(w, |_| true).unwrap();
    let rf = live.reduce(f, &sum).unwrap();
    live.push(6000, row("a", 6.0)).unwrap();
    assert_eq!(live[f].len(), 3);
    assert_eq!(numbers(live[rf].value()), [Some(15.0)]);

    // Rolling of a reorder series: a late event comes out keyed in the
    // past, so a window over the rolling output trims by key order.
    let mut live = series(LiveOptions::new().ordering(OrderingMode::Reorder));
    let root = live.root();
    let ro = live
        .rolling(root, "10s", &[Agg::new("cpu", "cpu", Reducer::Max)])
        .unwrap();
    let w = live.window_rows(ro, 2).unwrap();
    let r = live
        .reduce(
            w,
            &[
                Agg::new("hi", "cpu", Reducer::Max),
                Agg::new("lo", "cpu", Reducer::Min),
                Agg::new("last", "cpu", Reducer::Last),
            ],
        )
        .unwrap();
    for (t, cpu) in [(1000, 1.0), (2000, 2.0), (500, 7.0)] {
        live.push(t, row("a", cpu)).unwrap();
    }
    let held: Vec<f64> = live[w]
        .events()
        .map(|e| e.number("cpu").unwrap().unwrap())
        .collect();
    assert_eq!(held.len(), 2);
    let hi = held.iter().cloned().fold(f64::MIN, f64::max);
    let lo = held.iter().cloned().fold(f64::MAX, f64::min);
    assert_eq!(numbers(live[r].value()), [Some(hi), Some(lo), Some(2.0)]);
}

// ── push_series: a batch series pushed as one batch ──

/// A `Vec<Option<Value>>` row as a batch column cell.
fn chunk(rows: &[(i64, &str, Option<f64>, Option<f64>)]) -> TimeSeries {
    let time = rows.iter().map(|r| r.0).collect();
    let host = StringColumn::from_options(rows.iter().map(|r| Some(r.1)));
    let cpu = Float64Column::from_options(rows.iter().map(|r| r.2));
    let mem = Float64Column::from_options(rows.iter().map(|r| r.3));
    TimeSeries::new(
        "chunk",
        time,
        vec![
            Column::optional("host", host),
            Column::optional("cpu", cpu),
            Column::optional("mem", mem),
        ],
    )
    .unwrap()
}

fn wide_schema() -> Vec<ColumnDef> {
    vec![
        ColumnDef::required("time", ColumnKind::Time),
        ColumnDef::optional("host", ColumnKind::String),
        ColumnDef::optional("cpu", ColumnKind::Number),
        ColumnDef::optional("mem", ColumnKind::Number),
    ]
}

type WideRow = (i64, &'static str, Option<f64>, Option<f64>);

/// The rows of one session: in order, then (from 7000 on) a late batch
/// whose first rows are behind the tail, one at the tail, and a tail of
/// in-order rows.
const WIDE_ROWS: [WideRow; 12] = [
    (0, "a", Some(1.0), Some(10.0)),
    (1000, "b", Some(2.0), None),
    (2000, "a", None, Some(12.0)),
    (3000, "c", Some(4.0), Some(13.0)),
    (4000, "a", Some(5.0), Some(14.0)),
    (5000, "b", Some(6.0), Some(15.0)),
    (2500, "a", Some(99.0), Some(1.0)),
    (4500, "b", Some(98.0), Some(2.0)),
    (5000, "c", Some(97.0), Some(3.0)),
    (6000, "a", Some(7.0), Some(16.0)),
    (7000, "b", Some(8.0), Some(17.0)),
    (8000, "c", Some(9.0), Some(18.0)),
];

/// Outputs with the owner taken out of the node id, so two sessions
/// built the same way compare equal.
fn flat(out: &[Output]) -> Vec<String> {
    out.iter()
        .map(|o| {
            format!("{} {:?}", o.node().index, o)
                .replace(&format!("owner: {}, ", o.node().owner), "")
        })
        .collect()
}

/// `WIDE_ROWS` cut into batches a batch series can hold (each in key
/// order): the late batch on its own, every row alone, and the in-order
/// rows in one batch with the late ones after.
fn batches() -> Vec<Vec<&'static [WideRow]>> {
    let r = &WIDE_ROWS;
    vec![
        vec![&r[0..3], &r[3..6], &r[6..9], &r[9..12]],
        r.chunks(1).collect(),
        vec![&r[0..6], &r[6..9], &r[9..10], &r[10..12]],
    ]
}

/// Build the same tree on two sessions, push `batches` as rows into one
/// and as a batch series into the other, and expect the same outputs,
/// rows and stats (and the same errors).
fn same_as_push_many(options: LiveOptions, batches: &[&[WideRow]], build: bool) {
    let mut by_rows = LiveSeries::with_options("cpu", wide_schema(), options.clone()).unwrap();
    let mut by_series = LiveSeries::with_options("cpu", wide_schema(), options).unwrap();
    let tree = |live: &mut LiveSeries| {
        let root = live.root();
        for kind in [OutputKind::Event, OutputKind::Batch, OutputKind::Evict] {
            live.watch(root, kind).unwrap();
        }
        let f = live
            .filter(root, |e| e.number("cpu").unwrap().is_some_and(|v| v > 2.0))
            .unwrap();
        live.watch(f, OutputKind::Event).unwrap();
        let r = live
            .rolling(root, "2s", &[Agg::of("cpu", Reducer::Avg)])
            .unwrap();
        live.watch(r, OutputKind::Event).unwrap();
        let d = live.reduce(f, &[Agg::of("mem", Reducer::Max)]).unwrap();
        live.watch(d, OutputKind::Event).unwrap();
        (f, r, d)
    };
    let nodes = build.then(|| (tree(&mut by_rows), tree(&mut by_series)));
    for &batch in batches {
        let a = by_rows.push_many(batch.iter().map(|&(t, host, cpu, mem)| {
            (
                t,
                vec![
                    Some(Value::String(host.into())),
                    cpu.map(Value::Number),
                    mem.map(Value::Number),
                ],
            )
        }));
        let b = by_series.push_series(&chunk(batch));
        match (a, b) {
            (Ok(a), Ok(b)) => assert_eq!(flat(&a), flat(&b), "outputs of {batch:?}"),
            (Err(a), Err(b)) => assert_eq!(a.to_string(), b.to_string()),
            (a, b) => panic!("push_many {a:?} vs push_series {b:?}"),
        }
    }
    assert_eq!(by_rows.stats(), by_series.stats());
    assert_eq!(
        by_rows.to_time_series().unwrap(),
        by_series.to_time_series().unwrap()
    );
    if let Some((a, b)) = nodes {
        assert_eq!(
            by_rows[a.0].to_time_series().unwrap(),
            by_series[b.0].to_time_series().unwrap()
        );
        let rows = |e: &mut dyn Iterator<Item = LiveEvent>| e.collect::<Vec<_>>();
        assert_eq!(
            rows(&mut by_rows[a.1].events()),
            rows(&mut by_series[b.1].events())
        );
        assert_eq!(
            rows(&mut by_rows[a.2].events()),
            rows(&mut by_series[b.2].events())
        );
    }
}

#[test]
fn push_series_is_push_many_in_every_mode() {
    let modes = [
        LiveOptions::new(),
        LiveOptions::new().ordering(OrderingMode::Drop),
        LiveOptions::new().ordering(OrderingMode::Reorder),
        LiveOptions::new()
            .ordering(OrderingMode::Reorder)
            .grace_window("1s"),
        LiveOptions::new().max_events(4),
        LiveOptions::new()
            .ordering(OrderingMode::Drop)
            .max_events(5),
        LiveOptions::new()
            .ordering(OrderingMode::Reorder)
            .max_events(5),
        LiveOptions::new()
            .ordering(OrderingMode::Reorder)
            .max_age("3s"),
    ];
    for options in modes {
        for batches in batches() {
            for build in [false, true] {
                same_as_push_many(options.clone(), &batches, build);
            }
        }
    }
}

#[test]
fn push_series_takes_columns_in_any_order_and_empty() {
    let mut live = LiveSeries::new("cpu", wide_schema()).unwrap();
    let swapped = TimeSeries::new(
        "chunk",
        vec![0, 1000],
        vec![
            Column::optional("mem", Float64Column::from_options([Some(1.0), None])),
            Column::optional("cpu", Float64Column::from_options([Some(2.0), Some(3.0)])),
            Column::optional("host", StringColumn::from_options([Some("a"), None])),
        ],
    )
    .unwrap();
    assert!(live.push_series(&swapped).unwrap().is_empty());
    assert_eq!(live.len(), 2);
    assert_eq!(live.at(1).unwrap().number("cpu").unwrap(), Some(3.0));
    assert_eq!(live.at(1).unwrap().string("host").unwrap(), None);
    assert_eq!(live.at(0).unwrap().number("mem").unwrap(), Some(1.0));
    let empty = chunk(&[]);
    assert!(live.push_series(&empty).unwrap().is_empty());
    assert_eq!(live.len(), 2);
}

#[test]
fn push_series_checks_the_shape_and_the_rows() {
    let err = |live: &mut LiveSeries, s: TimeSeries| live.push_series(&s).unwrap_err().to_string();
    let mut live = LiveSeries::new("cpu", wide_schema()).unwrap();
    let col =
        |name: &str, v: Vec<Option<f64>>| Column::optional(name, Float64Column::from_options(v));
    let host = |v: Vec<Option<&str>>| Column::optional("host", StringColumn::from_options(v));
    // Key kind.
    let ranges = TimeSeries::from_time_ranges(
        "r",
        TimeRangeKeys {
            begin: vec![0],
            end: vec![1000],
        },
        vec![
            host(vec![Some("a")]),
            col("cpu", vec![Some(1.0)]),
            col("mem", vec![None]),
        ],
    )
    .unwrap();
    assert!(err(&mut live, ranges).contains("keyed by timeRange, but this live series by time"));
    // Missing, extra, wrong kind.
    let missing = TimeSeries::new(
        "c",
        vec![0],
        vec![host(vec![Some("a")]), col("cpu", vec![Some(1.0)])],
    )
    .unwrap();
    assert!(
        err(&mut live, missing)
            .contains("column 'mem' is missing from the series (it has: host, cpu)")
    );
    let extra = TimeSeries::new(
        "c",
        vec![0],
        vec![
            host(vec![Some("a")]),
            col("cpu", vec![Some(1.0)]),
            col("mem", vec![None]),
            col("disk", vec![None]),
        ],
    )
    .unwrap();
    assert!(err(&mut live, extra).contains("columns this live series does not: disk"));
    let wrong = TimeSeries::new(
        "c",
        vec![0],
        vec![
            host(vec![Some("a")]),
            Column::optional("cpu", StringColumn::from_options([Some("high")])),
            col("mem", vec![None]),
        ],
    )
    .unwrap();
    assert!(
        err(&mut live, wrong)
            .contains("'cpu': the series has a string column, this live series takes number")
    );
    // A gap in a required column names the row.
    let mut strict = LiveSeries::new(
        "v",
        vec![
            ColumnDef::required("time", ColumnKind::Time),
            ColumnDef::required("v", ColumnKind::Number),
        ],
    )
    .unwrap();
    let gappy = TimeSeries::new(
        "c",
        vec![0, 1000, 2000],
        vec![col("v", vec![Some(1.0), None, Some(2.0)])],
    )
    .unwrap();
    assert!(err(&mut strict, gappy).contains("row 1: column 'v' is required"));
    assert_eq!(strict.len(), 0, "all or nothing");
    // A late row under strict ordering refuses the batch, as push_many.
    live.push(5000, vec![Some("a".into()), Some(1.0.into()), None])
        .unwrap();
    let late = chunk(&[(4000, "a", Some(1.0), None), (6000, "a", Some(1.0), None)]);
    let e = err(&mut live, late);
    assert!(e.contains("row 0"), "{e}");
    assert_eq!(live.len(), 1);
    // Interval labels keep one kind.
    let mut by_label = LiveSeries::new(
        "i",
        vec![
            ColumnDef::required("key", ColumnKind::Interval),
            ColumnDef::optional("v", ColumnKind::Number),
        ],
    )
    .unwrap();
    let numbered = TimeSeries::from_intervals(
        "c",
        IntervalKeys {
            label: vec![1.0].into(),
            begin: vec![0],
            end: vec![1000],
        },
        vec![col("v", vec![Some(1.0)])],
    )
    .unwrap();
    by_label.push_series(&numbered).unwrap();
    let texted = TimeSeries::from_intervals(
        "c",
        IntervalKeys {
            label: vec!["x"].into(),
            begin: vec![1000],
            end: vec![2000],
        },
        vec![col("v", vec![Some(1.0)])],
    )
    .unwrap();
    let e = err(&mut by_label, texted);
    assert!(e.contains("numbers or all text"), "{e}");
    assert_eq!(by_label.len(), 1);
}

#[test]
fn push_series_with_range_and_interval_keys_is_push_many() {
    // Time ranges: the equivalence holds for a ranged key too, with a
    // filter built on the series (the event path).
    let mut by_rows = LiveSeries::new(
        "r",
        vec![
            ColumnDef::required("range", ColumnKind::TimeRange),
            ColumnDef::optional("v", ColumnKind::Number),
        ],
    )
    .unwrap();
    let mut by_series = LiveSeries::new("r", by_rows.schema().to_vec()).unwrap();
    for live in [&mut by_rows, &mut by_series] {
        let root = live.root();
        live.watch(root, OutputKind::Event).unwrap();
        let f = live
            .filter(root, |e| e.number("v").unwrap().is_some())
            .unwrap();
        live.watch(f, OutputKind::Event).unwrap();
    }
    let a = by_rows
        .push_many([
            (
                EventKey::time_range(0, 1000).unwrap(),
                vec![Some(Value::Number(1.0))],
            ),
            (EventKey::time_range(1000, 3000).unwrap(), vec![None]),
            (
                EventKey::time_range(1000, 4000).unwrap(),
                vec![Some(Value::Number(3.0))],
            ),
        ])
        .unwrap();
    let ranges = TimeSeries::from_time_ranges(
        "c",
        TimeRangeKeys {
            begin: vec![0, 1000, 1000],
            end: vec![1000, 3000, 4000],
        },
        vec![Column::optional(
            "v",
            Float64Column::from_options([Some(1.0), None, Some(3.0)]),
        )],
    )
    .unwrap();
    let b = by_series.push_series(&ranges).unwrap();
    assert_eq!(flat(&a), flat(&b));
    assert_eq!(
        by_rows.to_time_series().unwrap(),
        by_series.to_time_series().unwrap()
    );

    // Intervals: a batch series orders its rows by (begin, end) only, while
    // a live series also orders equal spans by label, so a valid series
    // whose labels are out of label order carries a "late" row in the
    // middle. The outcome is push_many's for the same rows: refused under
    // Strict, stored in key order under Reorder.
    let schema = vec![
        ColumnDef::required("key", ColumnKind::Interval),
        ColumnDef::optional("v", ColumnKind::Number),
    ];
    let intervals = TimeSeries::from_intervals(
        "c",
        IntervalKeys {
            label: vec!["b", "a", "c"].into(),
            begin: vec![0, 0, 0],
            end: vec![1000, 1000, 1000],
        },
        vec![Column::optional(
            "v",
            Float64Column::from_options([Some(1.0), Some(2.0), Some(3.0)]),
        )],
    )
    .unwrap();
    let rows = || {
        ["b", "a", "c"]
            .into_iter()
            .zip([1.0, 2.0, 3.0])
            .map(|(l, v)| {
                (
                    EventKey::interval(l, 0, 1000).unwrap(),
                    vec![Some(Value::Number(v))],
                )
            })
    };
    for options in [
        LiveOptions::new(),
        LiveOptions::new().ordering(OrderingMode::Reorder),
        LiveOptions::new().ordering(OrderingMode::Drop),
    ] {
        let mut by_rows = LiveSeries::with_options("i", schema.clone(), options.clone()).unwrap();
        let mut by_series = LiveSeries::with_options("i", schema.clone(), options).unwrap();
        let a = by_rows.push_many(rows());
        let b = by_series.push_series(&intervals);
        match (a, b) {
            (Ok(a), Ok(b)) => assert_eq!(flat(&a), flat(&b)),
            (Err(a), Err(b)) => assert_eq!(a.to_string(), b.to_string()),
            (a, b) => panic!("push_many {a:?} vs push_series {b:?}"),
        }
        assert_eq!(by_rows.stats(), by_series.stats());
        assert_eq!(
            by_rows.to_time_series().unwrap(),
            by_series.to_time_series().unwrap()
        );
    }
}

#[test]
fn push_series_required_gap_on_the_event_path_stores_nothing() {
    let mut live = LiveSeries::new(
        "v",
        vec![
            ColumnDef::required("time", ColumnKind::Time),
            ColumnDef::required("v", ColumnKind::Number),
        ],
    )
    .unwrap();
    let root = live.root();
    live.watch(root, OutputKind::Event).unwrap();
    let f = live.filter(root, |_| true).unwrap();
    let gappy = TimeSeries::new(
        "c",
        vec![0, 1000],
        vec![Column::optional(
            "v",
            Float64Column::from_options([Some(1.0), None]),
        )],
    )
    .unwrap();
    let e = live.push_series(&gappy).unwrap_err().to_string();
    assert!(e.contains("row 1: column 'v' is required"), "{e}");
    assert_eq!(live.len(), 0);
    assert_eq!(live[f].len(), 0);
}
