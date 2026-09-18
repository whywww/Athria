---
name: athria-training-planner
description: Plan or revise Athria session templates and the user's current multi-domain Mesocycle using local profile and training history. Use when an Agent connected to Athria creates, adjusts, validates, or explains a plan; do not use for medical diagnosis or injury treatment.
---

# Athria Training Planner

Build optional reusable Plan Schema v7 generic templates and save the single Current Mesocycle with complete week-specific prescriptions.

## Workflow

1. Call `get_athlete_profile`, `get_training_state`, `list_wellness`, and `get_training_taxonomy`. Keep the returned profile hash, `inputSnapshotHash`, taxonomy version, and `0.90` hard-confidence threshold.
2. Inspect only the history needed for the request. Prefer exact aliases, structured sources, and explicitly confirmed user facts.
3. A Template has exactly one domain. It contains a name, one concise intent, and ordered structural nodes with required `variables` and optional `optionalVariables`; never extra notes, use cases, identity ranges, exercises, sets/reps, distance, duration, load, recovery demand, or defaults. A node name is optional and otherwise derives from its role. Strength selectors must use taxonomy IDs and may combine movement patterns and target muscles; omitted `matchPolicy` means `any`, while `all` is explicit.
4. Use the structured prescription matching each classified domain: `strength`, `endurance`, `sport_skill`, `recovery`, or `mind_body`. Use `duration_only` only as a legacy fallback, and use `domain.value: null` only when a component cannot yet be classified reliably. Annotate effort by domain: every Strength exercise carries a numeric `targetRpe` (1–10, optional `targetRir`); every Endurance step carries a relative `heartRateZone` label such as `Zone 1–2`, which is relative to the athlete's own baseline and needs no stored maximum heart rate. Numeric RPE is never the primary endurance notation.
5. Exercises are open-world objects with stable `id`, `displayName`, and nullable `canonicalKey`. For custom exercises, infer the Strength descriptor proactively and record a source, confidence, non-empty evidence, and taxonomy version for every fact. Never pretend an inference is catalog- or user-confirmed.
6. Templates are optional. Construct the complete Current Mesocycle with an explicit `effectiveStartDate`, the rhythm-only schedule required by Profile `trainingRhythm`, complete `weeks[]`, one full-cycle `domainProgressions[]` timeline for every resolved Session domain, and adjustment rules. Domain phase names may reflect the sport (for example Base, Build, Acquisition, or Integration), while `phaseType` carries the shared semantic category. Every Weekly Session independently contains its final date, order, duration, recovery demand, components, complete dose, and optional `progressionNote`; `templateRef` records only versioned provenance. Count multiple same-date sessions as one training day. Do not invent loads, RPE, training days, equipment, or injury status.
7. Call `validate_current_plan`. Use returned `missingFacts` and structured `dataGaps` to improve classification. Ask the smallest possible user question only for a remaining gap that affects a blocker, then record the answer as `user_confirmed`.
8. Revise blocker failures and blocker unknowns until none remain, or explain why the explicit constraints cannot all be verified or satisfied. Fix `STRENGTH_EFFORT_RPE` and `ENDURANCE_EFFORT_ZONE` advisory failures before saving whenever a compliant annotation is possible. Advisories should inform the recommendation but do not block saving.
9. Show the actual domain list, components, each domain's phases, rule evidence, classification coverage, Blockers, Advisories, Unknowns, and material tradeoffs. Never describe Athria validation as medical or injury-safety certification.
10. Ask for explicit approval of the complete validated proposal. Do not call `save_current_plan` when the user rejects it, requests edits, or says to handle it later. Keep edits in conversation state and validate the complete proposal again before requesting approval.
11. After explicit approval, re-read `get_current_plan`, `get_training_state`, and `get_athlete_profile`. Save only when the revision, snapshot hash, and profile hash still match the proposal context; otherwise rebase and revalidate before requesting approval again.
12. Call `save_current_plan` with the latest `inputSnapshotHash` and `expectedRevision`. It atomically replaces the whole mesocycle: send one complete plan, never partial or multi-step writes. When revising, carry forward every kept occurrence unchanged: a skipped Session stays skipped only when its replacement keeps the same id and `status: "skipped"`, and re-planning it needs a new id. The response carries `{ revision, impact, blockerSummary }`; fetch details with `get_current_plan` or `validate_current_plan`. Delete a template only after an explicit user request; never delete one still referenced by the Current Mesocycle. Updating a Template never updates any Session.

## Adjustment workflow

Use this workflow when the user asks whether an existing Current Mesocycle should change, requests a periodic review, or has changed Profile constraints.

