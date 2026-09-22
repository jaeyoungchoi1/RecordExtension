#!/usr/bin/env python3
"""Validate and freeze a coding-portal export without silently replacing prior work."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RESEARCH = ROOT.parent
FIELDS = [
    "sample_id", "task_id", "episode_id", "primary_behavior", "secondary_behavior",
    "ax_projection", "outcome", "modifiers", "confidence", "evidence",
    "needs_human_review", "notes",
]
REQUIRED = ["primary_behavior", "ax_projection", "outcome", "confidence", "evidence", "needs_human_review"]
SCHEMA = json.loads((RESEARCH / "episode_annotation.schema.json").read_text())
ALLOWED = {
    key: set(spec["enum"])
    for key, spec in SCHEMA["properties"].items()
    if "enum" in spec
}
ALLOWED["needs_human_review"] = {"true", "false"}
ALLOWED_MODIFIERS = set(SCHEMA["properties"]["modifiers"]["items"]["enum"])


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_row(row: dict) -> dict:
    normalized = {field: row.get(field, "") for field in FIELDS}
    modifiers = normalized["modifiers"]
    if isinstance(modifiers, list):
        modifiers = "|".join(modifiers)
    normalized["modifiers"] = str(modifiers or "").strip()
    review = normalized["needs_human_review"]
    if isinstance(review, bool):
        review = str(review).lower()
    normalized["needs_human_review"] = str(review or "").strip().lower()
    for field in FIELDS:
        if field not in {"modifiers", "needs_human_review"}:
            normalized[field] = str(normalized[field] or "").strip()
    return normalized


def read_export(path: Path) -> tuple[list[dict], str | None]:
    if path.suffix.lower() == ".json":
        payload = json.loads(path.read_text())
        rows = payload.get("annotations")
        if not isinstance(rows, list):
            raise SystemExit("JSON export must contain an annotations array.")
        return [normalize_row(row) for row in rows], payload.get("codebook_version")
    if path.suffix.lower() != ".csv":
        raise SystemExit("Export must be the portal CSV or JSON file.")
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        missing = [field for field in FIELDS if field not in (reader.fieldnames or [])]
        if missing:
            raise SystemExit(f"CSV export is missing fields: {missing}")
        return [normalize_row(row) for row in reader], None


def load_manifest() -> dict[str, dict]:
    with (ROOT / "sample_manifest.csv").open(newline="") as handle:
        return {row["sample_id"]: row for row in csv.DictReader(handle)}


def validate(rows: list[dict], allow_incomplete: bool = False) -> dict:
    manifest = load_manifest()
    ids = [row["sample_id"] for row in rows]
    duplicates = sorted({sample_id for sample_id in ids if ids.count(sample_id) > 1})
    if duplicates:
        raise SystemExit(f"Duplicate sample IDs: {duplicates}")
    if set(ids) != set(manifest):
        raise SystemExit(
            f"Export sample IDs differ from manifest; missing={sorted(set(manifest) - set(ids))}, "
            f"extra={sorted(set(ids) - set(manifest))}"
        )
    missing_cells = []
    for line, row in enumerate(rows, 2):
        expected = manifest[row["sample_id"]]
        if (row["task_id"], row["episode_id"]) != (expected["task_id"], expected["episode_id"]):
            raise SystemExit(
                f"Line {line} {row['sample_id']} has task/episode "
                f"{row['task_id']}:{row['episode_id']}; expected {expected['task_id']}:{expected['episode_id']}"
            )
        for field, allowed in ALLOWED.items():
            value = row.get(field, "")
            if value and value not in allowed:
                raise SystemExit(f"Line {line} has invalid {field}={value!r}")
        modifiers = [value for value in row["modifiers"].split("|") if value]
        invalid = set(modifiers) - ALLOWED_MODIFIERS
        if invalid:
            raise SystemExit(f"Line {line} has invalid modifiers={sorted(invalid)}")
        if len(modifiers) != len(set(modifiers)):
            raise SystemExit(f"Line {line} repeats an evidence modifier")
        for field in REQUIRED:
            if not row[field]:
                missing_cells.append(f"{row['sample_id']}:{field}")
    if missing_cells and not allow_incomplete:
        preview = ", ".join(missing_cells[:12])
        suffix = "…" if len(missing_cells) > 12 else ""
        raise SystemExit(f"Export is incomplete ({len(missing_cells)} required cells): {preview}{suffix}")
    return {"rows": len(rows), "missing_required_cells": len(missing_cells), "complete": not missing_cells}


def has_annotations(path: Path) -> bool:
    if not path.exists():
        return False
    with path.open(newline="") as handle:
        return any(
            any(str(row.get(field, "")).strip() for field in FIELDS[3:])
            for row in csv.DictReader(handle)
        )


def write_csv_atomic(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDS)
            writer.writeheader()
            writer.writerows(rows)
        os.replace(temporary_name, path)
    finally:
        temporary = Path(temporary_name)
        if temporary.exists():
            temporary.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("coder", choices=["A", "B", "a", "b"])
    parser.add_argument("export", type=Path)
    parser.add_argument("--allow-incomplete", action="store_true", help="Validate and import a draft before 61/61 completion.")
    parser.add_argument("--replace", action="store_true", help="Replace an already annotated target after explicit review.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--target-dir", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args()

    source = args.export.expanduser().resolve()
    if not source.exists():
        raise SystemExit(f"Export not found: {source}")
    rows, exported_version = read_export(source)
    report = validate(rows, args.allow_incomplete)
    current_version = json.loads((RESEARCH / "episode_codebook.json").read_text())["version"]
    if exported_version and exported_version != current_version:
        raise SystemExit(f"Codebook version mismatch: export={exported_version}, current={current_version}")

    coder = args.coder.lower()
    target = args.target_dir.resolve() / f"coder_{coder}.csv"
    if target.resolve() != source and has_annotations(target) and not args.replace:
        raise SystemExit(f"{target} already contains annotations; inspect it and rerun with --replace if intentional.")

    result = {
        "coder": coder.upper(),
        "source": str(source),
        "source_sha256": sha256(source),
        "target": str(target),
        "codebook_version": current_version,
        **report,
        "dry_run": args.dry_run,
    }
    if not args.dry_run:
        if target.resolve() != source:
            write_csv_atomic(target, rows)
        result["target_sha256"] = sha256(target)
        result["frozen_at_utc"] = datetime.now(timezone.utc).isoformat()
        freeze_path = args.target_dir.resolve() / f"coder_{coder}.freeze.json"
        freeze_path.write_text(json.dumps(result, indent=2) + "\n")
        result["freeze_record"] = str(freeze_path)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
