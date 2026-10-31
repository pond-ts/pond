# pond-rs for Python

Time series analytics on the frames you already use: rolling windows,
calendar buckets in any time zone (daylight saving included), joins, and the
same work per host or per symbol on several cores. pyarrow, polars and pandas
frames go in and come back out through Arrow, so a column with no gaps crosses
without being copied.

It is the Python face of [pond-rs](https://crates.io/crates/pond-rs), the
Rust implementation of [pond](https://pond-ts.org). Results are the same as
pond-ts (TypeScript) and pond-rs (Rust): the test suite runs pond-ts's own
parity fixture through this package and every case matches.

```python
import datetime as dt
import polars as pl
import pond_rs

df = pl.DataFrame({
    "time": [dt.datetime(2026, 3, 8, h) for h in range(24)],
    "host": ["a", "b"] * 12,
    "cpu": [float(h) for h in range(24)],
})
s = pond_rs.TimeSeries(df, key="time")

# Five-hour trailing average, per host, back as a polars frame.
s.partition_by("host").rolling("5h", {"cpu_avg": ("cpu", "avg")}).collect().to_polars()

# Calendar days in New York: 8 March 2026 is 23 hours long there.
days = pond_rs.Sequence.calendar("day", "America/New_York")
s.aggregate(days, {"cpu_max": ("cpu", "max"), "n": ("cpu", "count")}).to_pandas()
```

## The basics

- **In:** `TimeSeries(data, key="time")` takes a pyarrow Table or RecordBatch,
  a polars or pandas DataFrame, anything with `__arrow_c_stream__`, or a dict
  of columns. `key_kind="time_range"` or `"interval"` reads a key of spans
  (`<key>` and `<key>End`, plus `<key>Label` for intervals). Every other column
  is a value column: numbers, exact decimals, text, true/false values or lists.
  A null or NaN is a gap. A column Arrow marks nullable is optional.
- **Out:** `to_pyarrow()`, `to_polars()`, `to_pandas()`, or hand the series to
  `pyarrow.table(s)` / `polars.DataFrame(s)` directly. Times come out as
  `timestamp[ms, UTC]`. Arrow, IPC files (`read_ipc` / `write_ipc`) and pond's
  JSON formats are all there.
- **Times** are whole milliseconds since 1970 inside. Anywhere a time is taken
  you can pass a `datetime` (one without a time zone is read as UTC), a `date`,
  text such as `"2026-03-08T12:00:00Z"`, an int of milliseconds, or a numpy
  `datetime64` / integer. A time
  with a part smaller than a millisecond is refused, not rounded.
- **Durations** are text (`"500ms"`, `"5s"`, `"5m"`, `"1h"`, `"1d"`) or a
  `timedelta`. In `rolling`, an int is a count of rows instead.
- **Reducers** are named per output column: `{"avg": ("cpu", "avg")}`, or
  `{"cpu": "avg"}` to reduce a column into itself. count, sum, avg, min, max,
  first, last, median, stdev, difference, keep, unique, samples, `top3`,
  `p95`, …
- **Errors** are `pond_rs.PondError` (a `ValueError`), naming the call and
  the column; a value of the wrong type (text where a number is needed) is a
  `TypeError`.
- **Python functions** work where a rule is yours: `filter(lambda row: …)`,
  `map(column, f)`, `scan(column, step, init)`, `collapse(...)`,
  `as_interval(lambda row: …)`. An exception inside one comes out as itself.
- **Threads:** every call lets go of Python's lock while it works, so calls
  from several Python threads run at the same time.

Type hints for every method are in the package (`pond_rs.pyi`).

## Finance studies

All 109 studies of `@pond-ts/financial` (moving averages, bands, RSI and
other momentum oscillators, trend, volatility, volume, statistics, session
VWAP and pivot points) run on any series of bars, with the same numbers as
pond-ts to the last bit (one difference: a source column that is missing or
not numbers is an error here, where pond-ts fills the output with gaps):

```python
bars = pond_rs.TimeSeries(df)                      # open/high/low/close/volume
bars.rsi(period=14).bollinger(period=20, std_dev=2).to_polars()
bars.study("macd", fast_period=12)                 # the same, by name
bars.partition_by("symbol").atr(period=14).collect()

nyse = pond_rs.TradingCalendar.from_rules(
    "America/New_York", "09:30", "16:00", "2024-01-02", "2024-12-31",
    holidays=["2024-07-04"], early_closes={"2024-12-24": "13:00"},
)
bars.session_vwap(sessions=nyse)
```

Each study adds its columns and keeps every row (the first rows are gaps
until the window fills). Columns it reads default to `close`, `high`, `low`,
`open` and `volume`; pass `column=` / `high=` … to use others. Options are
keywords in Python's spelling (`ema_period`, which the type hints list);
pond-ts's `emaPeriod` also works. An option the study does not have, or one
given twice, is a `TypeError`, so a typo cannot pass silently.
`pond_rs.studies()` describes every study: the columns it reads, its
options with defaults and ranges, and the columns it writes.

## Live series

`LiveSeries` takes events as they arrive. Nodes built on it (filters,
fills, buckets, rolling windows, per-host partitions) update with every
push, and each push returns what the nodes you `watch()` emitted. Results
match pond-ts's live layer output for output.

```python
live = pond_rs.LiveSeries({"time": "time", "host": "string", "cpu": "number"},
                          max_age="10m")
avg = live.rolling("1m", {"avg": ("cpu", "avg")})
per_min = live.aggregate("1m", {"max": ("cpu", "max")})
per_min.watch("event")                        # closed buckets

live.push("2026-03-08T12:00:00Z", host="a", cpu=0.5)
frame = pl.DataFrame({
    "time": [dt.datetime(2026, 3, 8, 12, m) for m in range(1, 5)],
    "host": ["a", "b", "a", "b"],
    "cpu": [0.7, 0.2, 0.9, 0.4],
})
for out in live.push_frame(frame):            # pyarrow / polars / pandas
    print(out.event.key, out.event["max"])    # each bucket that closed
avg.value()                                   # {"avg": 0.65}: 12:03 and 12:04

by_host = live.partition_by("host")
smooth = by_host.fill("hold").rolling("1m", {"cpu": "avg"}).collect()
smooth.to_polars()
```

A frame is the fastest way in (`push_frame`); `push_many` takes a batch of
`(time, values)` rows; `push` takes one event. A function you give a node
(`filter`, `map`) runs during the push; if it raises, that event gets no
value from it, the other nodes carry on, and the first error is raised when
the push returns, with the push's outputs as its `outputs` attribute (the
push has happened). Such a function must not use the series it belongs to:
on the same thread that is an error, and from a thread it waits for it
would wait forever. Calls from several threads
are safe: each call takes the series in turn, and waits with Python's lock
released.

## Speed

One million rows on a shared 4-core Linux VM, starting from a pyarrow table
and ending with a frame of each library's own kind (so getting data in and
out is counted). Median of 7 runs, milliseconds; `python bench/bench.py`
re-runs it. Runs on this VM vary by about a third.

