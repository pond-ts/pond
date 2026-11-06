"""pond_rs.LiveSeries from Python: the ways in (push, push_many, frames),
outputs, Python functions given to nodes, and threads. Parity with pond-ts
is `test_live_parity.py`; this file covers what only the Python side has."""

from __future__ import annotations

import threading
import time
from datetime import timedelta

import pyarrow as pa
import pytest

import pond_rs
from pond_rs import LiveSeries, PondError, Sequence, TimeSeries

SCHEMA = {"time": "time", "host": "string", "cpu": "number"}


def series(**kw) -> LiveSeries:
    return LiveSeries(SCHEMA, **kw)


def rows(node):
    return [(e.key, e.to_dict()) for e in node.events()]


# ---------------------------------------------------------------------------
# Schema and pushes
# ---------------------------------------------------------------------------


def test_schema_forms_agree():
    a = LiveSeries(SCHEMA)
    b = LiveSeries([("time", "time"), ("host", "string"), ("cpu", "number")])
    c = LiveSeries([{"name": "time", "kind": "time"}, {"name": "host", "kind": "string"}, {"name": "cpu", "kind": "number"}])
    assert a.schema == b.schema == c.schema
    # Value columns may have gaps unless marked required; the key never.
    assert [col["required"] for col in a.schema] == [True, False, False]
    d = LiveSeries([("time", "time"), ("host", "string", True), ("cpu", "number?")])
    assert [col["required"] for col in d.schema] == [True, True, False]
    assert a.columns == ["host", "cpu"]
    assert a.kind == "series" and a.name == "live"


def test_schema_from_a_time_series():
    ts = TimeSeries({"time": [0, 1000], "host": ["a", "b"], "cpu": [1.0, 2.0]})
    live = LiveSeries(ts.schema)
    assert live.schema == ts.schema


def test_bad_schemas_are_refused():
    with pytest.raises(PondError, match="first column is the key"):
        LiveSeries({"host": "string", "time": "time"})
    with pytest.raises(PondError):
        LiveSeries({"time": "time", "cpu": "float"})
    with pytest.raises(PondError, match="ordering"):
        LiveSeries(SCHEMA, ordering="sometimes")


def test_push_forms():
    live = series()
    live.push(0, {"host": "a", "cpu": 1.0})
    live.push(1000, ["b", 2.0])
    live.push(2000, host="c", cpu=3.0)
    live.push(3000, {"host": "d"}, cpu=4.0)
    live.push(4000)  # every value a gap
    assert rows(live) == [
        (0, {"host": "a", "cpu": 1.0}),
        (1000, {"host": "b", "cpu": 2.0}),
        (2000, {"host": "c", "cpu": 3.0}),
        (3000, {"host": "d", "cpu": 4.0}),
        (4000, {"host": None, "cpu": None}),
    ]
    assert len(live) == 5
    assert live.last().key == 4000


def test_push_refusals():
    live = series()
    with pytest.raises(PondError, match="no value column 'mem'"):
        live.push(0, mem=1.0)
    with pytest.raises(PondError, match="1 values for 2"):
        live.push(0, ["a"])
    with pytest.raises(PondError):
        live.push(0, cpu="high")  # text in a number column
    live.push(1000, cpu=1.0)
    with pytest.raises(PondError):
        live.push(500, cpu=1.0)  # out of order under "strict"
    assert len(live) == 1
    req = LiveSeries([("time", "time"), ("cpu", "number", True)])
    with pytest.raises(PondError):
        req.push(0)


def test_push_many_is_all_or_nothing():
    live = series()
    live.push_many([(0, {"cpu": 1.0}), (1000, ["a", 2.0]), {"time": 2000, "host": "b", "cpu": 3.0}])
    assert len(live) == 3
    with pytest.raises(PondError):
        live.push_many([(3000, {"cpu": 1.0}), (2500, {"cpu": 2.0})])
    assert len(live) == 3
    with pytest.raises(PondError, match="no key column 'time'"):
        live.push_many([{"cpu": 1.0}])


def test_keys_of_other_kinds():
    tr = LiveSeries({"window": "time_range", "v": "number"})
    tr.push((0, 1000), v=1.0)
    assert tr.last().key == (0, 1000) and tr.last().begin == 0 and tr.last().end == 1000
    iv = LiveSeries({"slot": "interval", "v": "number"})
    iv.push(("a", 0, 1000), v=1.0)
    assert iv.last().key == ("a", 0, 1000)


