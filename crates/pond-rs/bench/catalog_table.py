"""Join the catalog benchmark runs into one markdown table.

    python3 crates/pond-rs/bench/catalog_table.py ts.jsonl rs4.jsonl rs1.jsonl

Each file holds one JSON line per study (bench/catalog_pond_ts.mjs,
examples/perf_catalog.rs on all cores and with RAYON_NUM_THREADS=1).
"""
import json
import statistics
import sys


def load(path):
    with open(path) as f:
        return {r["study"]: r for r in map(json.loads, f) if r}


ts, rs4, rs1 = (load(p) for p in sys.argv[1:4])
print("| study | 1 thread | 4 cores | pond-ts | ratio | bits |")
print("| --- | --- | --- | --- | --- | --- |")
ratios, mismatches = [], []
for name, t in ts.items():
    a, b = rs1[name], rs4[name]
    ratio = t["ms"] / b["ms"]
    ratios.append(ratio)
    same = t["hash"] == a["hash"] == b["hash"]
    if not same:
        mismatches.append(name)
    print(
        f"| {name} | {a['ms']:.1f} | {b['ms']:.1f} | {t['ms']:.1f} | {ratio:.1f}x | {'same' if same else 'DIFF'} |"
    )
print()
print(
    f"{len(ratios)} studies; ratio min {min(ratios):.1f}x, median {statistics.median(ratios):.1f}x, max {max(ratios):.1f}x; bits differ: {mismatches or 'none'}"
)
