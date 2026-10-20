---
name: athria-workout
description: "Inspect and execute Athria's immediate workout queue: show today's training, add validated next-day sessions, skip, restore, or move a planned occurrence, record or edit a manual workout, and apply an explicit match correction. Do not use to redesign the complete Mesocycle."
---

# Athria Workout

Handle one or a few concrete workouts while preserving the structure of the Current Mesocycle.

## Language

Use the user's requested language, or the language of their latest substantive message; a brief approval does not switch it. Use that language for replies, previews, and newly generated workout text written through MCP. Preserve user and source text, unchanged data, and structured MCP fields, IDs, enums, numbers, and notation. If the write language is unclear, ask once before the usual approval.

## Read the execution context

- Use `get_next_training_day` for the current execution queue and `list_planned_sessions` for a bounded calendar window.
- Use `get_current_plan` only to identify the current revision and exact occurrence. Use `list_training_sessions` when recording, editing, or correcting history.
- Read `get_athlete_profile` and `get_training_state` only when needed to validate an added near-term prescription or refresh state.

## Planned workout actions

Each new session owns one domain and one direct, non-null `prescription` with domain-specific `blocks[]`. Keep warm-up, main work, and cooldown inside it; never send `components`. Existing migrated sessions may have a null prescription.

1. Identify the exact session and requested action. Do not turn a one-off change into a cycle redesign.
2. Show the before/after date, status, or prescription and obtain explicit approval immediately before the write.
3. Use `update_planned_session` for `skip`, `restore`, `move_occurrence`, or an explicitly requested completion. Re-read the current revision before writing and stop on a conflict.
4. To add sessions to the next training day, draft only that bounded set, call `validate_next_training_day_sessions`, show validation results and the proposed additions, obtain approval, then call `save_next_training_day_sessions` with fresh state.
5. If the requested change requires restructuring future weeks or changing the cycle's progression, hand off to `$athria-training-planner`.

## Training History

- Before `record_training_session`, show the complete normalized record and obtain explicit approval. RPE may be set only when creating that record. Do not send a `plannedSessionId`; Athria's deterministic reconciler owns normal matching.
- Use `update_manual_training_session` only for the exact start time or duration of a workout with a manual source. Obtain approval for the diff.
- RPE on an existing workout is read-only through MCP. Direct the user to change it in the Athria app under Training History → Effort (训练历史 → 强度); do not re-record, delete, or fabricate the workout or its RPE.
- Use `remove_manual_training_source` only after the user explicitly chooses removal and understands that synchronized observations remain.

## Match corrections

- Call `override_training_session_plan_match` only when the user explicitly identifies a particular workout and the intended same-day planned session, or explicitly marks it unplanned with a null match.
- A null override excludes the workout from later automatic matching. Call `allow_automatic_plan_match` only when the user explicitly revokes that decision.
- Show the existing and proposed match state and obtain explicit approval immediately before either write.

## Boundaries

- Every write affects the user's local Athria data; advice or discussion alone is not approval.
- Do not edit Profile or Wellness and do not call the whole-plan save path.
- Do not fabricate completion details, timestamps, duration, load, RPE, heart rate, distance, or exercise classification.

Read [references/tool-contracts.md](references/tool-contracts.md) before constructing a planned-session, history, or match-correction write.

## Wellness interpretation

Interpret Wellness using the read tool descriptions. Missing/null is unavailable, not zero. subjectiveFatigue is a user-reported 0-100 rating; ICU may import this rating, while ATL/CTL are ICU-calculated training loads and Form is CTL minus ATL. Readiness is Athria's 0-100 estimate of health status through the previous day: the app on day E+1 displays the estimate calculated from day E wellness, and `readinessAssessment.assessmentDay` is the display day while the record date is E. To discuss the score shown today, read yesterday's wellness record. Sleep is stored on the evening date; do not shift MCP record dates. Wellness is read-only through MCP: users record or correct it in the Athria app. Workout write approval still applies.
