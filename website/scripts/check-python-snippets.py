#!/usr/bin/env python3
"""Run every Python example shown in a docs language tab, so the examples
cannot drift from the Python package (`import pond`).

Each ```python block inside a <TabItem value="python"> must be a whole
script: it runs on its own, in a fresh interpreter, and a failed assert
fails it. A block fenced as ```python ignore is skipped. Python blocks
outside a language tab (the Python page's short fragments) are not run
here, nor are the fit guides, whose blocks build on each other and are
run by check-fit-guides.mts (by hand: CI runs that
script with --no-python).

    python website/scripts/check-python-snippets.py          # every page
    python website/scripts/check-python-snippets.py creating  # pages whose path holds "creating"

Needs the package installed (`maturin develop -m crates/pond-py/Cargo.toml`
or a wheel), plus polars, pandas and pyarrow for examples that use them.
"""
import pathlib
import re
import subprocess
import sys
import tempfile

docs = pathlib.Path(__file__).resolve().parent.parent / "docs"
only = sys.argv[1:]
tab = re.compile(r'<TabItem value="python"[^>]*>(.*?)</TabItem>', re.S)
fence = re.compile(r"```python([^\n]*)\n(.*?)```", re.S)

n = failed = 0
with tempfile.TemporaryDirectory() as work:
    for page in sorted(docs.rglob("*.mdx")):
        rel = page.relative_to(docs).as_posix()
        if rel.startswith("fit/") or (only and not any(o in rel for o in only)):
            continue
        blocks = [m for t in tab.findall(page.read_text()) for m in fence.findall(t)]
        for i, (info, code) in enumerate(blocks, 1):
            if "ignore" in info.split():
                continue
            n += 1
            # Run from an empty directory, so a file next to the docs can't
            # shadow a module the example imports.
            script = pathlib.Path(work, "snippet.py")
            script.write_text(code)
            run = subprocess.run(
                [sys.executable, "-I", str(script)], cwd=work, capture_output=True, text=True
            )
            if run.returncode == 0:
                print(f"ok   {rel} #{i}")
            else:
                failed += 1
                print(f"FAIL {rel} #{i}\n{run.stderr.rstrip()}\n")
print(f"{n} snippets, {failed} failed")
sys.exit(1 if failed or not n else 0)
