# Coding Study Kit

This kit contains 511 evidence packets and 60 independently codable sampled episodes covering all 31 tasks. Each packet distinguishes source-state evidence, linked post-action result-state evidence, and bounded adjacent context. Task intent and specificity fields are provisional stratification metadata and require researcher review before analysis.

1. Review `sampling_audit.md` and the provisional strata in `sample_manifest.csv`.
2. Give `coder_a.csv` and `coder_b.csv` to two human coders; they must work independently.
3. Populate `disagreement_log.csv` only after both passes are frozen.
4. Run `python3 compute_agreement.py`; revise the codebook and re-code an agreed subset.
5. Only then run `compare_llm_to_gold.py` on `llm_sample_pilot_annotations.jsonl` or later LLM outputs.
