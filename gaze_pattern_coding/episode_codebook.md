# Episode Codebook

Version: `1.0.0-draft`

Analysis unit: Recorder-state/action-bounded episode containing retained AOI visits, actions, and projected AX nodes. A bounded adjacent-context window and the linked result state may support cross-state codes, but they do not merge episode boundaries and must be cited explicitly.

> Visit caveat: A retained component visit is an AOI-based grouping under project parameters (100 ms minimum, 75 ms sample-gap cap, 150 ms same-component merge gap), not a validated fixation.

> Population caveat: Sighted gaze projected onto AX nodes must not be described as blind-user or screen-reader behavior.

Coding rule: Assign at most one primary observed-behavior code, optionally one secondary code, one AX-projection code, one outcome code, and zero or more evidence modifiers. Abstain when minimum evidence is absent.

## Dimension 1 — Observed behavior

### DIR — Directed target acquisition

- Provenance: **literature-adapted** (G2, W4, W5)
- Definition: A short evidence path reaches a task-relevant unit and is immediately followed by the corresponding action or state transition.
- Include when: Target-relevant unit is visited; The next meaningful action operates on that unit or its direct control; Little or no peer-candidate inspection is present
- Exclude when: Several peer candidates are inspected; A known target is reached through multiple contextual intermediate states; use ORI; The episode only contains an action with no aligned gaze evidence
- Minimum evidence: At least one mapped target-related visit plus a corresponding action or result state.
- Confounds: A sparse recording can falsely appear directed.
- Positive example: Visit Search button → click Search → results state.
- Borderline example: One result is clicked after the gaze briefly passes over several unretained candidates.
- Compatible secondary codes: VER
- AX signature: No unique signature; often a short local or cross-subtree path.
- Candidate screen-reader implication: Offer an optional context-labeled shortcut while preserving the intermediate structure and original controls.
- Confidence guidance: High only when target visit, action, and resulting state align.

### SCN — Broad candidate scan

- Provenance: **literature-adapted** (G2, W1)
- Definition: Several peer semantic units are sampled to locate a promising candidate without evidence of pairwise comparison or sustained revisiting.
- Include when: At least four peer candidates or sections are visited; Most candidates receive one retained visit; No repeated A–B–A comparison loop dominates
- Exclude when: Two or more candidates are revisited with attribute evidence; use CMP; The route consists of contextual intermediate states; use ORI; Many visits are caused by one broad noisy container
- Minimum evidence: Ordered visits to at least four non-noisy peer units in one retrieval context.
- Confounds: Poor calibration, overlapping boxes, and missing text-level units can create apparent scanning.
- Positive example: Briefly visit five search-result cards, then continue scrolling.
- Borderline example: Four headings in a long article are visited but do not represent interchangeable candidates.
- Compatible secondary codes: DIR, RET
- AX signature: Often repeated traversal among sibling or nearby subtrees, but no signature is required.
- Candidate screen-reader implication: Provide a concise list overview with role, name, and key metadata; keep the full list reachable.
- Confidence guidance: Lower when semantic peer status is uncertain or component granularity is coarse.

### ORI — Contextual orienteering

- Provenance: **literature-grounded** (W3, W5)
- Definition: The user reaches a target through small contextual steps where each intermediate state or entity supplies information for the next move.
- Include when: At least two meaningful intermediate states or entities precede the target; Transitions follow contextual links, categories, hubs, or known landmarks; The route is not merely a direct query-result click
- Exclude when: Open-ended query or source reformulation dominates; use EXP; Intermediate states are redirects with no user decision; Only one target-directed action is observed; use DIR
- Minimum evidence: A cross-state route with at least three meaningful nodes and observable contextual transitions.
- Confounds: Navigation paths alone do not prove the user consciously used context.
- Positive example: University homepage → department → faculty list → faculty profile.
- Borderline example: Search result → detail → subpage, where the middle page may only be a required gateway.
- Compatible secondary codes: RET, VER
- AX signature: Usually includes document resets and movement into new semantic landmarks.
- Candidate screen-reader implication: Preserve breadcrumbs and source-link context; offer state-dependent next-step shortcuts rather than flattening the route.
- Confidence guidance: High when intermediate link names and resulting page semantics clearly align.

### EXP — Iterative exploration or reformulation

