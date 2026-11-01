"""polars side of examples/perf_array.rs: 100k rows with a text-list column
`tags`, a number-list column `nums` (a gap every tenth row) and `v`.

- contains: `list.contains`, keeping matching rows (as pond's filter).
- contains any / all: two `list.contains`, or-ed / and-ed.
- aggregate: `list.len` / `list.mean` / `list.median` / `list.first`; a
  gap row (no list) gives a gap, as pond.
- explode: `DataFrame.explode(empty_as_null=False, keep_nulls=False)`, which
  drops empty and missing lists (as pond) in the one call.
- JSON: polars `write_json` / `read_json` write and read one object per row,
  so they are compared with pond's object rows (`toJSON object` /
  `fromJSON object`), with the time stored as epoch milliseconds (an
  `Int64` column) so both write and read the same numbers. pond's own array
  rows (`toJSON` / `fromJSON`) have no polars counterpart.
- Arrow: `to_arrow` / `from_arrow` and IPC bytes of the time column and the
  two list columns, as pond-rs's (its `select` keeps the time key).
- Each case's answer is checked against pond-rs's (`../check_outputs.py`).
"""

import io

import polars as pl

from common import run

ROWS = 100_000
words = [f"w{w}" for w in range(20)]


def make(single):
    tags, nums = [], []
    for i in range(ROWS):
        if i % 10 == 9:
            tags.append(None)
            nums.append(None)
            continue
        t = 1 if single else i % 7
        n = 1 if single else i % 9
        tags.append([words[(i * 7 + k * 3) % 20] for k in range(t)])
        nums.append([((i * 31 + k * 17) % 1000) / 8 for k in range(n)])
    return pl.DataFrame(
        {
            "time": pl.Series([i * 1000 for i in range(ROWS)]).cast(pl.Datetime("ms", "UTC")).set_sorted(),
            "tags": pl.Series(tags, dtype=pl.List(pl.String)),
            "nums": pl.Series(nums, dtype=pl.List(pl.Float64)),
            "v": pl.Series([float(i) for i in range(ROWS)]),
        }
    )


tags, nums = pl.col("tags"), pl.col("nums")


def ipc_bytes(df):
    b = io.BytesIO()
    df.write_ipc(b, compression="uncompressed")
    return b.getvalue()


for name, single in (("typical", False), ("single", True)):
    s = make(single)
    js = s.with_columns(pl.col("time").dt.epoch("ms"))  # times as numbers
    text = js.write_json()
    lists = s.select("time", "tags", "nums")
    arrow = lists.to_arrow()
    ipc = ipc_bytes(lists)

    def explode(c):
        return s.explode(c, empty_as_null=False, keep_nulls=False)

    run(
        [
            (f"{name} contains", lambda: s.filter(tags.list.contains("w3"))),
            (f"{name} containsAny", lambda: s.filter(tags.list.contains("w1") | tags.list.contains("w4"))),
            (f"{name} containsAll", lambda: s.filter(tags.list.contains("w1") & tags.list.contains("w4"))),
            (f"{name} aggregate count", lambda: s.with_columns(nums.list.len())),
            (f"{name} aggregate avg", lambda: s.with_columns(nums.list.mean())),
            (f"{name} aggregate median", lambda: s.with_columns(nums.list.median())),
            (f"{name} aggregate first", lambda: s.with_columns(tags.list.first())),
            (f"{name} explode tags", lambda: explode("tags")),
            (f"{name} explode nums", lambda: explode("nums")),
            (f"{name} toJSON object", lambda: js.write_json()),
            (f"{name} fromJSON object", lambda: pl.read_json(io.StringIO(text), schema=js.schema)),
            (f"{name} toArrow", lambda: lists.to_arrow()),
            (f"{name} fromArrow", lambda: pl.from_arrow(arrow)),
            (f"{name} writeIpc", lambda: ipc_bytes(lists)),
            (f"{name} readIpc", lambda: pl.read_ipc(io.BytesIO(ipc))),
        ]
    )
