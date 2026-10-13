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
2. After database confirmation, read `get_athlete_profile`, `get_training_memory`, `get_training_state`, `get_current_plan`, `get_data_source_status`, `get_training_taxonomy`. For adjustments, obtain the review context described below and read `list_training_sessions`, `get_training_summary`, and `list_wellness` with the same explicit paired `from`/`to` dates, plus `list_planned_sessions` execution status for that period. For other planning, use decision-relevant windows. Keep the profile hash, `inputSnapshotHash`, current-plan revision, taxonomy version, and hard-confidence threshold.
3. Review every Profile field and the available history, Wellness coverage, and source freshness internally. Tell the user only the known facts and evidence cutoffs that matter to this plan, plus the most important unresolved gap, if any. Ask at most two or three related things per turn; ask the next question only if its answer could change the outline or clear a validation blocker. Prioritize goal, availability and session length, then relevant equipment and constraints. Use existing values for preferences, recovery spacing, cycle length, and target events as provisional context when unconfirmed; confirm them only if the request or evidence makes that necessary. Keep the current timezone unless a date or scheduling decision depends on it or there is evidence of a mismatch. Do not display the whole Profile or ask for every possible field at once.
4. Handle any Profile or Wellness correction through `$athria-athlete-profile`, including its exact diff, approval, update, and freshness rules. Do not add Profile or Wellness write tools to this Skill. After a correction, re-read the affected context before continuing.
   If history and memory cannot support an experience or capability judgment needed for this plan, ask up to two or three short, related questions about prior activity, recent consistency, or a concrete comfortable session. Skip known facts and accept uncertainty if the athlete declines. Route meaningful new evidence or a memory correction through `$athria-athlete-profile` for a concise automatic memory revision, then refresh `get_training_memory` and `get_training_state` before drafting.
5. Ask about connection, sync, or import only when that source could materially improve this plan's evidence. For a relevant disconnected API source, offer Athria → Connections; for a relevant connected API source whose `syncedToday` is false, offer **Sync now**. If the user chooses to sync, pause planning and re-call `get_data_source_status` after they finish. Treat Hevy as an optional CSV import, not an API connection or daily-sync requirement. If the user declines, continue when feasible and briefly state the evidence cutoff and limitation.
6. Propose a short outline containing the primary goal, cycle duration, each domain's phases and progression, and every training day's broad objective and rationale. Obtain explicit approval of this outline before creating or resuming a plan draft. Revisions require a new outline approval.
   Treat Profile `usualSessionMinutes` as the target duration for regular training, allowing reasonable variation. Before seeking outline approval, identify any noticeably longer or shorter session, its duration, and the reason for the unusual duration; obtain explicit acceptance of each exception. A long run, hike, or camping activity is not automatically exempt. If the user declines, revise the outline.

## Detailed plan and commit

1. Only after outline approval, create or recover a persistent plan draft. For a new plan call `create_plan_draft` with Plan Schema v7 metadata but no `weeks`; when revising use `current_plan` and preserve unaffected weeks. Write one complete week at a time with `upsert_plan_draft_week`. Templates are optional provenance, never the executable plan.
2. Call `validate_plan_draft`. Resolve blocker failures and blocker unknowns. Ask only for a fact needed to clear a remaining blocker; do not invent loads, effort, availability, equipment, recovery, or injury status.
3. Show the complete detailed plan: goal, every week's sessions and prescriptions, progression, validation blockers/advisories/unknowns, material tradeoffs, and exactly what will replace the Current Plan. List each accepted unusual-duration session with its duration and reason again when requesting detailed approval. If a previously accepted exception's duration or substance changed, explain the change and obtain renewed acceptance before approval.
4. Obtain explicit approval for this complete detailed proposal. Outline approval does not authorize `commit_plan_draft`; editing, rejection, or “later” is not approval.
5. After detailed approval, re-read `get_database_context`, `get_current_plan`, `get_training_state`, and `get_athlete_profile`. If the database path changed, restart at database confirmation. If the plan revision, snapshot hash, or profile hash changed, rebase, revalidate, show the affected detailed changes, and obtain detailed approval again.
6. Call `commit_plan_draft` once with the draft ID, latest `inputSnapshotHash`, expected plan and draft revisions, and `confirmed: true`. Never make a partial Current Plan write. Use `list_plan_drafts` to locate earlier drafts, but repeat database and outline confirmation before resuming one in a later conversation. Use `discard_plan_draft` for abandoned work.

## Adjustment workflow

Use this for a periodic review or a user-requested change to the current cycle.

