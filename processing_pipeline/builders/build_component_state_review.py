#!/usr/bin/env python3
"""Build state-based component gaze reviews for the 0819 recordings.

Each recorder screen state is one analysis unit - never an arbitrary time
window.  For that state, the script derives visible DOM/AX components and
bounding boxes, maps transformed gaze samples to the smallest containing box,
and writes an inspectable HTML page with dwell scores, ordered visits, and
keyboard/mouse/navigation actions.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
import shutil
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parent
LOG_ROOT = ROOT / "task_logs" / "User 1"
MAPPED_ROOT = ROOT / "mapped"
OUT = ROOT / "component_state_review"
MIN_VISIT_MS = 100
MAX_GAP_MS = 75
MERGE_GAP_MS = 150
MAX_COMPONENTS = 80

INTERESTING_TAGS = {
    "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "IMG", "VIDEO", "AUDIO",
    "H1", "H2", "H3", "H4", "H5", "H6", "P", "LI", "ARTICLE", "SECTION",
    "NAV", "MAIN", "ASIDE", "SUMMARY", "TABLE", "TR", "TD", "TH",
}
INTERESTING_ROLES = {
    "button", "link", "heading", "textbox", "searchbox", "checkbox", "radio",
    "combobox", "listbox", "option", "tab", "menuitem", "slider", "switch",
    "article", "main", "navigation", "dialog", "alertdialog", "listitem",
}
ACTION_TYPES = {
    "click", "change", "submit", "tab_activated", "tab_created", "tab_url_changed",
    "navigation_committed", "browser_history_navigation", "spa_route_change", "popstate",
    "hashchange", "scroll_down", "scroll_up",
}


def load_json(path: Path):
    return json.loads(path.read_text())


def text(value: object, limit: int = 80) -> str:
    value = " ".join(str(value or "").split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


def task_dirs(selected: set[str] | None):
    paths = [path for path in LOG_ROOT.iterdir() if path.is_dir()]
    for path in sorted(paths, key=lambda item: int(item.name)):
        task_id = f"{int(path.name):02d}"
        if selected is None or task_id in selected:
            yield task_id, path


def load_events(path: Path):
    return sorted(
        [json.loads(line) for line in path.read_text().splitlines() if line.strip()],
        key=lambda row: row["timestamp_ms"],
    )


def load_gaze(path: Path):
    rows = []
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            try:
                if row["gaze detected in reference image"] != "True":
                    continue
                rows.append((
                    int(int(row["timestamp [ns]"]) / 1_000_000),
                    float(row["gaze position transf x [px]"]),
                    float(row["gaze position transf y [px]"]),
                ))
            except (KeyError, ValueError):
                continue
    return sorted(rows)


def attributes(nodes: dict, strings: list[str], index: int) -> dict[str, str]:
    raw = nodes.get("attributes", [])[index] if index < len(nodes.get("attributes", [])) else []
    return {
        strings[raw[position]]: strings[raw[position + 1]]
        for position in range(0, len(raw) - 1, 2)
    }


def descendant_text(nodes: dict, strings: list[str], parent: int, children: dict[int, list[int]], limit: int = 120) -> str:
    collected = []
    stack = list(reversed(children.get(parent, [])))
    while stack and len(" ".join(collected)) < limit:
        index = stack.pop()
        node_name = strings[nodes["nodeName"][index]]
        if node_name == "#text":
            collected.append(strings[nodes["nodeValue"][index]])
        stack.extend(reversed(children.get(index, [])))
    return text(" ".join(collected), limit)


def ax_labels(ax: dict) -> dict[int, tuple[str, str]]:
    result = {}
    for node in ax.get("nodes", []):
        backend = node.get("backendDOMNodeId")
        role = ((node.get("role") or {}).get("value")) or ""
        name = ((node.get("name") or {}).get("value")) or ""
        if backend and (name or role in INTERESTING_ROLES):
            result[int(backend)] = (text(name), role)
    return result


def ax_tree(ax: dict):
    """Index recorder AX nodes by DOM backend ID and by tree parent."""
    by_backend, parents = {}, {}
    for node in ax.get("nodes", []):
        node_id = str(node.get("nodeId", ""))
        if not node_id:
            continue
        parents[node_id] = str(node["parentId"]) if node.get("parentId") is not None else None
        if node.get("backendDOMNodeId") is not None:
            by_backend[int(node["backendDOMNodeId"])] = node
    return by_backend, parents


def accessible_tree_rows(ax: dict, components: list[dict]) -> list[dict]:
    """Render the actual exposed AX tree; link its nodes to screen components."""
    nodes = {str(node.get("nodeId")): node for node in ax.get("nodes", []) if node.get("nodeId") is not None}
    children = defaultdict(list)
    roots = []
    for node_id, node in nodes.items():
        parent_id = str(node["parentId"]) if node.get("parentId") is not None else None
        if parent_id in nodes:
            children[parent_id].append(node_id)
        else:
            roots.append(node_id)
    components_by_ax = defaultdict(list)
    for component in components:
        if component.get("ax_node_id"):
            components_by_ax[component["ax_node_id"]].append(component["component_id"])
    rows = []
    def walk(node_id: str, depth: int):
        node = nodes[node_id]
        if not node.get("ignored", False):
            rows.append({
                "depth": depth,
                "node_id": node_id,
                "role": ((node.get("role") or {}).get("value")) or "",
                "name": text(((node.get("name") or {}).get("value")), 100),
                "component_ids": " ".join(components_by_ax.get(node_id, [])),
            })
            child_depth = depth + 1
        else:
            child_depth = depth
        for child_id in children.get(node_id, []):
            walk(child_id, child_depth)
    for root in roots:
        walk(root, 0)
    return rows


def ax_depth(node_id: str | None, parents: dict[str, str | None]) -> int | None:
    if not node_id:
        return None
    depth, seen = 0, set()
    while node_id in parents and parents[node_id] is not None and node_id not in seen:
        seen.add(node_id); node_id = parents[node_id]; depth += 1
    return depth


def ax_distance(first: str | None, second: str | None, parents: dict[str, str | None]) -> int | None:
    """Undirected parent-child edge distance; None means no valid shared tree."""
    if not first or not second:
        return None
    ancestors, distance, seen = {}, 0, set()
    current = first
    while current and current not in seen:
        ancestors[current] = distance; seen.add(current); current = parents.get(current); distance += 1
    current, distance, seen = second, 0, set()
    while current and current not in seen:
        if current in ancestors:
            return ancestors[current] + distance
        seen.add(current); current = parents.get(current); distance += 1
    return None


def box_gap(first: dict, second: dict) -> float:
    """Minimum screen-space gap between two component rectangles, in pixels."""
    horizontal = max(first["x"] - (second["x"] + second["width"]), second["x"] - (first["x"] + first["width"]), 0)
    vertical = max(first["y"] - (second["y"] + second["height"]), second["y"] - (first["y"] + first["height"]), 0)
    return round(math.hypot(horizontal, vertical), 1)


def visible_components(snapshot: dict, ax: dict, viewport: dict) -> list[dict]:
    document = snapshot["documents"][0]
    nodes, layout, strings = document["nodes"], document["layout"], snapshot["strings"]
    by_backend = ax_labels(ax)
    children = defaultdict(list)
    for child_index, parent_index in enumerate(nodes["parentIndex"]):
        if parent_index >= 0:
            children[parent_index].append(child_index)
    layout_by_node = {}
    for layout_index, node_index in enumerate(layout["nodeIndex"]):
        bounds = layout["bounds"][layout_index]
        if node_index not in layout_by_node or bounds[2] * bounds[3] < layout_by_node[node_index][2] * layout_by_node[node_index][3]:
            layout_by_node[node_index] = bounds
    scale = float(viewport.get("device_pixel_ratio", 2))
    view_w, view_h = int(viewport["width"] * scale), int(viewport["height"] * scale)
    scroll_x, scroll_y = document.get("scrollOffsetX", 0), document.get("scrollOffsetY", 0)
    candidates = []
    for index, bounds in layout_by_node.items():
        if nodes["nodeType"][index] != 1:
            continue
        left, top, width, height = bounds
        left, top = left - scroll_x, top - scroll_y
        right, bottom = left + width, top + height
        if width < 20 or height < 14 or right <= 0 or bottom <= 0 or left >= view_w or top >= view_h:
            continue
        tag = strings[nodes["nodeName"][index]]
        backend = nodes["backendNodeId"][index]
        ax_name, role = by_backend.get(backend, ("", ""))
        attrs = attributes(nodes, strings, index)
        label = ax_name or attrs.get("aria-label") or attrs.get("title") or attrs.get("placeholder")
        if not label:
            label = descendant_text(nodes, strings, index, children)
        interesting = tag in INTERESTING_TAGS or role in INTERESTING_ROLES
        if not interesting or not label:
            continue
        priority = 3 if role in INTERESTING_ROLES or tag in {"A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"} else 2
        candidates.append({
            "node_index": index, "backend_id": backend, "label": text(label), "role": role or tag.lower(),
            "tag": tag.lower(), "x": max(0, int(round(left))), "y": max(0, int(round(top))),
            "width": min(view_w, int(round(right))) - max(0, int(round(left))),
            "height": min(view_h, int(round(bottom))) - max(0, int(round(top))), "priority": priority,
        })
    candidates.sort(key=lambda row: (-row["priority"], row["width"] * row["height"]))
    deduped = []
    for candidate in candidates:
        duplicate = False
        for existing in deduped:
            inter_x = max(0, min(candidate["x"] + candidate["width"], existing["x"] + existing["width"]) - max(candidate["x"], existing["x"]))
            inter_y = max(0, min(candidate["y"] + candidate["height"], existing["y"] + existing["height"]) - max(candidate["y"], existing["y"]))
            intersection = inter_x * inter_y
            smaller = min(candidate["width"] * candidate["height"], existing["width"] * existing["height"])
            if candidate["label"] == existing["label"] and smaller and intersection / smaller > .9:
                duplicate = True
                break
        if not duplicate:
            deduped.append(candidate)
        if len(deduped) >= MAX_COMPONENTS:
            break
    for index, component in enumerate(deduped, 1):
        component["component_id"] = f"C{index:02d}"
    return deduped


def component_at(components: list[dict], x: float, y: float):
    matches = [
        component for component in components
        if component["x"] <= x <= component["x"] + component["width"]
        and component["y"] <= y <= component["y"] + component["height"]
    ]
    return min(matches, key=lambda component: component["width"] * component["height"]) if matches else None


def score_components(
    components: list[dict],
    samples: list[tuple[int, float, float]],
    start: int,
    end: int,
    min_visit_ms: int = MIN_VISIT_MS,
):
    assigned = []
    for index, (timestamp, x, y) in enumerate(samples):
        if not start <= timestamp < end:
            continue
        next_timestamp = samples[index + 1][0] if index + 1 < len(samples) else timestamp + 5
        duration = min(max(0, next_timestamp - timestamp), MAX_GAP_MS)
        component = component_at(components, x, y)
        assigned.append((timestamp, x, y, duration, component["component_id"] if component else None))
    dwell = Counter()
    for _, _, _, duration, component_id in assigned:
        if component_id:
            dwell[component_id] += duration
    by_id = {component["component_id"]: component for component in components}
    visits, current = [], None
    for timestamp, x, y, duration, component_id in assigned:
        if not component_id:
            if current:
                visits.append(current); current = None
            continue
        separated = current and timestamp - current["last_timestamp"] > MAX_GAP_MS
        if current is None or separated or current["component_id"] != component_id:
            if current:
                visits.append(current)
            current = {"component_id": component_id, "start_ms": timestamp, "end_ms": timestamp + duration, "last_timestamp": timestamp,
                       "duration_ms": duration, "weighted_x": x * duration, "weighted_y": y * duration}
        else:
            current["end_ms"] = timestamp + duration; current["last_timestamp"] = timestamp
            current["duration_ms"] += duration; current["weighted_x"] += x * duration; current["weighted_y"] += y * duration
    if current:
        visits.append(current)
    merged = []
    for visit in visits:
        if merged and merged[-1]["component_id"] == visit["component_id"] and visit["start_ms"] - merged[-1]["end_ms"] <= MERGE_GAP_MS:
            previous = merged[-1]; total = previous["duration_ms"] + visit["duration_ms"]
            previous["weighted_x"] += visit["weighted_x"]; previous["weighted_y"] += visit["weighted_y"]
            previous["duration_ms"] = total; previous["end_ms"] = visit["end_ms"]
        else:
            merged.append(visit)
    retained = [visit for visit in merged if visit["duration_ms"] >= min_visit_ms]
    for index, visit in enumerate(retained, 1):
        visit["visit_order"] = index; visit["label"] = by_id[visit["component_id"]]["label"]
        visit["role"] = by_id[visit["component_id"]]["role"]
        visit["centroid_x"] = round(visit["weighted_x"] / visit["duration_ms"], 1)
        visit["centroid_y"] = round(visit["weighted_y"] / visit["duration_ms"], 1)
    mapped_ms = sum(row[3] for row in assigned if row[4])
    score_rows = []
    for component in components:
        row = dict(component)
        row["total_dwell_ms"] = dwell[component["component_id"]]
        row["total_dwell_s"] = round(dwell[component["component_id"]] / 1000, 3)
        row["visit_count"] = sum(visit["component_id"] == component["component_id"] for visit in retained)
        row["dwell_ratio"] = round(dwell[component["component_id"]] / mapped_ms, 4) if mapped_ms else 0
        score_rows.append(row)
    score_rows.sort(key=lambda row: (-row["total_dwell_ms"], row["component_id"]))
    for rank, row in enumerate(score_rows, 1): row["rank"] = rank
    return score_rows, retained, assigned, mapped_ms


def action_summary(events: list[dict], start: int, end: int, task_start: int):
    relevant = [event for event in events if start <= event["timestamp_ms"] < end]
    keys = Counter((event.get("key") or {}).get("key", "typing") for event in relevant if event.get("type") == "keydown")
    lines = []
    for event in relevant:
        if event.get("type") not in ACTION_TYPES:
            continue
        target = event.get("target") or {}
        label = text(target.get("accessible_name") or target.get("aria_label") or target.get("text") or event.get("url"), 70)
        lines.append({"time_s": round((event["timestamp_ms"] - task_start) / 1000, 3), "type": event["type"], "target": label})
    for key, count in keys.items():
        lines.append({"time_s": "", "type": "keyboard", "target": f"{key} ×{count}"})
    return lines


def color(score: float, maximum: float):
    if score <= 0 or maximum <= 0: return (190, 130, 40)
    ratio = min(1, score / maximum)
    return (int(40 + 20 * (1 - ratio)), int(190 - 110 * ratio), int(255 - 30 * ratio))


def render_overlay(image_path: Path, output_path: Path, components: list[dict], scores: list[dict], visits: list[dict]):
    image = cv2.imread(str(image_path))
    if image is None: raise RuntimeError(image_path)
    max_width = 1440
    scale = min(1.0, max_width / image.shape[1])
    if scale < 1: image = cv2.resize(image, (int(image.shape[1] * scale), int(image.shape[0] * scale)))
    by_id = {row["component_id"]: row for row in scores}; maximum = max((row["total_dwell_ms"] for row in scores), default=0)
    for component in components:
        x, y, w, h = (int(component[key] * scale) for key in ("x", "y", "width", "height"))
        score = by_id[component["component_id"]]["total_dwell_ms"]
        cv2.rectangle(image, (x, y), (x + w, y + h), color(score, maximum), 3 if score else 1)
        if score:
            cv2.putText(image, component["component_id"], (x + 3, max(16, y - 4)), cv2.FONT_HERSHEY_SIMPLEX, .45, color(score, maximum), 2, cv2.LINE_AA)
    points = []
    for visit in visits:
        point = (int(visit["centroid_x"] * scale), int(visit["centroid_y"] * scale)); points.append(point)
        cv2.circle(image, point, 12, (30, 30, 230), -1)
        cv2.putText(image, str(visit["visit_order"]), (point[0] - 5, point[1] + 5), cv2.FONT_HERSHEY_SIMPLEX, .45, (255, 255, 255), 2, cv2.LINE_AA)
    for first, second in zip(points, points[1:]): cv2.arrowedLine(image, first, second, (30, 30, 230), 2, cv2.LINE_AA, tipLength=.03)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), image, [cv2.IMWRITE_JPEG_QUALITY, 86])


def table(headers, rows):
    return "<table><thead><tr>" + "".join(f"<th>{html.escape(str(h))}</th>" for h in headers) + "</tr></thead><tbody>" + "".join("<tr>" + "".join(f"<td>{html.escape(str(cell))}</td>" for cell in row) + "</tr>" for row in rows) + "</tbody></table>"


def page(task, states):
    cards = []
    for state in states:
        component_rows = [[row["rank"], row["component_id"], row["label"], row["ax_role"], row["ax_depth"], f"{row['total_dwell_s']:.3f}", row["visit_count"], f"{row['dwell_ratio']:.1%}"] for row in state["scores"] if row["total_dwell_ms"]][:20]
        visit_rows = [[visit["visit_order"], visit["component_id"], visit["label"], f"{(visit['start_ms'] - state['task_start']) / 1000:.3f}", f"{visit['duration_ms'] / 1000:.3f}"] for visit in state["visits"]]
        action_rows = [[action["time_s"], action["type"], action["target"]] for action in state["actions"]]
        tree_text = "\n".join(f"{'  ' * row['depth']}{'[' + row['component_ids'] + '] ' if row['component_ids'] else ''}{row['role']} {row['name']}" for row in state["ax_tree"])
        cards.append(f"""<section class=state><h2>{state['state_id']} <small>{state['start_s']:.3f}s - {state['end_s']:.3f}s · scroll y={state['scroll_y']}</small></h2><p>{html.escape(state['url'])}</p><img src=\"{state['image']}\" alt=\"Bounding boxes and ordered gaze visits for {state['state_id']}\"><div class=grid><div><h3>Component dwell score</h3>{table(['rank','id','component','AX role','AX depth','dwell s','visits','ratio'],component_rows) if component_rows else '<p>No gaze was mapped to an extracted component.</p>'}</div><div><h3>Ordered gaze visits</h3>{table(['#','id','component','task time s','dwell s'],visit_rows) if visit_rows else '<p>No retained visit (minimum 100 ms).</p>'}<h3>Keyboard / mouse / navigation</h3>{table(['time s','type','target'],action_rows) if action_rows else '<p>No recorded action in this state.</p>'}</div></div><details><summary>Accessibility tree for this screen state - [Cxx] marks a bounding-box component mapped to that AX node</summary><pre>{html.escape(tree_text)}</pre></details></section>""")
    return f"""<!doctype html><meta charset=utf-8><title>Task {task['task_id']} component gaze review</title><style>body{{font:14px system-ui;margin:32px;color:#172033}}h1{{margin-bottom:4px}}small,p{{color:#526070}}.state{{border-top:2px solid #dce3ea;margin-top:30px;padding-top:18px}}img{{width:100%;max-width:1440px;border:1px solid #b9c4ce}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:24px}}table{{border-collapse:collapse;width:100%;font-size:12px}}th,td{{border-bottom:1px solid #dce3ea;padding:5px;text-align:left;vertical-align:top}}th{{background:#f3f6f8}}@media(max-width:850px){{.grid{{grid-template-columns:1fr}}}}</style><a href=index.html>← all tasks</a><h1>Task {task['task_id']} · {html.escape(text(task['title']))}</h1><p><b>Prompt:</b> {html.escape(text(task['prompt']))}<br><b>Outcome:</b> {html.escape(text(task['outcome']))}</p><p>Orange/blue boxes: extracted DOM/AX components. Brighter boxes have higher mapped dwell. Red numbered points/arrows: retained gaze-visit order. State duration is defined by recorder checkpoints, not an arbitrary fixed window.</p>{''.join(cards)}"""


