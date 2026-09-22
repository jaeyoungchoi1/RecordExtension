"""Auditable AOI-level STA selection, fixation attribution, and tree statistics.

No synthetic representative order: original orders and projected orders are separate.
Selection is at AOI level, not the duration-ranked visit-instance level of original STA.
"""
from __future__ import annotations

import csv
import hashlib
import json
import math
import unicodedata
from bisect import bisect_right
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit


def norm(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).split()).casefold()


def page_key(url):
    """Ignore fragments/known tracking parameters; retain content-changing queries."""
    p = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in {"gclid", "fbclid"}]
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or "/", urlencode(sorted(query)), ""))


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:20]


def chain(node, parents):
    if node is None or node not in parents:
        return None
    out, seen = [], set()
    while node is not None:
        if node in seen or node not in parents:
            return None  # cycle or truncated ancestry: never invent a depth/LCA
        seen.add(node)
        out.append(node)
        node = parents[node]
    return out


def tree_record(node, parents, labels):
    ancestors = chain(node, parents)
    return {"node_id": node, "depth": len(ancestors) - 1 if ancestors else None,
            "leaf": node not in set(parents.values()) if ancestors else None,
            "ancestors": ancestors, "path": [labels.get(n, str(n)) for n in reversed(ancestors or [])]}


def jump(first, second):
    a, b = first.get("ancestors"), second.get("ancestors")
    if not a or not b:
        return {"available": False, "reason": "unmapped_or_incomplete_tree"}
    positions = {node: i for i, node in enumerate(a)}
    for down, node in enumerate(b):
        if node in positions:
            up = positions[node]
            depth = len(a) - 1 - up
            return {"available": True, "from_depth": first["depth"], "to_depth": second["depth"],
                    "from_leaf": first["leaf"], "to_leaf": second["leaf"],
                    "lca_id": node, "lca_depth": depth, "up": up, "down": down,
                    "distance": up + down, "lca_label": first["path"][depth]}
    return {"available": False, "reason": "different_tree_roots"}


def recorded_trees(base, snapshot, ax):
    """Compact complete recorded trees for lazy, source-faithful HTML inspection."""
    nodes, strings = snapshot['documents'][0]['nodes'], snapshot['strings']
    dom = []
    for i, parent in enumerate(nodes['parentIndex']):
        label = strings[nodes['nodeName'][i]]
        if nodes['nodeType'][i] == 1:
            attrs = base.attributes(nodes, strings, i)
            label += ('#' + attrs['id']) if attrs.get('id') else ''
        elif nodes.get('nodeValue'):
            label += ' ' + strings[nodes['nodeValue'][i]][:100]
        dom.append({'id': str(i), 'parent': str(parent) if parent >= 0 else None, 'label': label})
    _, parents = base.ax_tree(ax)
    for n in ax.get('nodes', []):
        for child in n.get('childIds', []):
            if str(child) in parents and parents[str(child)] is None:
                parents[str(child)] = str(n['nodeId'])
    accessibility = [{'id': str(n['nodeId']), 'parent': parents.get(str(n['nodeId'])),
                      'label': str((n.get('role') or {}).get('value', '')) + ': ' +
                               str((n.get('name') or {}).get('value', ''))[:160]}
                     for n in ax.get('nodes', [])]
    return {'dom': dom, 'ax': accessibility}