def test_times_as_datetimes_and_text():
    from datetime import datetime, timezone

    live = series()
    live.push(datetime(2026, 1, 1, tzinfo=timezone.utc), cpu=1.0)
    live.push("2026-01-01T00:00:01Z", cpu=2.0)
    assert [e.key for e in live.events()] == [1767225600000, 1767225601000]


# ---------------------------------------------------------------------------
# Frames
# ---------------------------------------------------------------------------


def frame(n=5, start=0):
    return {
        "time": [start + i * 1000 for i in range(n)],
        "host": ["a" if i % 2 else "b" for i in range(n)],
        "cpu": [float(i) for i in range(n)],
    }


@pytest.mark.parametrize("kind", ["dict", "pyarrow", "polars", "pandas", "series"])
def test_push_frame_every_form(kind):
    data = frame()
    if kind == "pyarrow":
        data = pa.table(data)
    elif kind == "polars":
        pl = pytest.importorskip("polars")
        data = pl.DataFrame(data)
    elif kind == "pandas":
        pd = pytest.importorskip("pandas")
        data = pd.DataFrame(data)
    elif kind == "series":
        data = TimeSeries(data)
    live = series()
    live.push_frame(data)
    assert rows(live) == [(i * 1000, {"host": "a" if i % 2 else "b", "cpu": float(i)}) for i in range(5)]


def test_push_frame_matches_push_many_with_nodes_built():
    # With nothing built the columns go straight into storage; with nodes,
    # rows go through them. Both must leave the same state.
    bare, built, by_rows = series(), series(), series()
    f = built.filter(lambda e: e["cpu"] > 1)
    agg = built.aggregate("2s", {"cpu": "sum"})
    g = by_rows.filter(lambda e: e["cpu"] > 1)
    agg2 = by_rows.aggregate("2s", {"cpu": "sum"})
    data = frame(9)
    bare.push_frame(data)
    built.push_frame(data)
    by_rows.push_many([(t, {"host": h, "cpu": c}) for t, h, c in zip(data["time"], data["host"], data["cpu"])])
    assert rows(bare) == rows(built) == rows(by_rows)
    assert rows(f) == rows(g)
    assert rows(agg) == rows(agg2)
    assert bare.stats() == built.stats() == by_rows.stats()


def test_push_frame_outputs_and_refusals():
    live = series()
    live.watch("batch")
    out = live.push_frame(frame(3))
    assert [(o.kind, len(o.events)) for o in out] == [("batch", 3)]
    with pytest.raises(PondError):
        live.push_frame({"time": [5000], "host": ["a"]})  # a column missing
    with pytest.raises(PondError):
        live.push_frame({"time": [5000], "host": ["a"], "cpu": [1.0], "mem": [2.0]})
    with pytest.raises(PondError):
        live.push_frame(frame(2, start=0))  # older than what is held
    assert len(live) == 3


# ---------------------------------------------------------------------------
# Nodes and outputs
# ---------------------------------------------------------------------------


def test_outputs_carry_their_node():
    live = series()
    hot = live.filter(lambda e: e["cpu"] > 1)
    roll = live.rolling("2s", {"avg": ("cpu", "avg")})
    hot.watch()
    roll.watch("update")
    out = live.push(0, host="a", cpu=2.0)
    assert [(o.node, o.kind) for o in out] == [(hot, "event"), (roll, "update")]
    assert out[0].event["cpu"] == 2.0 and out[0].event.to_dict() == {"host": "a", "cpu": 2.0}
    assert out[1].values == {"avg": 2.0}
    assert out[0].node != roll and len({hot, roll, out[0].node}) == 2
    assert roll.value() == {"avg": 2.0}
    hot.unwatch()
    assert [o.node for o in live.push(1000, cpu=3.0)] == [roll]
    with pytest.raises(PondError, match="output kind"):
        hot.watch("events")


def test_nodes_of_two_series_differ():
    a, b = series(), series()
    assert a.root != b.root
    assert a.root == a.root


def test_aggregation_reads():
    live = series()
    agg = live.aggregate(Sequence.every("2s"), {"cpu": "sum", "n": ("cpu", "count")})
    agg.watch()
    live.push_many([(t, {"cpu": 1.0}) for t in (0, 1000, 2000)])
    assert agg.kind == "aggregation"
    assert len(agg) == 1 and agg.has_open_bucket
    assert [r.to_dict() for r in agg.to_series()] == [{"cpu": 2.0, "n": 2.0}]
    assert len(agg.snapshot()) == 2
    assert agg.stats()["buckets_closed"] == 1
    assert agg.to_pyarrow().num_rows == 1
    with pytest.raises(PondError, match="value\\(\\) is for rolling"):
        agg.value()


