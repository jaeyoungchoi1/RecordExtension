#!/usr/bin/env python3
"""Build a 31-task episode-based gaze + accessibility-tree review viewer.

Episodes use recorder state/action boundaries. They never use a fixed-duration
window. The generated viewer is static and works over file://; annotations are
kept in localStorage and can be exported as JSON or CSV.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
import shutil
from collections import Counter
from pathlib import Path

import cv2

import build_component_state_review as base


ROOT = Path(__file__).resolve().parent
LOG_ROOT = ROOT / "task_logs" / "User 1"
MAPPED_ROOT = ROOT / "mapped"
OUT = ROOT / "episode_review"
TASK_IDS = tuple(f"{task_id:02d}" for task_id in range(1, 32))
LAUNCHER_DOMAIN = "real-world-task-library.vercel.app"
RELAXED_MIN_VISIT_MS = 50

USER_BOUNDARY_ACTIONS = {
    "click", "change", "submit", "browser_history_navigation",
}

VISUAL_PATTERNS = ["", "DIR", "SCN", "ORI", "EXP", "CMP", "RET", "VER", "INS", "ABSTAIN"]
TREE_PATTERNS = ["", "AX_LOCAL", "AX_CROSS", "AX_RETURN", "AX_RESET", "AX_UNMAPPED"]
OUTCOMES = ["", "OUT_CONTINUE", "OUT_SELECT", "OUT_CONFIRM", "OUT_UNRESOLVED", "OUT_UNKNOWN"]
CONTEXTS = ["ordered", "short_dwell_relative", "repeated", "cross_state", "cross_document", "hub_detail", "attribute_linked", "query_changed", "filter_or_sort_changed", "browser_history", "state_change_observed", "evidence_cumulative", "mapping_uncertain"]


def semantic_unit(component: dict) -> tuple[str, str, bool]:
    """Return a cautious semantic name/type and whether the candidate is noisy."""
    label = base.text(component.get("ax_name") or component.get("label") or component.get("tag"), 90)
    lower = label.lower()
    role = (component.get("ax_role") or component.get("role") or component.get("tag") or "").lower()
    noisy = role in {"main", "navigation", "section", "generic", "none"} or label.lower() in {"main", "nav", "section", "p", "div"}
    if "comment thread" in lower or ("reply from" in lower and "comment" in lower):
        kind = "Reddit comment"
    elif any(word in lower for word in ("sort", "filter", "relevance", "price (lowest", "new")):
        kind = "Sort / filter control"
    elif "flight" in lower and any(word in lower for word in ("select", "depart", "arriv")):
        kind = "Flight result"
    elif any(word in lower for word in ("date", "next month", "done")) and role in {"button", "textbox", "combobox", "gridcell"}:
        kind = "Date control"
    elif any(word in lower for word in ("search", "submit")) and role in {"button", "textbox", "searchbox", "combobox", "link"}:
        kind = "Search control"
    elif role in {"heading", "paragraph"} or component.get("tag") in {"h1", "h2", "h3", "p"}:
        kind = "Content section"
    elif role == "link" or component.get("tag") == "a":
        kind = "Link / candidate"
    elif role in {"button", "checkbox", "radio", "combobox", "textbox", "slider", "option"}:
        kind = "Interactive control"
    else:
        kind = "Visual element"
    name = f"{kind}: {label}" if label and label.lower() != kind.lower() else kind
    return base.text(name, 120), kind, noisy


def tree_movement(visits: list[dict], document_reset: bool) -> list[str]:
    movements = []
    if document_reset:
        movements.append("Reset")
    mapped = [visit for visit in visits if visit.get("ax_node_id")]
    if len(mapped) < len(visits):
        movements.append("Unmapped")
    for first, second in zip(mapped, mapped[1:]):
        a, b = first.get("ax_depth"), second.get("ax_depth")
        if a is None or b is None:
            continue
        if b > a:
            movements.append("Descent")
        elif b < a:
            movements.append("Ascent")
        elif first.get("ax_node_id") != second.get("ax_node_id"):
            movements.append("Lateral")
        else:
            movements.append("Subtree scan")
    return list(dict.fromkeys(movements))


def suggest(state: dict) -> list[dict]:
    visits, actions = state["visits"], state["actions"]
    suggestions = []
    ids = [visit["component_id"] for visit in visits]
    unique = len(set(ids))
    action_text = " ".join(f"{action['type']} {action['target']}" for action in actions).lower()
    alternation = any(ids[i] == ids[i + 2] != ids[i + 1] for i in range(max(0, len(ids) - 2)))
    if alternation:
        suggestions.append({"label": "CMP", "why": "A–B–A visit alternation; candidate identity still needs review"})
    if unique >= 4 and visits:
        median = sorted(visit["duration_ms"] for visit in visits)[len(visits) // 2]
        if median <= 450:
            suggestions.append({"label": "SCN", "why": "several units with short visits; peer status needs review"})
    if any(word in action_text for word in ("filter", "sort", "relevance", "price (lowest", " new")):
        suggestions.append({"label": "filter_or_sort_changed", "why": "retrieval policy changed"})
    if any(action["type"] == "browser_history_navigation" for action in actions):
        suggestions.append({"label": "RET", "why": "browser history navigation"})
        suggestions.append({"label": "browser_history", "why": "recorded Back/history action"})
    if any(action["type"] in {"change", "submit"} for action in actions):
        suggestions.append({"label": "DIR", "why": "input/change followed by submit; target alignment needs review"})
    if state.get("document_reset"):
        suggestions.append({"label": "AX_RESET", "why": "new recorder document/tree"})
    if len(visits) <= 3 and any(action["type"] in {"click", "submit"} for action in actions):
        suggestions.append({"label": "DIR", "why": "short target-to-action path"})
    deduped = []
    for row in suggestions:
        if row["label"] not in {item["label"] for item in deduped}:
            deduped.append(row)
    return deduped[:4]


def state_data(task_id: str, folder: Path, session: dict, events: list[dict], gaze: list[tuple]) -> list[dict]:
    states = sorted([base.load_json(path) for path in (folder / "states").glob("*.json")], key=lambda row: row["timestamp_ms"])
    task_start, task_end = min(event["timestamp_ms"] for event in events), max(event["timestamp_ms"] for event in events)
    output = []
    previous_document = None
    for index, raw_state in enumerate(states):
        start = raw_state["timestamp_ms"]
        end = states[index + 1]["timestamp_ms"] if index + 1 < len(states) else task_end
        snapshot = base.load_json(folder / raw_state["dom_snapshot_asset"]["file"])
        ax = base.load_json(folder / raw_state["a11y_asset"]["file"])
        components = base.visible_components(snapshot, ax, raw_state["viewport"])
        ax_by_backend, ax_parents = base.ax_tree(ax)
        for component in components:
            node = ax_by_backend.get(component["backend_id"])
            component["ax_node_id"] = str(node.get("nodeId")) if node else ""
            component["ax_parent_id"] = str(node.get("parentId")) if node and node.get("parentId") is not None else ""
            component["ax_role"] = ((node.get("role") or {}).get("value")) if node else ""
            component["ax_name"] = base.text(((node.get("name") or {}).get("value"))) if node else ""
            component["ax_depth"] = base.ax_depth(component["ax_node_id"], ax_parents)
            component["semantic_name"], component["semantic_type"], component["noisy"] = semantic_unit(component)
        scores, visits, _, mapped_ms = base.score_components(components, gaze, start, end)
        _, relaxed_visits, _, _ = base.score_components(
            components, gaze, start, end, min_visit_ms=RELAXED_MIN_VISIT_MS
        )
        by_component = {component["component_id"]: component for component in components}
        for visit in [*visits, *relaxed_visits]:
            component = by_component[visit["component_id"]]
            visit.update({
                "semantic_name": component["semantic_name"], "semantic_type": component["semantic_type"],
                "noisy": component["noisy"], "ax_node_id": component["ax_node_id"],
                "ax_role": component["ax_role"], "ax_name": component["ax_name"],
                "ax_depth": component["ax_depth"],
                "time_s": round((visit["start_ms"] - task_start) / 1000, 3),
                "duration_s": round(visit["duration_ms"] / 1000, 3),
            })
        # The 50 ms pass is a sensitivity analysis only. Keep only visits that
        # failed the standard 100 ms gate so they cannot be mistaken for the
        # primary retained-visit sequence.
        strict_keys = {(visit["component_id"], visit["start_ms"], visit["end_ms"]) for visit in visits}
        relaxed_only_visits = [
            visit for visit in relaxed_visits
            if (visit["component_id"], visit["start_ms"], visit["end_ms"]) not in strict_keys
            and visit["duration_ms"] < base.MIN_VISIT_MS
        ]
        document_reset = previous_document is not None and raw_state.get("document_id") != previous_document
        previous_document = raw_state.get("document_id")
        actions = base.action_summary(events, start, end, task_start)
        tree = base.accessible_tree_rows(ax, components)
        for row in tree:
            row["visited"] = []
        tree_by_node = {row["node_id"]: row for row in tree}
        for visit in visits:
            if visit.get("ax_node_id") in tree_by_node:
                tree_by_node[visit["ax_node_id"]]["visited"].append(visit["visit_order"])
        src = folder / raw_state["screenshot_file"]
        image_rel = f"images/task{task_id}_{raw_state['state_id']}.png"
        shutil.copy2(src, OUT / image_rel)
        image = cv2.imread(str(src))
        h, w = image.shape[:2]
        output.append({
            "state_id": raw_state["state_id"], "start_ms": start, "end_ms": end,
            "start_s": round((start - task_start) / 1000, 3), "end_s": round((end - task_start) / 1000, 3),
            "url": raw_state.get("url", ""), "title": raw_state.get("title", ""),
            "document_id": raw_state.get("document_id", ""), "document_reset": document_reset,
            "image": image_rel, "image_width": w, "image_height": h,
            "components": components, "scores": scores, "visits": visits,
            "relaxed_only_visits": relaxed_only_visits, "actions": actions,
            "ax_tree": tree, "tree_movements": tree_movement(visits, document_reset),
            "mapped_ms": mapped_ms, "evidence_warning": "",
        })
    return output


def base_episodes(task_id: str, states: list[dict], events: list[dict], task_start: int, task_end: int) -> list[dict]:
    # Normally each recorder checkpoint is the smallest mergeable episode.
    episodes = []
    eligible_indexes = [
        index for index, state in enumerate(states)
        if LAUNCHER_DOMAIN not in state.get("url", "")
    ]
    for eligible_position, index in enumerate(eligible_indexes):
        state = states[index]
        if (
            not state["visits"]
            and not state.get("relaxed_only_visits")
            and not state["actions"]
            and eligible_position not in {0, len(eligible_indexes) - 1}
        ):
            continue
        last_action = next((a for a in reversed(state["actions"]) if a["type"] in USER_BOUNDARY_ACTIONS), None)
        title = last_action["target"] if last_action and last_action["target"] else state["title"] or state["state_id"]
        episode = {
            "episode_id": f"E{len(episodes) + 1:02d}", "title": base.text(title, 62),
            "state_ids": [state["state_id"]],
            "result_state_id": states[eligible_indexes[eligible_position + 1]]["state_id"]
            if eligible_position + 1 < len(eligible_indexes) else "",
            "start_s": state["start_s"], "end_s": state["end_s"],
            "boundary": last_action["type"] if last_action else ("document reset" if state["document_reset"] else "state checkpoint"),
            "suggestions": suggest(state), "source_warning": state.get("evidence_warning", ""),
        }
        episodes.append(episode)
    # Task 15 has one initial launcher state only. Preserve provenance, but expose
    # action-centered subepisodes without pretending that its AX snapshot is Booking.
    if task_id == "15" and len(states) == 1:
        significant = [e for e in events if e.get("type") in USER_BOUNDARY_ACTIONS]
        episodes = []
        prior = task_start
        for event in significant:
            target = event.get("target") or {}
            label = base.text(target.get("accessible_name") or target.get("aria_label") or target.get("text") or event.get("url") or event["type"], 62)
            if label.lower() == "open website" or label.lower().startswith("open task:"):
                prior = event["timestamp_ms"]
                continue
            action = {
                "time_s": round((event["timestamp_ms"] - task_start) / 1000, 3),
                "type": event["type"],
                "target": label,
            }
            episodes.append({
                "episode_id": f"E{len(episodes) + 1:02d}", "title": label,
                "state_ids": [states[0]["state_id"]], "result_state_id": "",
                "start_s": round((prior-task_start)/1000, 3), "end_s": round((event["timestamp_ms"]-task_start)/1000, 3),
                "boundary": event["type"], "suggestions": [],
                "actions": [action], "suppress_state_evidence": True,
                "source_warning": "Only the initial launcher screen/AX tree was recorded for Task 15. Booking actions are listed, but screen–tree mapping is unavailable.",
            })
            prior = event["timestamp_ms"]
    elif len(states) == 1:
        warning = "Only one recorder checkpoint was captured. Episode segmentation and state-transition evidence are unreliable for this task."
        for episode in episodes:
            episode["source_warning"] = warning
    return episodes


def build_task(task_id: str) -> tuple[dict, list[dict], list[dict], list[dict]]:
    folder = LOG_ROOT / task_id
    session = base.load_json(folder / "session.json")
    events = base.load_events(folder / "events.jsonl")
    gaze = base.load_gaze(MAPPED_ROOT / f"task{task_id}_mapped_gaze.csv")
    task_start, task_end = min(e["timestamp_ms"] for e in events), max(e["timestamp_ms"] for e in events)
    states = state_data(task_id, folder, session, events, gaze)
    episodes = base_episodes(task_id, states, events, task_start, task_end)
    semantic_rows = []
    for state in states:
        for component in state["components"]:
            semantic_rows.append({
                "task_id": task_id, "state_id": state["state_id"], "component_id": component["component_id"],
                "semantic_name": component["semantic_name"], "semantic_type": component["semantic_type"],
                "noisy": component["noisy"], "raw_label": component["label"], "backend_id": component["backend_id"],
                "ax_node_id": component["ax_node_id"], "ax_role": component["ax_role"], "ax_name": component["ax_name"],
            })
    task = {
        "task_id": task_id, "title": session["task"]["title"], "prompt": session.get("task_prompt", ""),
        "outcome_status": (session.get("outcome") or {}).get("status", ""),
        "final_choice": (session.get("outcome") or {}).get("final_choice", ""),
        "duration_s": round((task_end-task_start)/1000, 3), "state_count": len(states), "episode_count": len(episodes),
        "visited_state_count": sum(bool(state["visits"]) for state in states),
        "visit_count": sum(len(state["visits"]) for state in states),
        "action_count": sum(len(state["actions"]) for state in states),
        "quality_warnings": (["Only one recorder checkpoint; segmentation and transitions are unreliable."] if len(states) == 1 else [])
            + (["Target-site screenshots, DOM, and AX snapshots are missing; only action evidence is valid."] if task_id == "15" else []),
    }
    return task, episodes, states, semantic_rows


def html_page(task_id: str) -> str:
    return f"""<!doctype html>