def enrich_components(base, semantic_unit, snapshot, ax, state, user, task, overrides, matching="balanced", max_components=200):
    # Reuse extraction unchanged, with a JY-only runtime limit; restore the imported
    # module even on failure. This builder is sequential, not multithreaded.
    original_limit = base.MAX_COMPONENTS
    try:
        base.MAX_COMPONENTS = max_components
        components = base.visible_components(snapshot, ax, state["viewport"])
    finally:
        base.MAX_COMPONENTS = original_limit
    doc = snapshot["documents"][0]
    nodes, strings = doc["nodes"], snapshot["strings"]
    parents = {i: p if p >= 0 else None for i, p in enumerate(nodes["parentIndex"])}
    children = defaultdict(list)
    for child, parent in parents.items():
        if parent is not None:
            children[parent].append(child)
    dom_labels = {i: strings[nodes["nodeName"][i]] for i in parents}
    ax_backend, ax_parents = base.ax_tree(ax)
    # Some AX snapshots provide childIds but omit parentId. Reconstruct those links.
    for n in ax.get("nodes", []):
        for child in n.get("childIds", []):
            if str(child) in ax_parents and ax_parents[str(child)] is None:
                ax_parents[str(child)] = str(n["nodeId"])
    ax_labels = {str(n["nodeId"]): f"{(n.get('role') or {}).get('value', '')}: {(n.get('name') or {}).get('value', '')}"
                 for n in ax.get("nodes", [])}
    for c in components:
        i = c["node_index"]
        attrs = base.attributes(nodes, strings, i)
        ax_node = ax_backend.get(c["backend_id"], {})
        full_name = ((ax_node.get("name") or {}).get("value") or attrs.get("aria-label")
                     or attrs.get("title") or attrs.get("placeholder")
                     or base.descendant_text(nodes, strings, i, children, limit=10**9))
        # Display labels are truncated by the original builder. Never use those
        # truncated labels as identity: different articles often share a prefix.
        normalized_name = norm(full_name)
        c["ax_name"] = full_name[:1024]
        c["ax_role"] = (ax_node.get("role") or {}).get("value") or ""
        c["semantic_name"], c["semantic_type"], c["noisy"] = semantic_unit(c)
        c["dom"] = tree_record(i, parents, dom_labels)
        c["ax"] = tree_record(str(ax_node["nodeId"]) if ax_node else None, ax_parents, ax_labels)
        # Full role/name + nearest named semantic container + target URL.
        # No XPath, coordinates, state Cxx, or backend ID used as cross-user identity.
        context = ""
        for parent in (c["dom"]["ancestors"] or [])[1:]:
            ancestor = ax_backend.get(nodes["backendNodeId"][parent], {})
            role = (ancestor.get("role") or {}).get("value", "")
            name = (ancestor.get("name") or {}).get("value", "")
            if role in {"article", "listitem", "row", "region", "navigation", "dialog", "form"} and name:
                context = norm(role) + ":" + norm(name)
                break
        target = attrs.get("href") or (attrs.get("src") if c["tag"] == "img" else "")
        # Anchor fragments distinguish e.g. different table-of-contents links.
        target = urljoin(state.get("url", ""), target) if target else ""
        identity = {"page": page_key(state.get("url", "")), "role": norm(c["ax_role"] or c["role"]),
                    "name": normalized_name[:512], "name_digest": digest(normalized_name),
                    "context": context, "target": target}
        c["identity"] = identity
        c["aoi_id"] = "A_" + digest(identity)
        c["matching"] = "exact_page_role_name_context_target"
        # Same-page links with the same destination and semantic container can
        # change accessible names (image alt text, loaded titles). Keep strict
        # identity for audit; never merge different pages or ambiguous copies.
        if matching == "balanced" and identity["role"] == "link" and target:
            target_parts = urlsplit(target)
            canonical_target = page_key(target) + ("#" + target_parts.fragment if target_parts.fragment else "")
            c["aoi_id"] = "B_" + digest([identity["page"], identity["role"], context, canonical_target])
            c["matching"] = "same_page_link_target_context"
        hits = [r for r in overrides if all(str(r[k]) == str(v) for k, v in
                {"user": user, "task": task, "state_id": state["state_id"], "component_id": c["component_id"]}.items()
                if k in r)]
        if len(hits) > 1:
            raise ValueError(f"Overlapping AOI overrides for {user}/{task}/{state['state_id']}/{c['component_id']}")
        if hits:
            c["aoi_id"] = "M_" + digest(hits[0]["canonical_id"])
            c["matching"] = "manual:" + hits[0]["canonical_id"]
        c["ambiguous"] = False
    groups = defaultdict(list)
    for c in components:
        groups[c["aoi_id"]].append(c)
    # A duplicated target (e.g. header + footer) does not justify merging copies.
    # Fall back to the original full identity before applying duplicate protection.
    for group in groups.values():
        if len(group) > 1 and group[0]["matching"] == "same_page_link_target_context":
            for c in group:
                c["aoi_id"] = "A_" + digest(c["identity"])
                c["matching"] = "exact_page_role_name_context_target"
    groups = defaultdict(list)
    for c in components:
        groups[c["aoi_id"]].append(c)
    for group in groups.values():
        if len(group) > 1 and not group[0]["matching"].startswith("manual:"):
            for c in group:
                c["ambiguous"] = True
                c["matching"] = "ambiguous_local_only"
                c["aoi_id"] = "L_" + digest([user, task, state["state_id"], c["component_id"], c["identity"]])
    return components


