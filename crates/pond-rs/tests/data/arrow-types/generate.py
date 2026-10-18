"""Arrow files written by pyarrow and polars, for tests/arrow_types.rs.

Each file has a `time` key (Timestamp ms, 3 rows) and one value column `v`
of the type under test, and `expected.json` gives what pond-rs must read `v`
as: numbers in milliseconds for time types, null for a gap. The expected
values are worked out here from the raw inputs, not by reading the files back.

Run from this folder with pyarrow and polars installed:
    python generate.py
"""

import datetime as dt
import json

import polars as pl
import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.ipc as ipc

TIME = pa.array([0, 1000, 2000], pa.timestamp("ms", tz="UTC"))
NUMBERS = pa.array([1.5, None, -2.0], pa.float64())
EXPECTED = {}


def table(v):
    return pa.table({"time": TIME, "v": v})


def write_file(name, v, expected, compression=None):
    with ipc.new_file(
        f"{name}.arrow",
        table(v).schema,
        options=ipc.IpcWriteOptions(compression=compression),
    ) as w:
        w.write_table(table(v))
    EXPECTED[name] = expected


# Layouts and compression (the values are plain float64).
numbers = [1.5, None, -2.0]
feather.write_feather(table(NUMBERS), "feather_lz4.arrow")  # LZ4 is the default
EXPECTED["feather_lz4"] = numbers
write_file("zstd", NUMBERS, numbers, compression="zstd")
with ipc.new_stream("stream.arrows", table(NUMBERS).schema) as w:
    # two batches, so the stream reader joins them
    for batch in table(NUMBERS).to_batches(max_chunksize=2):
        w.write_batch(batch)
EXPECTED["stream"] = numbers
pl.from_arrow(table(NUMBERS)).write_ipc("polars_zstd.arrow", compression="zstd")
EXPECTED["polars_zstd"] = numbers

# Time types as value columns: milliseconds, fractions kept.
write_file(
    "timestamp_us",
    pa.array([1_500, None, -1_500], pa.timestamp("us", tz="UTC")),
    [1.5, None, -1.5],
)
write_file(
    "timestamp_ns",
    pa.array([1_700_000_000_000_000_000, 250_000, None], pa.timestamp("ns")),
    [1_700_000_000_000.0, 0.25, None],
)
write_file("timestamp_s", pa.array([1, 2, None], pa.timestamp("s")), [1000, 2000, None])
write_file(
    "date32",
    pa.array([dt.date(1970, 1, 2), None, dt.date(1969, 12, 31)], pa.date32()),
    [86_400_000, None, -86_400_000],
)
write_file("date64", pa.array([86_400_000, None, 0], pa.date64()), [86_400_000, None, 0])
write_file("time32_ms", pa.array([1, 60_000, None], pa.time32("ms")), [1, 60_000, None])
write_file("time64_ns", pa.array([1_000_000, 1, None], pa.time64("ns")), [1, 0.000001, None])
write_file(
    "duration_us",
    pa.array([2_000, -500, None], pa.duration("us")),
    [2, -0.5, None],
)

# Cheap extras.
write_file("null", pa.nulls(3), [None, None, None])
write_file("float16", pa.array([0.5, None, -2.0], pa.float16()), [0.5, None, -2.0])
write_file(
    "int_dictionary",
    pa.DictionaryArray.from_arrays(
        pa.array([1, None, 0], pa.int8()), pa.array([7, 9], pa.int64())
    ),
    [9, None, 7],
)

with open("expected.json", "w") as f:
    json.dump(EXPECTED, f, indent=1, sort_keys=True)
    f.write("\n")
