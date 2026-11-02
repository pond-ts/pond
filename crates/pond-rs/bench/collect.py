"""Turn a compare_all.sh results directory into tables.

    python crates/pond-rs/bench/collect.py <results dir> [run.sh output] > tables.md

Rows timed on pond-rs alone (decimal columns, tiny JSON inputs) are left
out. Each cell is the median over repeats of each runner's own median time; the
range over repeats follows in brackets when it spans more than ±15%.
Also writes <results dir>/results.json with every number.
"""

import json
import re
import statistics
import sys
from pathlib import Path

ENGINES = ["pond-ts", "pond-rs-1t", "pond-rs-all", "polars-1t", "polars-all"]
HEAD = ["pond-ts", "pond-rs 1 core", "pond-rs 4 cores", "polars 1 core", "polars 4 cores"]
TITLES = {
    "rowwise": "Row-by-row operations (1M rows)",
    "partition": "Per-entity work: 500 symbols × 1000 bars",
    "grid": "Putting rows on a time grid: align, materialize, dedupe",
    "join": "Joins on time",
    "rolling": "Rolling windows",
    "smooth": "Smoothing, baseline, outliers, scan, sample",
    "reshape": "concat, collapse, pivot",
    "value_axis": "Binning by a number column (by_column, rolling_by_column)",
    "value_series": "ValueSeries (rows keyed by a number)",
    "reducers": "Reducers: aggregate / rolling / reduce",
    "array": "Array (list) columns, 100k rows",
    "json": "JSON text in and out",
}
TABLE = re.compile(r"^\|\s*(.+?)\s*\|\s*([\d.]+) ms\s*\|")
ARRAY = re.compile(r"^(typical|single)\s+(.+?)\s+([\d.]+) ms$")
JSON_PART = re.compile(r"([a-z_ ]+?) ([\d.]+) ms")


def parse(family, text):
    out = {}
    if family == "reducers":
        cols = []
        for line in text.splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if cells[0] == "Reducer":
                cols = cells[1:]
            elif cols and cells[0] != "---" and len(cells) == len(cols) + 1:
                for col, cell in zip(cols, cells[1:]):
                    if cell.endswith(" ms"):
                        out[f"{cells[0]}, {col}"] = float(cell[:-3])
        return out
    label = None
    for line in text.splitlines():
        m = TABLE.match(line)
        if m:
            out[re.sub(r"\s+", " ", m.group(1))] = float(m.group(2))
            continue
        m = ARRAY.match(line.strip())
        if m:
            out[f"{m.group(1)} {re.sub(r'\s+', ' ', m.group(2))}"] = float(m.group(3))
            continue
        if family == "json" and " ms" in line:
            if not line.startswith(" "):
                label, line = line.split(": ", 1)
            for op, ms in JSON_PART.findall(line):
                op = op.strip()
                op = "to_json object" if op == "object" else op
                out[f"{label} {op}"] = float(ms)
    return out


def fmt(ms):
    if ms is None:
        return "–"
    if ms >= 100:
        return f"{ms:,.0f}"
    if ms >= 10:
        return f"{ms:.0f}"
    if ms >= 1:
        return f"{ms:.1f}"
    return f"{ms:.2f}"


def cell(runs):
    if not runs:
        return "–", None
    m = statistics.median(runs)
    lo, hi = min(runs), max(runs)
    text = fmt(m)
    if m > 0 and (hi > m * 1.15 or lo < m * 0.85):
        text += f" ({fmt(lo)}–{fmt(hi)})"
    return text, m


def ratio(a, b):
    """How many times faster b is than a (a / b), in words."""
    if a is None or b is None:
        return "–"
    if a < 0.5 and b < 0.5:
        return "both <0.5 ms"
    if b < 0.05:
        return "pond-rs under 0.05 ms"
    if a < 0.05:
        return "other under 0.05 ms"
    r = a / b
    return f"{r:.1f}× faster" if r >= 1.05 else (f"{1 / r:.1f}× slower" if r <= 1 / 1.05 else "same")


def main():
    root = Path(sys.argv[1])
    data = {}
    for fam_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        fam = fam_dir.name
        rank = {"pond-rs-all": 0, "pond-rs-1t": 1, "pond-ts": 2}
        for f in sorted(fam_dir.glob("*-r*.txt"), key=lambda p: (rank.get(p.stem.rsplit("-r", 1)[0], 3), p.name)):
            engine, rep = f.stem.rsplit("-r", 1)
            for case, ms in parse(fam, f.read_text()).items():
                data.setdefault(fam, {}).setdefault(case, {}).setdefault(engine, []).append(ms)
    (root / "results.json").write_text(json.dumps(data, indent=1))
    print((root / "machine.txt").read_text() if (root / "machine.txt").exists() else "")
    order = [f for f in TITLES if f in data]
    for fam in order:
        print(f"\n### {TITLES[fam]}\n")
        print("Times in ms.\n")
        print(
            "| case | "
            + " | ".join(HEAD)
            + " | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |"
        )
        print("| --- " * (len(HEAD) + 4) + "|")
        for case, by in data[fam].items():
            if not by.get("pond-ts") and not by.get("polars-all"):
                continue  # pond-rs only: nothing to compare
            cells, meds = [], {}
            for e in ENGINES:
                t, m = cell(by.get(e))
                cells.append(t)
                meds[e] = m
            print(
                f"| {case} | "
                + " | ".join(cells)
                + f" | {ratio(meds['pond-ts'], meds['pond-rs-all'])}"
                + f" | {ratio(meds['polars-1t'], meds['pond-rs-1t'])}"
                + f" | {ratio(meds['polars-all'], meds['pond-rs-all'])} |"
            )


if __name__ == "__main__":
    main()