def load_fixations(path: Path, task_start, task_end, min_ms=100, gap_ms=75):
    """Use exporter fixation IDs; sum valid sample supports, never bridge missing IDs.

    A source fixation crossing a state is later split for attribution, but counted once
    per AOI. A >gap_ms gap starts a new fragment of the same source fixation.
    """
    rows, bad = [], 0
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        if "fixation id" not in (reader.fieldnames or []):
            raise ValueError("Missing fixation id; no silent sample-as-fixation fallback")
        for row in reader:
            try:
                t = int(row["timestamp [ns]"]) / 1_000_000
                if not task_start <= t < task_end:
                    continue
                fid = row.get("fixation id", "").strip()
                if fid and math.isfinite(float(fid)):
                    fid = str(int(float(fid))) if float(fid).is_integer() else fid
                else:
                    fid = ""
                x, y = float(row["gaze position transf x [px]"]), float(row["gaze position transf y [px]"])
                valid = row["gaze detected in reference image"] == "True" and math.isfinite(x) and math.isfinite(y)
                rows.append((t, x, y, (row.get("recording id", ""), fid) if fid else None, valid))
            except (ValueError, KeyError, OverflowError):
                bad += 1
    rows.sort(key=lambda r: r[0])
    groups = defaultdict(list)
    valid_support = no_id_support = 0.0
    for i, (t, x, y, fid, valid) in enumerate(rows):
        end = min(rows[i + 1][0] if i + 1 < len(rows) else t + 5, t + gap_ms, task_end)
        if not valid or end <= t:
            continue
        valid_support += end - t
        if fid:
            groups[fid].append((t, end, x, y))
        else:
            no_id_support += end - t
    retained = []
    for fid, samples in groups.items():
        duration = sum(b - a for a, b, _, _ in samples)
        if duration >= min_ms:
            retained.append({"fixation_id": "F_" + digest(fid), "source_fixation_id": fid[1],
                             "duration_ms": duration, "samples": samples})
    retained.sort(key=lambda f: f["samples"][0][0])
    return retained, {"invalid_rows": bad, "valid_sample_support_ms": valid_support,
                      "no_fixation_id_ms": no_id_support, "source_fixation_count": len(groups),
                      "retained_fixation_count": len(retained),
                      "retained_fixation_ms": sum(f["duration_ms"] for f in retained)}


