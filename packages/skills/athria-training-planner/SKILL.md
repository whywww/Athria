---
name: athria-training-planner
description: Create, review, revise, validate, and save Athria's current multi-domain Mesocycle and reusable session templates. Use for a first cycle, a material current-cycle adjustment, an end-of-cycle review, the next cycle, or template management; do not use for read-only coaching, athlete-profile updates, or one-off workout execution.
---

# Athria Training Planner

Own the lifecycle of the user's single Current Mesocycle. Do not update Profile, Wellness, individual workout execution, or Training History.

## Language

Use the user's requested language, or the language of their latest substantive message; a brief approval does not switch it. Use that language for replies, previews, and all newly generated plan, session, exercise, and template text written through MCP. Preserve user and source text, unchanged plan content, and structured MCP fields, IDs, enums, numbers, and notation. If a revision's mixed language makes the write unclear, ask whether to keep or translate old text before drafting; show any translation in the normal approval previews.

## Mandatory planning preflight

Run this preflight for every new, revised, adjusted, or next-cycle plan. It has two user checkpoints before detailed drafting.

1. Call only `get_database_context`. Show its absolute `databasePath` in a short confirmation request. Do not read athlete data until the user confirms this is the intended database. If the path changes later, stop and repeat this checkpoint.
2. After database confirmation, read `get_athlete_profile`, `get_training_memory`, `get_training_state`, `get_current_plan`, `get_data_source_status`, `get_training_taxonomy`, and decision-relevant windows from `list_training_sessions`, `get_training_summary`, and `list_wellness`. Keep the profile hash, `inputSnapshotHash`, current-plan revision, taxonomy version, and hard-confidence threshold.
3. Review every Profile field and the available history, Wellness coverage, and source freshness internally. Tell the user only the known facts and evidence cutoffs that matter to this plan, plus the most important unresolved gap, if any. Ask at most two or three related things per turn; ask the next question only if its answer could change the outline or clear a validation blocker. Prioritize goal, availability and session length, then relevant equipment and constraints. Use existing values for preferences, recovery spacing, cycle length, and target events as provisional context when unconfirmed; confirm them only if the request or evidence makes that necessary. Keep the current timezone unless a date or scheduling decision depends on it or there is evidence of a mismatch. Do not display the whole Profile or ask for every possible field at once.
4. Handle any Profile or Wellness correction through `$athria-athlete-profile`, including its exact diff, approval, update, and freshness rules. Do not add Profile or Wellness write tools to this Skill. After a correction, re-read the affected context before continuing.
   If history and memory cannot support an experience or capability judgment needed for this plan, ask up to two or three short, related questions about prior activity, recent consistency, or a concrete comfortable session. Skip known facts and accept uncertainty if the athlete declines. Route meaningful new evidence or a memory correction through `$athria-athlete-profile` for a concise automatic memory revision, then refresh `get_training_memory` and `get_training_state` before drafting.
5. Ask about connection, sync, or import only when that source could materially improve this plan's evidence. For a relevant disconnected API source, offer Athria → Connections; for a relevant connected API source whose `syncedToday` is false, offer **Sync now**. If the user chooses to sync, pause planning and re-call `get_data_source_status` after they finish. Treat Hevy as an optional CSV import, not an API connection or daily-sync requirement. If the user declines, continue when feasible and briefly state the evidence cutoff and limitation.
6. Propose a short outline containing the primary goal, cycle duration, each domain's phases and progression, and every training day's broad objective and rationale. Obtain explicit approval of this outline before creating or resuming a plan draft. Revisions require a new outline approval.
   Treat Profile `maxSessionMinutes` as the usual limit for ordinary training. Before seeking outline approval, identify any proposed longer session, its duration, and why it needs to exceed the limit; ask whether the user accepts each exception. A long run, hike, or camping activity is not automatically exempt. If the user declines, revise the outline.

## Detailed plan and commit

1. Only after outline approval, create or recover a persistent plan draft. For a new plan call `create_plan_draft` with Plan Schema v7 metadata but no `weeks`; when revising use `current_plan` and preserve unaffected weeks. Write one complete week at a time with `upsert_plan_draft_week`. Templates are optional provenance, never the executable plan.
2. Call `validate_plan_draft`. Resolve blocker failures and blocker unknowns. Ask only for a fact needed to clear a remaining blocker; do not invent loads, effort, availability, equipment, recovery, or injury status.
3. Show the complete detailed plan: goal, every week's sessions and prescriptions, progression, validation blockers/advisories/unknowns, material tradeoffs, and exactly what will replace the Current Plan. List each session over `maxSessionMinutes` with its duration and reason again when requesting detailed approval. If a previously accepted exception's duration or substance changed, explain the change and obtain renewed acceptance before approval.
4. Obtain explicit approval for this complete detailed proposal. Outline approval does not authorize `commit_plan_draft`; editing, rejection, or “later” is not approval.
5. After detailed approval, re-read `get_database_context`, `get_current_plan`, `get_training_state`, and `get_athlete_profile`. If the database path changed, restart at database confirmation. If the plan revision, snapshot hash, or profile hash changed, rebase, revalidate, show the affected detailed changes, and obtain detailed approval again.
6. Call `commit_plan_draft` once with the draft ID, latest `inputSnapshotHash`, expected plan and draft revisions, and `confirmed: true`. Never make a partial Current Plan write. Use `list_plan_drafts` to locate earlier drafts, but repeat database and outline confirmation before resuming one in a later conversation. Use `discard_plan_draft` for abandoned work.

## Adjustment workflow

Use this for a periodic review or a user-requested change to the current cycle.

1. Call `get_plan_adjustment_review` with `weekly_review` or `user_request`.
2. For `keep`, do not propose a rewrite. For `watch`, explain the signal and keep the plan unless the user explicitly requests a change. For `review_recommended` or `review_required`, read only the evidence identified by the assessment.
3. Apply the minimum recommended scope while preserving unaffected future work and every completed or skipped historical occurrence. Do not automatically repay missed volume.
4. Validate, explain, approve, freshness-check, and atomically save using the mandatory preflight and detailed-plan workflow above.

Profile changes are handled by `$athria-athlete-profile`. When that workflow reports a plan review is recommended or required, continue here with a fresh `get_plan_adjustment_review` using `profile_change`; never treat the Profile update as approval to rewrite the plan.

## End-of-cycle and next-cycle workflow

1. Compare the ending cycle with actual Training History: adherence, completed key sessions, domain-specific progression, interruptions, and unresolved data gaps.
2. Separate evidence from interpretation. Do not collapse Strength, Endurance, sport skill, mind-body, and recovery into one synthetic readiness score.
3. Confirm the next cycle's primary goal only when it cannot be derived confidently from the current Profile and the user's request.
4. Draft the next complete cycle using the mandatory preflight and detailed-plan workflow above. Preserve the prior cycle only as review evidence; Athria stores one editable Current Mesocycle, not plan history.

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
- Count multiple sessions on one date as one training day. Respect Profile rhythm, equipment, and explicit recovery-day constraints. Use `maxSessionMinutes` for ordinary sessions; a longer session remains a validation advisory and requires the user's explicit acceptance in the planning conversation.
- A skipped session stays skipped only when its replacement retains the same ID and `status: "skipped"`; re-planning it requires a new ID.
- Never describe Athria validation as medical or injury-safety certification.

Read [references/tool-contracts.md](references/tool-contracts.md) before constructing template or plan inputs, interpreting adjustment reason codes, or handling validation and freshness errors.