- Provenance: **literature-grounded** (W2, W6)
- Definition: The retrieval strategy, query, source, or working evidence changes across iterations while the user learns or investigates.
- Include when: A query, filter policy, source, or route is observably changed; Multiple iterations contribute different evidence or reject a prior route; The task supports learning, investigation, or cumulative gain
- Exclude when: A fixed known target is reached by contextual stepping; use ORI; A sort control changes only result order and no broader strategy change is visible; Goal evolution is inferred only from dwell
- Minimum evidence: At least two retrieval iterations plus an observable reformulation, source switch, or retained partial evidence.
- Confounds: The recording rarely exposes the user's evolving mental information need.
- Positive example: Search query → inspect source → revise query with a discovered term → inspect another source.
- Borderline example: Switch Relevance to New without evidence that the retrieval goal changed.
- Compatible secondary codes: SCN, CMP, RET
- AX signature: Commonly cross-document; no unique within-tree signature.
- Candidate screen-reader implication: Maintain an evidence tray, query history, and source context; do not collapse exploration into one recommended answer.
- Confidence guidance: High only with explicit query, source, or policy changes.

### CMP — Candidate comparison

- Provenance: **literature-adapted** (G2, W6, A7)
- Definition: Two or more semantically comparable candidates are revisited or inspected through attributes before a choice or continued search.
- Include when: At least two peer candidates exist; At least two candidates are revisited or each is connected to attribute evidence; The sequence provides a basis for a choice, rejection, or unresolved comparison
- Exclude when: Several candidates are viewed once with no return; use SCN; A–B–A crosses unrelated controls; The final choice is known but comparative evidence is absent
- Minimum evidence: Peer-candidate identity plus revisit or candidate-to-attribute transitions for at least two candidates.
- Confounds: Component-level boxes may not reveal which attribute text was read.
- Positive example: Candidate A → price A → Candidate B → price B → Candidate A → select A.
- Borderline example: A result card and a filter control alternate repeatedly.
- Compatible secondary codes: SCN, VER
- AX signature: Often lateral movement among sibling candidate subtrees with returns.
- Candidate screen-reader implication: Create an optional temporary comparison region or table that groups equivalent attributes and preserves links to source candidates.
- Confidence guidance: Lower when attribute-level evidence is unavailable.

### RET — Return or revisit

- Provenance: **literature-adapted** (W1, A2, A4)
- Definition: The sequence returns to a previously visited semantic unit, subtree, hub, or document after intervening evidence.
- Include when: A previously visited unit or state is revisited after at least one different meaningful unit; The return is visible in gaze, browser history, or state transition
- Exclude when: Consecutive samples merged into one visit; A duplicate DOM node is mistaken for the same semantic unit; The return is automatically labeled frustration or confusion
- Minimum evidence: A–…–A at the semantic-unit, subtree, or document level.
- Confounds: Return may indicate comparison, recovery, confirmation, or ordinary hub navigation; motivation is not encoded by RET.
- Positive example: Detail page → browser Back → result list.
- Borderline example: Gaze returns to the page header after a scroll reset.
- Compatible secondary codes: ORI, EXP, CMP, VER
- AX signature: AX return loop or document restoration when snapshots support it.
- Candidate screen-reader implication: Offer recent semantic locations, a context-preserving Back path, or next/previous candidate navigation.
- Confidence guidance: High for explicit browser history or stable semantic identity; lower for state-local Cxx identity alone.

### VER — Post-action verification

- Provenance: **literature-adapted** (G2, A8)
- Definition: After an action, the user inspects an observable changed value, selected state, destination, or completion signal.
- Include when: A meaningful action occurs in the source episode; A linked result state or changed region is captured after that action; A subsequent result-state visit targets the changed value, control, destination, or success signal
- Exclude when: Gaze merely returns to the control with no observable state change; A completion label is inferred from task intent alone; The episode ends immediately after the action
- Minimum evidence: Source action + linked observable before/after change + semantically aligned result-state inspection or explicit success signal.
- Confounds: Recorder checkpoints may miss the changed state; visual return alone is insufficient.
- Positive example: Select 720p → changed quality state → revisit quality value/player.
- Borderline example: Click a link → inspect the destination title, where this may be ordinary orientation rather than verification.
- Compatible secondary codes: DIR, ORI, CMP, RET
- AX signature: Document reset or changed control state followed by a mapped visit.
- Candidate screen-reader implication: Announce the verified change, retain or restore logical focus, and expose the completion signal.
- Confidence guidance: High only when the state change is recorded and semantically attributable to the action.

### INS — Sparse semantic inspection

