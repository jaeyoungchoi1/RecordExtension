#!/usr/bin/env python3

from __future__ import annotations

import csv
import json
import tempfile
from pathlib import Path

import compute_agreement as agreement


perfect = agreement.kappa(["DIR", "SCN", "DIR"], ["DIR", "SCN", "DIR"])
assert perfect == {"n": 3, "agreement": 1.0, "kappa": 1.0}
partial = agreement.kappa(["DIR", "SCN", "DIR", "SCN"], ["DIR", "DIR", "DIR", "SCN"])
assert partial["n"] == 4
assert partial["agreement"] == 0.75

with tempfile.TemporaryDirectory() as directory:
    original_root = agreement.ROOT
    agreement.ROOT = Path(directory)
    try:
        fields = ["sample_id", "dimension", "coder_a", "coder_b", "adjudicated", "reason", "codebook_change", "adjudicator"]
        with (agreement.ROOT / "disagreement_log.csv").open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            writer.writerow({
                "sample_id": "S001", "dimension": "primary_behavior", "coder_a": "DIR", "coder_b": "SCN",
                "adjudicated": "DIR", "reason": "Action alignment", "codebook_change": "no", "adjudicator": "tester",
            })
        agreement.sync_disagreement_log([
            {"sample_id": "S001", "dimension": "primary_behavior", "coder_a": "DIR", "coder_b": "CMP", "status": "disagree"},
            {"sample_id": "S002", "dimension": "modifiers", "coder_a": "ordered", "coder_b": "", "status": "disagree"},
        ])
        with (agreement.ROOT / "disagreement_log.csv").open(newline="") as handle:
            rows = list(csv.DictReader(handle))
        assert len(rows) == 2
        assert rows[0]["coder_b"] == "CMP"
        assert rows[0]["adjudicated"] == "DIR"
        assert rows[0]["reason"] == "Action alignment"
        assert rows[1]["dimension"] == "modifiers"
    finally:
        agreement.ROOT = original_root

print(json.dumps({
    "kappa": True,
    "disagreement_sync": True,
    "prior_adjudication_preserved": True,
}))
