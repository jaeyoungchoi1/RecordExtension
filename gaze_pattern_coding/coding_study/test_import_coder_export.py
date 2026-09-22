#!/usr/bin/env python3

from __future__ import annotations

import csv
import json
import tempfile
from pathlib import Path

import import_coder_export as importer


def complete_rows():
    with (importer.ROOT / "sample_manifest.csv").open(newline="") as handle:
        manifest = list(csv.DictReader(handle))
    return [
        {
            "sample_id": row["sample_id"],
            "task_id": row["task_id"],
            "episode_id": row["episode_id"],
            "primary_behavior": "ABSTAIN",
            "secondary_behavior": "",
            "ax_projection": "AX_UNMAPPED",
            "outcome": "OUT_UNKNOWN",
            "modifiers": "mapping_uncertain",
            "confidence": "low",
            "evidence": "Insufficient evidence for a more specific code.",
            "needs_human_review": "true",
            "notes": "Synthetic import-pipeline test only.",
        }
        for row in manifest
    ]


rows = complete_rows()
report = importer.validate(rows)
assert report == {"rows": len(rows), "missing_required_cells": 0, "complete": True}

with tempfile.TemporaryDirectory() as directory:
    target = Path(directory) / "coder_a.csv"
    importer.write_csv_atomic(target, rows)
    assert importer.has_annotations(target)
    loaded, version = importer.read_export(target)
    assert version is None
    assert loaded == rows

    json_path = Path(directory) / "coder_a.json"
    version = json.loads((importer.RESEARCH / "episode_codebook.json").read_text())["version"]
    json_path.write_text(json.dumps({"codebook_version": version, "annotations": rows}))
    loaded_json, exported_version = importer.read_export(json_path)
    assert loaded_json == rows
    assert exported_version == version

print(json.dumps({
    "complete_rows_validated": len(rows),
    "csv_round_trip": True,
    "json_round_trip": True,
    "annotated_target_detection": True,
}))
