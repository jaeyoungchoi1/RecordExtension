# From browser recorder and mapped gaze to episode review

## Scope

This document records the reproducible part of the 31-task analysis:

```text
Browser recorder + screen-mapped gaze
        ↓
state-level DOM / accessibility-tree / screen-element alignment
        ↓
component visits, dwell, and transitions
        ↓
episode-review data and static viewer
```

It is designed for reusing the same analysis with another participant. It does not claim to reconstruct raw eye-tracker sensor data or the reference-image mapping that happened before `mapped/taskXX_mapped_gaze.csv` was written.

## Inputs

Each task has a recorder folder under `task_logs/<participant>/<task_id>/` containing:

- `session.json`: task prompt and recorded outcome;
- `events.jsonl`: timestamped browser, pointer, keyboard, navigation, and checkpoint events;
- `screen.webm`: browser-screen recording for visual QA;
- `states/state_XXXX.json` and `.png`: recorder checkpoints and screenshots;
- `assets/dom_snapshot/*.json`: DOM layout snapshots;
- `assets/ax/*.json`: accessibility-tree snapshots.

Each task also needs one screen-mapped gaze CSV, named `taskXX_mapped_gaze.csv`. The current code requires these columns:

| Column | Use |
|---|---|
| `timestamp [ns]` | converted to milliseconds for alignment with recorder events |
| `gaze detected in reference image` | rows other than `True` are discarded |
| `gaze position transf x [px]` | screen-space horizontal gaze coordinate |
| `gaze position transf y [px]` | screen-space vertical gaze coordinate |

The CSV may retain reference-image coordinates and fixation IDs, but the builder consumes the transformed screen coordinates. The raw eye-tracker export and the transformation used to generate these fields are not present in the 31-task pipeline.

## Stage 1 — Recorder state boundaries

The analysis unit is a recorder state rather than a fixed-duration window. States are sorted by `timestamp_ms`.

- State start: its recorder timestamp.
- State end: the following state timestamp; the final state ends at the final recorded event.
- Actions: events whose timestamps fall within `[state start, state end)`.
- Gaze: samples whose timestamps fall within the same half-open interval.

This keeps every screenshot, DOM snapshot, AX snapshot, action list, and gaze sample synchronized to the same visible state.

## Stage 2 — Visible components and AX provenance

`build_component_state_review.py` reads the state’s DOM layout snapshot and accessibility tree.

1. It retains visible, sufficiently large elements with a task-relevant DOM tag or accessibility role.
2. It corrects layout coordinates using the recorded scroll offset and device-pixel ratio.
3. It derives an accessible label from AX name, ARIA attributes, or descendant text.
4. It links the DOM element to its AX node through `backendDOMNodeId`.
5. It removes near-duplicate boxes with the same label and keeps at most 80 candidates.

Each retained component receives a state-local ID such as `C01`. These IDs must not be compared across different pages without the task and state ID.

## Stage 3 — Gaze-to-component attribution

For every gaze sample in the state interval:

1. If the point falls inside one or more component boxes, assign it to the smallest containing box.
2. Estimate its duration from the next gaze sample, capped at 75 ms to prevent a dropped sample from creating artificial dwell.
3. Break a visit when the point has no assigned component, the assigned component changes, or the sampling gap exceeds 75 ms.
4. Merge repeated visits to the same component when the gap is at most 150 ms.
5. Retain visits lasting at least 100 ms. The episode viewer also computes a separate 50 ms sensitivity pass; it does not replace the primary 100 ms sequence.

The result is an ordered list of component visits with start/end time, dwell, weighted gaze centroid, label, role, and state-local component ID.

## Stage 4 — Derived measures

For each state, the component builder writes:

- `component_scores.csv`: dwell, visit count, and dwell ratio for each visible component;
- `component_visits.csv`: ordered retained gaze visits;
- `state_actions.csv`: relevant browser, pointer, keyboard, and navigation actions;
- `a11y_scanpath_edges.csv`: each consecutive visit pair, its screen-space jump, component-box gap, and AX-tree distance.

The matching HTML pages render component boxes, dwell, numbered visit order, actions, and the AX tree. They are inspection aids, not cognitive labels.

## Stage 5 — Episode review

`build_episode_review.py` reuses the component extraction and visit-building functions. It then:

1. attaches cautious semantic names such as `Link / candidate`, `Sort / filter control`, or `Content section`;
2. marks generic containers as noisy instead of silently deleting them;
3. records tree movement and screen-state changes;
4. forms base episodes from recorder state and action boundaries;
5. exports one static task payload per task and a browser-based review interface.

Episodes are review units. They are not validated cognitive episodes and should not themselves be treated as ground-truth intent labels.

## Outputs

When using `run_pipeline.py --output-root /path/to/output`, the runner writes:

```text
/path/to/output/
├── component_state_review/
│   ├── component_scores.csv
│   ├── component_visits.csv
│   ├── state_actions.csv
│   ├── a11y_scanpath_edges.csv
│   ├── images/
│   └── taskXX.html
└── episode_review/
    ├── index.html
    ├── taskXX.html
    ├── images/
    └── data/
        ├── taskXX.js
        ├── episodes.json
        ├── semantic_units.json
        └── data_quality.json
```

## Reproduction checklist for another participant

1. Preserve a task-level correspondence between recorder folder and gaze CSV: task `12` uses `task12_mapped_gaze.csv`.
2. Confirm that recorder event timestamps are in milliseconds and mapped-gaze timestamps are in nanoseconds from the same clock basis.
3. Confirm that transformed gaze coordinates use the screenshot pixel frame after device-pixel-ratio scaling.
4. Run `validate_inputs.py` and resolve every failed task before rebuilding outputs.
5. Rebuild to a new `--output-root` first; inspect representative task HTML pages and CSV rows.
6. Do not infer preference, commitment, or intention from dwell alone. Repeat viewing can mean reading, comparison, confusion, or already-completed inspection.

## Code map

| File | Responsibility |
|---|---|
| `validate_inputs.py` | checks the recorder and mapped-gaze contract without writing derived data |
| `run_pipeline.py` | runs validation, component review, and episode review in order |
| `builders/build_component_state_review.py` | component extraction, AX linkage, gaze attribution, dwell/visit/edge generation |
| `builders/build_episode_review.py` | semantic normalization, episode construction, static viewer export |
| `../prepare_human_pattern_review.py` | optional manual-review package; outside the required rebuild path |

## Known boundary

The processing bundle begins after reference-image registration. The raw scene/sensor video and native eye-tracker exports that produced `taskXX_mapped_gaze.csv` are not linked by an executable 31-task mapper in this directory. A future full-stack handoff needs that mapping method, its calibration artifacts, and a per-session source manifest.
