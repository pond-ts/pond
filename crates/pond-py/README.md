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
  text such as `"2026-03-08T12:00:00Z"`, or an int of milliseconds. A time
  with a part smaller than a millisecond is refused, not rounded.
- **Durations** are text (`"500ms"`, `"5s"`, `"5m"`, `"1h"`, `"1d"`) or a
  `timedelta`. In `rolling`, an int is a count of rows instead.
- **Reducers** are named per output column: `{"avg": ("cpu", "avg")}`, or
  `{"cpu": "avg"}` to reduce a column into itself. count, sum, avg, min, max,
  first, last, median, stdev, difference, keep, unique, samples, `top3`,
  `p95`, …
- **Errors** are `pond_rs.PondError` (a `ValueError`), naming the call and
  the column.
- **Python functions** work where a rule is yours: `filter(lambda row: …)`,
  `map(column, f)`, `scan(column, step, init)`, `collapse(...)`,
  `as_interval(lambda row: …)`. An exception inside one comes out as itself.
- **Threads:** every call lets go of Python's lock while it works, so calls
  from several Python threads run at the same time.

Type hints for every method are in the package (`pond_rs.pyi`).

## Speed

One million rows on a shared 4-core Linux VM, starting from a pyarrow table
and ending with a frame of each library's own kind (so getting data in and
out is counted). Median of 7 runs, milliseconds; `python bench/bench.py`
re-runs it.

| Case                                   | pond_rs | polars 2.1 | pandas 3.1 |
| -------------------------------------- | ------: | ---------: | ---------: |
| Round trip (in and out only)           |     7.8 |        0.4 |       10.5 |
| Rolling 5-minute average               |    35.5 |       39.1 |       85.7 |
| Aggregate into 1-minute buckets        |    11.6 |       14.7 |       22.9 |
| Daily buckets in New York              |    11.8 |        7.1 |       17.4 |
| `diff`                                 |    16.5 |        3.3 |       11.5 |
| Rolling 5 minutes per host (100 hosts) |   427.5 |      127.0 |      657.7 |

pond_rs's rolling and bucket results match polars's to within 1e-13. Getting
data in costs about 7 ms per million rows: the time column is copied and
checked (in order, in range), and each number column is scanned once for gaps.
So the cheapest operations (`diff`) are slower than polars. The per-host case
is slow in pond-rs itself, not in the bridge: putting 100 partitions back
together in time order takes about 300 ms in plain Rust too. That is logged to
be fixed in pond-rs.

## Versions

The package carries pond-ts's version number and is released with it.
Wheels are abi3: one wheel per platform serves Python 3.9 and later.
