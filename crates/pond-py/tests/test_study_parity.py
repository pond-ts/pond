"""pond_rs (Python) studies and trading calendars against pond-ts.

The fixtures the Rust crate's study tests read, run through the Python API:

- `study-parity.json`: `@pond-ts/financial` output, bit for bit (the Rust
  `tests/study_parity.rs`).
- `study-oracle.json`: pandas / TA-Lib, within 5e-10 (`study_oracle.rs`).
- `catalog-parity.json`: every descriptor equals pond-ts's, and every study
  runs with its defaults (`study_catalog.rs`).
- `calendar-parity.json`: trading calendars (`calendar_parity.rs`).

Inputs go in as pyarrow tables; outputs come out through `to_pyarrow`.
"""

from __future__ import annotations

import json
import math
import re
import zlib

import pyarrow as pa
import pytest

import pond_rs
from pond_rs import TimeSeries, TradingCalendar

from test_core_parity import REPO, cell_number, same_number, to_series

FIN = REPO / "packages/financial/test/fixtures"


def load(name):
    return json.loads((FIN / name).read_text())


def calendar(spec) -> TradingCalendar:
    """The fixture's way of writing a calendar: `{rules, from, to}`."""
    r = spec["rules"]
    return TradingCalendar.from_rules(
        r["timeZone"],
        r["open"],
        r["close"],
        spec["from"],
        spec["to"],
        weekmask=r.get("weekmask"),
        breaks=[(b["start"], b["end"]) for b in r.get("breaks", [])],
        holidays=r.get("holidays", []),
        early_closes={e["date"]: e["close"] for e in r.get("earlyCloses", [])},
    )


def call(series, study, options):
    """A study call written as pond-ts's name and options, half the time
    as `series.study(name, ...)` and half as the named method with Python
    spellings, so both doors are covered."""
    options = dict(options)
    if isinstance(options.get("sessions"), dict):
        options["sessions"] = calendar(options["sessions"])
    method = pond_rs.study_info(study)["method"]
    if zlib.crc32(json.dumps([study, options], default=str).encode()) % 2:
        return series.study(study, **options)
    snake = {"".join("_" + c.lower() if c.isupper() else c for c in k): v for k, v in options.items()}
    return getattr(series, method)(**snake)


def sources(study, options):
    """The columns a study reads with these options, from the catalog."""
    info = pond_rs.study_info(study)
    out = []
    for i in info["inputs"]:
        default = i.get("default")
        if study in ("atrBands", "prettyGoodOscillator") and i["role"] == "column":
            default = options.get("close", "close")
        if study == "medianPrice" and i["role"] == "close":
            continue  # pond-ts takes it and never reads it
        name = options.get(i["role"], default)
        if name is not None:
            out.append(name)
    return out


def unknown_options(study, options):
    """Option names the study does not have. pond-ts's types refuse them
    when the code compiles, and its runtime ignores them; pond_rs refuses
    them with a TypeError, as Python does for an unexpected keyword."""
    info = pond_rs.study_info(study)
    known = {i["role"] for i in info["inputs"]} | set(info["params"]) | {info["naming"]["kind"]}
    known |= {"session": {"session", "sessions", "stamped"}, "time": {"anchor"}}.get(info.get("anchor"), set())
    if study == "medianPrice":
        known.add("close")  # on pond-ts's options type, never read
    return [k for k in options if k not in known]


def numbers(table, name):
    return [math.nan if v is None else v for v in table.column(name).to_pylist()]


# ---------------------------------------------------------------------------
# @pond-ts/financial, bit for bit
# ---------------------------------------------------------------------------


