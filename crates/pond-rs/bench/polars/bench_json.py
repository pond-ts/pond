"""polars side of examples/perf_json.rs: the same four series written as
JSON text and read back.

polars' `write_json` writes an array of row objects (pond's "object" rows)
and `read_json` reads it, given the schema. polars has no form of pond's
columns or points JSON, so those columns have no polars number.
"""

import io

import polars as pl

from common import run

NUMERIC = ["open", "high", "low", "close", "volume"]
SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"]


def make(rows, strings=False, sparse=False):
    cols = {"time": pl.Series([i * 1000 for i in range(rows)]).cast(pl.Datetime("ms"))}
    for name in NUMERIC:
        cols[name] = pl.Series([None if sparse and i % 10 == 0 else (i % 100) / 7 for i in range(rows)], dtype=pl.Float64)
    if strings:
        cols["symbol"] = [SYMBOLS[i % 4] for i in range(rows)]
    return pl.DataFrame(cols)


wide = pl.DataFrame(
    {"time": pl.Series([i * 1000 for i in range(10_000)]).cast(pl.Datetime("ms"))}
    | {f"c{c}": pl.Series([float((i + c) % 97) for i in range(10_000)]) for c in range(40)}
)
for label, s in [
    ("dense numeric (100k x 6)", make(100_000)),
    ("with a string column (100k x 7)", make(100_000, strings=True)),
    ("~10% gaps (100k x 6)", make(100_000, sparse=True)),
    ("wide (10k x 41)", wide),
]:
    text = s.write_json()
    run(
        [
            (f"{label} to_json object", lambda: s.write_json()),
            (f"{label} from_json", lambda: pl.read_json(io.StringIO(text), schema=s.schema)),
        ]
    )