<html lang=en><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">
<title>Task {task_id} episode review</title><link rel=stylesheet href=styles.css></head>
<body><script src=\"data/task{task_id}.js\"></script><script src=app.js defer></script>
<header><div class=topline><a class=home-link href=index.html>All tasks</a><div class=controls>
<label>Task<select id=taskSelect></select></label><label>Episode<select id=episodeSelect></select></label>
<div class=step-controls><button id=prevBtn aria-label="Previous episode">←</button><button id=nextBtn aria-label="Next episode">→</button></div>
<details class=episode-tools><summary>Episode tools</summary><div><button id=mergeBtn>Merge next</button><button id=splitBtn>Split here</button></div></details>
</div></div><div class=task-copy><h1 id=taskTitle></h1><p id=prompt></p><p id=taskMeta></p></div><div id=warning></div></header>
<main>
<section class=panel id=screenPanel><div class=panel-head><h2>Screen</h2><div class=layer-controls><label><input id=boxesToggle type=checkbox checked> Boxes</label><label><input id=gazeToggle type=checkbox checked> Gaze</label></div></div><div id=stateTabs></div><div id=screenWrap><img id=screenImage><svg id=screenOverlay></svg></div></section>
<section class=panel id=treePanel><div class=panel-head><h2>Accessibility tree</h2><div class=tree-controls><span id=treeMeta></span><select id=treeMode aria-label="Accessibility tree view"><option value=visited>Visited paths</option><option value=full>Full tree</option></select></div></div><div id=axTree></div></section>
<section class=panel id=visitsPanel><div class=panel-head><h2>Visits and actions</h2><span id=movementSummary></span></div><div id=visitList></div><h3>Actions</h3><div id=actionList></div></section>
<section class=panel id=annotationPanel><div class=panel-head><h2>Episode coding</h2><button id=exportBtn>Export annotations</button></div><div id=suggestions></div>
<div class=form-grid><label>Visual pattern<select id=visualPattern></select></label><label>Tree pattern<select id=treePattern></select></label><label>Outcome<select id=outcome></select></label><label>Confidence<select id=confidence><option></option><option>High</option><option>Medium</option><option>Low</option></select></label></div>
<fieldset><legend>Workflow context</legend><div id=contextChecks></div></fieldset><label>Evidence note<textarea id=notes rows=4></textarea></label><p class=save-note>Annotations are saved locally in this browser. Suggested labels remain separate from coder decisions.</p></section>
</main></body></html>"""


def write_csv(path: Path, rows: list[dict]):
    if not rows:
        path.write_text("")
        return
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]), extrasaction="ignore")
        writer.writeheader(); writer.writerows(rows)


def write_quality_report(tasks: list[dict]):
    fields = [
        "task_id", "title", "outcome_status", "duration_s", "state_count",
        "episode_count", "visited_state_count", "visit_count", "action_count",
        "quality_warnings",
    ]
    rows = []
    for task in tasks:
        row = {field: task.get(field, "") for field in fields}
        row["quality_warnings"] = " | ".join(task.get("quality_warnings", []))
        rows.append(row)
    write_csv(OUT / "data" / "data_quality.csv", rows)
    (OUT / "data" / "data_quality.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    table = [
        "# Data Quality and Coverage",
        "",
        "Episode counts use recorder state/action boundaries and the current 100 ms retained-visit threshold. They are review units, not validated cognitive episodes.",
        "",
        "| Task | Duration (s) | States | Episodes | Visited states | Visits | Actions | Outcome | Warning |",
        "|---:|---:|---:|---:|---:|---:|---:|---|---|",
    ]
    for row in rows:
        warning = str(row["quality_warnings"]).replace("|", "/") or "—"
        table.append(
            f"| {row['task_id']} | {row['duration_s']} | {row['state_count']} | {row['episode_count']} | "
            f"{row['visited_state_count']} | {row['visit_count']} | {row['action_count']} | "
            f"{row['outcome_status'] or '—'} | {warning} |"
        )
    (OUT / "DATA_QUALITY.md").write_text("\n".join(table) + "\n")


def main(argv: list[str] | None = None):
    """Build the static episode-review viewer.

    Defaults retain the historical 0819 paths; command-line paths let the
    exact same builder operate on another participant's recorder bundle.
    """
    global LOG_ROOT, MAPPED_ROOT, OUT
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", nargs="*", help="Task IDs, e.g. 01 02")
    parser.add_argument("--log-root", type=Path, default=LOG_ROOT,
                        help="Directory containing one recorder folder per task")
    parser.add_argument("--mapped-root", type=Path, default=MAPPED_ROOT,
                        help="Directory containing taskXX_mapped_gaze.csv files")
    parser.add_argument("--output-root", type=Path, default=OUT,
                        help="Directory for the static episode-review viewer")
    args = parser.parse_args(argv)
    LOG_ROOT = args.log_root.expanduser().resolve()
    MAPPED_ROOT = args.mapped_root.expanduser().resolve()
    OUT = args.output_root.expanduser().resolve()
    task_ids = tuple(f"{int(value):02d}" for value in args.tasks) if args.tasks else TASK_IDS
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "images").mkdir(parents=True)
    (OUT / "data").mkdir()
    tasks, all_episodes, all_semantic = [], [], []
    task_payloads = {}
    for task_id in task_ids:
        task, episodes, states, semantic_rows = build_task(task_id)
        tasks.append(task); all_semantic.extend(semantic_rows)
        all_episodes.extend({"task_id": task_id, **episode} for episode in episodes)
        payload = {"task": task, "episodes": episodes, "states": states,
                   "coding": {"visual": VISUAL_PATTERNS, "tree": TREE_PATTERNS, "outcomes": OUTCOMES, "contexts": CONTEXTS}}
        task_payloads[task_id] = payload
        (OUT / "data" / f"task{task_id}.js").write_text("window.EPISODE_REVIEW_DATA=" + json.dumps(payload, ensure_ascii=False) + ";")
        (OUT / f"task{task_id}.html").write_text(html_page(task_id))
    (OUT / "data" / "episodes.json").write_text(json.dumps(all_episodes, ensure_ascii=False, indent=2))
    (OUT / "data" / "semantic_units.json").write_text(json.dumps(all_semantic, ensure_ascii=False, indent=2))
    (OUT / "data" / "annotations.json").write_text("[]\n")
    write_csv(OUT / "data" / "annotations.csv", [{"task_id":"","episode_id":"","visual_pattern":"","tree_pattern":"","outcome":"","workflow_context":"","confidence":"","notes":""}])
    write_quality_report(tasks)
    links = "".join(f'<li><a href="task{t["task_id"]}.html">Task {t["task_id"]} · {html.escape(t["title"])}</a><span>{t["episode_count"]} episodes · {t["state_count"]} recorder states</span></li>' for t in tasks)
    (OUT / "index.html").write_text(f"""<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Episode review</title><link rel=stylesheet href=styles.css></head><body class=index><header><h1>Episode-based gaze + accessibility-tree review</h1><p>All 31 recorded tasks are available for bottom-up taxonomy coding. Episodes follow recorder state/action boundaries, never a fixed-duration window.</p><p><a href=\"../pattern_recurrence/index.html\">Compare provisional patterns across tasks</a></p></header><ol class=task-list>{links}</ol></body></html>""")
    shutil.copy2(Path(__file__).with_name("episode_review_app.js"), OUT / "app.js")
    shutil.copy2(Path(__file__).with_name("episode_review_styles.css"), OUT / "styles.css")
    shutil.copy2(Path(__file__).with_name("episode_review_README.md"), OUT / "README.md")
    print(json.dumps({"output": str(OUT), "tasks": tasks, "episodes": len(all_episodes), "semantic_units": len(all_semantic)}, indent=2))


if __name__ == "__main__":
    main()