def test_studies_match_pond_ts():
    fixture = load("study-parity.json")
    inputs = {name: to_series(s) for name, s in fixture["inputs"].items()}
    failures, counts = [], {"matched": 0, "errors": 0, "refused": 0, "unknown option": 0}
    for case in fixture["cases"]:
        label = f"{case['id']} {json.dumps(case['options'])}"
        s = inputs[case["input"]]
        if unknown_options(case["study"], case["options"]):
            try:
                call(s, case["study"], case["options"])
                failures.append(f"{label}: an option the study does not have was accepted")
            except TypeError:
                counts["unknown option"] += 1
            continue
        try:
            got = call(s, case["study"], case["options"])
        except pond_rs.PondError as e:
            got = e
        # Known difference: pond-rs refuses a missing or non-number source
        # column, where pond-ts reads it as all gaps.
        refused = any(
            c not in s.columns or s.schema[s.columns.index(c) + 1]["kind"] != "number"
            for c in sources(case["study"], case["options"])
        )
        expected = case.get("expected")
        if expected is None:
            if isinstance(got, Exception):
                counts["errors"] += 1
            else:
                failures.append(f"{label}: pond-ts throws ({case['error']['message']}), pond_rs succeeds")
            continue
        if refused:
            if isinstance(got, Exception):
                counts["refused"] += 1
            else:
                failures.append(f"{label}: pond_rs should refuse this source column")
            continue
        if isinstance(got, Exception):
            failures.append(f"{label}: pond_rs raised {got}")
            continue
        why = check_study(s, got, expected)
        if why:
            failures.append(f"{label}: {why}")
        else:
            counts["matched"] += 1
    print(f"study parity: {counts}")
    assert not failures, f"{len(failures)} of {len(fixture['cases'])} failed:\n" + "\n".join(failures[:40])
    # The Rust harness: 3,702 matched (here 3,680 + the 22 cases passing an
    # option the study does not have), 827 errors agree, 526 refused.
    assert counts == {"matched": 3680, "errors": 827, "refused": 526, "unknown option": 22}


def check_study(source: TimeSeries, got: TimeSeries, expected):
    n = len(source.columns)
    if got.columns[:n] != source.columns or len(got) != len(source):
        return "changed the input's columns or rows"
    added = got.schema[n + 1 :]
    if len(added) != len(expected):
        return f"added {len(added)} columns, pond-ts {len(expected)}"
    table = got.to_pyarrow()
    for d, want in zip(added, expected):
        if (d["name"], d["kind"], d["required"]) != (want["name"], want["kind"], want["required"]):
            return f"column {d}, pond-ts {want['name']} {want['kind']} required={want['required']}"
        have = numbers(table, d["name"])
        for i, cell in enumerate(want["values"]):
            e = cell_number(cell)
            if e is None:
                if not math.isnan(have[i]):
                    return f"{d['name']}[{i}]: expected a gap, got {have[i]!r}"
            elif not same_number(e, have[i], None):
                return f"{d['name']}[{i}]: expected {e!r}, got {have[i]!r}"
    return None


# ---------------------------------------------------------------------------
# pandas / TA-Lib oracle
# ---------------------------------------------------------------------------


def oracle_bars(fixture, case) -> TimeSeries:
    i = fixture["input"]
    which = case.get("input")
    if which == "long":
        cols = {"close": i["longCloses"]}
        times = list(range(len(i["longCloses"])))
    else:
        cols = {"open": i["opens"], "high": i["highs"], "low": i["lows"], "close": i["closes"], "volume": i["volumes"]}
        if which is None:
            cols["bench"] = i["benchmarks"]
            times = list(range(len(i["closes"])))
        else:
            times = [int(t) for t in i["sessionTimes"]]
    stamp = pa.timestamp("ms", tz="UTC")
    table = pa.table({"time": pa.array(times, pa.int64()).cast(stamp), **{k: pa.array(v, pa.float64()) for k, v in cols.items()}})
    return TimeSeries(table, name="oracle")


def test_studies_match_the_oracle():
    fixture = load("study-oracle.json")
    nyse = TradingCalendar.from_rules(
        "America/New_York", "09:30", "16:00", "2024-01-08", "2024-01-16", holidays=["2024-01-15"]
    )
    failures = []
    for case in fixture["cases"]:
        params = dict(case["params"])
        if case.get("input") == "session":
            params["sessions"] = nyse
        label = f"{case['study']}({json.dumps(case['params'])})"
        try:
            out = call(oracle_bars(fixture, case), case["study"], params).to_pyarrow()
        except pond_rs.PondError as e:
            failures.append(f"{label}: {e}")
            continue
        for name, want in case["expected"].items():
            have = numbers(out, name)
            for i, (e, a) in enumerate(zip(want, have)):
                if e is None:
                    if not math.isnan(a):
                        failures.append(f"{label}.{name}[{i}]: expected a gap, got {a}")
                        break
                elif math.isnan(a) or abs(e - a) > 5e-10:
                    failures.append(f"{label}.{name}[{i}]: expected {e}, got {a}")
                    break
    assert not failures, "\n".join(failures)
    assert len(fixture["cases"]) == 220