def main(argv: list[str] | None = None):
    """Build component-level outputs.

    The defaults intentionally preserve the original 0819 layout.  Optional
    path arguments make the same processing usable for a new participant
    without editing this file.
    """
    global LOG_ROOT, MAPPED_ROOT, OUT
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", nargs="*", help="Task IDs, e.g. 01 02")
    parser.add_argument("--log-root", type=Path, default=LOG_ROOT,
                        help="Directory containing one recorder folder per task")
    parser.add_argument("--mapped-root", type=Path, default=MAPPED_ROOT,
                        help="Directory containing taskXX_mapped_gaze.csv files")
    parser.add_argument("--output-root", type=Path, default=OUT,
                        help="Directory for component review HTML, overlays, and CSV files")
    args = parser.parse_args(argv)
    LOG_ROOT = args.log_root.expanduser().resolve()
    MAPPED_ROOT = args.mapped_root.expanduser().resolve()
    OUT = args.output_root.expanduser().resolve()
    selected = {str(value).zfill(2) for value in args.tasks} if args.tasks else None
    if OUT.exists() and selected is None: shutil.rmtree(OUT)
    (OUT / "images").mkdir(parents=True, exist_ok=True)
    all_scores, all_visits, all_actions, all_edges, index_rows = [], [], [], [], []
    for task_id, folder in task_dirs(selected):
        session = load_json(folder / "session.json"); events = load_events(folder / "events.jsonl")
        states = sorted([load_json(path) for path in (folder / "states").glob("*.json")], key=lambda row: row["timestamp_ms"])
        gaze = load_gaze(MAPPED_ROOT / f"task{task_id}_mapped_gaze.csv")
        task_start, task_end = min(event["timestamp_ms"] for event in events), max(event["timestamp_ms"] for event in events)
        task = {"task_id": task_id, "title": session["task"]["title"], "prompt": session.get("task_prompt", ""), "outcome": (session.get("outcome") or {}).get("final_choice", "")}
        page_states = []
        for index, state in enumerate(states):
            start = state["timestamp_ms"]; end = states[index + 1]["timestamp_ms"] if index + 1 < len(states) else task_end
            snapshot = load_json(folder / state["dom_snapshot_asset"]["file"]); ax = load_json(folder / state["a11y_asset"]["file"])
            components = visible_components(snapshot, ax, state["viewport"])
            ax_by_backend, ax_parents = ax_tree(ax)
            for component in components:
                node = ax_by_backend.get(component["backend_id"])
                component["ax_node_id"] = str(node.get("nodeId")) if node else ""
                component["ax_parent_id"] = str(node.get("parentId")) if node and node.get("parentId") is not None else ""
                component["ax_role"] = ((node.get("role") or {}).get("value")) if node else ""
                component["ax_name"] = text(((node.get("name") or {}).get("value"))) if node else ""
                component["ax_depth"] = ax_depth(component["ax_node_id"], ax_parents)
            tree_rows = accessible_tree_rows(ax, components)
            scores, visits, assigned, mapped_ms = score_components(components, gaze, start, end)
            by_component = {component["component_id"]: component for component in components}
            previous, state_edges = None, []
            for visit in visits:
                component = by_component[visit["component_id"]]
                visit["ax_node_id"] = component["ax_node_id"]
                visit["ax_role"] = component["ax_role"]
                visit["ax_tree_distance_from_previous"] = ax_distance(previous["ax_node_id"], visit["ax_node_id"], ax_parents) if previous else None
                if previous:
                    prior_component, current_component = by_component[previous["component_id"]], by_component[visit["component_id"]]
                    gaze_jump = round(math.hypot(visit["centroid_x"] - previous["centroid_x"], visit["centroid_y"] - previous["centroid_y"]), 1)
                    gap = box_gap(prior_component, current_component)
                    tree_distance = visit["ax_tree_distance_from_previous"]
                    spatial = "near" if gap <= 80 else "far"
                    structural = "near" if tree_distance is not None and tree_distance <= 3 else "far"
                    edge = {"task_id": task_id, "state_id": state["state_id"], "from_component_id": previous["component_id"], "to_component_id": visit["component_id"], "from_label": previous["label"], "to_label": visit["label"], "from_ax_node_id": previous["ax_node_id"], "to_ax_node_id": visit["ax_node_id"], "ax_tree_distance": tree_distance, "gaze_jump_px": gaze_jump, "box_gap_px": gap, "spatial_relation": spatial, "structural_relation": structural, "alignment_class": f"screen_{spatial}__tree_{structural}"}
                    all_edges.append(edge); state_edges.append(edge)
                previous = visit
            actions = action_summary(events, start, end, task_start)
            image_rel = f"images/task{task_id}_{state['state_id']}.jpg"; image_out = OUT / image_rel
            render_overlay(folder / state["screenshot_file"], image_out, components, scores, visits)
            for row in scores: all_scores.append({"task_id": task_id, "state_id": state["state_id"], **row})
            for visit in visits: all_visits.append({"task_id": task_id, "state_id": state["state_id"], **visit})
            for action in actions: all_actions.append({"task_id": task_id, "state_id": state["state_id"], **action})
            page_states.append({"state_id": state["state_id"], "start_s": (start-task_start)/1000, "end_s": (end-task_start)/1000,
                                "scroll_y": (state.get("scroll") or {}).get("y", 0), "url": state.get("url", ""), "image": image_rel,
                                "scores": scores, "visits": visits, "ax_tree": tree_rows, "actions": actions, "task_start": task_start})
        (OUT / f"task{task_id}.html").write_text(page(task, page_states))
        index_rows.append(task)
    if all_scores:
        for filename, rows in [("component_scores.csv", all_scores), ("component_visits.csv", all_visits), ("state_actions.csv", all_actions), ("a11y_scanpath_edges.csv", all_edges)]:
            with (OUT / filename).open("w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(rows[0]), extrasaction="ignore"); writer.writeheader(); writer.writerows(rows)
    links = "".join(f"<li><a href=task{row['task_id']}.html>Task {row['task_id']} · {html.escape(row['title'])}</a><br><small>{html.escape(row['prompt'])}</small></li>" for row in index_rows)
    (OUT / "index.html").write_text(f"<!doctype html><meta charset=utf-8><title>Component gaze review</title><style>body{{font:16px system-ui;margin:40px;max-width:960px}}li{{margin:16px 0}}small{{color:#526070}}</style><h1>Component-level gaze and action review</h1><p>Recorder screen state is the analysis unit. Each task page shows bounding-box component dwell, gaze-visit order, and recorded keyboard/mouse/navigation actions.</p><ol>{links}</ol>")
    print(json.dumps({"tasks": len(index_rows), "output": str(OUT)}, indent=2))


if __name__ == "__main__": main()
