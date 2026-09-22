#!/usr/bin/env python3
"""Build offline, per-task multi-user AOI selection and scanpath reviews.

Reuses the original component extraction and episode semantic-label helpers.
Does not execute either original builder or modify its outputs.
"""
from __future__ import annotations

import argparse
import base64
import csv
import html
import json
import math
import sys
from pathlib import Path
from urllib.parse import urlsplit

from jy_validate_inputs import PIPELINE, LAUNCHER, add_inputs, resolve_inputs, inspect_user, asset_path
from jy_analysis import (enrich_components, load_fixations, attribute_fixations,
                         select_trends, transitions, summarize, recorded_trees)
from jy_page_view import build_pages

sys.path.insert(0, str(PIPELINE / "builders"))
import build_component_state_review as base
from build_episode_review import semantic_unit


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def csv_export(path, rows):
    if not rows:
        path.write_text("status\nno_rows\n", encoding="utf-8")
        return
    keys = list(dict.fromkeys(k for row in rows for k in row))
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        writer.writerows({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v
                         for k, v in row.items()} for row in rows)


def load_user(root, task, args, task_assets, overrides, report):
    folder = root / "task_logs" / task
    session = base.load_json(folder / "session.json")
    events = base.load_events(folder / "events.jsonl")
    start, end = events[0]["timestamp_ms"], events[-1]["timestamp_ms"]
    if end <= start:
        raise ValueError("Nonpositive task interval")
    raw = sorted((base.load_json(p) for p in (folder / "states").glob("*.json")),
                 key=lambda s: s["timestamp_ms"])
    if len({s["state_id"] for s in raw}) != len(raw):
        raise ValueError("Duplicate state IDs")
    states, warnings = [], list(report["warnings"])
    for i, state in enumerate(raw):
        row = {"state_id": state["state_id"], "start_ms": state["timestamp_ms"],
               "end_ms": min(raw[i + 1]["timestamp_ms"] if i + 1 < len(raw) else end, end),
               "url": state.get("url", ""), "document_id": state.get("document_id"),
               "components": [], "usable": False, "reason": None, "image": None}
        if urlsplit(row["url"]).hostname == LAUNCHER and not args.include_launcher:
            row["reason"] = "launcher_excluded"
        else:
            try:
                snapshot = base.load_json(asset_path(folder, state["dom_snapshot_asset"]["file"]))
                ax = base.load_json(asset_path(folder, state["a11y_asset"]["file"]))
                row["trees"] = recorded_trees(base, snapshot, ax)
                row["components"] = enrich_components(base, semantic_unit, snapshot, ax, state, root.name, task, overrides, args.aoi_matching, args.max_components)
                doc = snapshot["documents"][0]
                row["scroll_x"] = doc.get("scrollOffsetX", 0)
                row["scroll_y"] = doc.get("scrollOffsetY", 0)
                row["usable"] = True
                if len(snapshot.get("documents", [])) > 1:
                    warnings.append(f"{row['state_id']}: only main document AOIs extracted; iframe documents excluded")
            except (KeyError, ValueError, OSError, TypeError, IndexError) as error:
                row["reason"] = "snapshot_unavailable: " + str(error)
                warnings.append(f"{row['state_id']}: {row['reason']}")
        # Save a portable preview, including excluded/unusable states for auditing.
        try:
            source = asset_path(folder, state["screenshot_file"])
            image = base.cv2.imread(str(source))
            if image is None:
                raise ValueError("unreadable screenshot")
            h, w = image.shape[:2]
            row["image_width"], row["image_height"] = w, h
            scale = min(1, args.image_width / w)
            if scale < 1:
                image = base.cv2.resize(image, (round(w * scale), round(h * scale)))
            preview = task_assets / "images" / root.name / (row["state_id"] + ".jpg")
            preview.parent.mkdir(parents=True, exist_ok=True)
            if not base.cv2.imwrite(str(preview), image, [base.cv2.IMWRITE_JPEG_QUALITY, 82]):
                raise ValueError("could not write screenshot preview")
            row["image"] = preview.relative_to(task_assets.parent.parent).as_posix()
        except (OSError, KeyError, ValueError) as error:
            warnings.append(f"{row['state_id']}: {error}")
        states.append(row)
    fixations, quality = load_fixations(base.gaze_csv_path(root / "mapped", task), start, end,
                                      args.min_fixation_ms, args.max_sample_gap_ms)
    observations = attribute_fixations(base, fixations, states, args.max_sample_gap_ms)
    target_states = sum(s["usable"] for s in states)
    mapped = sum(o["duration_ms"] for o in observations if o["aoi_id"])
    quality.update({"usable_states": target_states, "mapped_duration_ms": mapped,
                    "assessable": target_states > 0 and mapped > 0, "warnings": warnings,
                    "mapping_pct": 100 * mapped / quality["retained_fixation_ms"] if quality["retained_fixation_ms"] else None})
    return {"user": root.name, "session": {"task": session.get("task"), "prompt": session.get("task_prompt"),
            "outcome": session.get("outcome")}, "start_ms": start, "end_ms": end,
            "states": states, "observations": observations, "quality": quality}


