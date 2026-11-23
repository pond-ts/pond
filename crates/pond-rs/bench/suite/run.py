"""Run the six-engine benchmark suite and write results.json.

    python crates/pond-rs/bench/suite/run.py [--rows 1000000] [--engines a,b]
                                             [--rounds 5] [--out results.json]

Each round runs every engine once, in a different order each round, and a
case's time is the median over the rounds. One run of each engine is not
enough: on a shared or busy machine the same case on the same engine moves
by a third from one run to the next, more than many of the gaps being
measured. pondjs, a thousand times slower, runs in the first round only.

Engines: pond-rs, polars, wasm, pond-py, pond-ts, pondjs. An engine that is
not built or not installed is skipped and recorded as such; see README.md
for how to build each one.

The three engines that can use several cores (pond-rs, polars, pond-py) run
twice: with one thread, and with every core. The JavaScript engines run on
one thread, once.

Each case's answer (rows out, and the sum of its number columns) is compared
with pond-rs's on one thread, and recorded as `same: true / false`.
"""

import argparse
import datetime
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]

CASES = [
    ("agg_1m", "Buckets", "Average per minute"),
    ("roll_5m", "Rolling windows", "5-minute rolling average"),
    ("roll_20", "Rolling windows", "20-row rolling average"),
    ("roll_20_sd", "Rolling windows", "20-row rolling standard deviation"),
    ("roll_20_host", "Rolling windows", "20-row rolling average, per host"),
    ("roll_grid", "Rolling windows", "5-minute average onto a 1-second grid"),
    ("diff", "Row by row", "Change from the previous row"),
    ("fill", "Row by row", "Fill gaps with a straight line"),
    ("cumsum", "Row by row", "Running total"),
    ("filter", "Row by row", "Keep rows where v > 500"),
    ("add", "Row by row", "Add two columns"),
    ("align_hold", "Onto a time grid", "Align to 1 second, holding the last value"),
    ("align_linear", "Onto a time grid", "Align to 1 second, straight line between"),
    ("dedupe", "Onto a time grid", "Drop repeated times, keeping the last"),
    ("join_left", "Combining", "Left join of two series"),
    ("pivot", "Combining", "Pivot 100 hosts into columns"),
]

ENGINES = [
    ("pond-rs", "Pond Rust (pond-rs)"),
    ("polars", "Polars"),
    ("wasm", "@pond-ts/wasm"),
    ("pond-py", "Pond Python (pond-rs)"),
    ("pond-ts", "Pond TypeScript (pond-ts)"),
    ("pondjs", "pondjs"),
]
THREADED = {"pond-rs", "polars", "pond-py"}
# pondjs keeps every event as an object, and a million of them through five
# cases does not fit in one process's memory. So it gets a process per case.
ONE_CASE_PER_PROCESS = {"pondjs": ["agg_1m", "fill", "add", "align_hold", "align_linear"]}


def command(engine, rows):
    """The command for an engine, or a reason it cannot run."""
    if engine == "pond-rs":
        binary = ROOT / "target/release/examples/suite"
        if not binary.exists():
            return None, "not built: cargo build --release -p pond-rs --example suite"
        return [str(binary), str(rows)], None
    if engine in ("polars", "pond-py"):
        # pond-py's module is `pond` from 0.79, `pond_rs` before.
        module = "polars" if engine == "polars" else "pond"
        code = "import polars, numpy" + ("" if engine == "polars" else "\ntry:\n import pond\nexcept ImportError:\n import pond_rs")
        probe = subprocess.run([sys.executable, "-c", code], capture_output=True)
        if probe.returncode != 0:
            return None, f"python cannot import {module} (and polars, numpy)"
        return [sys.executable, str(HERE / "suite.py"), engine, str(rows)], None
    node = shutil.which("node")
    if node is None:
        return None, "node not found"
    if engine == "pond-ts":
        if not (ROOT / "packages/core/dist/index.js").exists():
            return None, "not built: npm run build --workspace=pond-ts"
        return [node, "--max-old-space-size=8192", str(HERE / "suite.mjs"), "pond-ts", str(rows)], None
    if engine == "wasm":
        if not (ROOT / "packages/rs/pkg/pond_wasm_bg.wasm").exists():
            return None, "not built: bash packages/rs/build.sh"
        return [node, "--max-old-space-size=8192", str(HERE / "suite.mjs"), "wasm", str(rows)], None
    if engine == "pondjs":
        if not (ROOT / "node_modules/pondjs").exists():
            return None, "not installed: npm ci"
        return [node, "--max-old-space-size=6000", str(HERE / "suite_pondjs.cjs"), str(rows)], None
    return None, "unknown engine"


