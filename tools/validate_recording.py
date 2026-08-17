#!/usr/bin/env python3
"""Validate one GazeAware task recording folder."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import sys
from pathlib import Path


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def video_duration_ms(path: Path) -> float | None:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None


def png_dimensions(path: Path) -> tuple[int, int] | None:
    data = path.read_bytes()[:24]
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])
    result = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    try:
        return float(result.stdout.strip()) * 1000
    except ValueError:
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("task_dir", type=Path)
    parser.add_argument("--contract-smoke", action="store_true", help="Require all actions from the bundled smoke-test page.")
    args = parser.parse_args()
    root = args.task_dir.resolve()
    failures: list[str] = []

    session_path = root / "session.json"
    events_path = root / "events.jsonl"
    video_path = root / "screen.webm"
    qa_path = root / "qa.json"
    for path in (session_path, events_path, video_path, qa_path):
        if not path.is_file():
            failures.append(f"missing required file: {path.name}")
    if failures:
        return report(failures)

    session = load_json(session_path)
    qa = load_json(qa_path)
    events = []
    for number, line in enumerate(events_path.read_text(encoding="utf-8").splitlines(), start=1):
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as error:
            failures.append(f"invalid events.jsonl line {number}: {error}")

    states = sorted((root / "states").glob("state_*.json"))
    if session.get("status") != "completed":
        failures.append(f"session status is {session.get('status')!r}, not 'completed'")
    if not session.get("started_at") or not session.get("ended_at"):
        failures.append("session start/end timestamps are incomplete")
    if session.get("counts", {}).get("events") != len(events):
        failures.append("manifest event count differs from events.jsonl")
    if session.get("counts", {}).get("states") != len(states):
        failures.append("manifest state count differs from state files")
    if not qa.get("passed"):
        failures.append("qa.json does not pass")
    if video_path.stat().st_size <= 0:
        failures.append("screen.webm is empty")

    observed_state_ids = set()
    expected_viewport = session.get("viewport") or {}
    expected_size = (expected_viewport.get("width"), expected_viewport.get("height"))
    for state_path in states:
        state = load_json(state_path)
        state_id = state.get("state_id")
        observed_state_ids.add(state_id)
        for field in ("url", "screenshot_file", "html_asset", "css_asset", "dom_snapshot_asset", "a11y_asset"):
            if not state.get(field):
                failures.append(f"{state_path.name}: missing {field}")
        screenshot = root / str(state.get("screenshot_file", ""))
        dimensions = png_dimensions(screenshot) if screenshot.is_file() else None
        if dimensions is None:
            failures.append(f"{state_path.name}: invalid PNG screenshot")
        elif all(isinstance(value, int) for value in expected_size) and dimensions != expected_size:
            failures.append(f"{state_path.name}: screenshot {dimensions} differs from viewport {expected_size}")
        viewport = state.get("viewport") or {}
        state_size = (viewport.get("width"), viewport.get("height"))
        if all(isinstance(value, int) for value in expected_size) and state_size != expected_size:
            failures.append(f"{state_path.name}: state viewport {state_size} differs from manifest {expected_size}")
        scroll = state.get("scroll") or {}
        if not all(isinstance(scroll.get(axis), (int, float)) for axis in ("x", "y")):
            failures.append(f"{state_path.name}: scroll position is missing or non-numeric")
        for field in ("html_asset", "css_asset", "dom_snapshot_asset", "a11y_asset"):
            reference = state.get(field) or {}
            asset = root / str(reference.get("file", ""))
            if not asset.is_file():
                failures.append(f"{state_path.name}: missing asset {reference.get('file')}")
            elif reference.get("sha256") != sha256(asset):
                failures.append(f"{state_path.name}: hash mismatch for {reference.get('file')}")

    event_ids = [event.get("event_id") for event in events]
    expected_ids = [f"event_{number:06d}" for number in range(1, len(events) + 1)]
    if event_ids != expected_ids:
        failures.append("event IDs are not contiguous and ordered")
    for event in events:
        for field in ("event_id", "timestamp", "timestamp_ms", "type", "source", "tab_id", "document_id", "url", "viewport", "scroll"):
            if field not in event:
                failures.append(f"{event.get('event_id', '?')}: missing {field}")
        for state_field in ("state_before_id", "state_after_id"):
            value = event.get(state_field)
            if value is not None and value not in observed_state_ids:
                failures.append(f"{event.get('event_id')}: unknown {state_field} {value}")

    if args.contract_smoke:
        event_types = {event.get("type") for event in events}
        required = {"click", "change", "input", "submit", "scroll_down", "scroll_up", "spa_route_change"}
        for missing in sorted(required - event_types):
            failures.append(f"smoke test did not record event type: {missing}")
        if len(states) < 8:
            failures.append(f"smoke test expected at least 8 states, found {len(states)}")
        if not any(event.get("type") == "navigation_committed" for event in events):
            failures.append("smoke test did not record a full navigation")
        semantic_targets = [event for event in events if event.get("type") in {"click", "change", "submit"}]
        if not any(event.get("target", {}).get("dom_backend_node_id") for event in semantic_targets):
            failures.append("smoke test has no action target linked to a DOM backend node")

    duration = video_duration_ms(video_path)
    if duration is not None and duration <= 0:
        failures.append("ffprobe could not establish a positive video duration")
    if duration is not None and session.get("duration_ms"):
        if abs(duration - float(session["duration_ms"])) >= 5000:
            failures.append("video/session duration mismatch is at least 5 seconds")

    if failures:
        return report(failures)
    print(f"PASS: {root}")
    print(f"  events={len(events)} states={len(states)} video_bytes={video_path.stat().st_size}")
    if duration is not None:
        print(f"  ffprobe_duration_ms={duration:.1f}")
    else:
        print("  ffprobe_duration_ms=not_checked (ffprobe unavailable)")
    return 0


def report(failures: list[str]) -> int:
    print("FAIL")
    for failure in failures:
        print(f"  - {failure}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
