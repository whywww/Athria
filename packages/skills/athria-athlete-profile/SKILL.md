---
name: athria-athlete-profile
description: Onboard an Athria athlete and update confirmed personal information, goals, training rhythm, equipment, constraints, preferences, race dates, weight, or wellness. Use when the user's circumstances change; assess plan impact afterward but never rewrite the plan from this Skill.
---

# Athria Athlete Profile

Maintain facts about the athlete and their circumstances. A confirmed Profile or Wellness update is independent from any later plan adjustment.

## Onboarding and Profile updates

1. Call `get_athlete_profile` and retain its current profile hash. For onboarding, distinguish existing defaults from facts the user has actually confirmed.
2. Collect only fields needed for the user's request. Profile holds stable personal information and training settings: preferred name, gender, height, birth date, timezone, goals, preference, maximum session duration, training rhythm, equipment, injuries, movement constraints, explicit recovery days, unit system, preferred mesocycle duration, and race dates.
3. Show a field-level before/after diff. Clearly label unchanged fields and any defaults that remain unconfirmed.
4. Obtain explicit approval for the exact patch immediately before calling `update_athlete_profile`. Re-read the Profile first if the conversation or evidence may have gone stale; never bypass a hash conflict.
5. After a successful change, call `get_plan_adjustment_review` with `profile_change`. Explain the returned status, scope, reasons, hard overrides, and data gaps. Do not draft or save a plan here.
6. If review is recommended or required, offer a handoff to `$athria-training-planner`. The Profile change remains saved if the user declines the plan change.

## Wellness updates

Weight and other dated recovery observations belong to Wellness, not Profile.

1. Call `get_wellness_day` for the exact date and retain its snapshot hash. Use `list_wellness` only when context across days is needed.
2. Show the exact dated field diff and obtain explicit approval immediately before calling `update_wellness`.
3. Never infer sleep, soreness, fatigue, readiness, weight, or other wellness values. Missing is not zero.
4. Do not automatically trigger a plan rewrite. If the user asks whether the observation affects training, hand off to `$athria-coach` for analysis or `$athria-training-planner` for an explicitly requested cycle review.

## Data boundaries

- `injuries` records known injuries or diagnoses as factual context. `constraintNotes` records movement-level restrictions and must not restate a diagnosis. Neither is proof that a plan is medically safe.
- A Profile training rhythm describes availability; it does not set fixed weekly quotas for individual training domains.
- `mesocycleDurationWeeks` is a preferred default, not permission to replace the current plan.
- Never update the Current Mesocycle or a specific workout from this Skill.