# ---------------------------------------------------------------------------
# The catalog
# ---------------------------------------------------------------------------


def test_descriptors_match_pond_ts():
    fixture = load("catalog-parity.json")
    mine = pond_rs.studies()
    assert [d["name"] for d in mine] == [d["name"] for d in fixture["studies"]]
    for d, want in zip(mine, fixture["studies"]):
        extra = {k: d.pop(k) for k in ("method", "output_names")}
        assert d == want, d["name"]
        assert extra["method"] == "".join("_" + c.lower() if c.isupper() else c for c in d["name"])


def catalog_bars(fixture) -> TimeSeries:
    rows = fixture["bars"]
    names = ["open", "high", "low", "close", "volume", "sess"]
    stamp = pa.timestamp("ms", tz="UTC")
    cols = {"time": pa.array([r[0] for r in rows], pa.int64()).cast(stamp)}
    for i, n in enumerate(names, start=1):
        cols[n] = pa.array([float(r[i]) for r in rows], pa.float64())
    return TimeSeries(pa.table(cols), name="bars")


def test_every_study_runs_from_its_method_with_defaults():
    fixture = load("catalog-parity.json")
    bars = catalog_bars(fixture)
    for d in pond_rs.studies():
        options = {}
        for i in d["inputs"]:
            if "default" not in i:
                options[i["role"]] = "open"
        for name, p in d["params"].items():
            if p.get("optional"):
                continue
            if "default" not in p:
                options[name] = p["example"]
        if d.get("anchor") == "session":
            options["session"] = "sess"
        elif d.get("anchor") == "time":
            options["anchor"] = fixture["bars"][30][0]
        snake = {"".join("_" + c.lower() if c.isupper() else c for c in k): v for k, v in options.items()}
        out = getattr(bars, d["method"])(**snake)
        assert out.columns == bars.columns + d["output_names"], d["name"]
        assert len(out) == len(bars)


def test_partitioned_studies_run_per_group():
    fixture = load("catalog-parity.json")
    bars = catalog_bars(fixture)
    syms = bars.with_column("sym", ["a" if i % 2 else "b" for i in range(len(bars))])
    per = syms.partition_by("sym").rsi(period=5).to_dict()
    assert sorted(per) == ["a", "b"]
    for key, part in per.items():
        alone = syms.filter(lambda r, k=key: r["sym"] == k).rsi(period=5)
        assert part.to_pyarrow().equals(alone.to_pyarrow()), key


def test_study_errors():
    fixture = load("catalog-parity.json")
    bars = catalog_bars(fixture)
    with pytest.raises(TypeError, match="unexpected option 'peroid'"):
        bars.rsi(peroid=5)
    with pytest.raises(pond_rs.PondError, match="not a study"):
        bars.study("nope")
    with pytest.raises(pond_rs.PondError, match="whole number of bars"):
        bars.rsi(period=2.5)
    with pytest.raises(pond_rs.PondError, match="finite"):
        bars.bollinger(period=20, std_dev=math.nan)
    with pytest.raises(AttributeError):
        bars.not_a_study
    with pytest.raises(AttributeError):
        bars.anchoredVwap  # only the Python spelling is a method
    assert bars.study("anchoredVwap", anchor=fixture["bars"][30][0]).columns[-1] == "avwap"
    assert "rsi" in dir(bars) and "anchored_vwap" in dir(bars)
    assert not hasattr(bars, "not_a_study")
    assert "relative strength" in bars.rsi.__doc__
    with pytest.raises(TypeError, match="twice"):
        bars.macd(fast_period=5, fastPeriod=50)
    np = pytest.importorskip("numpy")
    with pytest.raises(pond_rs.PondError, match="must be a number"):
        bars.rsi(period=np.bool_(True))
    with pytest.raises(pond_rs.PondError, match="must be a number"):
        bars.rsi(period=True)
    assert bars.rsi(period=np.int64(5)).column("rsi") == bars.rsi(period=5).column("rsi")


