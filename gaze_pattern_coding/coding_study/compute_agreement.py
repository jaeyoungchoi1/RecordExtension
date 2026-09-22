#!/usr/bin/env python3
"""Audit coding completeness and report agreement by dimension and code."""

from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DIMENSIONS = ["primary_behavior", "secondary_behavior", "ax_projection", "outcome", "confidence", "needs_human_review"]
REQUIRED_FIELDS = ["primary_behavior", "ax_projection", "outcome", "confidence", "evidence", "needs_human_review"]
SCHEMA = json.loads((ROOT.parent / "episode_annotation.schema.json").read_text())
ALLOWED = {key: set(spec["enum"]) for key, spec in SCHEMA["properties"].items() if "enum" in spec}
ALLOWED["needs_human_review"] = {"true", "false"}
ALLOWED_MODIFIERS = set(SCHEMA["properties"]["modifiers"]["items"]["enum"])


def read(name):
    with (ROOT / name).open() as handle:
        rows = list(csv.DictReader(handle))
    ids = [row["sample_id"] for row in rows]
    duplicates = sorted({sample_id for sample_id in ids if ids.count(sample_id) > 1})
    if duplicates:
        raise SystemExit(f"{name} contains duplicate sample IDs: {duplicates}")
    for line, row in enumerate(rows, 2):
        for field, allowed in ALLOWED.items():
            value = row.get(field, "").strip()
            if value and value not in allowed:
                raise SystemExit(f"{name}:{line} invalid {field}={value!r}")
        invalid_modifiers = {value for value in row.get("modifiers", "").split("|") if value} - ALLOWED_MODIFIERS
        if invalid_modifiers:
            raise SystemExit(f"{name}:{line} invalid modifiers={sorted(invalid_modifiers)}")
    return {row["sample_id"]: row for row in rows}


def write_csv(name, rows, fields):
    with (ROOT / name).open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def sync_disagreement_log(disagreements):
    fields = ["sample_id", "dimension", "coder_a", "coder_b", "adjudicated", "reason", "codebook_change", "adjudicator"]
    path = ROOT / "disagreement_log.csv"
    existing = {}
    if path.exists():
        with path.open() as handle:
            existing = {
                (row["sample_id"], row["dimension"]): row
                for row in csv.DictReader(handle)
            }
    rows = []
    for disagreement in disagreements:
        key = (disagreement["sample_id"], disagreement["dimension"])
        prior = existing.get(key, {})
        rows.append({
            "sample_id": key[0],
            "dimension": key[1],
            "coder_a": disagreement["coder_a"],
            "coder_b": disagreement["coder_b"],
            "adjudicated": prior.get("adjudicated", ""),
            "reason": prior.get("reason", ""),
            "codebook_change": prior.get("codebook_change", ""),
            "adjudicator": prior.get("adjudicator", ""),
        })
    write_csv("disagreement_log.csv", rows, fields)


def kappa(a, b):
    pairs = [(x, y) for x, y in zip(a, b) if x and y]
    if not pairs:
        return {"n": 0, "agreement": None, "kappa": None}
    agreement = sum(x == y for x, y in pairs) / len(pairs)
    left, right = Counter(x for x, _ in pairs), Counter(y for _, y in pairs)
    labels = set(left) | set(right)
    expected = sum((left[label] / len(pairs)) * (right[label] / len(pairs)) for label in labels)
    score = (agreement - expected) / (1 - expected) if expected < 1 else 1.0
    return {"n": len(pairs), "agreement": round(agreement, 4), "kappa": round(score, 4)}


def per_code(dimension, left, right):
    rows = []
    labels = sorted(({value for value in left if value} | {value for value in right if value}))
    for label in labels:
        a_count = sum(value == label for value in left)
        b_count = sum(value == label for value in right)
        both = sum(a == label and b == label for a, b in zip(left, right))
        denominator = a_count + b_count
        rows.append({
            "dimension": dimension,
            "code": label,
            "coder_a_count": a_count,
            "coder_b_count": b_count,
            "both_code": both,
            "positive_agreement": round(2 * both / denominator, 4) if denominator else "",
        })
    return rows


