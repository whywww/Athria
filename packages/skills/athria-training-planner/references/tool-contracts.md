# Athria tool contracts

## Template and current-plan lifecycle

`get_training_state` returns the `inputSnapshotHash` required by `save_current_plan`. `get_training_taxonomy` returns the Plan Schema version, domains, Strength vocabularies, allowed fact sources, and the AI hard-confidence threshold.

A v7 Current Plan contains `planSchemaVersion: "7.0"`, title, summary, explicit `effectiveStartDate`, a complete `mesocycle`, optimistic `revision`, snapshot hash, and Agent provenance. Runtime APIs do not accept older plan writes.

The mesocycle contains exactly one rhythm-only schedule matching Profile `trainingRhythm`: fixed weekday numbers, flexible day-count bounds, or interval days. It contains no templates, rotations, or prescription generation. `domainProgressions[]` contains exactly one entry for every resolved domain present in Weekly Sessions. Each domain's phases independently and contiguously cover the complete week-based duration.

`weeks[]` is the authoritative prescription. It contains every week exactly once and every session has a stable ID, real `scheduledDate`, within-day `order`, optional versioned `templateRef`, name, intent, duration, recovery demand, key-session flag, complete components, and optional progression or scheduling notes. Dates must fall in their numbered week and inside the plan. Session IDs are unique across the plan. Same-day sessions are ordered independently.

Each domain phase has a free-text `name`, shared `phaseType`, inclusive week range, focus, and concise progression strategies. Exact weekly load, volume, distance, RPE, or complexity belongs in Weekly Session prescriptions and `progressionNote`, not in a second progression metrics table. Domains must never be collapsed into a synthetic cross-sport load score.

Templates are independent single-domain generic structures managed with `list/get/create/update/delete_session_template`. Call `get_training_taxonomy` first and submit catalog IDs only. A Template contains structural nodes, variable keys, and optional identity ranges—never executable prescription fields or defaults. Built-ins are read-only and copyable. A Weekly Session may cite a versioned `templateRef` as provenance, but its complete components and dose are authoritative; later Template updates never change Sessions.

Each exercise has `id`, `displayName`, nullable `canonicalKey`, its prescription, and a classification descriptor. Every classification fact includes `value`, `source`, `confidence`, `evidence`, and `taxonomyVersion`. The absence of a canonical key is valid.

Profile `trainingRhythm` is a required discriminated union and is Core-enforced. `fixed_week.days` uses Monday=0 through Sunday=6 and must match the plan's fixed weekdays. `flexible_week` supplies `minDaysPerWeek <= targetDaysPerWeek <= maxDaysPerWeek`; map those values to the plan schedule's corresponding `*SessionsPerWeek` fields, while counting distinct scheduled dates as training days. `interval.intervalDays` must match the plan cadence. Multiple sessions on one date count as one training day. Profile does not contain fixed Strength or Endurance weekly quotas; derive each week's domain mix from goals, `preference`, history, recovery, and phase. After calling `get_athlete_profile`, read the free-text `preference` field (a short one-line user preference) as advisory reference when shaping that mix. `strengthConstraints` contains typed canonical-exercise exclusions and movement-pattern prohibitions. `constraintNotes` are not enforced by Core.

Create a user Template before saving a plan that references its exact revision. `save_current_plan` revalidates the complete Weekly Sessions against the current Profile, classifications, taxonomy, rule-pack versions, snapshot hash, and references. User Template updates and deletes require `expectedRevision`; built-in mutation returns `TEMPLATE_READ_ONLY`.

Saving a plan materializes its planned occurrences from `weeks[].sessions` and records a `{ domain, phaseId }` reference for every resolved domain in each Session. `get_next_training_day` returns the earliest occurrence with an unresolved session plus its distinct `domainPhases[]`. Use `update_planned_session` only after explicit user direction: `complete` records a manual completion, `skip` abandons that session without a make-up, and `move_occurrence` reschedules only the selected occurrence while recomputing its domain phase references. Moves never cascade or reorder other sessions and are rejected when the resulting dates would break the Profile rhythm.

## Validation

Each result has `status: pass | fail | unknown | not_applicable` and `enforcement: blocker | advisory | info`. Only blocker `fail` or blocker `unknown` makes the plan invalid.

Use `reasonCode`, `rulePackId`, `ruleVersion`, `subjectRefs`, `evidence`, `missingFacts`, and `confidenceLimit`. `dataGaps` identify the fact path, affected rules, blocking state, and next resolution: `agent_infer`, `user_confirm`, or `add_profile_data`.

Resolve safe inference gaps first. Ask the user only when an unresolved fact is necessary to decide a blocker. Record explicit answers with source `user_confirmed`.

## Deterministic calculations

- `estimate_1rm` accepts an explicit load, unit, and 1–12 repetitions; it is an estimate.
- `calculate_heart_rate_zones` requires an explicit maximum heart rate. Never derive it from age.
- Progression and RPE tools return proposals only.
- Direct sets, indirect muscle participation, Endurance metrics, and heart-rate zones remain separate measurements.
