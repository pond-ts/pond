"""The Python doors: frames in and out, times and durations, errors,
Python functions, threads."""

from __future__ import annotations

import datetime as dt
import threading

import pandas as pd
import polars as pl
import pyarrow as pa
import pytest

import pond_rs
from pond_rs import Sequence, TimeSeries

UTC = dt.timezone.utc
STAMP = pa.timestamp("ms", tz="UTC")


def cpu_table(n=6):
    return pa.table(
        {
            "time": pa.array([i * 60_000 for i in range(n)], pa.int64()).cast(STAMP),
            "cpu": pa.array([float(i) for i in range(n)]),
            "host": pa.array(["a", "b"] * (n // 2)),
        }
    )


def address(chunked: pa.ChunkedArray) -> int:
    """Where a one-chunk column's values live."""
    assert chunked.num_chunks == 1
    return chunked.chunks[0].buffers()[1].address


# --- frames in and out ------------------------------------------------------


def test_a_gap_free_float_column_crosses_both_ways_without_a_copy():
    t = cpu_table()
    s = TimeSeries(t)
    out = s.select("cpu").to_pyarrow()
    assert address(out.column("cpu")) == address(t.column("cpu"))
    # The stream interface too: pyarrow reads the series directly.
    assert address(pa.table(s).column("cpu")) == address(t.column("cpu"))


def test_polars_frames_in_and_out():
    df = pl.DataFrame(
        {
            "time": [dt.datetime(2026, 1, 1, 0, m) for m in range(4)],
            "cpu": [1.0, None, 3.0, 4.0],
            "n": [1, 2, 3, 4],
        }
    )
    s = TimeSeries(df)
    assert s.schema[1] == {"name": "cpu", "kind": "number", "required": False}
    assert s.column("cpu") == [1.0, None, 3.0, 4.0]
    assert s.column("n") == [1.0, 2.0, 3.0, 4.0]  # integers read as numbers
    back = s.to_polars()
    assert back.columns == ["time", "cpu", "n"]
    assert back.schema["time"] == pl.Datetime("ms", "UTC")
    assert back["cpu"].to_list() == [1.0, None, 3.0, 4.0]
    assert pl.DataFrame(s).equals(back)


def test_polars_float_column_is_not_copied_on_the_way_in():
    df = pl.DataFrame({"time": [0, 1000, 2000], "v": [1.0, 2.0, 3.0]}).with_columns(
        pl.col("time").cast(pl.Datetime("ms"))
    )
    before = address(pa.chunked_array([df["v"].to_arrow()]))
    s = TimeSeries(df)
    after = address(s.to_pyarrow().column("v"))
    assert before == after


def test_pandas_frames_in_and_out():
    idx = pd.date_range("2026-03-07", periods=4, freq="12h", tz="America/New_York")
    df = pd.DataFrame({"time": idx, "cpu": [1.0, 2.0, float("nan"), 4.0]})
    s = TimeSeries(df)
    assert s.column("cpu") == [1.0, 2.0, None, 4.0]  # NaN is a gap
    back = s.to_pandas()
    assert str(back["time"].dtype) == "datetime64[ms, UTC]"
    assert list(back["time"]) == list(idx.tz_convert("UTC"))
    # A time index becomes the key column too.
    assert len(TimeSeries(df.set_index("time"))) == 4


def test_naive_timestamps_are_read_as_utc():
    df = pd.DataFrame({"time": pd.to_datetime(["2026-01-01", "2026-01-02"]), "v": [1.0, 2.0]})
    s = TimeSeries(df)
    assert s[0].begin == pond_rs.parse_time("2026-01-01T00:00:00Z")


def test_sub_millisecond_times_are_refused_not_rounded():
    t = pa.table({"time": pa.array([1_500], pa.timestamp("us")), "v": [1.0]})
    with pytest.raises(pond_rs.PondError, match="millisecond"):
        TimeSeries(t)


def test_empty_and_chunked_tables():
    empty = pa.table({"time": pa.array([], STAMP), "v": pa.array([], pa.float64())})
    assert len(TimeSeries(empty)) == 0
    two = pa.concat_tables([cpu_table(4).slice(0, 2), cpu_table(4).slice(2)])
    assert two.column("cpu").num_chunks == 2  # several chunks are copied into one
    assert TimeSeries(two).column("cpu") == [0.0, 1.0, 2.0, 3.0]
    backwards = pa.concat_tables([cpu_table(4).slice(2), cpu_table(4).slice(0, 2)])
    with pytest.raises(pond_rs.PondError):
        TimeSeries(backwards)


def test_ipc_round_trip(tmp_path):
    s = TimeSeries(cpu_table(), name="cpu")
    path = tmp_path / "cpu.arrow"
    s.write_ipc(path)
    again = TimeSeries.read_ipc(path, name="cpu")
    assert again.to_pyarrow().equals(s.to_pyarrow())
    assert pa.ipc.open_file(str(path)).read_all().equals(s.to_pyarrow())


def test_dict_input_takes_its_kinds_from_the_values():
    s = TimeSeries(
        {
            "time": [dt.datetime(2026, 1, 1, tzinfo=UTC), "2026-01-01T00:01:00Z", 120_000 + 1767225600000],
            "x": [1, None, 2.5],
            "s": ["a", "b", "c"],
            "b": [True, False, None],
            "tags": [["a"], [], ["b", "c"]],
        },
        name="d",
    )
    assert [(d["name"], d["kind"], d["required"]) for d in s.schema] == [
        ("time", "time", True),
        ("x", "number", False),
        ("s", "string", True),
        ("b", "boolean", False),
        ("tags", "array", True),
    ]
    assert [r.begin for r in s] == [1767225600000, 1767225660000, 1767225720000]


def test_time_range_and_interval_keys_from_a_dict():
    r = TimeSeries({"span": [(0, 10), (10, 20)], "v": [1.0, 2.0]}, key="span", key_kind="time_range")
    assert r.key_kind == "time_range"
    assert r[1].key == (10, 20)
    i = TimeSeries({"b": [("x", 0, 10), ("y", 10, 20)], "v": [1.0, 2.0]}, key="b", key_kind="interval")
    assert i[0].key == ("x", 0, 10)
    # Arrow output uses pond's field names (as pond-ts toArrow).
    assert i.to_pyarrow().column_names == ["interval", "intervalEnd", "v", "intervalLabel"]


# --- times and durations ----------------------------------------------------


def test_times_take_datetimes_dates_text_and_milliseconds():
    s = TimeSeries(cpu_table())
    a = s.within(dt.datetime(1970, 1, 1, 0, 1, tzinfo=UTC), dt.datetime(1970, 1, 1, 0, 3))
    b = s.within("1970-01-01T00:01:00Z", 180_000)
    c = s.within(dt.datetime(1970, 1, 1, 1, 1, tzinfo=dt.timezone(dt.timedelta(hours=1))), 180_000)
    assert a.column("cpu") == b.column("cpu") == c.column("cpu") == [1.0, 2.0, 3.0]
    assert s.within(dt.date(1970, 1, 1), dt.date(1970, 1, 2)).column("cpu") == s.column("cpu")
    with pytest.raises(ValueError, match="millisecond"):
        s.within(dt.datetime(1970, 1, 1, 0, 0, 0, 1, tzinfo=UTC), 1)
    with pytest.raises(TypeError):
        s.within(True, 1)


def test_durations_take_text_or_timedelta():
    s = TimeSeries(cpu_table())
    a = s.rolling("2m", {"avg": ("cpu", "avg")})
    b = s.rolling(dt.timedelta(minutes=2), {"avg": ("cpu", "avg")})
    assert a.column("avg") == b.column("avg") == [0.0, 0.5, 1.5, 2.5, 3.5, 4.5]
    assert s.rolling(2, {"avg": ("cpu", "avg")}).column("avg") == a.column("avg")  # an int counts rows
    assert s.offset_time("-1m")[0].begin == -60_000
    assert s.offset_time(dt.timedelta(minutes=-1))[0].begin == -60_000
    assert pond_rs.parse_duration("5m") == 300_000
    with pytest.raises(pond_rs.PondError, match="duration"):
        s.rolling("5 minutes", {"avg": ("cpu", "avg")})


def test_calendar_days_follow_the_clock_change():
    days = Sequence.calendar("day", "America/New_York")
    [(begin, end)] = days.buckets("2026-03-08T12:00:00Z", "2026-03-08T12:00:00Z")
    assert end - begin == 23 * 3_600_000
    s = TimeSeries(cpu_table())
    assert len(s.aggregate(days, {"n": ("cpu", "count")})) == 1


# --- reducer mappings -------------------------------------------------------


def test_the_three_mapping_forms_agree():
    s = TimeSeries(cpu_table())
    a = s.aggregate("2m", {"m": ("cpu", "avg")})
    b = s.aggregate("2m", {"m": {"from": "cpu", "using": "avg"}})
    c = s.aggregate("2m", {"cpu": "avg"}).rename({"cpu": "m"})
    assert a.column("m") == b.column("m") == c.column("m") == [0.5, 2.5, 4.5]


def test_reduce_gives_a_dict():
    s = TimeSeries(cpu_table())
    assert s.reduce({"total": ("cpu", "sum"), "hosts": ("host", "unique")}) == {
        "total": 15.0,
        "hosts": ["a", "b"],
    }


# --- errors -------------------------------------------------------------------


def test_errors_are_pond_errors_naming_the_call_and_column():
    s = TimeSeries(cpu_table())
    assert issubclass(pond_rs.PondError, ValueError)
    with pytest.raises(pond_rs.PondError, match=r"no column named 'nope'"):
        s.rolling("1m", {"x": ("nope", "avg")})
    with pytest.raises(pond_rs.PondError, match=r"column 'host' is a string column"):
        s.rolling("1m", {"x": ("host", "avg")})
    with pytest.raises(pond_rs.PondError, match="unknown reducer 'average'"):
        s.rolling("1m", {"x": ("cpu", "average")})
    with pytest.raises(ValueError, match="alignment"):
        s.rolling("1m", {"x": ("cpu", "avg")}, alignment="middle")


def test_a_python_exception_in_a_function_comes_out_as_itself():
    s = TimeSeries(cpu_table())

    class Boom(Exception):
        pass

    def bad(row):
        if row.index == 2:
            raise Boom("row 2")
        return True

    with pytest.raises(Boom, match="row 2"):
        s.filter(bad)
    with pytest.raises(Boom):
        s.map("cpu", lambda v: (_ for _ in ()).throw(Boom()))
    with pytest.raises(Boom):
        s.partition_by("host").scan("cpu", lambda a, v, i: (_ for _ in ()).throw(Boom()), 0.0)


# --- Python functions ---------------------------------------------------------


def test_rows_and_functions():
    s = TimeSeries(cpu_table())
    assert s.filter(lambda r: r["host"] == "a").column("cpu") == [0.0, 2.0, 4.0]
    assert s.find(lambda r: r["cpu"] > 2).index == 3
    assert s.map("cpu", lambda v: v * 10).column("cpu")[:3] == [0.0, 10.0, 20.0]
    assert s.map("host", str.upper).column("host")[:2] == ["A", "B"]
    running = s.partition_by("host").scan("cpu", lambda a, v, i: (a + v, a + v), 0.0, output="run")
    assert running.collect().column("run") == [0.0, 1.0, 2.0, 4.0, 6.0, 9.0]
    labelled = s.as_interval(lambda r: f"bar{r.index}")
    assert labelled[1].key == ("bar1", 60_000, 60_000)
    assert s.collapse(["cpu"], "half", lambda r: r["cpu"] / 2).column("half")[1] == 0.5
    row = s.nearest("1970-01-01T00:02:10Z")
    assert (row.index, row["cpu"], row.get("nope", "-")) == (2, 2.0, "-")
    assert row.to_dict() == {"cpu": 2.0, "host": "a"}


def test_partitions_by_several_columns_key_by_tuples():
    s = TimeSeries(cpu_table()).with_column("zone", ["x", "x", "y", "y", "x", "x"])
    groups = s.group_by(["host", "zone"])
    assert list(groups) == [("a", "x"), ("b", "x"), ("a", "y"), ("b", "y")]
    p = s.partition_by(["host", "zone"])
    assert len(p) == 4 and p.by == ["host", "zone"]
    assert list(p.to_dict()) == list(groups)


def test_partitioned_scan_gives_each_group_its_own_state():
    s = TimeSeries(cpu_table())

    def count(seen, v, i):
        seen.append(v)  # changes the state in place
        return seen, float(len(seen))

    out = s.partition_by("host").scan("cpu", count, [], output="n").collect()
    assert out.column("n") == [1.0, 1.0, 2.0, 2.0, 3.0, 3.0]


def test_numpy_and_pandas_times():
    import numpy as np

    s = TimeSeries(cpu_table())
    assert s.within(np.int64(60_000), np.datetime64("1970-01-01T00:02:00")).column("cpu") == [1.0, 2.0]
    with pytest.raises(pond_rs.PondError, match="millisecond"):
        s.within(np.datetime64("1970-01-01T00:00:00.000000001"), 60_000)
    with pytest.raises(pond_rs.PondError, match="millisecond"):
        s.within(pd.Timestamp("1970-01-01T00:00:00.000000001Z"), 60_000)
    assert len(s.within(pd.Timestamp("1970-01-01T00:01:00Z"), 60_000)) == 1


def test_bad_option_values_are_pond_errors():
    s = TimeSeries(cpu_table())
    with pytest.raises(pond_rs.PondError, match="alignment"):
        s.rolling("1m", {"x": ("cpu", "avg")}, alignment="middle")
    with pytest.raises(pond_rs.PondError, match="exactly one of alpha or span"):
        s.smooth("cpu", "ema")
    with pytest.raises(TypeError):
        s.sample(stride=1.5)


def test_iterating_rows_is_lazy():
    s = TimeSeries(cpu_table())
    it = iter(s)
    assert next(it).index == 0 and next(it).index == 1
    assert [r.index for r in it] == [2, 3, 4, 5]


# --- threads ------------------------------------------------------------------


def test_calls_from_several_threads_give_the_same_answers():
    big = cpu_table(20_000)
    s = TimeSeries(big)
    want = s.rolling("10m", {"avg": ("cpu", "avg")}).column("avg")
    out = [None] * 4

    def work(k):
        out[k] = s.rolling("10m", {"avg": ("cpu", "avg")}).column("avg")

    threads = [threading.Thread(target=work, args=(k,)) for k in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert all(o == want for o in out)


def test_version_matches_the_package():
    assert pond_rs.__version__.count(".") == 2
