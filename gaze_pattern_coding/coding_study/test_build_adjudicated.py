#!/usr/bin/env python3

from __future__ import annotations

import csv
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FIELDS = [
    "sample_id", "task_id", "episode_id", "primary_behavior", "secondary_behavior",
    "ax_projection", "outcome", "modifiers", "confidence", "evidence",
    "needs_human_review", "notes",
]


def write(path, rows, fields=FIELDS):
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


with (ROOT / "sample_manifest.csv").open(newline="") as handle:
    manifest = list(csv.DictReader(handle))

base = [
    {
        "sample_id": row["sample_id"], "task_id": row["task_id"], "episode_id": row["episode_id"],
        "primary_behavior": "ABSTAIN", "secondary_behavior": "", "ax_projection": "AX_UNMAPPED",
        "outcome": "OUT_UNKNOWN", "modifiers": "mapping_uncertain", "confidence": "low",
        "evidence": "Insufficient evidence.", "needs_human_review": "true", "notes": "Synthetic test.",
    }
    for row in manifest
]
coder_b = [dict(row) for row in base]
coder_b[0]["primary_behavior"] = "DIR"
coder_b[0]["modifiers"] = "ordered"

with tempfile.TemporaryDirectory() as directory:
    temporary = Path(directory)
    shutil.copy(ROOT / "sample_manifest.csv", temporary / "sample_manifest.csv")
    write(temporary / "coder_a.csv", base)
    write(temporary / "coder_b.csv", coder_b)
    write(
        temporary / "disagreement_log.csv",
        [
            {"sample_id": "S001", "dimension": "primary_behavior", "coder_a": "ABSTAIN", "coder_b": "DIR", "adjudicated": "ABSTAIN", "reason": "Minimum evidence is absent.", "codebook_change": "no", "adjudicator": "test"},
            {"sample_id": "S001", "dimension": "modifiers", "coder_a": "mapping_uncertain", "coder_b": "ordered", "adjudicated": "mapping_uncertain", "reason": "Mapping remains uncertain.", "codebook_change": "no", "adjudicator": "test"},
        ],
        ["sample_id", "dimension", "coder_a", "coder_b", "adjudicated", "reason", "codebook_change", "adjudicator"],
    )
    result = subprocess.run(
        [sys.executable, str(ROOT / "build_adjudicated.py"), "--root", str(temporary)],
        check=True, capture_output=True, text=True,
    )
    with (temporary / "adjudicated.csv").open(newline="") as handle:
        gold = list(csv.DictReader(handle))
    assert len(gold) == len(manifest)
    assert gold[0]["primary_behavior"] == "ABSTAIN"
    assert gold[0]["modifiers"] == "mapping_uncertain"
    assert gold[0]["adjudicator"] == "test"
    freeze = json.loads((temporary / "adjudicated.freeze.json").read_text())
    assert freeze["rows"] == len(manifest)
    assert freeze["disagreements_resolved"] == 2

print(json.dumps({
    "gold_rows": len(manifest),
    "resolved_disagreements": 2,
    "freeze_hashes_written": True,
}))
