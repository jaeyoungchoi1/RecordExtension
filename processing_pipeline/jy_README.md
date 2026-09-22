# JY common AOI and scanpath analysis

An offline English report for each of 31 tasks, comparing User 1, User 3 and User 4.
Original `validate_inputs.py`, `builders/build_component_state_review.py`, and
`builders/build_episode_review.py` are imported/reused, not run as builders or edited.
The component extraction and semantic names come from these existing modules.

## Environment and execution

Use Python 3.11 (3.10+ required), NumPy and OpenCV. The local `.venv-jy` is verified
with Python 3.11.0, NumPy 2.4.6 and OpenCV 4.14.0. No model, GPU, network service,
JavaScript package, or web server is needed to generate or view the reports.

From the workspace root:

```bash
cd RecordExtension/processing_pipeline
# Existing environment on this machine:
source .venv-jy/bin/activate
python -m pip install -r jy_requirements.txt
python jy_validate_inputs.py
python jy_build_common_review.py
```

On another machine, create the environment before activation:

```bash
python3.11 -m venv .venv-jy
source .venv-jy/bin/activate
python -m pip install -r jy_requirements.txt
```

One-task run (recommended before the full batch):

```bash
python jy_build_common_review.py --tasks 04
```

Explicit paths and parameter example:

```bash
python jy_build_common_review.py \
  --data-root /path/to/utah_gazeaware \
  --users "User 1" "User 3" "User 4" \
  --output-root /path/to/reports/jy_common_review \
  --min-fixation-ms 80 --aoi-matching balanced --max-components 200 --max-sample-gap-ms 75 \
  --max-transition-gap-ms 1000 --majority-fraction 0.5 \
  --html-image-width 1000 --html-image-quality 58
```

Omit `--tasks` for tasks 01–31. The original output directories are not touched.
Rerunning a task replaces only that task's JY reports/previews; other task index
entries remain. No directory is recursively deleted. Use separate output roots for
parameter variants: the index can otherwise contain runs with different parameters.

## Inputs and outputs

Default inputs resolve relative to the script location, not the shell directory:

```text
utah_gazeaware/
  User 1/{mapped/,task_logs/01/,...,task_logs/31/}
  User 3/{mapped/,task_logs/01/,...,task_logs/31/}
  User 4/{mapped/,task_logs/01/,...,task_logs/31/}
```

Both `task01_mapped_gaze.csv` and `task1_gaze.csv` are supported. Gaze must include
`fixation id`, `timestamp [ns]`, `gaze detected in reference image`, and transformed
x/y pixel coordinates. Recorder inputs include events, session, state JSON,
DOMSnapshot, AX snapshot and screenshot assets. This is screen-mapped gaze analysis,
not a new eye-tracker calibration or fixation detection algorithm.

```text
RecordExtension/processing_pipeline/jy_derived/common_review/
  index.html             # tracked report entry point
  task01.html ... task31.html  # tracked standalone compact reports
  jy_index.json          # local build manifest; ignored by Git
  data/task01/
    analysis.json       # complete local audit; ignored by Git
    aois.csv            # selection category, identity, support, per-user attention
    fixations.csv       # source fixation fragments with AOI and tree ancestry
    transitions.csv     # direct and projected ordered edges, support, LCA/jumps
    tree_summary.csv    # per-user/per-tree/subset means and missing counts
    coverage.csv        # dwell, fixation-count and shared-edge coverage
    images/User 1/...   # portable JPEG previews; input PNGs are unchanged
```

Open `index.html` directly. Each task HTML contains its compact analysis payload and
screenshots, so the tracked HTML files can be shared without `data/`. The local
`data/` directory retains full JSON/CSV/tree audit outputs and is intentionally
ignored by Git. Screenshots embedded in HTML default to width **1000 px** and JPEG
quality **58**; use `--html-image-width` and `--html-image-quality` to change them.
Input errors produce a task report and a nonzero final exit code while other tasks
continue. Missing target evidence produces `not_assessable`, not an input failure.

## Method and thresholds

This is **AOI-level STA-inspired selection (stages 1–2)**, with original per-user
order retained. It deliberately does not implement duration-ranked instance selection
or the final priority/order aggregation from the 2016 STA paper.

1. **Fixations**: reuse source fixation IDs (qualified by recording ID). Retain a
   source fixation with at least **80 ms** of valid mapped-gaze sample support (previously 100 ms).
   Each valid sample contributes up to **75 ms**, clipped to the next timestamp and
   task end; the last sample receives at most **5 ms**. Invalid gaze and missing IDs
   are not counted as fixations. This support-based duration is conservative and
   can differ from the eye tracker's full fixation duration. Missing IDs and rejected
   rows are reported; there is no silent sample-count or visit-count fallback.
