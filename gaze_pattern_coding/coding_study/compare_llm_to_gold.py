#!/usr/bin/env python3
"""Compare structured LLM episode labels with adjudicated human labels."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DIMENSIONS = ["primary_behavior", "secondary_behavior", "ax_projection", "outcome", "confidence", "needs_human_review"]


def read_csv(path):
    with path.open() as handle:
        return list(csv.DictReader(handle))


def normalize(value):
    return str(value if value is not None else "").strip().lower() if isinstance(value, bool) else str(value or "").strip()


def safe_ratio(numerator, denominator):
    return round(numerator / denominator, 4) if denominator else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gold", type=Path, default=ROOT / "adjudicated.csv")
    parser.add_argument("--llm", type=Path, default=ROOT / "llm_sample_pilot_annotations.jsonl")
    parser.add_argument("--output-prefix", type=Path, default=ROOT / "llm_comparison_report")
    args = parser.parse_args()

    gold_rows = read_csv(args.gold)
    gold_by_key = {(row["task_id"], row["episode_id"]): row for row in gold_rows}
    llm_rows = [json.loads(line) for line in args.llm.read_text().splitlines() if line.strip()]
    llm_by_key = {}
    for row in llm_rows:
        key = (row["task_id"], row["episode_id"])
        if key in llm_by_key:
            raise SystemExit(f"Duplicate LLM annotation for {key[0]}:{key[1]}")
        llm_by_key[key] = row
    overlap = sorted(set(gold_by_key) & set(llm_by_key))
    report = {
        "gold_rows": len(gold_rows),
        "llm_rows": len(llm_rows),
        "overlap_rows": len(overlap),
        "dimensions": {},
        "primary_behavior_by_code": {},
        "primary_behavior_by_llm_confidence": {},
        "missing_gold_primary_in_overlap": sum(not normalize(gold_by_key[key].get("primary_behavior")) for key in overlap),
    }
    for dimension in DIMENSIONS:
        pairs = [
            (normalize(gold_by_key[key].get(dimension)), normalize(llm_by_key[key].get(dimension)))
            for key in overlap
        ]
        paired = [(gold, model) for gold, model in pairs if gold and model]
        report["dimensions"][dimension] = {
            "n": len(paired),
            "agreement": safe_ratio(sum(gold == model for gold, model in paired), len(paired)),
            "missing_gold": sum(not gold for gold, _ in pairs),
            "missing_llm": sum(not model for _, model in pairs),
        }
    primary_pairs = [
        (normalize(gold_by_key[key].get("primary_behavior")), normalize(llm_by_key[key].get("primary_behavior")))
        for key in overlap
        if normalize(gold_by_key[key].get("primary_behavior")) and normalize(llm_by_key[key].get("primary_behavior"))
    ]
    labels = sorted({value for pair in primary_pairs for value in pair})
    for label in labels:
        gold_count = sum(gold == label for gold, _ in primary_pairs)
        llm_count = sum(model == label for _, model in primary_pairs)
        both = sum(gold == label and model == label for gold, model in primary_pairs)
        precision, recall = safe_ratio(both, llm_count), safe_ratio(both, gold_count)
        f1 = safe_ratio(2 * precision * recall, precision + recall) if precision is not None and recall is not None else None
        report["primary_behavior_by_code"][label] = {
            "gold_count": gold_count, "llm_count": llm_count, "both": both,
            "precision": precision, "recall": recall, "f1": f1,
        }
    confidence_rows = []
    for key in overlap:
        gold = normalize(gold_by_key[key].get("primary_behavior"))
        model = normalize(llm_by_key[key].get("primary_behavior"))
        confidence = normalize(llm_by_key[key].get("confidence"))
        if gold and model and confidence:
            confidence_rows.append((confidence, gold == model))
    for confidence in sorted({value for value, _ in confidence_rows}):
        matches = [match for value, match in confidence_rows if value == confidence]
        report["primary_behavior_by_llm_confidence"][confidence] = {
            "n": len(matches), "agreement": safe_ratio(sum(matches), len(matches)),
        }

    json_path = args.output_prefix.with_suffix(".json")
    md_path = args.output_prefix.with_suffix(".md")
    json_path.write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# LLM vs. Adjudicated Human Labels", "",
        f"Gold rows: {report['gold_rows']}; LLM rows: {report['llm_rows']}; overlap: {report['overlap_rows']}", "",
        "No agreement value is reported until the corresponding adjudicated human cells are populated.", "",
        "| Dimension | N paired | Agreement | Missing gold | Missing LLM |", "|---|---:|---:|---:|---:|",
    ]
    for dimension, row in report["dimensions"].items():
        lines.append(f"| {dimension} | {row['n']} | {row['agreement'] if row['agreement'] is not None else '—'} | {row['missing_gold']} | {row['missing_llm']} |")
    lines.extend(["", "## Primary behavior by code", "", "| Code | Gold | LLM | Both | Precision | Recall | F1 |", "|---|---:|---:|---:|---:|---:|---:|"])
    for label, row in report["primary_behavior_by_code"].items():
        lines.append(f"| {label} | {row['gold_count']} | {row['llm_count']} | {row['both']} | {row['precision']} | {row['recall']} | {row['f1']} |")
    lines.extend(["", "## Primary behavior by LLM confidence", ""])
    if report["primary_behavior_by_llm_confidence"]:
        lines.extend(f"- {label}: N={row['n']}, agreement={row['agreement']}" for label, row in report["primary_behavior_by_llm_confidence"].items())
    else:
        lines.append("- No paired adjudicated labels yet.")
    md_path.write_text("\n".join(lines) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
