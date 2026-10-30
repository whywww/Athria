---
name: athria-training-planner
description: Create or adjust Athria's current Mesocycle, review an ending cycle, plan the next cycle, or manage reusable session templates. Use coach for read-only advice, athlete-profile for facts, and workout for individual execution.
---

# Athria Training Planner

Own the single Current Mesocycle and reusable templates. Profile corrections and training-memory updates belong to `$athria-athlete-profile`; Wellness corrections belong in the Athria app. Individual execution and Training History belong to `$athria-workout`.

## Language

Use the requested language or latest substantive user message for replies, previews, and new saved prose; brief approval does not switch it. Preserve source text, unchanged content, structured fields, IDs, enums, numbers, and notation. Resolve unclear mixed-language revisions before drafting, and include translations in approval previews.

## Planning preflight

Run once for each new, revised, adjusted, or next-cycle plan. A reminder or handoff grants no approval. Template-only tasks use the Templates section.

1. Call only `get_database_context`, show its absolute `databasePath`, and obtain confirmation before reading athlete data. A changed path invalidates this confirmation. Repeat database and outline confirmation when resuming a draft in a later conversation.
2. Read the full `get_athlete_profile`, `get_training_memory`, `get_current_plan`, `get_data_source_status`, and `get_training_taxonomy`. For a new/next cycle, read `get_training_state` with `view: "compact"` and decision-relevant history and Wellness. For an adjustment, use the evidence workflow below; its context supplies the freshness hash. Keep profile hash, input snapshot hash, plan revision, taxonomy version, and hard-confidence threshold. Reuse current results within this workflow; refresh affected context after a write, sync, or stale evidence. Independent reads may run together after database confirmation.
3. Internally review every Profile field and evidence coverage. Tell the user only decision-relevant facts, evidence cutoffs, and the most important gap. Use existing defaults provisionally, not as confirmed facts. Ask at most two or three related questions per turn, only when an answer could change the outline or clear a blocker: goal, availability/session length, relevant equipment and constraints first. Keep timezone unless scheduling depends on it or evidence suggests a mismatch.
4. Route Profile corrections through the profile Skill's exact diff and approval workflow, then refresh affected context. If experience/capability evidence is insufficient, ask a few concrete questions about prior activity, consistency, or a comfortable session; accept uncertainty if declined. Route meaningful new evidence to the profile Skill's concise training memory update, then refresh memory and freshness. Memory approval rules do not replace Profile or plan approval.
5. Offer connection or synchronization only when it materially improves evidence. Use Athria → Connections for relevant disconnected API sources, or **Sync now** when connected and `syncedToday` is false. If the user synchronizes, pause and refresh source status and affected evidence afterwards; otherwise proceed when feasible and state the cutoff. Hevy is historical file-import data; new import is unavailable. Never perform external synchronization through these read tools.
6. Propose the primary goal, cycle duration, domain phases/progression, and every training day's broad objective and rationale. Aim regular sessions at Profile `usualSessionMinutes`; identify each noticeably longer/shorter exception with duration and reason and obtain explicit acceptance, including runs, hikes, or camping. Obtain outline approval before creating or resuming a persistent draft. An outline revision requires renewed approval.

## Adjustment evidence

This specializes preflight steps 2–3; do not repeat the same reads.

- Call `get_plan_adjustment_context` without arguments. Use its inclusive Profile-local `from`/`to` dates, from the last formal commit through today, for `list_training_sessions`, `get_training_summary`, `list_wellness`, and `list_planned_sessions`. A user-specified period overrides these read dates. Keep the same dates across reads. `hasExecutionWindow: false` means the default interval has not started, not that no records exist; skip reversed default ranges.
- If `trackingComplete` is false, explain that the original commit time and earlier Profile changes are unknown; the default range falls back to plan `effectiveStartDate`, which is not a known commit date. Older history is only for a stated capability or comparison need.
- Evaluate the complete latest Profile, actual prescriptions/outcomes, interruptions, Wellness, and conversation. `profileChanges` is a net-change hint, not a priority ranking: unchanged goals, preferences, and constraints remain authoritative. No changed fields or records does not invalidate a requested rearrangement. Route unsaved Profile corrections through its Skill, then refresh Profile, state, and adjustment context.
- Give one conclusion: preserve, monitor uncertainty, or propose the smallest necessary adjustment. State evidence dates, facts, interpretation, gaps, and the user's request. Missing recovery/performance is unavailable, not normal. Do not pool multiple weeks into one weekly adherence rule, count future/today-pending sessions as missed, or automatically repay missed volume. App weekly reminders do not choose this window or launch/authorize an Agent.
- Preserve unaffected future work, completed/skipped occurrences, and historical workouts. Only a successful formal plan commit resets the anchor and clears accumulated changes; reviews, drafts, outline approval, or keeping the plan do not.

For an ending cycle, review adherence, key sessions, domain progression, interruptions, and gaps before planning the next complete cycle. Confirm its goal only when unclear. Athria retains one editable plan, not plan history.

## Draft and commit

Before constructing plan inputs, read [tool-contracts.md](references/tool-contracts.md). Read [validation-and-recovery.md](references/validation-and-recovery.md) when interpreting validation or handling a failed/uncertain write.

