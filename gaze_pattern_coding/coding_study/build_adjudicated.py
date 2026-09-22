#!/usr/bin/env python3
"""Build adjudicated human gold labels from two frozen coder passes and a resolved log."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import compute_agreement as agreement


ROOT = Path(__file__).resolve().parent
DIMENSIONS = agreement.DIMENSIONS
OUTPUT_FIELDS = [
    "sample_id", "task_id", "episode_id", "primary_behavior", "secondary_behavior",
    "ax_projection", "outcome", "modifiers", "confidence", "evidence",
    "needs_human_review", "notes", "adjudicator", "adjudication_note",
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_log(path: Path) -> dict[tuple[str, str], dict]:
    with path.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    keys = [(row["sample_id"], row["dimension"]) for row in rows]
    duplicates = sorted({key for key in keys if keys.count(key) > 1})
    if duplicates:
        raise SystemExit(f"Duplicate adjudication entries: {duplicates}")
    return dict(zip(keys, rows))


def read_coder(path: Path) -> dict[str, dict]:
    with path.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    ids = [row["sample_id"] for row in rows]
    duplicates = sorted({sample_id for sample_id in ids if ids.count(sample_id) > 1})
    if duplicates:
        raise SystemExit(f"{path.name} contains duplicate sample IDs: {duplicates}")
    for line, row in enumerate(rows, 2):
        for field, allowed in agreement.ALLOWED.items():
            value = row.get(field, "").strip()
            if value and value not in allowed:
                raise SystemExit(f"{path.name}:{line} invalid {field}={value!r}")
        invalid = {value for value in row.get("modifiers", "").split("|") if value} - agreement.ALLOWED_MODIFIERS
        if invalid:
            raise SystemExit(f"{path.name}:{line} invalid modifiers={sorted(invalid)}")
        missing = [field for field in agreement.REQUIRED_FIELDS if not row.get(field, "").strip()]
        if missing:
            raise SystemExit(f"{path.name}:{line} missing required fields: {missing}")
    return {row["sample_id"]: row for row in rows}


def valid_adjudication(dimension: str, value: str) -> bool:
    if dimension == "modifiers":
        values = [item for item in value.split("|") if item]
        return len(values) == len(set(values)) and not (set(values) - agreement.ALLOWED_MODIFIERS)
    return value in agreement.ALLOWED.get(dimension, set())


def has_gold(path: Path) -> bool:
    if not path.exists():
        return False
    with path.open(newline="") as handle:
        return any(row.get("primary_behavior", "").strip() for row in csv.DictReader(handle))


def write_atomic(path: Path, rows: list[dict]) -> None:
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=OUTPUT_FIELDS)
            writer.writeheader()
            writer.writerows(rows)
        os.replace(temporary_name, path)
    finally:
        temporary = Path(temporary_name)
        if temporary.exists():
            temporary.unlink()


def combine(label: str, left: str, right: str) -> str:
    left, right = left.strip(), right.strip()
    if left == right:
        return left
    return f"Coder A {label}: {left}\nCoder B {label}: {right}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replace", action="store_true", help="Replace an already populated gold file.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args()

    root = args.root.resolve()
    paths = {
        "coder_a": root / "coder_a.csv",
        "coder_b": root / "coder_b.csv",
        "log": root / "disagreement_log.csv",
        "output": root / "adjudicated.csv",
    }
    coder_a, coder_b = read_coder(paths["coder_a"]), read_coder(paths["coder_b"])
    if set(coder_a) != set(coder_b):
        raise SystemExit("Coder sample IDs differ.")
    with (root / "sample_manifest.csv").open(newline="") as handle:
        manifest = {row["sample_id"]: row for row in csv.DictReader(handle)}
    if set(coder_a) != set(manifest):
        raise SystemExit("Coder sample IDs do not match sample_manifest.csv.")
    for sample_id, expected in manifest.items():
        for name, rows in (("coder_a.csv", coder_a), ("coder_b.csv", coder_b)):
            observed = (rows[sample_id]["task_id"], rows[sample_id]["episode_id"])
            if observed != (expected["task_id"], expected["episode_id"]):
                raise SystemExit(f"{name} {sample_id} task/episode identity does not match the manifest.")
    log = read_log(paths["log"])
    unresolved = []
    output = []
    for sample_id in sorted(coder_a):
        left, right = coder_a[sample_id], coder_b[sample_id]
        row = {
            "sample_id": sample_id,
            "task_id": left["task_id"],
            "episode_id": left["episode_id"],
        }
        adjudicators, reasons = set(), []
        for dimension in [*DIMENSIONS, "modifiers"]:
            left_value, right_value = left[dimension].strip(), right[dimension].strip()
            if dimension == "modifiers":
                left_value = "|".join(sorted(value for value in left_value.split("|") if value))
                right_value = "|".join(sorted(value for value in right_value.split("|") if value))
            if left_value == right_value:
                row[dimension] = left_value
                continue
            decision = log.get((sample_id, dimension), {})
            value = decision.get("adjudicated", "").strip()
            reason = decision.get("reason", "").strip()
            adjudicator = decision.get("adjudicator", "").strip()
            if not value or not reason or not adjudicator or not valid_adjudication(dimension, value):
                unresolved.append(f"{sample_id}:{dimension}")
                continue
            row[dimension] = value
            adjudicators.add(adjudicator)
            reasons.append(f"{dimension}: {reason}")
        row["evidence"] = combine("evidence", left["evidence"], right["evidence"])
        row["notes"] = combine("notes", left["notes"], right["notes"])
        row["adjudicator"] = "|".join(sorted(adjudicators))
        row["adjudication_note"] = " | ".join(reasons)
        output.append(row)
    if unresolved:
        preview = ", ".join(unresolved[:16])
        suffix = "…" if len(unresolved) > 16 else ""
        raise SystemExit(f"Unresolved or invalid adjudications ({len(unresolved)}): {preview}{suffix}")
    if has_gold(paths["output"]) and not args.replace:
        raise SystemExit("adjudicated.csv already contains labels; use --replace only after reviewing the existing gold file.")

    result = {"rows": len(output), "disagreements_resolved": len(log), "dry_run": args.dry_run}
    if not args.dry_run:
        write_atomic(paths["output"], output)
        freeze = {
            **result,
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "coder_a_sha256": sha256(paths["coder_a"]),
            "coder_b_sha256": sha256(paths["coder_b"]),
            "disagreement_log_sha256": sha256(paths["log"]),
            "adjudicated_sha256": sha256(paths["output"]),
        }
        (root / "adjudicated.freeze.json").write_text(json.dumps(freeze, indent=2) + "\n")
        result["freeze_record"] = str(root / "adjudicated.freeze.json")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
