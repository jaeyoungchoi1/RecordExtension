#!/usr/bin/env python3
"""Read-only multi-participant validation; reuses the original CSV contract."""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from urllib.parse import urlsplit

from validate_inputs import gaze_csv_path, validate

PIPELINE = Path(__file__).resolve().parent
DATA_ROOT = PIPELINE.parents[1]
LAUNCHER = "real-world-task-library.vercel.app"


def asset_path(folder: Path, relative: str) -> Path:
    path = (folder / relative).resolve()
    if not path.is_relative_to(folder.resolve()):
        raise ValueError(f"Asset escapes task folder: {relative}")
    return path


def inspect_user(root: Path, task: str) -> dict:
    folder = root / "task_logs" / task
    result = {"user": root.name, "task_id": task, "errors": [], "warnings": [],
              "target_states": 0, "usable_states": 0}
    try:
        original = validate(root / "task_logs", root / "mapped", [task])["tasks"][0]
        result["original_validation"] = original
        if not original["passed"]:
            result["errors"].append(str(original["missing_recorder_items"]) + " " + original["gaze_error"])
        with gaze_csv_path(root / "mapped", task).open(newline="") as handle:
            if "fixation id" not in (csv.DictReader(handle).fieldnames or []):
                result["errors"].append("fixation id column required; samples are not counted as fixations")
        events = [json.loads(line) for line in (folder / "events.jsonl").read_text().splitlines() if line.strip()]
        if not events or any(not isinstance(e.get("timestamp_ms"), (int, float)) for e in events):
            result["errors"].append("Missing or invalid event timestamps")
        for path in sorted((folder / "states").glob("*.json")):
            state = json.loads(path.read_text())
            if urlsplit(state.get("url", "")).hostname == LAUNCHER:
                continue
            result["target_states"] += 1
            try:
                for field in ("dom_snapshot_asset", "a11y_asset"):
                    asset = asset_path(folder, state[field]["file"])
                    if not asset.is_file():
                        raise ValueError(f"Missing {field}: {asset.name}")
                if not asset_path(folder, state["screenshot_file"]).is_file():
                    raise ValueError("Missing screenshot")
                view = state["viewport"]
                if min(float(view["width"]), float(view["height"]), float(view.get("device_pixel_ratio", 2))) <= 0:
                    raise ValueError("Invalid viewport")
                result["usable_states"] += 1
            except (KeyError, ValueError, TypeError) as error:
                result["warnings"].append(f"{path.name}: {error}")
        if not result["usable_states"]:
            result["warnings"].append("No usable target-site snapshots: commonality is not assessable for this user")
    except (OSError, ValueError, KeyError, TypeError) as error:
        result["errors"].append(str(error))
    result["passed"] = not result["errors"]
    return result


def add_inputs(parser: argparse.ArgumentParser):
    parser.add_argument("--data-root", type=Path, default=DATA_ROOT)
    parser.add_argument("--users", nargs="+", default=["User 1", "User 3", "User 4"])
    parser.add_argument("--tasks", nargs="+", default=[str(i) for i in range(1, 32)])


def resolve_inputs(args):
    root = args.data_root.expanduser().resolve()
    users = [(root / user).resolve() for user in args.users]
    if len(users) < 2 or len(set(users)) != len(users) or len({u.name for u in users}) != len(users):
        raise ValueError("Choose at least two distinct participant folders with unique names")
    tasks = sorted({f"{int(t):02d}" for t in args.tasks}, key=int)
    return users, tasks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_inputs(parser)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    users, tasks = resolve_inputs(args)
    reports = [inspect_user(u, t) for t in tasks for u in users]
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n")
    for r in reports:
        print(f"{r['user']} task{r['task_id']}: {'PASS' if r['passed'] else 'ERROR'}; "
              f"usable target states={r['usable_states']}; warnings={len(r['warnings'])}")
    return int(any(not r["passed"] for r in reports))


if __name__ == "__main__":
    raise SystemExit(main())
