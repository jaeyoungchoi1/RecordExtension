# Gaze-pattern qualitative coding kit

This is the standalone qualitative-coding package for the gaze-aware UI-agent study. It contains a literature-grounded codebook, a static HTML portal, 60 sampled episode evidence packets, blank independent-coder templates, and scripts for import, agreement, adjudication, and optional LLM comparison.

It intentionally does **not** include the 1.3 GB episode-review viewer, raw browser recordings, screenshots, or raw/mapped gaze files. The portal remains usable because its packet data includes the task prompt, ordered component visits, actions, AX projections, result-state evidence, and bounded adjacent context. The portal's optional screenshot/AX-tree link works only if a separately generated `episode_review/` folder is placed at this repository's root.

## Start coding

1. Read [episode_codebook.md](episode_codebook.md) and [CODER_PROTOCOL.md](coding_study/CODER_PROTOCOL.md).
2. Open `coding_study/coding_portal.html?coder=A` for coder A, or replace `A` with `B` for coder B. Use separate browser profiles and do not share local exports during independent coding.
3. The portal auto-saves locally. At the end, export the coder's CSV and JSON.
4. Validate and freeze both CSV exports before agreement:

   ```bash
   cd gaze_pattern_coding/coding_study
   python3 import_coder_export.py A /absolute/path/to/coder_a.csv
   python3 import_coder_export.py B /absolute/path/to/coder_b.csv
   python3 compute_agreement.py
   ```

See [coding_study/README.md](coding_study/README.md) for the full study sequence.

## Contents

- `episode_codebook.{md,json}` — observed-behavior, AX-projection, outcome, and modifier definitions.
- `coding_study/coding_portal.html` — static, two-coder HTML interface; `coding_portal_data.js` embeds the evidence packets and codebook.
- `coding_study/episode_evidence_packets.jsonl` — the full, auditable evidence data for 511 episodes.
- `coding_study/sample_manifest.csv` — 60 independently codable samples across the 31 tasks.
- `coding_study/coder_a.csv` and `coder_b.csv` — blank templates, not completed annotations.
- `coding_study/*agreement*`, `*adjudicated*`, and Python scripts — the reliability/adjudication workflow and current pilot artifacts. Recompute reports after importing a new independent coding pass.

## Scope boundary

The codebook labels observable, evidence-bounded behavior. It does not license claims about intent, comprehension, confusion, frustration, blind-user behavior, or screen-reader commands from gaze alone.