def attribute_fixations(base, fixations, states, max_gap_ms):
    starts = [s["start_ms"] for s in states]
    observations = []
    for fix in fixations:
        groups = []
        for a, b, x, y in fix["samples"]:
            while a < b:
                si = bisect_right(starts, a) - 1
                if si < 0:
                    si = None
                    cut = min(b, starts[0]) if starts else b
                else:
                    cut = min(b, states[si]["end_ms"])
                    if cut <= a:
                        si, cut = None, b
                if groups and groups[-1]["si"] == si and a - groups[-1]["end_ms"] <= max_gap_ms:
                    g = groups[-1]
                else:
                    g = {"si": si, "start_ms": a, "end_ms": cut, "duration_ms": 0, "wx": 0, "wy": 0}
                    groups.append(g)
                dt = cut - a
                g["duration_ms"] += dt
                g["wx"] += x * dt
                g["wy"] += y * dt
                g["end_ms"] = cut
                a = cut
        for g in groups:
            x, y = g["wx"] / g["duration_ms"], g["wy"] / g["duration_ms"]
            state = states[g["si"]] if g["si"] is not None else None
            component = base.component_at(state["components"], x, y) if state and state["usable"] else None
            observations.append({"fixation_id": fix["fixation_id"], "source_fixation_id": fix["source_fixation_id"],
                "start_ms": g["start_ms"], "end_ms": g["end_ms"], "duration_ms": g["duration_ms"],
                "x": x, "y": y, "state_id": state["state_id"] if state else None,
                "aoi_id": component["aoi_id"] if component else None,
                "component_id": component["component_id"] if component else None,
                "dom": component["dom"] if component else None, "ax": component["ax"] if component else None,
                "unassigned_reason": None if component else (state["reason"] if state and not state["usable"] else "outside_extracted_AOI")})
    observations.sort(key=lambda o: o["start_ms"])
    for i, o in enumerate(observations):
        o["index"] = i
    return observations


def select_trends(users, min_majority=0.5):
    """Universal AOIs + strict-majority AOIs meeting BOTH universal attention minima."""
    stats = {}
    for user in users:
        exposed = set()
        for state in user["states"]:
            for c in state["components"]:
                a = stats.setdefault(c["aoi_id"], {"aoi_id": c["aoi_id"], "label": c["label"],
                    "identity": c["identity"], "matching": c["matching"], "by_user": {}, "exposed_users": []})
                if c["aoi_id"] not in exposed:
                    a["exposed_users"].append(user["user"])
                    exposed.add(c["aoi_id"])
        grouped = defaultdict(list)
        for o in user["observations"]:
            if o["aoi_id"]:
                grouped[o["aoi_id"]].append(o)
        for aid, obs in grouped.items():
            stats[aid]["by_user"][user["user"]] = {
                "fixation_count": len({o["fixation_id"] for o in obs}),
                "fragment_count": len(obs), "duration_ms": sum(o["duration_ms"] for o in obs),
                "first_ms": min(o["start_ms"] for o in obs) - user["start_ms"]}
    for a in stats.values():
        a["support"] = len(a["by_user"])
        a["frequency"] = sum(r["fixation_count"] for r in a["by_user"].values())
        a["duration_ms"] = sum(r["duration_ms"] for r in a["by_user"].values())
        a["category"] = "common" if a["support"] == len(users) else "remaining"
    common = [a for a in stats.values() if a["category"] == "common"]
    thresholds = {"frequency": min((a["frequency"] for a in common), default=None),
                  "duration_ms": min((a["duration_ms"] for a in common), default=None),
                  "majority_support_strictly_greater_than": min_majority,
                  "baseline_available": bool(common)}
    if common:
        for a in stats.values():
            if (a["category"] != "common" and a["support"] / len(users) > min_majority
                    and a["frequency"] >= thresholds["frequency"]
                    and a["duration_ms"] >= thresholds["duration_ms"]):
                a["category"] = "majority"
    return stats, thresholds