def main():
    coder_a, coder_b = read("coder_a.csv"), read("coder_b.csv")
    with (ROOT / "sample_manifest.csv").open() as handle:
        manifest = {row["sample_id"]: row for row in csv.DictReader(handle)}
    if set(coder_a) != set(coder_b):
        missing_a = sorted(set(coder_b) - set(coder_a))
        missing_b = sorted(set(coder_a) - set(coder_b))
        raise SystemExit(f"Coder sample IDs differ; missing from A={missing_a}, missing from B={missing_b}")
    if set(coder_a) != set(manifest):
        raise SystemExit("Coder sample IDs do not match sample_manifest.csv")
    for sample_id in manifest:
        expected = (manifest[sample_id]["task_id"], manifest[sample_id]["episode_id"])
        for name, rows in (("coder_a.csv", coder_a), ("coder_b.csv", coder_b)):
            observed = (rows[sample_id]["task_id"], rows[sample_id]["episode_id"])
            if observed != expected:
                raise SystemExit(f"{name} {sample_id} task/episode {observed} does not match manifest {expected}")
    ids = sorted(coder_a)
    report, code_rows, disagreement_rows = {}, [], []
    missing_required = {"coder_a": 0, "coder_b": 0}
    for dimension in DIMENSIONS:
        left = [coder_a[sample_id][dimension].strip() for sample_id in ids]
        right = [coder_b[sample_id][dimension].strip() for sample_id in ids]
        row = kappa(left, right)
        row["coder_a_missing"] = sum(not value for value in left)
        row["coder_b_missing"] = sum(not value for value in right)
        report[dimension] = row
        code_rows.extend(per_code(dimension, left, right))
        if dimension in REQUIRED_FIELDS:
            missing_required["coder_a"] += row["coder_a_missing"]
            missing_required["coder_b"] += row["coder_b_missing"]
        for sample_id, a_value, b_value in zip(ids, left, right):
            if a_value != b_value and (a_value or b_value):
                disagreement_rows.append({
                    "sample_id": sample_id,
                    "dimension": dimension,
                    "coder_a": a_value,
                    "coder_b": b_value,
                    "status": "missing" if not a_value or not b_value else "disagree",
                })
    evidence_missing = {
        "coder_a": sum(not coder_a[sample_id]["evidence"].strip() for sample_id in ids),
        "coder_b": sum(not coder_b[sample_id]["evidence"].strip() for sample_id in ids),
    }
    missing_required["coder_a"] += evidence_missing["coder_a"]
    missing_required["coder_b"] += evidence_missing["coder_b"]
    report["evidence_completeness"] = {
        "paired_nonblank": sum(
            bool(coder_a[sample_id]["evidence"].strip()) and bool(coder_b[sample_id]["evidence"].strip())
            for sample_id in ids
        ),
        "coder_a_missing": evidence_missing["coder_a"],
        "coder_b_missing": evidence_missing["coder_b"],
    }
    modifier_pairs = []
    for sample_id in ids:
        a = {value for value in coder_a[sample_id]["modifiers"].split("|") if value}
        b = {value for value in coder_b[sample_id]["modifiers"].split("|") if value}
        if a or b:
            modifier_pairs.append(len(a & b) / len(a | b))
        if a != b:
            disagreement_rows.append({
                "sample_id": sample_id,
                "dimension": "modifiers",
                "coder_a": "|".join(sorted(a)),
                "coder_b": "|".join(sorted(b)),
                "status": "disagree",
            })
    report["modifiers"] = {
        "n": len(modifier_pairs),
        "mean_jaccard": round(sum(modifier_pairs) / len(modifier_pairs), 4) if modifier_pairs else None,
    }
    report["completeness"] = {
        "sample_count": len(ids),
        "required_fields": REQUIRED_FIELDS,
        "coder_a_missing_required_cells": missing_required["coder_a"],
        "coder_b_missing_required_cells": missing_required["coder_b"],
        "both_passes_complete": not missing_required["coder_a"] and not missing_required["coder_b"],
    }
    (ROOT / "agreement_report.json").write_text(json.dumps(report, indent=2) + "\n")
    write_csv(
        "agreement_by_code.csv", code_rows,
        ["dimension", "code", "coder_a_count", "coder_b_count", "both_code", "positive_agreement"],
    )
    write_csv(
        "disagreement_candidates.csv", disagreement_rows,
        ["sample_id", "dimension", "coder_a", "coder_b", "status"],
    )
    sync_disagreement_log(disagreement_rows)
    complete = report["completeness"]["both_passes_complete"]
    lines = [
        "# Inter-Coder Agreement", "",
        f"Both required coding passes complete: {'yes' if complete else 'no'}", "",
        "Blank required dimensions prevent a completed reliability claim. Optional secondary behavior may remain blank.", "",
        "| Dimension | N paired | Missing A | Missing B | Agreement | Cohen's κ |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for dimension in DIMENSIONS:
        row = report[dimension]
        lines.append(
            f"| {dimension} | {row['n']} | {row['coder_a_missing']} | {row['coder_b_missing']} | "
            f"{row['agreement'] if row['agreement'] is not None else '—'} | {row['kappa'] if row['kappa'] is not None else '—'} |"
        )
    evidence = report["evidence_completeness"]
    lines.append(
        f"| evidence (required; not agreement-scored) | {evidence['paired_nonblank']} | "
        f"{evidence['coder_a_missing']} | {evidence['coder_b_missing']} | — | — |"
    )
    lines.extend([
        "",
        f"Modifier mean Jaccard: {report['modifiers']['mean_jaccard'] if report['modifiers']['mean_jaccard'] is not None else '—'} (N={report['modifiers']['n']})",
        "",
        "See `agreement_by_code.csv` for code-level positive agreement and `disagreement_candidates.csv` for adjudication candidates.",
        "",
    ])
    (ROOT / "agreement_report.md").write_text("\n".join(lines))
    print(json.dumps(report))


if __name__ == "__main__":
    main()
