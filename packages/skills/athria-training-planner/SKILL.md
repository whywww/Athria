---
name: athria-training-planner
description: Plan or revise Athria session templates and the user's current multi-domain Mesocycle using local profile and training history. Use when an Agent connected to Athria creates, adjusts, validates, or explains a plan; do not use for medical diagnosis or injury treatment.
---

# Athria Training Planner

Build reusable Plan Schema v4 session templates, then save the single Current Mesocycle that references them.

## Workflow

1. Call `get_athlete_profile`, `get_training_preferences`, `get_training_state`, and `get_training_taxonomy`. Keep the returned `inputSnapshotHash`, taxonomy version, and `0.90` hard-confidence threshold.
2. Inspect only the history and catalog slices needed for the request. Prefer catalog facts, exact aliases, and structured sources.
3. Split every session into one component per training mode. A session may contain multiple same-domain or different-domain components. Never generate `mixed`; the session domain list is derived from its components.
4. Use a `strength` prescription for Strength and `duration_only` for Endurance, Sport skill, Mind-body, Recovery, or currently unclassified content. Use `domain.value: null` only when a component cannot yet be classified reliably.
5. Exercises are open-world objects with stable `id`, `displayName`, and nullable `canonicalKey`. For custom exercises, infer the Strength descriptor proactively and record a source, confidence, non-empty evidence, and taxonomy version for every fact. Never pretend an inference is catalog- or user-confirmed.
6. List the template library and create or update templates first. Construct the complete Current Mesocycle with an explicit `effectiveStartDate`, a sparse natural-week structure that references template IDs, contiguous phases, and adjustment rules. Do not invent loads, RPE, training days, equipment, or injury status.
7. Call `validate_current_plan`. Use returned `missingFacts` and structured `dataGaps` to improve classification. Ask the smallest possible user question only for a remaining gap that affects a blocker, then record the answer as `user_confirmed`.
8. Revise blocker failures and blocker unknowns until none remain, or explain why the explicit constraints cannot all be verified or satisfied. Advisories should inform the recommendation but do not block saving.
9. Show the actual domain list, components, phases, rule evidence, classification coverage, Blockers, Advisories, Unknowns, and material tradeoffs. Never describe Athria validation as medical or injury-safety certification.
10. Call `save_current_plan` with the latest `inputSnapshotHash` and `expectedRevision`. If future planned sessions are affected, explain the impact and obtain a `keep` or `update` choice. Delete a template only after an explicit user request; never delete one still referenced by the Current Mesocycle.

## Boundaries

- Profile `constraintNotes` are context only. Do not claim Core enforced their natural-language contents.
- Typed equipment, duration, training-day, canonical-exercise, movement-pattern, and explicit-recovery constraints are Core-enforced.
- An action missing from the catalog is not an error. `UNKNOWN` is a rule-level outcome only when that rule lacks a required trusted fact.
- AI facts can support a hard pass only at confidence `>= 0.90`, with non-empty evidence and no source conflict. Lower confidence, missing evidence, or conflicting sources require inference or confirmation when a blocker depends on the fact.
- Never collapse Strength and Endurance into one unsupported fatigue or readiness score.
- Profile changes use `propose_profile_update` and remain pending until Dashboard approval.
- If the state snapshot changes, refresh context and revalidate instead of bypassing stale-state rejection.

Read [references/tool-contracts.md](references/tool-contracts.md) before constructing tool inputs or handling validation reason codes.