- Provenance: **literature-adapted** (G2, W1)
- Definition: One or more mapped semantic units are inspected, but the available sequence does not support a more specific acquisition, scan, comparison, return, reformulation, orientation, or verification claim.
- Include when: At least one non-noisy semantic-unit visit is available; No more specific observed-behavior code meets its minimum evidence rule
- Exclude when: No mapped semantic-unit evidence is available; A more specific code meets its minimum evidence rule; Only a noisy broad container is mapped
- Minimum evidence: At least one identifiable non-noisy semantic-unit visit; 50–99 ms sensitivity visits are permitted only at low confidence and must be marked as relaxed evidence.
- Confounds: Sparse inspection does not establish reading, comprehension, relevance, decision strategy, or target intent.
- Positive example: Visit two content sections once without a return or subsequent aligned action.
- Borderline example: A 65 ms mapped link visit with no other retained evidence; code only as low-confidence relaxed INS.
- Compatible secondary codes: None
- AX signature: No unique signature; preserve the mapped node sequence and evidence tier.
- Candidate screen-reader implication: Do not create a shortcut from INS alone; retain it as descriptive evidence for later cross-episode motifs.
- Confidence guidance: Medium for standard retained visits and low when evidence exists only in the 50–99 ms sensitivity pass.

## Dimension 2 — AX projection

These codes describe where sighted gaze-mapped semantic units fall in the recorded AX tree. They are not screen-reader commands.

### AX_LOCAL — Local subtree traversal

- Definition: Most consecutive projected AX nodes remain within one shallow common ancestor or sibling group.
- Minimum evidence: At least two mapped visits with valid ancestry.
- Interpretation limit: Describes projected structure, not a screen-reader command.
- Candidate implication: Consider a region or group-level navigation unit.

### AX_CROSS — Cross-subtree traversal

- Definition: The projected sequence repeatedly moves between structurally separated AX subtrees in the same document.
- Minimum evidence: At least two transitions with valid least-common-ancestor evidence.
- Interpretation limit: Structural distance does not imply difficulty without an actual screen-reader interaction trace.
- Candidate implication: A shared virtual region may reduce repeated structural traversal when semantics justify grouping.

### AX_RETURN — AX return loop

- Definition: A projected AX node or semantic subtree is revisited after an intervening mapped node or subtree.
- Minimum evidence: A–…–A using stable AX or semantic identity.
- Interpretation limit: Does not reveal whether a screen-reader user would use Back, Shift+Tab, heading navigation, or another command.
- Candidate implication: Expose recent locations or group next/previous navigation.

### AX_RESET — Document or accessibility-tree reset

- Definition: The recorder document identifier changes and a new AX snapshot becomes current.
- Minimum evidence: Before/after document identifiers and AX snapshots.
- Interpretation limit: A reset may be navigation, reload, redirect, or tab change.
- Candidate implication: Announce the new context and establish a predictable initial focus.

### AX_UNMAPPED — Insufficient AX projection

- Definition: Visits lack valid AX nodes, ancestry, state alignment, or sufficient granularity for a structural code.
- Minimum evidence: Missing or contradictory mapping evidence.
- Interpretation limit: Requires abstention from tree-pattern claims.
- Candidate implication: Do not propose a structural transformation from this episode.

## Dimension 3 — Episode outcome

- **OUT_CONTINUE — Continued search:** The episode produces a route or evidence state but no selection or verified completion.
- **OUT_SELECT — Selection or commitment:** A candidate, control, or value is observably selected.
- **OUT_CONFIRM — Verified state:** An observable success or changed-state signal is confirmed.
- **OUT_UNRESOLVED — Unresolved:** The episode ends or pivots without task-relevant evidence or a valid next route.
- **OUT_UNKNOWN — Unknown or insufficient evidence:** The recording does not support an outcome claim.

## Evidence modifiers

`ordered`, `short_dwell_relative`, `repeated`, `cross_state`, `cross_document`, `hub_detail`, `attribute_linked`, `query_changed`, `filter_or_sort_changed`, `browser_history`, `state_change_observed`, `evidence_cumulative`, `mapping_uncertain`

## Abstention rules

- No aligned screenshot/DOM/AX state for the relevant action.
- Only noisy broad containers are visited.
- The code would require inferring intent, comprehension, confusion, frustration, or disability experience.
- Candidate or attribute identity cannot be established.
- A state change or completion signal required by the code was not recorded.
- Two codes remain equally plausible after applying exclusion criteria; mark needs adjudication.
