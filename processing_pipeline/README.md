# 0819 Gaze-to-Episode Processing Pipeline

This folder is a standalone handoff bundle for rebuilding the 31-task analysis up to `episode_review`.
It preserves the existing 0819 output schemas while making paths and stages explicit for another participant's recording bundle.

The pipeline begins with **screen-mapped gaze**. It does not recreate the earlier eye-tracker export or reference-image registration step because the available 31-task code receives `taskXX_mapped_gaze.csv` as its input.

### If the bundle already has `out/taskN_gaze.csv`

Files with the required transformed x/y columns are already screen-mapped gaze; they do not need another gaze-registration step. Normalize their historical filenames once, using links by default (no duplicated CSVs):

```bash
python3 processing_pipeline/prepare_mapped_gaze.py \
  --source-root /path/to/out \
  --mapped-root /path/to/mapped
```

Then pass that `mapped` folder as `--mapped-root` to the validator and runner. Add `--copy` only if symbolic links are unsuitable for the handoff environment.

## What this bundle runs

```text
recorder bundle + screen-mapped gaze CSV
        ↓
component-level gaze / DOM / AX alignment
        ↓
component scores, visits, and scanpath edges
        ↓
episode-review viewer and task payloads
```

Read [PROCESS.md](PROCESS.md) before running the pipeline. It defines the input contract, temporal rules, component-attribution rules, outputs, and known limitations.

## Quick start

Run a read-only validation first:

```bash
python3 processing_pipeline/validate_inputs.py
```

Rebuild every task into a fresh output parent:

```bash
python3 processing_pipeline/run_pipeline.py \
  --output-root /path/to/rebuilt_0819_outputs
```

Test one task without touching the historical outputs:

```bash
python3 processing_pipeline/run_pipeline.py \
  --tasks 12 \
  --output-root /tmp/0819_task12_check
```

Use a new participant's data by replacing only the two input roots:

```bash
python3 processing_pipeline/run_pipeline.py \
  --log-root /path/to/new_user/task_logs \
  --mapped-root /path/to/new_user/mapped \
  --output-root /path/to/new_user/derived
```

With no `--output-root`, the runner writes to `processing_pipeline/derived/`. Builders replace their output directories, so use a distinct output root for separate runs.

## Canonical implementation

The canonical 0819 builders are included under `builders/` so this repository can be shared independently:

- `builders/build_component_state_review.py`
- `builders/build_episode_review.py`

They accept `--log-root`, `--mapped-root`, and `--output-root` and retain the original component attribution and episode-construction logic.