1. Run database confirmation first: call only `get_database_context`, show the absolute path, and obtain confirmation before any athlete-data read. A request such as “开始 Athria，帮我调整计划” routes directly here. Coming from an App reminder, a Profile change, a progress review, or a user-requested change uses this same workflow and grants no write approval.
2. Read the full latest Profile, training memory, state, Current Plan, source freshness, and taxonomy. Call `get_plan_adjustment_context` with no arguments. It returns the formal commit anchor, inclusive local `from`/`to` dates, net `profileChanges`, tracking coverage, and freshness hashes; it does not decide whether to adjust the plan. Do not choose a trigger or ask the App to launch an Agent review.
3. Use the last formal plan commit date through today as the common evidence period in the current Profile timezone. Read `list_training_sessions`, `get_training_summary`, `list_wellness`, and `list_planned_sessions` with these same paired `from`/`to` dates. Draft saves, workout moves, skips, and completions do not reset the anchor. A user-specified period overrides the read dates. `hasExecutionWindow: false` means the default period has not started, not a measured absence of records; skip reversed-date queries and do not invent execution evidence.
4. If `trackingComplete` is false, explain that earlier Profile changes and the original commit time are unavailable; use the plan's effective start through today as fallback. Do not present this as a known commit date. Read older history only for a stated capability or comparison need, and distinguish it from current-plan execution.
5. Compare the full latest Profile and its changes with the Current Plan and training evidence, including new records since the commit date, actual prescriptions and outcomes, interruptions, and dated Wellness. `profileChanges` identifies fields worth rechecking; it neither raises changed fields' priority nor lowers unchanged goals, preferences, or constraints. Changes and new records invite evaluation, not automatic rewriting. No diff or new records does not end the review: the user may request a different arrangement or provide a new goal, limitation, or preference in conversation. Route unsaved Profile corrections through `$athria-athlete-profile`, obtain its exact-patch approval, then refresh Profile, state, and adjustment context. A Profile update is not plan approval.
6. Give one evidence-based Agent conclusion: preserve the plan, monitor an uncertainty, or propose an adjustment. State evidence dates, known facts, interpretation, missing data, and the user's requested change. Do not treat App reminder statuses as an Agent decision or use a separate weekly assessment window. Missing recovery or performance evidence is unavailable, not normal. Do not pool multiple weeks into a four-session weekly rule, count future/today-pending work as missed, or automatically repay missed volume.
7. When adjustment is justified, propose the smallest necessary outline with reasons, affected scope, and important requirements to preserve. Preserve unaffected future work, completed/skipped occurrences, and historical sessions. Obtain explicit outline approval before writing a detailed draft; then validate, show the complete proposal, obtain detailed approval, refresh context and hashes, and atomically commit using the workflow above. Only a successful formal commit resets the anchor and clears changes; reviewing, approving an outline, keeping the plan, or abandoning a draft does not.

Example: an unchanged primary goal of improving running endurance remains in force when the athlete changes `preference` to “more strength training.” Evaluate the full Profile and commit-to-today history, explain whether that mix supports the goal and which running sessions should remain, then obtain both outline and detailed-plan approval for any proposed change. The same process applies if the request followed an App reminder or if no records changed but the athlete dislikes the current arrangement.

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

- Each session owns one domain and one direct, non-null `prescription` with domain-specific `blocks[]`. Keep warm-up, main work, and cooldown inside its blocks; never send `components`.
- Every Strength exercise has numeric `targetRpe`; every Endurance step has a relative `heartRateZone` string: `1`–`5` or an ascending range such as `1-3`, without a `Z` or `Zone` prefix (displayed as `Zone 1-3`).
- Fix missing Strength RPE and Endurance zone advisories before saving whenever the evidence permits a compliant annotation. Advisories inform the recommendation but do not themselves block saving.
- Exercise and classification facts retain source, confidence, evidence, and taxonomy version. AI-inferred facts support hard validation only at or above the returned confidence threshold with no conflict.
- Count multiple sessions on one date as one training day. Respect Profile rhythm and equipment. Treat explicit recovery days as advisory spacing guidance; user-initiated moves may override rhythm and recovery spacing and are assessed at the next adjustment review. Aim for `usualSessionMinutes` in regular sessions. Noticeably longer or shorter sessions require explicit acceptance in the planning conversation; duration relative to this target is not a validation constraint.
- A skipped session stays skipped only when its replacement retains the same ID and `status: "skipped"`; re-planning it requires a new ID.
- Never describe Athria validation as medical or injury-safety certification.

Read [references/tool-contracts.md](references/tool-contracts.md) before constructing template or plan inputs, interpreting adjustment reason codes, or handling validation and freshness errors.


After commit, the draft and its weeks are deleted; Current Plan retains the Athria-managed `sourceDraftId`. There is no commit replay or historical receipt. If a commit response is lost or times out, call `get_current_plan` first: a matching `sourceDraftId` confirms success. If the draft still exists, refresh the draft, plan revision, and training context before deciding whether to retry. If the draft is absent and the source ID does not match, the outcome is uncertain (a later formal commit may have replaced the marker); do not infer success or failure, or automatically recreate and submit a replacement. Reading or submitting a deleted draft returns `DRAFT_NOT_FOUND`.