def run(engine, rows, threads, timeout):
    cmd, why = command(engine, rows)
    if cmd is None:
        return {"skipped": why}
    env = dict(os.environ)
    if threads == 1:
        env["RAYON_NUM_THREADS"] = "1"
        env["POLARS_MAX_THREADS"] = "1"
    else:
        env.pop("RAYON_NUM_THREADS", None)
        env.pop("POLARS_MAX_THREADS", None)
    print(f"  {engine} ({'1 thread' if threads == 1 else 'all cores'}) ...", file=sys.stderr, flush=True)
    out = {"cases": {}, "version": ""}
    for only in ONE_CASE_PER_PROCESS.get(engine, [None]):
        try:
            done = subprocess.run(cmd + ([only] if only else []), capture_output=True, text=True, env=env, timeout=timeout)
            text = done.stdout
            if done.returncode != 0:
                out["error"] = (done.stderr or "").strip()[-400:]
                if only:
                    out["cases"][only] = {"failed": "stopped with an error (often: out of memory)"}
        except subprocess.TimeoutExpired as late:
            text = late.stdout.decode() if isinstance(late.stdout, bytes) else (late.stdout or "")
            out["error"] = f"stopped after {timeout} s"
        for line in text.splitlines():
            part = line.split("\t")
            if part[0] == "RESULT" and len(part) == 5:
                out["cases"][part[1]] = {"ms": float(part[2]), "rows": int(part[3]), "sum": float(part[4])}
            elif part[0] == "SKIP" and len(part) >= 3:
                out["cases"][part[1]] = {"failed": part[2]}
            elif part[0] == "VERSION":
                out["version"] = " ".join(part[2:])
    return out


def cpu():
    try:
        for line in open("/proc/cpuinfo"):
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    try:
        return subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
    except OSError:
        return platform.processor()


def git(*args):
    try:
        return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True).stdout.strip()
    except OSError:
        return ""


# Engines too slow to run more than once.
SLOW = {"pondjs"}