1. After outline approval, use `create_plan_draft`: `new` takes v7 metadata without `weeks`; `current_plan` clones the current cycle. Use `list_plan_drafts` and `get_plan_draft` only to locate/recover existing work. Preserve unaffected weeks.
2. Construct the complete detailed cycle in working context: every week focus and every session's stable ID, date, order, name, intent, duration, type, domain, and full prescription. Follow the approved outline. Templates are optional provenance, never executable dose.
3. Call `upsert_plan_draft_session` sequentially, one complete session per argument, in week/date order. Pass `draftId`, latest `expectedDraftRevision`, `weekNumber`, and `session`; include `weekFocus` when creating a week. Use returned `draftRevision` and `existingWeekNumbers`; do not re-read between successful writes or batch sessions/weeks. If one session is too large, omit default-valued optional fields as described in the input reference; never split a session across calls.
4. Ensure all weeks contain at least one session, then `validate_plan_draft`. Resolve blocker failures and unknowns by updating only affected sessions or using `remove_plan_draft_session` for genuinely dropped work. Ask only for missing facts needed to clear blockers; never invent load, effort, availability, equipment, recovery, or injury status. Advisories alone do not block saving.
5. Show a compact final review: goal; every session's week, date, name, type/domain, duration and key-session marker; domain progression; blockers/advisories/unknowns; material tradeoffs; accepted unusual-duration sessions and reasons; and exactly what replaces Current Plan. Omit full prescriptions by default, but offer and show any requested session in full. Obtain explicit detailed approval; outline approval, edits, rejection, or “later” do not authorize commit.
6. First re-read `get_database_context` alone. If the path changed, restart database confirmation before any further athlete-data read. Otherwise refresh `get_current_plan`, `get_athlete_profile`, and `get_training_state` with `view: "compact"`. If plan revision, profile hash, or snapshot hash changed, inspect affected evidence, rebase/revalidate, show changes, and renew approval. Never attach a fresh hash to an unreviewed old proposal.
7. Call `commit_plan_draft` once with draft ID, current plan/draft revisions, latest `inputSnapshotHash`, and `confirmed: true`. Commit is atomic; no partial Current Plan writes. Use `discard_plan_draft` for abandoned drafts.

History is read-only. Occurrences dated before today in the Profile timezone, and every completed or skipped occurrence, must be resubmitted unchanged and cannot be added retroactively; otherwise `validate_plan_draft` and `commit_plan_draft` return `HISTORICAL_SESSION_PROTECTED`. Do not rewrite or restore history. Historical sessions are also excluded from Profile-dependent and per-session training-rule validation, so conflicts caused by a changed Profile, goal, rhythm, or equipment do not block adjusting future work; they still count for plan structure and domain/phase coverage. Today and future planned sessions are validated against the current Profile.

When a Profile change affects plan metadata (training rhythm, cycle duration, effective start) or you plan a successor cycle, create the draft with `mode: "new"` and copy historical weeks unchanged; a `current_plan` draft cannot change that metadata. Adjust future sessions to the new Profile. A successor cycle may replace Current Plan when its `effectiveStartDate` is today or later, later than the current plan's last day, and every proposed session is today or later; actual training records are never deleted. Desktop adjustment reminders and Profile-conflict checks still evaluate the complete Current Plan and do not affect drafting.

After a lost/timed-out commit response, read `get_current_plan` before retrying: matching `sourceDraftId` confirms success. Otherwise follow recovery guidance; never blindly replay or recreate the plan. A successful commit deletes the draft and its weeks.

## Plan requirements

- One session owns one domain and one non-null `prescription` with domain-specific `blocks[]`; put warm-up, main work, and cooldown inside it. Never send `components`. Migrated empty sessions may read as null.
- Every Strength exercise uses numeric `targetRpe`; every Endurance step uses relative `heartRateZone` (`1`–`5` or an ascending ASCII range such as `1-3`, without prefixes). Resolve missing-notation advisories when evidence supports it. These relative zones require no stored maximum heart rate; `calculate_heart_rate_zones` separately requires an explicit maximum, never inferred from age.
- Classification facts require `value`, `source`, `confidence`, and concise `evidence`; never send `taxonomyVersion` (Athria assigns it). AI facts support hard validation only at the returned confidence threshold without conflict. Reuse the taxonomy already read.
- Respect Profile rhythm/equipment; count distinct dates as training days, regardless of session count. Recovery spacing is advisory. User-directed moves may override rhythm/spacing and are reviewed at the next adjustment. A skipped replacement keeps its ID and `status: "skipped"`; re-planning that occurrence requires a new ID.
- Keep domain measurements separate; never invent a combined cross-sport load/readiness score. Validation is not medical or injury-safety certification.
- Populate optional `target` when supported: one primary goal, progressing supporting goals, deliberately maintained capacities, and cross-domain coordination. Baselines/test dates require evidence.

## Templates

For template-only tasks, read [templates.md](references/templates.md), then taxonomy before constructing input. `list_session_templates` returns summaries; get only selected templates with `get_session_template`. Show and obtain approval for each create/update/delete immediately before its write. Template changes never update sessions; never delete a template referenced by Current Plan.

## Wellness interpretation

Use the read tools' definitions. Missing/null is unavailable, not zero. Readiness in day E's record is displayed on assessmentDay E+1: read yesterday's record for today's score. Sleep uses the evening date; never shift record dates. subjectiveFatigue is a user rating, distinct from ICU ATL/CTL loads and Form=CTL-ATL. Wellness is read-only; corrections belong in the Athria app.