1. Call `get_plan_adjustment_review` with `weekly_review`, `profile_change`, or `user_request` as the trigger. Treat its `reviewStatus`, `recommendedScope`, reason codes, hard overrides, data gaps, plan revision, profile hash, and snapshot hash as the authoritative review context.
2. For `keep`, do not propose a rewrite. For `watch`, explain the signal and normally keep the plan; revise only when the user explicitly asks. For `review_recommended` or `review_required`, read `get_current_plan` and only the evidence identified by the assessment. Use `suggestedReadWindow` as the history limit unless a cited reason requires fewer records.
3. Draft one complete revised Plan Schema v7 object in conversation state. Apply the minimum necessary change within `recommendedScope`: `workout` changes only affected future sessions, `week` changes only affected future weeks, and `plan` may change future structure. Preserve unaffected weeks, sessions, domains, still-valid phase intent, and every completed or skipped historical occurrence. Never compensate for missed training by automatically adding all missed volume.
4. Call `validate_current_plan` on the complete proposal. Resolve blockers by revising the proposal; ask only for information necessary to clear a remaining blocker. Do not use optional questions to optimize an already valid proposal.
5. Before approval, show `why_now`, `changed`, `preserved`, `rationale`, `tradeoffs`, `unresolved_data_gaps`, and a validation summary separated into blockers, advisories, and unknowns. State that approval is required and do not call `save_current_plan` yet.
6. After explicit approval, re-read `get_current_plan`, `get_training_state`, and `get_athlete_profile`. Save only if the current revision, snapshot hash, and profile hash still match the reviewed values. If any value is stale, do not save: run `get_plan_adjustment_review` again and rebase the proposal.
7. Save the complete plan with `save_current_plan`. Rejection, editing, or “later” leaves the Current Plan unchanged; edits remain conversation state and must be validated again. A Profile change is not rolled back when its associated plan proposal is rejected.

## Plan Target

When you save a Current Mesocycle, populate the optional `target` object so the Dashboard can explain *what this block is optimising for* at a glance. `planSchemaVersion` is `7.0`, and a plan without `target` remains valid. Derive every field from the profile, history, and the user's explicit request; never invent a baseline or test date the evidence does not support.

- `primaryGoal` — the single highest-priority outcome of the block. `label` is required; add `baseline` (current measurable level) and `testDate` (`YYYY-MM-DD`) only when the evidence supports them.
- `supporting` — goals that actively progress *toward* the primary goal this block (each `{ label, detail? }`).
- `maintenance` — capacities you are deliberately holding, not building (each `{ label, detail? }`). Keep supporting and maintenance distinct; do not flatten everything into one priority level.
- `coordinationStrategy` — one paragraph on how the domains interact: what wins on a conflict day, how high-intensity work from other sports is counted, and any sequencing rules (e.g. no heavy legs before a key run).

```json
{
  "target": {
    "primaryGoal": { "label": "Run 10K under 50:00", "baseline": "~54:30", "testDate": "2026-11-15" },
    "supporting": [{ "label": "Strength twice a week", "detail": "Preserve force output for running economy" }],
    "maintenance": [{ "label": "Weekly basketball" }],
    "coordinationStrategy": "Prioritise the 10K; count basketball as high-intensity load; keep lower-body strength off the day before a long run; when two key sessions collide, the current phase's primary goal wins."
  }
}
```

## Boundaries

- Profile `injuries` record known injuries or diagnoses (the factual "why") and `constraintNotes` record movement-level restrictions (the "what", derivable from injuries but never restating the diagnosis). Both are context only: at most 10 entries of 200 characters each, one issue per entry, no duplicates. Do not claim Core enforced their natural-language contents.
- Typed equipment, duration, training-day, and explicit-recovery constraints are Core-enforced.
- Profile has no fixed Strength or Endurance weekly quota. Choose the week-specific domain mix from goals, `preference`, history, recovery, and plan phase; it may vary between weeks while the Profile rhythm remains mandatory. Profile `preference` is a short free-text user preference (max 80 chars) that is advisory reference only, never Core-enforced.
- Profile `mesocycleDurationWeeks` (1-8) is the athlete's preferred length of one Mesocycle. Use it as the default plan `durationWeeks` unless the user requests a specific block length. It is advisory reference only, never Core-enforced.
- Exercises are open-world; there is no exercise catalog. `UNKNOWN` is a rule-level outcome only when a rule lacks a required trusted classification fact.
- AI facts can support a hard pass only at confidence `>= 0.90`, with non-empty evidence and no source conflict. Lower confidence, missing evidence, or conflicting sources require inference or confirmation when a blocker depends on the fact.
- Never collapse Strength and Endurance into one unsupported fatigue or readiness score.
- Apply Profile or Wellness changes directly only after explicit user confirmation, using `update_athlete_profile` or `update_wellness` with the latest hash.
- Treat Profile `preferredName`, `gender`, `heightCm`, and `birthDate` as stable personal facts. Weight is dated Wellness data and must never be written into Profile.
- If the state snapshot changes, refresh context and revalidate instead of bypassing stale-state rejection.
- Adjustment proposals are conversation state, not Athria records. Never create proposal CRUD, persist approval tokens, or partially patch the Current Plan.
- Treat `get_next_training_day` as the current execution queue. Add a manual completed workout, skip, restore, or move a planned session only after the user explicitly chooses that action.

Read [references/tool-contracts.md](references/tool-contracts.md) before constructing tool inputs or handling validation reason codes.
