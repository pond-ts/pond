#!/usr/bin/env python3
"""Write the Python API reference (website/docs/python/api/) from the package.

Signatures come from the package's type file, crates/pond-py/pond.pyi (what an
editor shows); descriptions from its docstrings, or, where the type file has
none, from the docstring the compiled package carries (written in the Rust
source). So the reference is the package's own account of itself, as the
TypeScript reference is TypeDoc's account of the TypeScript source.

    python website/scripts/gen-python-api.py          # rewrite the pages
    python website/scripts/gen-python-api.py --check  # exit 1 when they are stale

Needs the package installed (`import pond`), at the version of this checkout.
"""
from __future__ import annotations

import ast
import pathlib
import re
import sys

import pond

ROOT = pathlib.Path(__file__).resolve().parents[2]
STUB = ROOT / "crates/pond-py/pond.pyi"
OUT = ROOT / "website/docs/python/api"
STUDIES_BEGIN = "# --- studies"

tree = ast.parse(STUB.read_text())
source = STUB.read_text().splitlines()
classes = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}

# The study methods sit between two marker comments inside `class _Shared`.
study_lines = [i + 1 for i, line in enumerate(source) if STUDIES_BEGIN in line or "# --- end studies" in line]
STUDY_FIRST, STUDY_LAST = study_lines[0], study_lines[1]

# Descriptions for the few calls with no docstring anywhere: Python's own
# protocol methods, and the Expr spellings that are named for an operator.
DUNDER = {
    "__init__": None,
    "__len__": "`len(x)`: the number of rows (events, sessions, partitions).",
    "__iter__": "`for row in x`: every row in order, as a `Row`.",
    "__getitem__": "`x[i]` for one row (negative counts from the end), or `x[a:b]` for a new series of those rows; on a row or event, `x[\"column\"]` for one cell (`None` for a gap).",
}
OPERATOR = {
    "eq": "==", "ne": "!=", "gt": ">", "ge": ">=", "lt": "<", "le": "<=",
    "and_": "&", "or_": "|", "not_": "~", "add": "+", "sub": "-", "mul": "*",
    "div": "/", "neg": "-x", "abs": "abs(x)",
}


def runtime(owner: object, name: str) -> str | None:
    """The compiled package's docstring for `owner.name`, if it wrote one."""
    v = getattr(owner, name, None)
    if owner is None or v is None:
        return None
    doc = getattr(v, "__doc__", None)
    if not doc or not doc.strip():
        return None
    # Built-in fallbacks (property(), object.__init__ …) are not ours.
    # Skip the texts Python gives builtin slots (`__repr__`, `__len__`, ...),
    # not every docstring that happens to start with "Return".
    builtin = ("Return repr(self)", "Return hash(self)", "Return len(self)", "Return str(self)",
               "Return self", "Return iter(self)", "Return bool(self)", "Initialize self",
               "str(object", "Property attribute")
    if doc.startswith(builtin):
        return None
    return doc


def describe(cls_name: str | None, f: ast.FunctionDef) -> str:
    doc = ast.get_docstring(f)
    if not doc and cls_name:
        doc = runtime(getattr(pond, cls_name.lstrip("_"), None) or _runtime_owner(cls_name), f.name)
    if not doc and f.name in DUNDER:
        doc = DUNDER[f.name]
    if not doc and cls_name == "Expr" and f.name in OPERATOR:
        doc = f"The same as the `{OPERATOR[f.name]}` operator."
    return clean(doc or "")


def _runtime_owner(cls_name: str):
    # `_Shared` and `_LiveBase` are stub-only bases; their methods live on the
    # concrete classes at run time.
    return {"_Shared": pond.TimeSeries, "_LiveBase": pond.LiveSeries}.get(cls_name)


def clean(doc: str) -> str:
    """A docstring as MDX: indented examples become code blocks, and braces
    and angle brackets outside code are escaped."""
    import textwrap

    doc = textwrap.dedent(doc).strip()
    if not doc:
        return ""
    out, block = [], []
    for line in doc.splitlines() + [""]:
        if line.startswith("    "):
            block.append(line[4:])
            continue
        if block:
            out += ["", "```python", *block, "```", ""]
            block = []
        out.append(escape(line))
    return "\n".join(out).strip() + "\n"


def escape(text: str) -> str:
    parts = re.split(r"(`[^`]*`)", text)
    for i in range(0, len(parts), 2):
        parts[i] = (
            parts[i].replace("{", "\\{").replace("}", "\\}").replace("<", "&lt;").replace(">", "&gt;").replace("_", "\\_")
        )
    return "".join(parts)


