# Episode-Based Gaze + Accessibility-Tree Review

This static viewer supports bottom-up coding of all 31 recorded tasks. Open
`index.html` directly in a browser; no server is required.

## Evidence model

- Episodes follow recorder state/action boundaries, never a fixed time window.
- The screen, retained gaze visits, action list, and AX tree use the same recorder
  state. The result-state tab shows the immediate next checkpoint when present.
- `Cxx` remains a state-local visual-element candidate. `semantic_name` is a
  cautious normalization, while raw DOM/AX provenance remains in
  `data/semantic_units.json`.
- Generic `main`, `navigation`, `section`, and similar containers are marked as
  noisy rather than silently removed.
- Missing AX mappings are shown as `Unmapped`.

## Coding workflow

1. Select a task and episode.
2. Inspect the numbered screen scanpath.
3. Hover a screen box, tree node, or visit row to highlight its counterparts.
4. Inspect actions and tree movement descriptors.
5. Accept or ignore evidence-based suggestions, then record visual pattern,
   tree pattern, outcome, workflow context, confidence, and a note.
6. Export annotations as JSON and CSV.

Suggested labels and coder decisions are stored separately. Browser annotations
are kept in localStorage; the checked-in `data/annotations.*` files are empty
templates.

## Episode editing

`Merge next` combines adjacent base episodes. `Split here` separates a merged
episode after the selected state. Episode edits are also stored in localStorage.

## Known source limitation

Task 15 contains only one recorder checkpoint, captured on the task launcher.
Its Booking.com actions exist in the event log, but matching Booking screenshots,
DOM snapshots, and AX trees were not recorded. The viewer exposes this limitation
and does not attach the launcher AX tree to Booking actions as if it were valid.

## Rebuild

```bash
python3 /Users/jaywoong/Research/gaze_aware_ui_agent/0819/build_episode_review.py
```
