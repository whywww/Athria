---
name: athria-training-planner
description: Plan or revise a strength, endurance, or concurrent-training draft using the user's local Athria profile and history. Use when the user asks an Agent connected to Athria to create, adjust, validate, or explain a training plan; do not use for medical diagnosis or injury treatment.
---

# Athria Training Planner

Build a draft from the user's actual local state and leave final approval to the user in the Athria Dashboard.

## Workflow

1. Call `get_athlete_profile`, `get_training_preferences`, and `get_training_state`. Keep the returned `inputSnapshotHash` for the draft.
2. Inspect only the history and exercise-catalog slices needed for the request. Do not treat missing recovery, RPE, heart-rate, or load data as normal values.
3. Ask the user only for missing information that materially changes the plan. State uncertainty when a useful field remains unavailable.
4. Choose the training strategy and construct a complete `TrainingPlanDraft`. Include the mesocycle duration, seven-day weekly structure, labeled session templates, contiguous phase progression, structured adjustment rules, and all expanded dated sessions. Core evaluates rules; it does not choose the program for you.
5. Call `validate_plan`. Revise structural errors and hard violations until none remain, or stop and explain why the user's constraints cannot all be satisfied.
6. Show the duration, weekly structure, session templates, phase progression, adjustment rules, material changes, rule evidence, data gaps, and important tradeoffs. Never describe Athria validation as medical or injury-safety certification.
7. Call `save_plan_draft` only after the user has seen the proposal. This saves a draft; tell the user to review its diff and approve it in the Athria Dashboard.

## Boundaries

- Never invent absolute loads, RPE/RIR, training days, equipment, or injury status.
- `trainingDays` is an optional Monday-to-Sunday preference with no time ranges. Recovery hours, constraints, and excluded exercises must be proposed through `propose_profile_update` and approved in the Dashboard.
- Never collapse strength and endurance into one unsupported fatigue or readiness score.
- Never attempt arbitrary SQL, filesystem, credential, or third-party write access.
- Profile changes use `propose_profile_update` and remain pending until Dashboard approval.
- If the state snapshot changes, refresh context and rebuild or revalidate the draft instead of bypassing the stale-state rejection.

Read [references/tool-contracts.md](references/tool-contracts.md) when constructing tool inputs or handling validation reason codes.