def compact_tree_outline(rows, components, tree):
    """Keep AOI ancestry plus one collapsed placeholder per omitted branch."""
    wanted = {str(node) for c in components for node in ((c.get(tree) or {}).get("ancestors") or [])}
    if not wanted:
        return []
    kept = [{"id": str(n["id"]), "parent": str(n["parent"]) if n.get("parent") is not None else None,
             "label": n.get("label", "")} for n in rows if str(n["id"]) in wanted]
    omitted = {}
    for node in rows:
        parent = str(node["parent"]) if node.get("parent") is not None else None
        if parent in wanted and str(node["id"]) not in wanted:
            omitted[parent] = omitted.get(parent, 0) + 1
    kept.extend({"id": "omitted:" + parent, "parent": parent,
                 "label": f"{count} other recorded node(s) — collapsed"}
                for parent, count in omitted.items())
    return kept


def compact_html_payload(payload, output_root, image_width=1000, image_quality=58):
    """Project the audit payload into a standalone, Git-friendly report payload."""
    users = []
    for user in payload["users"]:
        states = []
        for state in user["states"]:
            components = []
            for c in state["components"]:
                item = {k: c.get(k) for k in ("aoi_id", "component_id", "label", "x", "y", "width", "height")}
                for tree in ("dom", "ax"):
                    record = c.get(tree) or {}
                    item[tree] = {k: record.get(k) for k in ("node_id", "depth", "leaf", "ancestors")}
                components.append(item)
            trees = state.get("trees") or {}
            states.append({k: state.get(k) for k in ("state_id", "start_ms", "end_ms", "url", "document_id",
                                                      "usable", "reason", "image_width", "image_height",
                                                      "scroll_x", "scroll_y")} | {
                "components": components,
                "trees": {tree: compact_tree_outline(trees.get(tree, []), components, tree)
                          for tree in ("dom", "ax")}})
        users.append({k: user.get(k) for k in ("user", "session", "start_ms", "end_ms", "observations",
                                               "quality", "coverage", "tree_summary")} | {"states": states})
    compact = {k: payload.get(k) for k in ("task_id", "status", "expected_users", "errors", "aois", "edges",
                                             "thresholds", "parameters", "method", "notes", "pages")} | {"users": users}
    image_paths = {tile["image"] for page in compact.get("pages", []) for variant in page["variants"]
                   for tile in variant["tiles"] if tile.get("image")}
    embedded = {}
    for relative in sorted(image_paths):
        source = (output_root / relative).resolve()
        if not source.is_relative_to(output_root.resolve()) or not source.is_file():
            continue
        image = base.cv2.imread(str(source))
        if image is None:
            continue
        height, width = image.shape[:2]
        scale = min(1, image_width / width)
        if scale < 1:
            image = base.cv2.resize(image, (round(width * scale), round(height * scale)))
        ok, encoded = base.cv2.imencode(".jpg", image, [base.cv2.IMWRITE_JPEG_QUALITY, image_quality])
        if ok:
            embedded[relative] = "data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii")
    compact["embedded_images"] = embedded
    return compact


def write_html(path, payload, image_width=1000, image_quality=58):
    template = (PIPELINE / "jy_review.html").read_text(encoding="utf-8")
    template = template.replace("/*__JY_MERGED__*/", (PIPELINE / "jy_merged.js").read_text(encoding="utf-8"))
    template = template.replace("/*__JY_TREES__*/", (PIPELINE / "jy_trees.js").read_text(encoding="utf-8"))
    compact = compact_html_payload(payload, path.parent, image_width, image_quality)
    # JSON embedded in a script must not allow page labels to end the element.
    data = json.dumps(compact, ensure_ascii=False, allow_nan=False, separators=(",", ":")).replace("<", "\\u003c").replace("&", "\\u0026")
    path.write_text(template.replace("/*__JY_DATA__*/", "const DATA = " + data + ";"), encoding="utf-8")


