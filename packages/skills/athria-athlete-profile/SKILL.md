---
name: athria-athlete-profile
description: Start Athria when the user explicitly asks to start it, including translations of "start Athria", without a more specific task. Onboard an athlete, maintain confirmed profile and wellness facts, and read or revise their concise training experience memory. A greeting alone does not trigger Athria; never rewrite the plan from this Skill.
---

# Athria Athlete Profile

Maintain facts about the athlete and their circumstances. A confirmed Profile or Wellness update is independent from any later plan adjustment.

## Language

Use the user's requested language, or the language of their latest substantive message; a brief approval does not switch it. Use that language for replies, previews, and newly written Profile or Wellness text. Preserve user and source text, unchanged data, and structured MCP fields, IDs, enums, numbers, and notation. If the write language is unclear, ask once before the usual approval.

## Starting Athria

Use this read-only entry when the user explicitly asks to start Athria, including English or Chinese variations, without naming a more specific task. A greeting such as "hi" alone is not an Athria request. If the user already asks to create or revise a plan, route directly to `$athria-training-planner` before any athlete-data read so its database confirmation remains first.

1. Call `get_athlete_profile` and `get_current_plan` to check what is already available. If Athria MCP is unavailable, briefly ask the user to check the Athria Agent connection; do not imply that any data was read.
2. If a Current Plan exists, briefly acknowledge it and ask what the user wants to do today: train, review progress, or adjust the plan. Otherwise, if the Profile appears to contain only initial defaults, treat those values as unconfirmed and ask about the user's training goal first. Continue with the onboarding workflow below as the user answers.
3. If the Profile contains personal information but no Current Plan, briefly acknowledge what is known and ask whether the user wants to make a training plan. Ask only one next-step question, and skip it when the user's request already states their intent.
4. Route the chosen work to `$athria-athlete-profile` for Profile or Wellness changes, `$athria-workout` for an immediate workout, `$athria-coach` for read-only review, or `$athria-training-planner` for plan creation or adjustment. Starting Athria grants no write approval. The planner must still confirm the database path before its planning-specific athlete reads.

## Onboarding and Profile updates

1. Call `get_athlete_profile` and retain its current profile hash. For onboarding, distinguish existing defaults from facts the user has actually confirmed.
2. For onboarding, use the training goal already stated by the user or ask for it first. Then learn their availability and usual session length, equipment, and relevant injuries or movement limits in short, related exchanges. Ask at most two or three related things per turn, and follow up only when the answer changes the next decision. For a single-field update, ask only about that change. Do not turn the Profile schema into an intake questionnaire.
3. Use existing values as context, but do not present an untouched default as a user-confirmed fact. Leave unrelated defaults and optional fields alone. Keep the current timezone and preferred cycle length unless the user wants to change them, a date or scheduling decision depends on them, or there is evidence of a mismatch. Profile holds stable personal information and training settings: preferred name, gender, height, birth date, timezone, goals, usual duration limit for ordinary sessions (`maxSessionMinutes`), training rhythm, equipment, injuries, movement constraints, explicit recovery days, unit system, preferred mesocycle duration, and race dates. A longer session may be accepted as a specific exception without changing this Profile value.
4. Show a concise field-level before/after diff for the proposed patch. Label an affected default as unconfirmed; mention unchanged fields only when they matter to the decision. Do not show the entire Profile for a small change.
5. Obtain explicit approval for the exact patch immediately before calling `update_athlete_profile`. Re-read the Profile first if the conversation or evidence may have gone stale; never bypass a hash conflict.
6. After a successful change, call `get_plan_adjustment_review` with `profile_change`. Briefly explain the returned status and decision-relevant scope, reasons, hard overrides, and data gaps. Do not draft or save a plan here.
7. If review is recommended or required, offer a handoff to `$athria-training-planner`. The Profile change remains saved if the user declines the plan change.

## Wellness updates

Weight and other dated recovery observations belong to Wellness, not Profile.

1. Call `get_wellness_day` for the exact date and retain its snapshot hash. Use `list_wellness` only when context across days is needed.
2. Show the exact dated field diff and obtain explicit approval immediately before calling `update_wellness`.
3. Never infer sleep, soreness, fatigue, readiness, weight, or other wellness values. Missing is not zero.
4. Do not automatically trigger a plan rewrite. If the user asks whether the observation affects training, hand off to `$athria-coach` for analysis or `$athria-training-planner` for an explicitly requested cycle review.

## Training memory

`get_training_memory` reads the athlete's current training experience and capability summary. Use `update_training_memory` only when the athlete corrects it or planning/review finds meaningful new evidence. This summary is separate from confirmed Profile and Wellness facts; its revision check replaces their approval rule.

- Keep a concise current picture of experience, demonstrated capacity, uncertainty, and a few dated/source references. Distinguish self-report, observed records, and interpretation. Do not accumulate raw conversations or each workout.
- Merge duplicates and replace stale conclusions. Aim for 500–1000 characters. If the draft grows, condense it automatically before saving; never send more than 2000 characters. Preserve the key current assessment and supporting evidence.
- Use the conversation language for new prose; preserve quoted user or source text. Skip the write if the meaning is unchanged. On a revision conflict, re-read and merge again. After saving, tell the athlete the change in one sentence. No separate prior approval is needed for this memory update.

## Data boundaries

- `injuries` records known injuries or diagnoses as factual context. `constraintNotes` records movement-level restrictions and must not restate a diagnosis. Neither is proof that a plan is medically safe.
- A Profile training rhythm describes availability; it does not set fixed weekly quotas for individual training domains.
- `mesocycleDurationWeeks` is a preferred default, not permission to replace the current plan.
- Never update the Current Mesocycle or a specific workout from this Skill.
