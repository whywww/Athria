---
name: athria-training-planner
description: Create, review, revise, validate, and save Athria's current multi-domain Mesocycle and reusable session templates. Use for a first cycle, a material current-cycle adjustment, an end-of-cycle review, the next cycle, or template management; do not use for read-only coaching, athlete-profile updates, or one-off workout execution.
---

# Athria Training Planner

Own the lifecycle of the user's single Current Mesocycle. Do not update Profile, Wellness, individual workout execution, or Training History.

## Plan workflow

1. Read `get_athlete_profile`, `get_training_state`, `list_wellness`, and `get_training_taxonomy`. Keep the profile hash, `inputSnapshotHash`, taxonomy version, and hard-confidence threshold.
2. Read only the training history and summaries needed for the requested cycle. Use `get_current_plan` when revising or replacing an existing plan.
3. Create or recover a persistent plan draft. For a new plan call `create_plan_draft` with Plan Schema v7 metadata but no `weeks`; when revising use `current_plan` and preserve unaffected weeks. Write one complete week at a time with `upsert_plan_draft_week`. Templates are optional provenance, never the executable plan.
4. Call `validate_plan_draft`. Resolve blocker failures and blocker unknowns. Ask only for a fact needed to clear a remaining blocker; do not invent loads, effort, availability, equipment, recovery, or injury status.
5. Show the plan's goal, domain phases, representative prescriptions, validation blockers/advisories/unknowns, material tradeoffs, and what will replace the current plan.
6. Obtain explicit approval for the complete proposal. Editing, rejection, or “later” is not approval.
7. After approval, re-read `get_current_plan`, `get_training_state`, and `get_athlete_profile`. Rebase, revalidate, and ask again if the revision, snapshot hash, or profile hash changed.
8. Call `commit_plan_draft` once with the draft ID, latest `inputSnapshotHash`, expected plan and draft revisions, and `confirmed: true`. Never make a partial Current Plan write. Use `list_plan_drafts` to resume work in a later conversation and `discard_plan_draft` for abandoned work.

## Adjustment workflow

Use this for a periodic review or a user-requested change to the current cycle.

1. Call `get_plan_adjustment_review` with `weekly_review` or `user_request`.
2. For `keep`, do not propose a rewrite. For `watch`, explain the signal and keep the plan unless the user explicitly requests a change. For `review_recommended` or `review_required`, read only the evidence identified by the assessment.
3. Apply the minimum recommended scope while preserving unaffected future work and every completed or skipped historical occurrence. Do not automatically repay missed volume.
4. Validate, explain, approve, freshness-check, and atomically save using the Plan workflow.

Profile changes are handled by `$athria-athlete-profile`. When that workflow reports a plan review is recommended or required, continue here with a fresh `get_plan_adjustment_review` using `profile_change`; never treat the Profile update as approval to rewrite the plan.

## End-of-cycle and next-cycle workflow

1. Compare the ending cycle with actual Training History: adherence, completed key sessions, domain-specific progression, interruptions, and unresolved data gaps.
2. Separate evidence from interpretation. Do not collapse Strength, Endurance, sport skill, mind-body, and recovery into one synthetic readiness score.
3. Confirm the next cycle's primary goal only when it cannot be derived confidently from the current Profile and the user's request.
4. Draft the next complete cycle using the normal Plan workflow. Preserve the prior cycle only as review evidence; Athria stores one editable Current Mesocycle, not plan history.

## Plan target

Populate the optional `target` object whenever the evidence supports it so the Dashboard can explain the block at a glance. Keep one `primaryGoal`, distinguish actively progressing `supporting` goals from deliberately held `maintenance` capacities, and summarize cross-domain priorities in `coordinationStrategy`. Add a baseline or test date only when it is supported by Profile, history, or the user's explicit request.

## Templates

Templates are optional, reusable, single-domain structures without an executable dose. Read `get_training_taxonomy` before constructing one and use only returned taxonomy IDs.

- Show the proposed create, update, or delete operation and obtain explicit approval immediately before calling `create_session_template`, `update_session_template`, or `delete_session_template`.
- Updating a Template never updates Sessions. Never delete a Template still referenced by the Current Mesocycle.
- A Weekly Session that cites a versioned template still contains its complete authoritative prescription.

## Plan invariants

- Every Strength exercise has numeric `targetRpe`; every Endurance step has a relative `heartRateZone` label.
- Fix missing Strength RPE and Endurance zone advisories before saving whenever the evidence permits a compliant annotation. Advisories inform the recommendation but do not themselves block saving.
- Exercise and classification facts retain source, confidence, evidence, and taxonomy version. AI-inferred facts support hard validation only at or above the returned confidence threshold with no conflict.
- Count multiple sessions on one date as one training day. Respect Profile rhythm, equipment, maximum duration, and explicit recovery-day constraints.
- A skipped session stays skipped only when its replacement retains the same ID and `status: "skipped"`; re-planning it requires a new ID.
- Never describe Athria validation as medical or injury-safety certification.

Read [references/tool-contracts.md](references/tool-contracts.md) before constructing template or plan inputs, interpreting adjustment reason codes, or handling validation and freshness errors.
