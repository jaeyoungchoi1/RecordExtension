#!/usr/bin/env python3
"""Exercise validate_recording.py with a complete temporary smoke fixture."""

from __future__ import annotations

import hashlib
import base64
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> int:
    validator = Path(__file__).with_name("validate_recording.py")
    with tempfile.TemporaryDirectory(prefix="gazeaware-validator-") as temporary:
        root = Path(temporary)
        (root / "states").mkdir()
        asset_paths = {}
        for kind, suffix, content in (
            ("dom", "html", b"<!doctype html><button>Test</button>"),
            ("css", "css", b"button { color: black; }"),
            ("dom_snapshot", "json", b'{"documents":[],"strings":[]}'),
            ("ax", "json", b'{"nodes":[]}'),
        ):
            digest = hashlib.sha256(content).hexdigest()
            directory = root / "assets" / kind
            directory.mkdir(parents=True)
            path = directory / f"{digest}.{suffix}"
            path.write_bytes(content)
            asset_paths[kind] = {"sha256": digest, "file": str(path.relative_to(root))}

        for number in range(1, 9):
            state_id = f"state_{number:04d}"
            screenshot = root / "states" / f"{state_id}.png"
            screenshot.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
            state = {
                "state_id": state_id,
                "url": "http://127.0.0.1:8765/",
                "viewport": {"width": 1, "height": 1},
                "scroll": {"x": 0, "y": 0},
                "screenshot_file": str(screenshot.relative_to(root)),
                "html_asset": asset_paths["dom"],
                "css_asset": asset_paths["css"],
                "dom_snapshot_asset": asset_paths["dom_snapshot"],
                "a11y_asset": asset_paths["ax"],
            }
            (root / "states" / f"{state_id}.json").write_text(json.dumps(state), encoding="utf-8")

        event_types = [
            "session_start", "click", "change", "input", "submit", "scroll_down",
            "scroll_up", "spa_route_change", "navigation_committed", "checkpoint_created",
        ]
        events = []
        for number, event_type in enumerate(event_types, start=1):
            event = {
                "event_id": f"event_{number:06d}",
                "timestamp": "2026-08-15T00:00:00.000Z",
                "timestamp_ms": number,
                "type": event_type,
                "source": "test",
                "tab_id": 1,
                "document_id": "tab_1_document_1",
                "url": "http://127.0.0.1:8765/",
                "viewport": {"width": 1, "height": 1},
                "scroll": {"x": 0, "y": 0},
                "state_before_id": None,
                "state_after_id": "state_0001" if event_type == "checkpoint_created" else None,
            }
            if event_type == "click":
                event["target"] = {"dom_backend_node_id": 12}
            events.append(event)
        (root / "events.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        (root / "screen.webm").write_bytes(b"test-video")
        session = {
            "status": "completed",
            "started_at": "2026-08-15T00:00:00.000Z",
            "ended_at": "2026-08-15T00:00:10.000Z",
            "duration_ms": 10000,
            "viewport": {"width": 1, "height": 1},
            "counts": {"events": len(events), "states": 8},
        }
        (root / "session.json").write_text(json.dumps(session), encoding="utf-8")
        (root / "qa.json").write_text(json.dumps({"passed": True}), encoding="utf-8")

        result = subprocess.run(
            [sys.executable, str(validator), str(root), "--contract-smoke"],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr, file=sys.stderr)
            return result.returncode
        print("PASS: recording validator fixture")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