def signature(owner: str | None, f: ast.FunctionDef) -> str:
    """`name(args) -> ret`, without `self`, with `Self` as the class."""
    args = f.args
    pos = args.posonlyargs + args.args
    if pos and pos[0].arg in ("self", "cls"):
        pos = pos[1:]
        is_method = True
    else:
        is_method = False
    shown = []
    defaults = [None] * (len(args.posonlyargs + args.args) - len(args.defaults)) + list(args.defaults)
    if is_method:
        defaults = defaults[1:]
    for i, a in enumerate(pos):
        shown.append(arg(a, defaults[i]))
        if args.posonlyargs and a is args.posonlyargs[-1]:
            shown.append("/")
    if args.vararg:
        shown.append("*" + arg(args.vararg, None))
    elif args.kwonlyargs:
        shown.append("*")
    for a, d in zip(args.kwonlyargs, args.kw_defaults):
        shown.append(arg(a, d))
    if args.kwarg:
        shown.append("**" + arg(args.kwarg, None))
    ret = ast.unparse(f.returns) if f.returns else "None"
    # `_Shared` methods keep `Self`: on a PartitionedSeries they return a
    # PartitionedSeries, so naming TimeSeries here would be wrong.
    concrete = {"_Shared": "Self", "_LiveBase": "LiveNode"}.get(owner or "", owner)
    ret = re.sub(r"\bSelf\b", concrete or "Self", ret)
    name = f.name
    one = f"{name}({', '.join(shown)}) -> {ret}"
    if len(one) <= 88:
        return one
    return f"{name}(\n" + "".join(f"    {s},\n" for s in shown) + f") -> {ret}"


def arg(a: ast.arg, default: ast.expr | None) -> str:
    s = a.arg
    if a.annotation is not None:
        s += ": " + ast.unparse(a.annotation)
    if default is not None:
        s += " = " + ast.unparse(default)
    return s


def is_property(f: ast.FunctionDef) -> bool:
    return any(isinstance(d, ast.Name) and d.id == "property" for d in f.decorator_list)


def is_static(f: ast.FunctionDef) -> bool:
    return any(isinstance(d, ast.Name) and d.id == "staticmethod" for d in f.decorator_list)


def is_overload(f: ast.FunctionDef) -> bool:
    return any(isinstance(d, ast.Name) and d.id == "overload" for d in f.decorator_list)


def public(f: ast.FunctionDef) -> bool:
    return not f.name.startswith("_") or f.name in DUNDER


def members(cls: str, *, studies: bool = False) -> list[ast.FunctionDef]:
    out, seen = [], set()
    for f in classes[cls].body:
        if not isinstance(f, ast.FunctionDef) or not public(f):
            continue
        in_block = STUDY_FIRST < f.lineno < STUDY_LAST
        if in_block != studies:
            continue
        if f.name in seen:  # overloads: one entry, the first signature's text
            continue
        seen.add(f.name)
        out.append(f)
    return out


def overloads(cls: str, name: str) -> list[ast.FunctionDef]:
    return [f for f in classes[cls].body if isinstance(f, ast.FunctionDef) and f.name == name]


def entry(owner: str, f: ast.FunctionDef, prefix: str) -> str:
    title = f.name if not is_property(f) else f.name
    kind = "property" if is_property(f) else ("static method" if is_static(f) else None)
    if f.name == "__init__":
        heading = f"{prefix}(...)"
        sig_name = prefix
    else:
        heading = f"{prefix}.{title}"
        sig_name = None
    lines = [f"### `{heading}`", ""]
    if kind:
        lines += [f"_{kind}_", ""]
    if is_property(f):
        ret = ast.unparse(f.returns) if f.returns else "Any"
        lines += ["```python", f"{f.name}: {ret}", "```", ""]
    else:
        sigs = [signature(owner, g) for g in overloads(owner, f.name)] if is_overload(f) else [signature(owner, f)]
        if sig_name:
            sigs = [s.replace("__init__", sig_name, 1).rsplit(" -> ", 1)[0] for s in sigs]
        lines += ["```python", *sigs, "```", ""]
    doc = describe(owner, f)
    if doc:
        lines += [doc]
    return "\n".join(lines).rstrip() + "\n"


def page(slug: str, title: str, position: int, description: str, intro: str, sections: list[tuple[str, list[str]]]) -> str:
    head = (
        "---\n"
        f"id: {slug}\n"
        f"title: {title}\n"
        f"sidebar_position: {position}\n"
        f"description: {description!r}\n"
        "---\n\n"
        "{/* Generated by website/scripts/gen-python-api.py from crates/pond-py/pond.pyi. Do not edit. */}\n\n"
        f"# {title}\n\n{intro.strip()}\n"
    )
    body = []
    for heading, entries in sections:
        if heading:
            body.append(f"\n## {heading}\n")
        body += ["\n" + e for e in entries]
    return head + "".join(body)


