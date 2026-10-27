//! What the replay fixture (`tests/live_parity.rs`) does not reach: the
//! lookups, JSON, handles and the errors.

use super::*;
use crate::Reducer;

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

fn begins<'a>(events: impl Iterator<Item = &'a LiveEvent>) -> Vec<i64> {
    events.map(LiveEvent::begin).collect()
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
    assert_eq!(live.at(-1).map(LiveEvent::begin), Some(4000));
    assert_eq!(live.at(4), None);
    assert_eq!(live.at(-5), None);
    assert_eq!(live.bisect(1000), 1);
    assert_eq!(live.bisect(1001), 3);
    assert!(live.includes_key(1000));
    assert!(!live.includes_key(2000));
    assert_eq!(live.at_or_before(2000).map(LiveEvent::begin), Some(1000));
    assert_eq!(
        live.at_or_before(1000).unwrap().number("cpu").unwrap(),
        Some(5.0)
    );
    assert_eq!(live.at_or_before(-1), None);
    assert_eq!(live.at_or_after(2000).map(LiveEvent::begin), Some(4000));
    assert_eq!(live.at_or_after(4001), None);
    let busy = |e: &LiveEvent| e.number("cpu").ok().flatten() > Some(4.0);
    assert_eq!(live.find(busy).map(LiveEvent::begin), Some(1000));
    assert!(live.some(busy));
    assert!(!live.every(busy));
    assert_eq!(live.time_range(), 4000);
    assert_eq!(live.event_rate(), 1.0);

    let v = live.filter(live.root(), busy).unwrap();
    let view = &live[v];
    assert_eq!(begins(view.events()), [1000, 1000]);
    assert_eq!(view.at(-1).unwrap().number("cpu").unwrap(), Some(6.0));
    assert!(view.includes_key(1000));
    assert_eq!(view.at_or_after(0).map(LiveEvent::begin), Some(1000));
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
    // pond-ts's view throws here ([PND-LATE]); pond-rs stores it in order.
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
    let day = Sequence::calendar("day", "UTC").unwrap();
    let sum = [Agg::of("cpu", Reducer::Sum)];
    assert!(live.aggregate(root, &day, &sum).is_err());
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