def test_views_chain():
    live = series()
    view = live.fill("hold").diff("cpu").select("cpu").window(3)
    for i, c in enumerate([1.0, None, 4.0, 6.0, 7.0]):
        live.push(i * 1000, cpu=c)
    assert [e["cpu"] for e in view.events()] == [3.0, 2.0, 1.0]
    assert view.columns == ["cpu"]
    cum = live.cumulative({"cpu": "sum"})
    assert [e["cpu"] for e in cum.events()][-1] == 18.0
    own = live.cumulative({"cpu": lambda acc, v: max(acc, v)})
    assert own.last()["cpu"] == 7.0


def test_rolling_forms():
    live = series()
    by_time = live.rolling("2s", {"cpu": "avg"})
    by_count = live.rolling(2, {"cpu": "sum"})
    several = live.rolling({"2s": {"a": ("cpu", "avg")}, "4s": {"aggs": {"m": ("cpu", "max")}, "min_samples": 2}})
    clocked = live.rolling(timedelta(seconds=2), {"cpu": "avg"}, trigger="2s", history={"max_events": 2})
    for i in range(6):
        live.push(i * 1000, cpu=float(i))
    # Windows include their start: 2s back from 5000 is 3000, 4000, 5000.
    assert by_time.value() == {"cpu": 4.0}
    assert by_count.value() == {"cpu": 9.0}
    assert several.value() == {"a": 4.0, "m": 5.0}
    assert len(clocked) == 2
    with pytest.raises(TypeError, match="needs aggs"):
        live.rolling("2s")


def test_reduce():
    live = series()
    r = live.reduce({"total": ("cpu", "sum")}, trigger=2)
    for i in range(4):
        live.push(i * 1000, cpu=1.0)
    assert [e["total"] for e in r.events()] == [2.0, 4.0]


