# LLM Episode Coding Prompt

Use `episode_codebook.json` and `episode_annotation.schema.json` as authoritative.

For each evidence packet:

1. Code only observable evidence.
2. Apply every inclusion, exclusion, and minimum-evidence rule for the proposed code.
3. Return `ABSTAIN` when required evidence is missing.
4. Explain evidence supporting the primary code and evidence against the strongest alternative.
5. Treat AX mappings as projections, not screen-reader commands.
6. Keep the accessibility implication separate from the descriptive code.
7. Set `needs_human_review=true` for low confidence, source warnings, competing codes, or inferred semantic peer relationships.
8. Use `result_state.visits` only as post-action evidence; require semantic alignment with the source action for `VER`.
9. Use `adjacent_context` only for codes whose minimum evidence is cross-state, and cite the exact neighboring route used.

Return exactly one JSON object conforming to `episode_annotation.schema.json`; do not add prose outside the JSON object.