| Case                                   | pond_rs | polars 2.1 | pandas 3.1 |
| -------------------------------------- | ------: | ---------: | ---------: |
| Round trip (in and out only)           |     7.4 |        0.4 |       11.7 |
| Rolling 5-minute average               |    33.5 |       36.3 |       66.7 |
| Aggregate into 1-minute buckets        |    15.2 |       12.4 |       17.0 |
| Daily buckets in New York              |     7.4 |        4.8 |       16.0 |
| `diff`                                 |    17.0 |        2.0 |       11.4 |
| RSI (14)                               |    21.5 |       36.3 |       58.4 |
| Bollinger bands (20, 2)                |    22.2 |       34.6 |       70.2 |
| Rolling 5 minutes per host (100 hosts) |   195.8 |       81.1 |      323.6 |

polars and pandas have no RSI or Bollinger bands; their columns are the
usual hand-written versions. pond_rs's rolling, bucket and Bollinger results
match polars's to within 1e-13. Getting data in costs about 7 ms per million
rows: the time column is copied and checked (in order, in range), and each
number column is scanned once for gaps. So the cheapest operations (`diff`)
are slower than polars. The per-host case is slow in pond-rs itself, not in
the bridge: putting 100 partitions back together in time order takes most of
that time in plain Rust too. That is logged to be fixed in pond-rs.

Live series, `python bench/bench_live.py 1000000`: one million events 10 ms
apart into a 1-minute rolling average and 1-minute buckets (avg, max). The
plain-Python column is the same work hand-written with a deque and a dict.

| How the events go in                     |    ms | events per second |
| ---------------------------------------- | ----: | ----------------: |
| `push(t, cpu=c)`, one call per event     | 630.8 |         1,585,000 |
| `push_many`, 1,000-row batches           | 299.2 |         3,342,000 |
| `push_frame`, 10,000-row pyarrow tables  | 218.7 |         4,574,000 |
| `push_frame`, nothing built (store only) |  19.2 |        52,077,000 |
| plain Python (deque + dict)              | 317.3 |         3,151,000 |

The same pushes in Rust alone take about 0.26 µs per event; one `push` call
from Python adds about 0.3 µs on top (reading the arguments, taking the
series' lock, building the result list), so one call per event runs at half
the speed of the hand-written loop. Batches pay most of that once per
batch, and a frame skips reading Python values altogether.

## Versions

The package carries pond-ts's version number and is released with it.
Wheels are abi3: one wheel per platform serves Python 3.9 and later.
