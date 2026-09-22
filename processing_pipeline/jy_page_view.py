"""Reference scroll mosaics and explicit AOI-center registration (not raw gaze)."""
from collections import defaultdict
from jy_analysis import page_key


def build_pages(users, stats):
    grouped = defaultdict(list)
    for ui, user in enumerate(users):
        for state in user["states"]:
            if state.get("usable") and state.get("image"):
                grouped[page_key(state["url"])].append((ui, state))
    pages = []
    for url, entries in sorted(grouped.items()):
        # A basis is a single document recording / width: never blend unrelated
        # responsive layouts or successive document reloads into one photograph.
        bases = defaultdict(list)
        for ui, state in entries:
            bases[(ui, state.get("document_id"), state["image_width"])].append(state)
        covered = set()
        for states in bases.values():
            bottom = 0
            for state in sorted(states, key=lambda s: (s.get("scroll_y", 0), s["start_ms"])):
                y = state.get("scroll_y", 0)
                top, end = max(y, bottom), y + state["image_height"]
                covered.update(c["aoi_id"] for c in state["components"]
                               if top <= y+c["y"]+c["height"]/2 < end)
                bottom = max(bottom, end)
        observed = {o["aoi_id"] for u in users for o in u["observations"] if o["aoi_id"]}
        # Preserve dynamic/menu AOIs hidden by the representative strip choice as
        # selectable single-state references, still only one screen at a time.
        for ui, state in entries:
            available = {c["aoi_id"] for c in state["components"]
                         if 0 <= c["y"]+c["height"]/2 < state["image_height"]}
            if (available & observed) - covered:
                bases[(ui, str(state.get("document_id"))+" / snapshot "+state["state_id"], state["image_width"])] = [state]
                covered.update(available)
        variants = []
        for (ui, document, width), states in bases.items():
            states.sort(key=lambda s: (s.get("scroll_y", 0), s["start_ms"]))
            tiles, anchors, bottom = [], {}, 0
            for state in states:
                x, y = state.get("scroll_x", 0), state.get("scroll_y", 0)
                end = y + state["image_height"]
                top = max(y, bottom)
                if end <= top:
                    continue
                tiles.append({"image": state["image"], "x": x, "y": y,
                              "width": width, "height": state["image_height"],
                              "clip_top": top, "clip_bottom": end, "state_id": state["state_id"]})
                for c in state["components"]:
                    cx, cy = x+c["x"]+c["width"]/2, y+c["y"]+c["height"]/2
                    if not top <= cy < end:
                        continue
                    aid = c["aoi_id"]
                    candidate = {"aoi_id": aid, "x": x+c["x"], "y": max(top, y+c["y"]),
                                 "width": c["width"], "height": min(end, y+c["y"]+c["height"])-max(top, y+c["y"]),
                                 "cx": cx, "cy": cy, "user_index": ui, "state_id": state["state_id"],
                                 "component_id": c["component_id"]}
                    # Largest visible instance avoids tiny clipped anchors.
                    if aid not in anchors or candidate["width"]*candidate["height"] > anchors[aid]["width"]*anchors[aid]["height"]:
                        anchors[aid] = candidate
                bottom = end
            counts = []
            for user in users:
                local_states = {s["state_id"] for s in user["states"] if page_key(s["url"]) == url}
                obs = [o for o in user["observations"] if o["state_id"] in local_states]
                mapped = [o for o in obs if o["aoi_id"] in anchors]
                counts.append({"user": user["user"], "shown": len(mapped), "total": len(obs),
                               "omitted": len(obs)-len(mapped), "state_ids": sorted(local_states)})
            variants.append({"reference_user": users[ui]["user"], "document_id": document,
                             "width": max((t["x"]+width for t in tiles), default=width), "height": bottom,
                             "tiles": tiles, "anchors": anchors, "alignment": counts,
                             "common_count": sum(stats[a]["category"] == "common" for a in anchors)})
        variants.sort(key=lambda v: (v["common_count"], sum(c["shown"] for c in v["alignment"])), reverse=True)
        pages.append({"url": url, "variants": variants})
    pages.sort(key=lambda p: max((v["common_count"] for v in p["variants"]), default=0), reverse=True)
    return pages
