# Independent Episode-Coding Protocol

## Purpose

Produce two independent human annotations of the same 60 episodes so that code definitions can be tested for reproducibility. This is a reliability study of the codebook, not a test of which coder is correct.

## Before the independent pass

1. Read `../episode_codebook.md` completely, including exclusions and abstention rules.
2. Review `sampling_audit.md` and the known source warnings.
3. Complete a small practice set that is not part of the 61 scored episodes.
4. Discuss only the practice cases and revise unclear written instructions before starting the scored 60-episode set.
5. Freeze the codebook version used for both passes.

Do not reveal the LLM pilot labels or virtual-transformation demo labels to either coder before the independent pass is frozen.

## Opening the portal

- Coder A: `coding_portal.html?coder=A`
- Coder B: `coding_portal.html?coder=B`

The two URLs use separate browser-storage namespaces. Each coder should use only their assigned URL and browser profile. The screenshot/AX-tree link opens a read-only viewer: automatic suggestions, merge/split controls, and the viewer's legacy annotation form are hidden.

## Decision order for every sample

1. Read the task prompt and episode boundary.
2. Inspect source-state visits and actions in temporal order.
3. Open the screenshot and AX-tree review when component identity or tree structure is unclear.
4. Inspect the linked result state only as post-action evidence.
5. Inspect bounded adjacent context only when a code explicitly requires cross-state evidence.
6. Choose one primary observed-behavior code or `ABSTAIN`.
7. Optionally choose one compatible secondary behavior.
8. Code the AX projection independently from the observed behavior.
9. Code the episode outcome independently from both behavior and task-level success.
10. Record evidence using visit numbers, action labels, state changes, and AX evidence.
11. Record the strongest alternative or exclusion reason in Notes.
12. Set confidence and whether human review is needed.

## Evidence boundaries

- Retained visits are AOI-based visits, not validated fixations.
- Dwell alone does not establish importance, relevance, comprehension, or confusion.
- A component-to-AX mapping is a structural projection of sighted gaze, not a screen-reader command.
- A result-state visit supports `VER` only when it is semantically attributable to the source action or an explicit success signal.
- Adjacent context does not silently merge episodes. Cite the exact neighboring episode when using it.
- Task-level success does not make every preceding episode `OUT_CONFIRM`.
- Choose `AX_UNMAPPED` when structural evidence is missing or contradictory.
- Choose `ABSTAIN` when minimum evidence is absent, even if an automatic pattern would be plausible.

## Independence rules

- Do not inspect the other coder's portal, exported CSV, notes, or progress.
- Do not discuss scored episodes until both exports are frozen.
- Do not inspect `llm_sample_pilot_annotations.jsonl`, `llm_pilot_annotations.jsonl`, or `demo_cases.json` during independent coding.
- Do not alter episode boundaries during the scored pass. Record a boundary concern in Notes.
- Do not revise the shared codebook mid-pass. Log a question and continue using the frozen version.

## Saving and export

The portal saves locally after form changes. A sample is counted complete only when primary behavior, AX projection, outcome, confidence, evidence, and review decision are filled. Secondary behavior is optional.

At the end:

1. Confirm the portal reports `61 / 61 complete`.
2. Export CSV and JSON.
3. Preserve the unedited JSON as an audit copy.
4. Validate and freeze each export from this directory:

   ```bash
   python3 import_coder_export.py A /absolute/path/to/coder_a.csv
   python3 import_coder_export.py B /absolute/path/to/coder_b.csv
   ```

   The importer requires all 60 samples and every required field, checks codebook enums and task/episode identity, writes `coder_a.csv` or `coder_b.csv` atomically, and records a SHA-256 freeze record. It refuses to replace existing annotations unless `--replace` is supplied deliberately. Use `--dry-run` to validate without writing.
5. Keep `coder_a.freeze.json` and `coder_b.freeze.json` with the unedited JSON exports.
6. Do not run adjudication until both files are frozen.

## Reliability and adjudication

Run:

```bash
python3 compute_agreement.py
```

Review:

- `agreement_report.md`
- `agreement_by_code.csv`
- `disagreement_candidates.csv`

`compute_agreement.py` synchronizes current disagreements into `disagreement_log.csv` while preserving any adjudication fields already entered for the same sample and dimension. Adjudicate each listed difference, including modifier differences. Record the selected value, evidence-based reason, whether the codebook changed, and adjudicator.

After every disagreement is resolved, build and freeze the human gold file:

```bash
python3 build_adjudicated.py
```

The builder uses coder agreement directly, requires a valid logged decision for every disagreement, combines the two evidence notes without treating their wording as an agreement score, and writes `adjudicated.freeze.json`. It refuses to overwrite populated gold labels unless `--replace` is supplied deliberately.

Low-agreement codes should be revised, merged, split, or explicitly retained as provisional. After revision, independently re-code an agreed subset before interpreting the final reliability values.

Only after adjudication should the LLM comparison be run:

```bash
python3 compare_llm_to_gold.py
```