def merge(results):
    """One engine's rounds as one result: per case, the median time over the
    rounds it ran in, with every round's time kept, and the answer (rows,
    sum) of its first round."""
    first = results[0]
    if "skipped" in first:
        return first
    out = {"version": first.get("version", ""), "cases": {}}
    errors = [r["error"] for r in results if "error" in r]
    if errors:
        out["error"] = errors[0]
    for case in dict.fromkeys(c for r in results for c in r.get("cases", {})):
        cells = [r["cases"][case] for r in results if case in r.get("cases", {})]
        timed = [c for c in cells if "ms" in c]
        if not timed:
            out["cases"][case] = cells[0]
            continue
        times = [c["ms"] for c in timed]
        out["cases"][case] = {
            "ms": statistics.median(times),
            "rounds": times,
            "rows": timed[0]["rows"],
            "sum": timed[0]["sum"],
        }
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=1_000_000)
    parser.add_argument("--engines", default=",".join(e for e, _ in ENGINES))
    parser.add_argument("--out", default=str(HERE / "results.json"))
    parser.add_argument("--timeout", type=int, default=3600, help="seconds allowed per engine per run")
    parser.add_argument("--rounds", type=int, default=5, help="runs of each engine; times are the median")
    args = parser.parse_args()
    chosen = [e for e, _ in ENGINES if e in args.engines.split(",")]

    # Every round runs each engine (and each engine's all-cores run) once,
    # starting one further along the list each time, so no engine always
    # runs first or last.
    jobs = [(e, 1) for e in chosen] + [(e, 0) for e in chosen if e in THREADED]
    rounds = {"1": {}, "all": {}}
    for r in range(args.rounds):
        print(f"round {r + 1} of {args.rounds}", file=sys.stderr, flush=True)
        for engine, threads in jobs[r % len(jobs):] + jobs[: r % len(jobs)]:
            if engine in SLOW and r > 0:
                continue
            mode = "1" if threads == 1 else "all"
            rounds[mode].setdefault(engine, []).append(run(engine, args.rows, threads, args.timeout))
    runs = {mode: {e: merge(results) for e, results in per.items()} for mode, per in rounds.items()}

    # Answers are compared with pond-rs's on one thread.
    reference = runs["1"].get("pond-rs", {}).get("cases", {})
    for mode in runs.values():
        for result in mode.values():
            for case, cell in result.get("cases", {}).items():
                ref = reference.get(case)
                if ref is None or "ms" not in ref or "ms" not in cell:
                    continue
                close = abs(cell["sum"] - ref["sum"]) <= 1e-9 * max(1.0, abs(ref["sum"]))
                cell["same"] = cell["rows"] == ref["rows"] and close

    results = {
        "meta": {
            "date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "rows": args.rows,
            "cpu": cpu(),
            "cores": os.cpu_count(),
            "os": f"{platform.system()} {platform.release()} {platform.machine()}",
            "commit": git("rev-parse", "--short", "HEAD"),
            "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
            "timing": (
                f"per run, median of 7 calls after a warm-up (a call over 20 s, 5 s for pondjs, is timed once); "
                f"per case, median of {args.rounds} runs taken in alternating order (pondjs: 1 run)"
            ),
            "rounds": args.rounds,
        },
        "cases": [{"id": i, "group": g, "label": label} for i, g, label in CASES],
        "engines": [{"id": i, "label": label, "threaded": i in THREADED} for i, label in ENGINES],
        "runs": runs,
    }
    Path(args.out).write_text(json.dumps(results, indent=1) + "\n")
    print(f"wrote {args.out}", file=sys.stderr)

    # The same numbers as one flat row per (cores, case, engine), which is
    # the shape the dashboard reads.
    flat = []
    for mode in ("1", "all"):
        for case, group, label in CASES:
            for engine, engine_label in ENGINES:
                # An engine with one thread only has the same time in both views.
                result = runs[mode].get(engine) or (runs["1"].get(engine) if engine not in THREADED else None)
                if result is None:
                    continue
                cell = result.get("cases", {}).get(case)
                row = {"key": f"{mode}.{case}.{engine}", "threads": mode, "case": case, "group": group,
                       "case_label": label, "engine": engine, "engine_label": engine_label,
                       "ms": None, "ms_low": None, "ms_high": None, "same": "", "status": "ok"}
                if "skipped" in result:
                    row["status"] = "skipped"
                elif cell is None:
                    row["status"] = "none" if engine in ONE_CASE_PER_PROCESS else "failed"
                elif "ms" not in cell:
                    row["status"] = "failed"
                else:
                    def rounded(ms):
                        return round(ms) if ms >= 100 else round(ms, 1) if ms >= 10 else round(ms, 2)

                    row["ms"] = rounded(cell["ms"])
                    times = cell.get("rounds", [cell["ms"]])
                    row["ms_low"], row["ms_high"] = rounded(min(times)), rounded(max(times))
                    row["same"] = "yes" if cell.get("same", True) else "no"
                flat.append(row)
    side = Path(args.out)
    side.with_name(side.stem + "-flat.json").write_text(json.dumps(flat, indent=1) + "\n")
    side.with_name(side.stem + "-meta.json").write_text(json.dumps([results["meta"]], indent=1) + "\n")

    # A plain table of the one-thread run, for the terminal.
    width = max(len(label) for _, _, label in CASES)
    names = [e for e, _ in ENGINES if e in runs["1"]]
    print(f"{'ms, one thread':{width}}  " + "  ".join(f"{n:>9}" for n in names))
    for case, _, label in CASES:
        cells = []
        for name in names:
            cell = runs["1"][name].get("cases", {}).get(case)
            if cell is None:
                cells.append(f"{'-':>9}")
            elif "ms" not in cell:
                cells.append(f"{'failed':>9}")
            else:
                mark = "" if cell.get("same", True) else "*"
                cells.append(f"{cell['ms']:>8.1f}{mark or ' '}")
        print(f"{label:{width}}  " + "  ".join(cells))
    print("* a different answer from pond-rs (rows or sum)")


if __name__ == "__main__":
    main()
