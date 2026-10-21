"""polars side of examples/perf_array.rs: 100k rows with a text-list column
`tags`, a number-list column `nums` (a gap every tenth row) and `v`.

- contains: `list.contains`, keeping matching rows (as pond's filter).
- contains any / all: two `list.contains`, or-ed / and-ed.
- aggregate: `list.len` / `list.mean` / `list.median` / `list.first`.
- explode: `DataFrame.explode`, dropping empty and missing lists (as pond).
- JSON: polars `write_json` / `read_json` (an array of row objects; pond's
  rows are arrays, so the text differs, not the work).
- Arrow: `to_arrow` / `from_arrow` and IPC bytes, the two list columns
  alone, as pond-rs's rows.
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
            "time": pl.Series([i * 1000 for i in range(ROWS)]).cast(pl.Datetime("ms")).set_sorted(),
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
    text = s.write_json()
    lists = s.select("tags", "nums")
    arrow = lists.to_arrow()
    ipc = ipc_bytes(lists)

    def explode(c):
        return s.filter(pl.col(c).list.len() > 0).explode(c)

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
            (f"{name} toJSON", lambda: s.write_json()),
            (f"{name} fromJSON", lambda: pl.read_json(io.StringIO(text), schema=s.schema)),
            (f"{name} toArrow", lambda: lists.to_arrow()),
            (f"{name} fromArrow", lambda: pl.from_arrow(arrow)),
            (f"{name} writeIpc", lambda: ipc_bytes(lists)),
            (f"{name} readIpc", lambda: pl.read_ipc(io.BytesIO(ipc))),
        ]
    )