def cls_doc(name: str) -> str:
    d = ast.get_docstring(classes[name]) or runtime(pond, name) or ""
    return clean(d)


def build() -> dict[str, str]:
    pages: dict[str, str] = {}

    # The module: functions, errors, the type names the signatures use.
    aliases = []
    for n in tree.body:
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            name = n.targets[0].id
            if not name.startswith("_"):
                aliases.append(f"{name} = {ast.unparse(n.value)}")
    fns = [entry_fn(f) for name, f in functions.items() if not name.startswith("_") and name not in ("col", "lit", "when")]
    pages["index"] = page(
        "index",
        "Python API reference",
        1,
        "Every class, method and function of the pond Python package (pip install pond-timeseries), with its signature and what it does.",
        """
Every public class and function of the `pond` package
(`pip install pond-timeseries`), built from the type hints and docstrings
that ship with it, so it matches what your editor shows. For a guided
tour start at [pond for Python](../index.mdx).

| Page | What is on it |
| --- | --- |
| [TimeSeries](./timeseries.mdx) | The batch series: making one, reading it, every operation |
| [PartitionedSeries](./partitioned-series.mdx) | A series split by host or symbol; operations run per group |
| [ValueSeries](./value-series.mdx) | Rows keyed by a number (a distance, a strike price) |
| [Finance studies](./studies.mdx) | The 109 study methods with their options |
| [TradingCalendar](./trading-calendar.mdx) | Trading sessions, for the session studies |
| [Expressions](./expressions.mdx) | `col`, `lit`, `when` and `Expr`: row rules run inside the Rust core |
| [Sequence and Row](./sequence-and-row.mdx) | Bucket grids, and one row of a series |
| [LiveSeries](./live-series.mdx) | Events as they arrive, and the nodes built on them |
| [LiveNode, LiveEvent, LiveOutput](./live-nodes.mdx) | What a live series is built from and what a push returns |
""",
        [
            ("Functions", fns),
            ("Errors", [entry_class_only("PondError")]),
            (
                "Type names",
                [
                    "The signatures on these pages use these names:\n\n```python\n"
                    + "\n".join(aliases)
                    + "\n```\n\n`Time` is epoch milliseconds, a datetime (no time zone means UTC), a date or text such as `\"2026-03-08T12:00:00Z\"`. `Duration` is text (`\"500ms\"`, `\"5m\"`, `\"1h\"`, `\"1d\"`) or a timedelta. `Aggs` maps each output column to its source and reducer: `{\"avg\": (\"cpu\", \"avg\")}`.\n"
                ],
            ),
        ],
    )

    shared = members("_Shared")
    ts = members("TimeSeries")
    pages["timeseries"] = page(
        "timeseries",
        "TimeSeries",
        2,
        "pond.TimeSeries in Python: constructor, reading and writing frames, Arrow and JSON, finding rows, time spans, and every operation.",
        cls_doc("TimeSeries"),
        [
            ("Making, reading and writing", [entry("TimeSeries", f, "TimeSeries") for f in ts]),
            (
                "Operations",
                ["These also work on a [PartitionedSeries](./partitioned-series.mdx), where each runs per group. "
                 "`Self` in a signature means the kind of series you called it on: a TimeSeries "
                 "gives a TimeSeries, a PartitionedSeries gives a PartitionedSeries.\n"]
                + [entry("_Shared", f, "TimeSeries") for f in shared],
            ),
        ],
    )
    pages["partitioned-series"] = page(
        "partitioned-series",
        "PartitionedSeries",
        3,
        "pond.PartitionedSeries in Python: a series split by host, symbol or any column, with operations that run per group on several cores.",
        cls_doc("PartitionedSeries")
        + "\nMade by `TimeSeries.partition_by(columns)`. Every [TimeSeries operation](./timeseries.mdx#operations) and every [study](./studies.mdx) works on it too, per group; `collect()` puts the groups back together.\n",
        [("", [entry("PartitionedSeries", f, "PartitionedSeries") for f in members("PartitionedSeries")])],
    )
    pages["value-series"] = page(
        "value-series",
        "ValueSeries",
        4,
        "pond.ValueSeries in Python: rows keyed by a rising number such as a distance or a strike price.",
        cls_doc("ValueSeries") + "\nMade by `TimeSeries.by_value(axis)` or read from JSON or Arrow.\n",
        [("", [entry("ValueSeries", f, "ValueSeries") for f in members("ValueSeries")])],
    )
    pages["studies"] = page(
        "studies",
        "Finance studies",
        5,
        "The 109 finance study methods on a pond TimeSeries in Python, each with its options, defaults and output columns.",
        """
Each study is a method on [TimeSeries](./timeseries.mdx) and
[PartitionedSeries](./partitioned-series.mdx). It adds its columns and
keeps every row (gaps until its window fills). It returns the same kind
of series it was called on, written `Self` below. `s.study(name, **options)`
runs one by name, and `pond.studies()` / `pond.study_info(name)` describe
them at run time. The guide is [Finance studies in Python](../finance.mdx).
""",
        [("", [entry("_Shared", f, "TimeSeries") for f in members("_Shared", studies=True)])],
    )
    pages["trading-calendar"] = page(
        "trading-calendar",
        "TradingCalendar",
        6,
        "pond.TradingCalendar in Python: exchange sessions from rules or a list, lookups over them, and tagging bars with their session.",
        cls_doc("TradingCalendar"),
        [
            ("", [entry("TradingCalendar", f, "TradingCalendar") for f in members("TradingCalendar")]),
            ("Session", [typed_dict("Session"), typed_dict("SessionBreak")]),
        ],
    )
    pages["expressions"] = page(
        "expressions",
        "Expressions",
        7,
        "col, lit, when and Expr in the pond Python package: per-row rules for filter, with_column and map that run inside the Rust core.",
        cls_doc("Expr"),
        [
            ("Building one", [entry_fn(functions[n]) for n in ("col", "lit", "when")]),
            ("Expr", [entry("Expr", f, "Expr") for f in members("Expr")]),
        ],
    )
    pages["sequence-and-row"] = page(
        "sequence-and-row",
        "Sequence and Row",
        8,
        "pond.Sequence (bucket grids: fixed steps or calendar units in a time zone) and pond.Row (one row of a series) in Python.",
        "A `Sequence` is the grid that `aggregate`, `align` and `materialize` bucket by; a `Row` is what reading one row of a series gives you.",
        [
            ("Sequence", [cls_doc("Sequence")] + [entry("Sequence", f, "Sequence") for f in members("Sequence")]),
            ("Row", [cls_doc("Row")] + [entry("Row", f, "row") for f in members("Row")]),
        ],
    )
    pages["live-series"] = page(
        "live-series",
        "LiveSeries",
        9,
        "pond.LiveSeries in Python: push events, batches and frames as they arrive, and build live filters, buckets, rolling windows and partitions on them.",
        cls_doc("LiveSeries"),
        [
            ("LiveSeries", [entry("LiveSeries", f, "LiveSeries") for f in members("LiveSeries")]),
            (
                "Building and reading nodes",
                [cls_doc("_LiveBase")] + [entry("_LiveBase", f, "node") for f in members("_LiveBase")],
            ),
        ],
    )
    pages["live-nodes"] = page(
        "live-nodes",
        "LiveNode, LiveEvent, LiveOutput",
        10,
        "pond.LiveNode, LiveEvent and LiveOutput in Python: the nodes of a live series, one event, and what each push returns.",
        "A `LiveNode` has everything under [Building and reading nodes](./live-series.mdx#building-and-reading-nodes) as well as what is on this page.",
        [
            ("LiveNode", [cls_doc("LiveNode")] + [entry("LiveNode", f, "node") for f in members("LiveNode")]),
            ("LiveEvent", [cls_doc("LiveEvent")] + [entry("LiveEvent", f, "event") for f in members("LiveEvent")]),
            ("LiveOutput", [cls_doc("LiveOutput")] + [entry("LiveOutput", f, "output") for f in members("LiveOutput")]),
        ],
    )
    return pages