def test_calendar_dates_are_strict():
    np = pytest.importorskip("numpy")
    import datetime as dt

    nyse = TradingCalendar.from_rules("America/New_York", "09:30", "16:00", "2024-01-08", "2024-01-19", holidays=["2024-01-15"])
    for bad in ("Jan 12", "2024-01-12T10:00", "2024-1-12"):
        with pytest.raises(pond_rs.PondError, match="YYYY-MM-DD"):
            nyse.session_on(bad)
    with pytest.raises(pond_rs.PondError, match="YYYY-MM-DD"):
        nyse.is_trading_day("2024-01-12 ")
    # A date, however given, steps by trading day.
    for d in ("2024-01-12", dt.date(2024, 1, 12), np.datetime64("2024-01-12")):
        assert nyse.next_session(d)["date"] == "2024-01-16"
        assert nyse.previous_session(d)["date"] == "2024-01-11"
    assert nyse.session_on(np.datetime64("2024-01-12"))["date"] == "2024-01-12"
    # Other text is a time: 10:00 New York on the 12th is inside that session.
    assert nyse.next_session("2024-01-12T10:00-05:00")["date"] == "2024-01-16"
    assert nyse.previous_session("2024-01-12T10:00-05:00")["date"] == "2024-01-12"
    assert nyse.previous_session(dt.datetime(2024, 1, 12, 15, tzinfo=dt.timezone.utc))["date"] == "2024-01-12"


def test_session_studies_take_a_calendar_a_list_or_a_column():
    nyse = TradingCalendar.from_rules("America/New_York", "09:30", "16:00", "2024-01-08", "2024-01-12")
    times = [s["open"] + k * 1_800_000 for s in nyse.sessions for k in range(13)]
    n = len(times)
    stamp = pa.timestamp("ms", tz="UTC")
    bars = TimeSeries(
        pa.table(
            {
                "time": pa.array(times, pa.int64()).cast(stamp),
                "high": [101.0 + (i % 5) for i in range(n)],
                "low": [99.0 - (i % 3) for i in range(n)],
                "close": [100.0 + (i % 4) for i in range(n)],
                "volume": [1000.0 + i for i in range(n)],
            }
        )
    )
    by_calendar = bars.session_vwap(sessions=nyse).column("svwap")
    by_list = bars.session_vwap(sessions=nyse.sessions).column("svwap")
    by_column = nyse.tag_sessions(bars).session_vwap(session="session").column("svwap")
    assert by_calendar == by_list == by_column
    pivots = bars.pivot_points(sessions=nyse, method="camarilla")
    assert "ppR4" in pivots.columns


# ---------------------------------------------------------------------------
# Trading calendars
# ---------------------------------------------------------------------------


FOREIGN = ("Unrecognized time zone", "invalid RFC 9557 string", "value out of range", "withColumnAppended")


def outcome(case, run, expected):
    try:
        got = run()
    except pond_rs.PondError as e:
        if "expected" in case:
            return f"pond_rs raised {e}"
        want = case["error"]["message"]
        if want.startswith(FOREIGN) or want in str(e):
            return None
        return f"message differs: pond-ts {want!r}, pond_rs {e}"
    if "expected" not in case:
        return f"pond-ts throws ({case['error']['message']}), pond_rs gave {got!r}"
    want = expected(case["expected"])
    return None if got == want else f"got {got!r}\nwant {want!r}"


def sessions_of(v):
    return [{"date": s["date"], "open": s["open"], "close": s["close"], "breaks": s.get("breaks", [])} for s in v]