def transitions(user, stats, mode="direct", max_transition_gap_ms=1000):
    obs = user["observations"]
    if mode == "selected_projection":
        obs = [o for o in obs if o["aoi_id"] and stats[o["aoi_id"]]["category"] != "remaining"]
    out = []
    for a, b in zip(obs, obs[1:]):
        if not a["aoi_id"] or not b["aoi_id"] or a["aoi_id"] == b["aoi_id"]:
            continue
        same_state = a["state_id"] == b["state_id"]
        gap = max(0, b["start_ms"] - a["end_ms"])
        continuous = same_state and gap <= max_transition_gap_ms
        if mode == "direct" and not continuous:
            continue  # no arrows jumping across snapshots or long missing-data intervals
        out.append({"user": user["user"], "mode": mode, "from": a["aoi_id"], "to": b["aoi_id"],
            "from_index": a["index"], "to_index": b["index"], "from_state": a["state_id"], "to_state": b["state_id"],
            "gap_ms": gap, "skipped_fragments": b["index"] - a["index"] - 1,
            "boundary": None if continuous else "snapshot_or_gap_boundary",
            "dom": jump(a["dom"], b["dom"]) if same_state else {"available": False, "reason": "different_snapshots"},
            "ax": jump(a["ax"], b["ax"]) if same_state else {"available": False, "reason": "different_snapshots"}})
    return out


def summarize(users, stats, edges):
    for mode in ("direct", "selected_projection"):
        support = defaultdict(set)
        for e in edges:
            if e["mode"] == mode and not e["boundary"]:
                support[(e["from"], e["to"])].add(e["user"])
        for e in edges:
            if e["mode"] == mode:
                e["support_users"] = sorted(support[(e["from"], e["to"])]) if not e["boundary"] else []
                e["common_transition"] = len(e["support_users"]) == len(users)
    for u in users:
        obs = [o for o in u["observations"] if o["aoi_id"]]
        denominator = sum(o["duration_ms"] for o in obs)
        total_fids = len({o["fixation_id"] for o in obs})
        u["coverage"] = {"mapped_AOI_duration_ms": denominator, "mapped_AOI_fixations": total_fids,
                         "unassigned_retained_duration_ms": max(0, u["quality"]["retained_fixation_ms"] - denominator)}
        for category in ("common", "majority", "remaining", "selected"):
            rows = [o for o in obs if (stats[o["aoi_id"]]["category"] != "remaining" if category == "selected"
                                      else stats[o["aoi_id"]]["category"] == category)]
            duration = sum(o["duration_ms"] for o in rows)
            count = len({o["fixation_id"] for o in rows})
            u["coverage"][category] = {"duration_ms": duration, "fixation_count": count,
                "dwell_pct": 100 * duration / denominator if denominator else None,
                "fixation_pct": 100 * count / total_fids if total_fids else None,
                "of_recorded_retained_dwell_pct": 100 * duration / u["quality"]["retained_fixation_ms"]
                    if u["quality"]["retained_fixation_ms"] else None}
        summaries = []
        for mode in ("direct", "selected_projection"):
            for subset in ("all", "common_endpoints", "shared_transition"):
                es = [e for e in edges if e["user"] == u["user"] and e["mode"] == mode
                      and (subset == "all" or (subset == "shared_transition" and e["common_transition"])
                           or (subset == "common_endpoints" and stats[e["from"]]["category"] == "common"
                               and stats[e["to"]]["category"] == "common"))]
                for tree in ("dom", "ax"):
                    js = [e[tree] for e in es if e[tree]["available"]]
                    summaries.append({"mode": mode, "subset": subset, "tree": tree, "edges": len(es),
                        "valid_tree_edges": len(js), "unavailable": len(es) - len(js),
                        "leaf_to_leaf_count": sum(j["from_leaf"] and j["to_leaf"] for j in js),
                        **{f"mean_{k}": sum(j[k] for j in js) / len(js) if js else None
                           for k in ("from_depth", "to_depth", "lca_depth", "up", "down", "distance")}})
        u["tree_summary"] = summaries
        direct = [e for e in edges if e["user"] == u["user"] and e["mode"] == "direct"]
        shared = [e for e in direct if e["common_transition"]]
        u["coverage"]["shared_direct_transitions"] = {"count": len(shared), "total": len(direct),
            "pct": 100 * len(shared) / len(direct) if direct else None}
    return users
