"""Trusted capture of transient generator diagnostics.

Some external generators write their most useful rejection evidence into a
temporary working directory that is removed before their Python call returns.
This module observes that directory while the pinned tool runs and retains only
small, structured counters.  It does not modify generator outputs or scoring.
"""

from __future__ import annotations

import csv
import os
import shutil
import threading
from collections import Counter
from pathlib import Path
from typing import Any


def _nonzero(value: str | None) -> bool:
    if value is None or not value.strip():
        return False
    try:
        return float(value) != 0
    except ValueError:
        return value.strip().lower() not in {"false", "none", "nan", "n/a"}


def _numeric(value: str | None) -> int:
    if value is None:
        return 0
    try:
        return max(0, int(float(value)))
    except ValueError:
        return 0


class GeneratorDiagnosticsCapture:
    """Watch an isolated TMPDIR and summarize known generator diagnostics."""

    _REJECTED = "rejected_mpnn_full_stats.csv"
    _FAILURES = "failure_csv.csv"
    _TRAJECTORIES = "trajectory_stats.csv"
    _ACCEPTED = "final_design_stats.csv"
    _KNOWN = {_REJECTED, _FAILURES, _TRAJECTORIES, _ACCEPTED}

    def __init__(self, output: Path, enabled: bool) -> None:
        self.enabled = enabled
        self.root = output / ".generator-diagnostics-tmp"
        self._snapshots: dict[str, tuple[str, list[dict[str, str]]]] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._previous_tmpdir: str | None = None

    def __enter__(self) -> GeneratorDiagnosticsCapture:
        if not self.enabled:
            return self
        self.root.mkdir(parents=True, exist_ok=True)
        self._previous_tmpdir = os.environ.get("TMPDIR")
        os.environ["TMPDIR"] = str(self.root)
        self._thread = threading.Thread(target=self._watch, name="autofold-generator-diagnostics", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        if not self.enabled:
            return
        self.scan()
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        if self._previous_tmpdir is None:
            os.environ.pop("TMPDIR", None)
        else:
            os.environ["TMPDIR"] = self._previous_tmpdir
        shutil.rmtree(self.root, ignore_errors=True)

    def _watch(self) -> None:
        while not self._stop.wait(0.1):
            self.scan()

    def scan(self) -> None:
        """Take a best-effort snapshot; partial CSV writes are retried later."""
        if not self.enabled or not self.root.exists():
            return
        for path in self.root.rglob("*.csv"):
            if path.name not in self._KNOWN:
                continue
            try:
                with path.open("r", encoding="utf-8", newline="") as handle:
                    rows = list(csv.DictReader(handle))
            except (OSError, UnicodeError, csv.Error):
                continue
            if not rows:
                continue
            with self._lock:
                self._snapshots[str(path)] = (path.name, rows)

    def summary(self) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        rejected = 0
        trajectories = 0
        accepted = 0
        rejection_filters: Counter[str] = Counter()
        trajectory_filters: Counter[str] = Counter()
        sources: set[str] = set()
        with self._lock:
            snapshots = list(self._snapshots.values())
        for name, rows in snapshots:
            sources.add(name)
            if name == self._REJECTED:
                rejected += len(rows)
                for row in rows:
                    for field, value in row.items():
                        if field.lower() in {"design", "sequence", "name", "id"}:
                            continue
                        if _nonzero(value):
                            rejection_filters[field] += 1
            elif name == self._FAILURES:
                for row in rows:
                    for field, value in row.items():
                        count = _numeric(value)
                        if count:
                            trajectory_filters[field] += count
            elif name == self._TRAJECTORIES:
                trajectories += len(rows)
            elif name == self._ACCEPTED:
                accepted += len(rows)
        if not sources:
            return []
        return [{
            "format": "autofold.generator-diagnostics.v1",
            "generator": "freebindcraft",
            "rejectedCandidates": rejected,
            "rejectionFilters": dict(sorted(rejection_filters.items())),
            "trajectoryFailures": sum(trajectory_filters.values()),
            "trajectoryFailureFilters": dict(sorted(trajectory_filters.items())),
            "trajectoriesObserved": trajectories,
            "acceptedCandidates": accepted,
            "sourceFiles": sorted(sources),
        }]


__all__ = ["GeneratorDiagnosticsCapture"]