def assessment_reasons(users, errors):
    reasons = list(errors)
    for u in users:
        q = u['quality']
        if not q['usable_states']:
            target = [s for s in u['states'] if s.get('reason') != 'launcher_excluded']
            if not target:
                reason = 'no target-page snapshots (launcher only)' if u['states'] else 'no recorded states'
            else:
                evidence = ' '.join((s.get('reason') or '') for s in target) + ' '.join(q['warnings'])
                missing = [label for keys, label in [(('dom_snapshot', '/dom/'), 'DOM snapshot'),
                           (('a11y', '/ax/'), 'A11y snapshot'), (('viewport',), 'viewport metadata')]
                           if any(k in evidence for k in keys)]
                reason = 'missing/invalid ' + ', '.join(missing) if missing else 'unusable target snapshots'
            reasons.append(u['user'] + ': ' + reason)
        elif not q['mapped_duration_ms']:
            reasons.append(u['user'] + (': no retained fixations' if not q['retained_fixation_ms'] else ': no fixations assigned to AOIs'))
    return reasons


def build_task(task, roots, args, output, overrides):
    reports = [inspect_user(u, task) for u in roots]
    assets = output / "data" / f"task{task}"
    assets.mkdir(parents=True, exist_ok=True)
    users, errors = [], []
    for root, report in zip(roots, reports):
        if not report["passed"]:
            errors.append(f"{root.name}: " + "; ".join(report["errors"]))
            continue
        try:
            users.append(load_user(root, task, args, assets, overrides, report))
        except (ValueError, OSError, KeyError, TypeError, IndexError) as error:
            errors.append(f"{root.name}: {error}")
    assessable = len(users) == len(roots) and all(u["quality"]["assessable"] for u in users)
    # Never reduce the all-users denominator to only users whose inputs passed.
    stats, thresholds = select_trends(users, args.majority_fraction)
    if not assessable:
        for a in stats.values():
            a["category"] = "unassessed"
        thresholds.update(baseline_available=False, frequency=None, duration_ms=None)
    edges = []
    for u in users:
        edges.extend(transitions(u, stats, "direct", args.max_transition_gap_ms))
        if assessable:
            edges.extend(transitions(u, stats, "selected_projection", args.max_transition_gap_ms))
    summarize(users, stats, edges)
    if not assessable:
        for edge in edges:
            edge["common_transition"] = False
        # A partial input set cannot establish common, majority or remaining membership.
        for u in users:
            for c in ("common", "majority", "remaining", "selected"):
                u["coverage"][c] = {"duration_ms": None, "fixation_count": None, "dwell_pct": None,
                                     "fixation_pct": None, "of_recorded_retained_dwell_pct": None}
            u["tree_summary"] = [s for s in u["tree_summary"] if s["subset"] == "all"]
            u["coverage"]["shared_direct_transitions"] = {"count": None, "total": None, "pct": None}
    status = "input_error" if errors else ("ready" if assessable else "not_assessable")
    payload = {"task_id": task, "status": status, "expected_users": [r.name for r in roots],
        "errors": errors, "validation": reports, "users": users, "aois": stats, "edges": edges,
        "thresholds": thresholds, "parameters": {k: v for k, v in vars(args).items() if not isinstance(v, Path)},
        "method": "AOI-level STA-inspired selection; original per-user order; no priority aggregation",
        "notes": ["Black AOIs were fixated by every requested user; black arrows require a supported directed transition in every user.",
                  "Common edge support does not prove that an entire multi-edge path was shared.",
                  "Projected arrows can skip remaining AOIs; snapshot boundaries never establish common transitions.",
                  "Coverage uses mapped retained fixation dwell. Source fixations split across AOIs can overlap in count percentages.",
                  "Balanced matching permits link label changes only for the same page, target and context; duplicate copies remain local-only.",
                  "Merged views use a reference recording's scroll mosaic. Other recordings are projected to matched AOI centers, not raw gaze coordinates."]}
    payload["pages"] = build_pages(users, stats)
    dump(assets / "analysis.json", payload)
    csv_export(assets / "aois.csv", list(stats.values()))
    csv_export(assets / "fixations.csv", [{"user": u["user"], **o} for u in users for o in u["observations"]])
    csv_export(assets / "transitions.csv", edges)
    csv_export(assets / "tree_summary.csv", [{"user": u["user"], **s} for u in users for s in u["tree_summary"]])
    csv_export(assets / "coverage.csv", [{"user": u["user"], **u["coverage"]} for u in users])
    write_html(output / f"task{task}.html", payload, args.html_image_width, args.html_image_quality)
    reasons = assessment_reasons(users, errors)
    return {"task_id": task, "status": status, "common_aois": sum(a["category"] == "common" for a in stats.values()),
            "majority_aois": sum(a["category"] == "majority" for a in stats.values()), "errors": errors, "reasons": reasons}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    add_inputs(parser)
    parser.add_argument("--output-root", type=Path, default=PIPELINE / "jy_derived" / "common_review")
    parser.add_argument("--min-fixation-ms", type=float, default=80)
    parser.add_argument("--aoi-matching", choices=["strict", "balanced"], default="balanced")
    parser.add_argument("--max-components", type=int, default=200, help="JY-only AOI extraction cap per snapshot (original: 80)")
    parser.add_argument("--max-sample-gap-ms", type=float, default=75)
    parser.add_argument("--max-transition-gap-ms", type=float, default=1000)
    parser.add_argument("--majority-fraction", type=float, default=.5,
                        help="Strictly greater than this fraction AND both common-attention minima")
    parser.add_argument("--image-width", type=int, default=1600)
    parser.add_argument("--html-image-width", type=int, default=1000,
                        help="Maximum embedded screenshot width in standalone HTML")
    parser.add_argument("--html-image-quality", type=int, default=58,
                        help="JPEG quality for screenshots embedded once per standalone HTML")
    parser.add_argument("--include-launcher", action="store_true")
    parser.add_argument("--aoi-overrides", type=Path, help="JSON list of audited canonical AOI mappings")
    args = parser.parse_args(argv)
    if not all(math.isfinite(x) for x in (args.min_fixation_ms, args.max_sample_gap_ms,
                                         args.max_transition_gap_ms, args.majority_fraction)):
        parser.error("Thresholds must be finite")
    if min(args.min_fixation_ms, args.max_sample_gap_ms, args.image_width, args.html_image_width, args.max_components) <= 0 or args.max_transition_gap_ms < 0:
        parser.error("Durations/image width must be positive (transition gap may be zero)")
    if not 1 <= args.html_image_quality <= 100:
        parser.error("HTML image quality must be between 1 and 100")
    if not .5 <= args.majority_fraction < 1:
        parser.error("Majority fraction must be >= 0.5 and < 1")
    roots, tasks = resolve_inputs(args)
    output = args.output_root.expanduser().resolve()
    # Only owned filenames are replaced; original input folders cannot be output roots.
    if any(output == r or output.is_relative_to(r) for r in roots):
        parser.error("Choose an output folder outside participant input folders")
    output.mkdir(parents=True, exist_ok=True)
    overrides = json.loads(args.aoi_overrides.read_text()) if args.aoi_overrides else []
    if not isinstance(overrides, list) or any(not isinstance(r, dict) or not r.get("canonical_id")
                                            or not all(k in r for k in ("user", "task", "state_id", "component_id")) for r in overrides):
        parser.error("Each override needs user, task (zero-padded), state_id, component_id, canonical_id")
    index_file = output / "jy_index.json"
    entries = json.loads(index_file.read_text()) if index_file.exists() else {}
    results = []
    for task in tasks:
        print(f"Building task {task} for {', '.join(r.name for r in roots)} ...", flush=True)
        result = build_task(task, roots, args, output, overrides)
        entries[task] = result
        results.append(result)
        print(f"  {result['status']}: {result['common_aois']} common, {result['majority_aois']} majority AOIs", flush=True)
        dump(index_file, entries)
        links = "".join(f'<li><a href="task{t}.html">Task {t}</a> — {html.escape(r["status"])} · '
                        f'{r["common_aois"]} common / {r["majority_aois"]} majority AOIs'
                        + ('<br><small>' + html.escape('; '.join(r.get('reasons') or r.get('errors') or ['Reason unavailable in old report; rebuild this task.'])) + '</small>' if r['status'] != 'ready' else '')
                        + '</li>' for t, r in sorted(entries.items()))
        (output / "index.html").write_text('<!doctype html><html lang="en"><meta charset="utf-8"><title>Common AOI reviews</title>'
            '<style>body{font:17px system-ui;max-width:950px;margin:50px auto;line-height:1.8}</style>'
            '<h1>Common AOI & scanpath reviews</h1><p>STA-inspired AOI selection with observed user order. '
            'Not-assessable tasks retain their quality reports and available recordings.</p><ol>' + links + '</ol></html>', encoding="utf-8")
    print(f"Open {output / 'index.html'}")
    return int(any(r["status"] == "input_error" for r in results))


if __name__ == "__main__":
    raise SystemExit(main())
