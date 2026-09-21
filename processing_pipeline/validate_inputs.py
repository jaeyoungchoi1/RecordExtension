#!/usr/bin/env python3
"""Validate a recorder bundle and its screen-mapped gaze files.

This validator intentionally starts after raw eye-tracker gaze has been
mapped into screen coordinates.  It checks the contract consumed by the 0819
component and episode builders without modifying any input or output files.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Iterable


PIPELINE_ROOT = Path(__file__).resolve().parent
DEFAULT_LOG_ROOT = PIPELINE_ROOT / "task_logs" / "User 1"
DEFAULT_MAPPED_ROOT = PIPELINE_ROOT / "mapped"
REQUIRED_GAZE_COLUMNS = {
    "timestamp [ns]",
    "gaze detected in reference image",
    "gaze position transf x [px]",
    "gaze position transf y [px]",
}


def normalized_task_ids(values: Iterable[str] | None, log_root: Path) -> list[str]:
    if values:
        return [f"{int(value):02d}" for value in values]
    task_paths = [path for path in log_root.iterdir() if path.is_dir() and path.name.isdigit()]
    return [f"{int(path.name):02d}" for path in sorted(task_paths, key=lambda item: int(item.name))]


def validate(log_root: Path, mapped_root: Path, task_ids: Iterable[str]) -> dict:
    rows = []
    for task_id in task_ids:
        task_dir = log_root / task_id
        gaze_path = mapped_root / f"task{task_id}_mapped_gaze.csv"
        missing = [name for name in ("session.json", "events.jsonl", "states") if not (task_dir / name).exists()]
        state_count = len(list((task_dir / "states").glob("*.json"))) if (task_dir / "states").exists() else 0
        gaze_error = ""
        mapped_rows = 0
        if not gaze_path.exists():
            gaze_error = "missing mapped gaze CSV"
        else:
            with gaze_path.open(newline="") as handle:
                reader = csv.DictReader(handle)
                columns = set(reader.fieldnames or [])
                absent = sorted(REQUIRED_GAZE_COLUMNS - columns)
                if absent:
                    gaze_error = f"missing gaze columns: {', '.join(absent)}"
                else:
                    mapped_rows = sum(1 for row in reader if row.get("gaze detected in reference image") == "True")
        rows.append({
            "task_id": task_id,
            "recorder_dir": str(task_dir),
            "mapped_gaze": str(gaze_path),
            "state_count": state_count,
            "mapped_sample_count": mapped_rows,
            "missing_recorder_items": missing,
            "gaze_error": gaze_error,
            "passed": not missing and state_count > 0 and not gaze_error,
        })
    return {
        "log_root": str(log_root),
        "mapped_root": str(mapped_root),
        "task_count": len(rows),
        "passed_count": sum(row["passed"] for row in rows),
        "failed_count": sum(not row["passed"] for row in rows),
        "tasks": rows,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate 0819 recorder and mapped-gaze inputs.")
    parser.add_argument("--log-root", type=Path, default=DEFAULT_LOG_ROOT)
    parser.add_argument("--mapped-root", type=Path, default=DEFAULT_MAPPED_ROOT)
    parser.add_argument("--tasks", nargs="*", help="Task IDs; omit for every numeric recorder folder")
    parser.add_argument("--report", type=Path, help="Optional path for the JSON validation report")
    args = parser.parse_args(argv)
    log_root = args.log_root.expanduser().resolve()
    mapped_root = args.mapped_root.expanduser().resolve()
    report = validate(log_root, mapped_root, normalized_task_ids(args.tasks, log_root))
    payload = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.expanduser().resolve().write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0 if report["failed_count"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