def test_partitions():
    live = series()
    by_host = live.partition_by("host")
    smooth = by_host.fill("hold").rolling("2s", {"cpu": "avg"})
    together = smooth.collect()
    synced = by_host.rolling("2s", {"cpu": "avg"}, trigger="2s")
    live.push_many([(i * 1000, {"host": "ab"[i % 2], "cpu": float(i)}) for i in range(6)])
    assert by_host.kind == "partitioned" and by_host.keys() == ["a", "b"]
    assert len(by_host) == 2
    assert [rows(p) for p in by_host.partitions().values()] == [
        [(t, {"host": "a", "cpu": float(t // 1000)}) for t in (0, 2000, 4000)],
        [(t, {"host": "b", "cpu": float(t // 1000)}) for t in (1000, 3000, 5000)],
    ]
    assert by_host.partition("a").kind == "series" and by_host.partition("z") is None
    assert smooth.kind == "partitioned_view"
    assert set(smooth.partitions()) == {"a", "b"}
    assert all(n.kind == "rolling" for n in smooth.partitions().values())
    assert len(together) == 6
    assert synced.kind == "partition_rolling" and synced.keys() == ["a", "b"]
    with pytest.raises(PondError, match="collect"):
        smooth.events()


def test_remove():
    live = series()
    f = live.filter(lambda e: True)
    g = f.select("cpu")
    live.push(0, cpu=1.0)
    f.remove()
    with pytest.raises(PondError, match="removed"):
        len(f)
    # What was built on it keeps what it holds, and gets nothing more.
    live.push(1000, cpu=2.0)
    assert len(g) == 1 and len(live) == 2
    with pytest.raises(PondError, match="root cannot be removed"):
        live.root.remove()


# ---------------------------------------------------------------------------
# Python functions given to nodes
# ---------------------------------------------------------------------------


def test_filter_exception_is_raised_after_the_push():
    live = series()

    def picky(e):
        if e["cpu"] == 2.0:
            raise RuntimeError("no twos")
        return True

    f = live.filter(picky)
    live.push(0, cpu=1.0)
    with pytest.raises(RuntimeError, match="no twos"):
        live.push(1000, cpu=2.0)
    # The push happened; the filter left the event out.
    assert len(live) == 2 and [e["cpu"] for e in f.events()] == [1.0]
    # The next push is unaffected.
    live.push(2000, cpu=3.0)
    assert [e["cpu"] for e in f.events()] == [1.0, 3.0]


def test_map_checks_what_the_function_returns():
    live = series()
    doubled = live.map(lambda e: {"cpu": e["cpu"] * 2})
    live.push(0, cpu=2.0)
    assert doubled.last()["cpu"] == 4.0
    # Built over the event already held, so the function runs at once; the
    # node is not kept.
    with pytest.raises(TypeError, match="column 'cpu' is number"):
        live.map(lambda e: {"cpu": "x"})
    flaky = live.map(lambda e: {"cpu": "x"} if e["cpu"] == 1.0 else {})
    with pytest.raises(TypeError, match="column 'cpu' is number"):
        live.push(1000, cpu=1.0)
    assert flaky.last()["cpu"] is None  # the event came through as gaps
    assert len(live) == 2
    seq = series()
    m = seq.map(lambda e: [e["host"].upper(), e["cpu"]])
    seq.push(0, host="a", cpu=1.0)
    assert m.last().to_dict() == {"host": "A", "cpu": 1.0}


def test_one_function_failing_leaves_the_others_alone():
    live = series()

    def bad(e):
        if e["cpu"] == 2.0:
            raise RuntimeError("no twos")
        return {"cpu": e["cpu"] * 10}

    mapped = live.map(bad)
    every = live.filter(lambda e: True)
    total = live.cumulative({"cpu": lambda acc, v: acc + v if v != 3.0 else 1 / 0})
    mapped.watch()
    with pytest.raises(RuntimeError, match="no twos") as raised:
        live.push_many([(t, {"cpu": c}) for t, c in ((0, 1.0), (1000, 2.0), (2000, 4.0))])
    # Only the failing event lost its values; the rest ran.
    assert [e["cpu"] for e in mapped.events()] == [10.0, None, 40.0]
    assert len(every) == 3
    # The push happened, and its outputs ride on the exception.
    assert [o.event["cpu"] for o in raised.value.outputs] == [10.0, None, 40.0]
    # A failing fold keeps the running value, and later pushes go on.
    with pytest.raises(ZeroDivisionError):
        live.push(3000, cpu=3.0)
    live.push(4000, cpu=1.0)
    assert [e["cpu"] for e in total.events()] == [1.0, 3.0, 7.0, 7.0, 8.0]


def test_partitioned_nodes_cannot_be_watched():
    live = series()
    by_host = live.partition_by("host")
    with pytest.raises(PondError, match="partitioned node emits nothing"):
        by_host.watch()
    with pytest.raises(PondError, match="partitioned node emits nothing"):
        by_host.fill("hold").watch("event")


def test_a_function_cannot_use_its_own_series():
    live = series()
    live.filter(lambda e: len(live) > 0)
    with pytest.raises(PondError, match="cannot use the series itself"):
        live.push(0, cpu=1.0)
    assert len(live) == 1


def test_threads_push_into_one_series():
    live = series(ordering="reorder")
    seen = []
    keep = live.filter(lambda e: seen.append(e.key) or True)
    total = live.reduce({"n": ("cpu", "count")})

    def worker(k):
        for i in range(200):
            live.push(i * 10 + k, cpu=1.0)

    threads = [threading.Thread(target=worker, args=(k,)) for k in range(4)]
    for t in threads:
        t.start()
    # Reading from this thread while the others push.
    for _ in range(50):
        len(live)
    for t in threads:
        t.join()
    assert len(live) == len(keep) == len(seen) == 800
    assert total.value() == {"n": 800.0}


def test_a_long_push_lets_other_threads_run_python():
    # push_frame works with Python's lock released, so another thread keeps
    # running Python meanwhile. Were the lock held, the other thread could
    # run only before the call starts or after it returns (a switch just
    # before the call lasts at most one switch interval, 5 ms), so no tick
    # could land well inside the call.
    live = series()
    for w in ("1m", "2m", "5m"):
        live.rolling(w, {"cpu": "avg"})
    n = 600_000
    data = pa.table({"time": pa.array(range(n), pa.int64()), "host": ["a"] * n, "cpu": [1.0] * n})
    ticks = []
    stop = threading.Event()

    def spin():
        i = 0
        while not stop.is_set():
            i += 1
            if i % 1000 == 0:
                ticks.append(time.perf_counter())

    t = threading.Thread(target=spin)
    t.start()
    try:
        time.sleep(0.01)
        start = time.perf_counter()
        live.push_frame(data)
        end = time.perf_counter()
    finally:
        stop.set()
        t.join()
    margin = 0.015
    assert end - start > 4 * margin, "the push must take long enough to measure"
    inside = [x for x in ticks if start + margin < x < end - margin]
    assert len(inside) > 10, (len(inside), end - start)


def test_repr():
    live = series(name="cpu")
    live.push(0, cpu=1.0)
    assert repr(live) == "LiveSeries('cpu', 1 events)"
    assert repr(live.root) == "LiveNode(series)"
    assert "LiveEvent(0," in repr(live.last())
    assert pond_rs.LiveOutput.__name__ == "LiveOutput"