def test_calendars_match_pond_ts():
    cases = load("calendar-parity.json")["cases"]
    failures, counts = [], {}
    for case in cases:
        kind = case["kind"]
        counts[kind] = counts.get(kind, 0) + 1
        if kind == "generate":
            why = generate_case(case)
        elif kind == "sessions":
            why = outcome(case, lambda: TradingCalendar.from_sessions(case["sessions"]).sessions, sessions_of)
        elif kind == "queries":
            why = queries_case(case)
        elif kind == "tag":
            why = tag_case(case)
        else:
            raise AssertionError(f"unknown kind {kind}")
        if why:
            failures.append(f"{case.get('id', kind)}: {why}")
    print(f"calendar parity: {counts}")
    assert not failures, "\n".join(failures[:40])


def rules_kwargs(r):
    return dict(
        weekmask=r.get("weekmask"),
        breaks=[(b["start"], b["end"]) for b in r.get("breaks", [])],
        holidays=r.get("holidays", []),
        early_closes={e["date"]: e["close"] for e in r.get("earlyCloses", [])},
    )


def from_rules(case):
    r = case["rules"]
    return TradingCalendar.from_rules(r["timeZone"], r["open"], r["close"], case["from"], case["to"], **rules_kwargs(r))


def generate_case(case):
    # pond-ts generateSessions and fromRules differ only in fromRules
    # checking the list; the fixture records both outcomes.
    cal = case.get("calendar")
    try:
        got = from_rules(case)
    except pond_rs.PondError as e:
        if cal is True:
            return f"from_rules raised {e}"
        if isinstance(cal, dict) and cal["message"] not in str(e):
            return f"message differs: pond-ts {cal['message']!r}, pond_rs {e}"
        if cal is None and "expected" in case:
            return f"generate succeeds in pond-ts, from_rules raised {e}"
        return None
    if cal is not True:
        return f"fromRules throws ({cal}), from_rules succeeds"
    if got.time_zone != case["rules"]["timeZone"]:
        return "from_rules lost the zone"
    want = sessions_of(case["expected"])
    return None if got.sessions == want else f"sessions differ\n got {got.sessions[:2]}\n want {want[:2]}"


def queries_case(case):
    cal = from_rules(case) if "rules" in case else TradingCalendar.from_sessions(case["sessions"])
    if cal.sessions != sessions_of(case["sessions"]):
        return "calendar sessions differ"

    def date(s):
        return None if s is None else s["date"]

    for q in case["queries"]:
        c, a = q["call"], q["arg"]
        if isinstance(a, str) and not re.fullmatch(r"\d{4}-\d\d-\d\d", a):
            # Known difference: pond-ts compares any text with session dates
            # as strings ("" sorts first); pond_rs takes YYYY-MM-DD as a
            # date and reads other text as a time, so "" and "2024-01-08x"
            # are errors.
            try:
                getattr(cal, re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), c))(a)
            except pond_rs.PondError:
                continue
            return f"{c}({a!r}) should raise"
        if c == "length":
            got = len(cal)
        elif c == "sessionOn":
            got = date(cal.session_on(a))
        elif c == "isTradingDay":
            got = cal.is_trading_day(a)
        elif c == "nextSession":
            got = date(cal.next_session(a))
        elif c == "previousSession":
            got = date(cal.previous_session(a))
        elif c == "sessionContaining":
            got = date(cal.session_containing(a))
        elif c == "isOpen":
            got = cal.is_open(a)
        elif c == "sessionsInRange":
            got = [s["date"] for s in cal.sessions_in_range(a["start"], a["end"])]
        else:
            raise AssertionError(f"unknown query {c}")
        if got != q["result"]:
            return f"{c}({a}): got {got}, want {q['result']}"
    return None


def tag_case(case):
    cal = TradingCalendar.from_sessions(case["sessions"])
    keys = case["keys"]
    stamp = pa.timestamp("ms", tz="UTC")
    bars = TimeSeries(
        pa.table({"time": pa.array(keys, pa.int64()).cast(stamp), "close": [float(i) for i in range(len(keys))]}),
        name="bars",
    )
    o = case["options"]

    def run():
        tagged = cal.tag_sessions(bars, column=o.get("column", "session"), stamped=o.get("stamped", "open"))
        assert not tagged.schema[-1]["required"], "session ids are optional"
        return [None if v is None or (isinstance(v, float) and math.isnan(v)) else v for v in tagged.column(tagged.columns[-1])]

    return outcome(case, run, lambda want: [None if v is None else float(v) for v in want])
