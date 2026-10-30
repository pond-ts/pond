"""The study methods in pond_rs.pyi match the catalog."""

import subprocess
import sys
from pathlib import Path


def test_study_stubs_are_current():
    script = Path(__file__).resolve().parents[1] / "scripts" / "gen_stubs.py"
    run = subprocess.run([sys.executable, str(script), "--check"], capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + run.stderr