2. Split source fixations at snapshot boundaries and gaps over **75 ms**; use each
   fragment's duration-weighted centroid to attribute it to the smallest containing
   extracted AOI. No visit-merge threshold is used here. The 80 ms threshold applies
   before splitting. Fragments may therefore be shorter than 80 ms. One source
   fixation counts once per AOI, even if it has multiple fragments in that AOI.
3. **AOIs**: reuse the original main-document extraction: interesting DOM tags/AX
   roles, minimum raw box width **20 px**, height **14 px**, labeled elements, up to
   **200 components per state** (`--max-components`; originally 80), and same-label overlap deduplication above **90%**
   of the smaller box. Original viewport/DPR/scroll handling is retained (DPR fallback
   **2**). No extra fixation-position tolerance is added. Iframe documents are not
   extracted. These inherited filters affect the mapped denominator and coverage.
4. **Cross-user identity**: exact normalized page URL (fragments and known tracking
   queries removed; content query parameters retained), role, full-name hash, nearest
   named semantic container and target URL. Same-state identity collisions become
   local-only AOIs. No merging just because `C01`, backend IDs, pixels or tree depths
   match. This is conservative: personalized content/URLs and changed labels can
   prevent valid matches. Long name previews are shortened, but the full name is
   hashed before shortening, so matching does not use truncated label prefixes.
   Conversely repeated labels across different UI contexts
   still require identity auditing. “Exposed” means extracted in a usable snapshot,
   not proof of continuous visual availability.
   The new default `--aoi-matching balanced` additionally matches links by same page,
   role, destination URL (including fragment), and named container, allowing their
   accessible labels to differ. Same-state target collisions fall back to strict
   identities; remaining strict collisions stay local-only. No fuzzy text matching,
   cross-page matching, or merging by coordinates is introduced. Each source identity
   remains in the clickable provenance audit. Balanced matches still need review.
5. **Common**: at least one retained attributed fixation from **every requested user**.
   Compute common-set minima `Fmin = min(total distinct source fixations per AOI)`
   and `Dmin = min(total attributed fixation dwell per AOI)`. The two minima can come
   from different AOIs.
6. **Strong majority**: support fraction strictly greater than **0.5** (thus **2/3**
   here), total fixation count **>= Fmin**, and total dwell **>= Dmin**. This explicit
   user-support guard is an AOI-level adaptation, not a verbatim original STA rule.
   All common AOIs are kept. With no common baseline, no majority AOIs are promoted.
   If any requested user has no usable target snapshots or no assigned fixations,
   selection is marked **unassessed** for the entire task; the participant denominator
   is never reduced to available users.
7. **Order**: direct edges follow consecutive fixation fragments, excluding same-AOI
   repetitions, snapshot crossings, unassigned intervening fragments, or gaps over
   **1000 ms**. Projected edges connect consecutive common/majority observations after
   removing others; skipped-fragment counts and snapshot/gap boundaries are explicit.
   Nothing is sorted into a synthetic consensus. A shared directed edge requires
   support from every user in the same mode, without crossing a snapshot/gap boundary.
   Shared nodes or edges do not prove a shared longer subsequence.

The task-library launcher is excluded by default to avoid trivial common controls
dominating attention. `--include-launcher` includes it explicitly. Ignored launcher
time remains in the all-retained-dwell quality denominator, not the mapped AOI
denominator. Preview width is **1600 px**, JPEG quality **82**; these do not affect
analysis coordinates or thresholds.

For the previous analysis settings use `--min-fixation-ms 100 --aoi-matching strict
--max-components 80`. The defaults are sensitivity adjustments, not empirically
optimized thresholds; they do not guarantee more common AOIs. Different pages,
missing snapshots and genuinely different attention remain non-common/unassessable.

## Merged page visualization and annotations

The sequence rails and separate participant panels have been removed. Choose one
page and one reference mosaic. Screenshot strips from that recording are positioned
using DOMSnapshot scroll offsets in the same pixel space as extracted AOIs. Each
strip contributes only its not-yet-covered vertical region. Different URLs,
document recordings and viewport widths are kept as separate choices. The default
reference maximizes common anchors, then aligned observations. Dynamic/sticky content
can produce seams; this is a recorded-state mosaic, not a reconstructed live DOM.
Dynamic/menu AOIs absent from mosaic strips receive selectable single-state reference
fallbacks so their remaining observations can still be inspected on one screen.

