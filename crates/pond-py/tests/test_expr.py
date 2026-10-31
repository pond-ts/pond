"""Expression uses the parity fixture does not reach: Python operators with
plain values on either side, `bool(expr)`, `map_columns` mixing expressions
and functions, and the JSON form."""

import json

import pytest

import pond_rs
from pond_rs import col, lit, when


@pytest.fixture
def s():
    return pond_rs.TimeSeries(
        {
            "time": [0, 1000, 2000, 3000],
            "v": [1.0, None, 3.0, -6.0],
            "w": [2.0, 4.0, 0.0, 3.0],
            "host": ["a", "b", "a", "c"],
        }
    )


def values(s, column):
    return s.to_pyarrow()[column].to_pylist()


def test_reflected_operators_keep_the_plain_value_on_its_side(s):
    assert values(s.with_column("r", 10 - col("v")), "r") == [9.0, None, 7.0, 16.0]
    assert values(s.with_column("r", 12 / col("w")), "r") == [6.0, 3.0, None, 4.0]
    assert values(s.with_column("r", 1 + col("v") * 2), "r") == [3.0, None, 7.0, -11.0]
    assert values(s.with_column("r", -col("v")), "r") == [-1.0, None, -3.0, 6.0]
    assert values(s.with_column("r", abs(col("v"))), "r") == [1.0, None, 3.0, 6.0]
    assert values(s.filter(True & (col("v") > 0)), "v") == [1.0, 3.0]
    assert values(s.filter(False | (col("host") == "c")), "host") == ["c"]
    assert values(s.filter(5 > col("v")), "v") == [1.0, 3.0, -6.0]


def test_gaps_follow_pond_ts(s):
    # A comparison with a gap is false, so != keeps the gap row.
    assert values(s.filter(col("v") != 1), "host") == ["b", "a", "c"]
    assert values(s.filter(~(col("v") > 0)), "host") == ["b", "c"]
    assert values(s.filter(col("v").is_missing()), "host") == ["b"]
    assert values(s.filter(col("host").is_in(["a", "c"])), "host") == ["a", "a", "c"]
    # map keeps a gap; with_column fills.
    assert values(s.map("v", col("v").fill(0)), "v") == [1.0, None, 3.0, -6.0]
    assert values(s.with_column("r", col("v").fill(0)), "r") == [1.0, 0.0, 3.0, -6.0]
    assert values(s.with_column("r", when(col("v") > 2, "big", "small")), "r") == [
        "small", "small", "big", "small",
    ]


def test_an_expr_has_no_truth_value():
    with pytest.raises(TypeError, match="no truth value"):
        bool(col("v") > 0)
    with pytest.raises(TypeError):
        (col("v") > 0) and (col("w") > 0)  # noqa: B015


def test_bad_operands_are_type_errors():
    with pytest.raises(TypeError):
        col("v") > float("nan")
    with pytest.raises(TypeError):
        lit([1, 2])
    # True is a true/false literal, not the number 1.
    assert json.loads((col("v") == True).to_json())["args"][1] == {"lit": True}  # noqa: E712


def test_map_columns_mixes_expressions_and_functions(s):
    # The expression reads v as it was before the function mapped it.
    out = s.map_columns({"v": lambda x: x * 10, "w": col("w") + col("v")})
    assert values(out, "v") == [10.0, None, 30.0, -60.0]
    assert values(out, "w") == [3.0, None, 3.0, -3.0]
    with pytest.raises(pond_rs.PondError):
        s.map_columns({})


def test_find_some_every(s):
    assert s.find(col("v") > 2).index == 2
    assert s.some(col("host") == "c")
    assert not s.every(col("v") > 0)


def test_json_round_trip_matches_pond_ts_shape():
    e = (col("v") / col("w") > 10) & (col("host") == "h3")
    tree = json.loads(e.to_json())
    assert tree == {
        "op": "and",
        "args": [
            {"op": "gt", "args": [{"op": "div", "args": [{"col": "v"}, {"col": "w"}]}, {"lit": 10.0}]},
            {"op": "eq", "args": [{"col": "host"}, {"lit": "h3"}]},
        ],
    }
    assert pond_rs.Expr.from_json(e.to_json()).to_json() == e.to_json()