def entry_fn(f: ast.FunctionDef) -> str:
    return "\n".join(
        [f"### `pond.{f.name}`", "", "```python", signature(None, f), "```", "", describe(None, f) or runtime(pond, f.name) or ""]
    ).rstrip() + "\n"


def entry_class_only(name: str) -> str:
    base = ", ".join(ast.unparse(b) for b in classes[name].bases)
    return f"### `pond.{name}`\n\n```python\nclass {name}({base})\n```\n\n{cls_doc(name)}"


def typed_dict(name: str) -> str:
    fields = [ast.unparse(n) for n in classes[name].body if isinstance(n, ast.AnnAssign)]
    return f"### `{name}`\n\nA dict with these keys.\n\n```python\n" + "\n".join(fields) + "\n```\n\n" + cls_doc(name)


def main() -> int:
    check = "--check" in sys.argv[1:]
    pages = build()
    stale = []
    for slug, text in pages.items():
        path = OUT / f"{slug}.mdx"
        if check:
            if not path.exists() or path.read_text() != text:
                stale.append(path)
        else:
            OUT.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
    extra = [p for p in OUT.glob("*.mdx") if p.stem not in pages] if OUT.exists() else []
    if check and (stale or extra):
        for p in stale + extra:
            print(f"stale: {p.relative_to(ROOT)}")
        print("Run: python website/scripts/gen-python-api.py")
        return 1
    for p in extra:
        p.unlink()
    print(f"{len(pages)} pages {'up to date' if check else 'written'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