All users' paths are **AOI-center projections**, not raw fixation coordinates: a
matched AOI supplies the common visual anchor despite scrolling or layout changes.
Orange/blue/purple paths are translucent; common AOIs and genuinely shared directed
edges are bold black. No shared edge means no invented black connecting arrow.
Projected mode also overlays solid direct links involving remaining observations;
projected selected links are dashed. The filter can hide either category.
The report retains the existing same-snapshot/gap restrictions on transitions.

Only observations with anchors in the chosen mosaic are plotted. Per-user shown and
omitted counts are explicit. Change the reference to see other remaining AOIs;
All displayed AOI anchors have boxes, regardless of the path filter; the default
path filter is **Common only**. Common strokes are 6 display pixels and user strokes
3.5 display pixels, independent of screenshot scaling.
Unassigned observations and AOIs absent from all reference strips remain in the data
and provenance audit, not misleadingly placed on an unrelated screen. Whole-task
coverage percentages are independent of this display subset.

Click an AOI box/node to highlight it. The screen and right-hand tree panel use a
4:1 layout (stacked on narrow screens). Standalone HTML retains the recorded ancestry
of every extracted AOI plus collapsed counts for omitted branches; only the selected
ancestry opens by default. Complete recorded trees remain in ignored `analysis.json`.
Choose a recorded instance to inspect another user's/state's node. Coverage shows
common, majority and remaining only; the separate AOI statistics section is removed.
Tree jumps shows common-endpoint transitions only for the selected page/path mode:
source, LCA and destination are highlighted in their actual recorded trees, with
up/down routes, depths, leaf flags and distance explained. Shared-all-user edges are
distinguished from individual ordering of common AOIs. Index entries now report
participant-specific missing snapshots/assets or absent retained/assigned fixations.

Write a note and select **Save**. Notes are stored per task/AOI
in browser localStorage, with **Export annotations JSON** for portable backup. File-URL
storage support varies by browser; export if storage is unavailable. Regenerating with
different matching settings may change AOI IDs; export annotations before doing so.

## Coverage and structural movement

Primary coverage is category dwell / all mapped retained fixation dwell per user.
Common + majority + remaining dwell partitions that denominator. Also report:
distinct-fixation coverage, selected coverage, common/all-retained dwell, unassigned
retained dwell, mapping coverage, and shared direct edge occurrences / all eligible
direct edge occurrences. A source fixation split between multiple AOIs/categories
can contribute to multiple count numerators; count percentages need not sum to 100%.
Null means unavailable; it is never displayed as zero.

For each transition in the same recorded snapshot, calculate DOM and AX start/end
depth, actual recorded leaf flags, lowest common ancestor ID/label/depth, edges up,
edges down and total distance. Roots have depth 0; DOM includes text nodes and AX
includes ignored nodes. Missing/cyclic/truncated ancestry yields unavailable values.
Distances across snapshots/documents are unavailable even for equal-looking node IDs.
The UI separates common endpoints from truly shared directed transitions and offers
both direct and projected sequences. Projected jumps describe relationships of selected
AOIs, not necessarily a single observed saccade.

## Auditing AOI matches

Inspect HTML identity details and the local `analysis.json` before interpreting
absence as a personal behavior. If two local elements demonstrably represent the
same target, supply a manual mapping with `--aoi-overrides mappings.json`:

```json
[
  {"user":"User 1","task":"04","state_id":"state_0004","component_id":"C07","canonical_id":"task04:verified-search-control"},
  {"user":"User 3","task":"04","state_id":"state_0008","component_id":"C12","canonical_id":"task04:verified-search-control"}
]
```

Repeat audited mappings for relevant states and all matching users. Shared arbitrary
roles like “button” are insufficient evidence. Automatic identities are preserved in
the export even for overridden elements.

Some current tasks have only launcher snapshots for one or more users. Such tasks
still produce English HTML reports with available colored trajectories and a clear
not-assessable state; they cannot establish common target AOIs without the missing
recorded evidence. Merely having the session/events/CSV files does not ensure usable
target AOI coverage.

## Small checks

```bash
python jy_test_analysis.py
python jy_build_common_review.py --tasks 04 --output-root /tmp/jy_common_smoke
```

The synthetic checks cover universal/majority thresholds, missing baselines, source
fixation counting and time conservation at state boundaries, direct vs projected
order, common nodes vs shared edges, and tree LCA/depth calculations.
