# Athria tool contracts

## Template and current-plan lifecycle

`get_training_state` returns the `inputSnapshotHash` required by `save_current_plan`. `get_training_taxonomy` returns the Plan Schema version, domains, Strength vocabularies, allowed fact sources, and the AI hard-confidence threshold.

A v7 Current Plan contains `planSchemaVersion: "7.0"`, title, summary, explicit `effectiveStartDate`, a complete `mesocycle`, optimistic `revision`, snapshot hash, and Agent provenance. Runtime APIs do not accept older plan writes.

The mesocycle contains exactly one rhythm-only schedule matching Profile `trainingRhythm`: fixed weekday numbers, flexible day-count bounds, or interval days. It contains no templates, rotations, or prescription generation. `domainProgressions[]` contains exactly one entry for every resolved domain present in Weekly Sessions. Each domain's phases independently and contiguously cover the complete week-based duration.

`weeks[]` is the authoritative prescription. It contains every week exactly once and every session has a stable ID, real `scheduledDate`, within-day `order`, optional versioned `templateRef`, name, intent, duration, recovery demand, key-session flag, complete components, and optional progression or scheduling notes. Dates must fall in their numbered week and inside the plan. Session IDs are unique across the plan. Same-day sessions are ordered independently.

Each domain phase has a free-text `name`, shared `phaseType`, inclusive week range, focus, and concise progression strategies. Exact weekly load, volume, distance, RPE, or complexity belongs in Weekly Session prescriptions and `progressionNote`, not in a second progression metrics table. Domains must never be collapsed into a synthetic cross-sport load score.

Templates are independent single-domain generic structures managed with `list/get/create/update/delete_session_template`. Call `get_training_taxonomy` first and submit taxonomy IDs only. A Template contains a name, one concise intent, and ordered `nodes`; each node has a role, optional name, required `variables`, optional `optionalVariables`, and an `optional: true` flag only when the node itself is optional. It never contains extra notes, use cases, identity ranges, executable prescription fields, or defaults. Built-ins are read-only and copyable. A Weekly Session may cite a versioned `templateRef` as provenance, but its complete components and dose are authoritative; later Template updates never change Sessions.

Each exercise has `id`, `displayName`, nullable `canonicalKey`, its prescription, and a classification descriptor. Every classification fact includes `value`, `source`, `confidence`, `evidence`, and `taxonomyVersion`. The absence of a canonical key is valid.

Profile `trainingRhythm` is a required discriminated union and is Core-enforced. `fixed_week.days` uses Monday=0 through Sunday=6 and must match the plan's fixed weekdays. `flexible_week` supplies `minDaysPerWeek <= targetDaysPerWeek <= maxDaysPerWeek`; map those values to the plan schedule's corresponding `*SessionsPerWeek` fields, while counting distinct scheduled dates as training days. `interval.intervalDays` must match the plan cadence. Multiple sessions on one date count as one training day. Profile does not contain fixed Strength or Endurance weekly quotas; derive each week's domain mix from goals, `preference`, history, recovery, and phase. After calling `get_athlete_profile`, read the free-text `preference` field (a short one-line user preference) as advisory reference when shaping that mix. `strengthConstraints` is removed; Core no longer performs canonical-exercise exclusion or movement-pattern prohibition checks. `explicitRecoveryDays` is the minimum day gap between high-recovery-demand sessions. `injuries` capture known injuries or diagnoses (the factual why) and `constraintNotes` capture movement-level restrictions (the what); notes may be derived from injuries but must not restate the diagnosis. Both are advisory context only: at most 10 entries of up to 200 characters each, one issue per entry, no duplicates.

Profile also owns stable Personal Information: `preferredName`, optional `gender`, `heightCm`, and `birthDate`. Weight is never a Profile field; read and update it as the dated Wellness `weightKg` field.

Create a user Template before saving a plan that references its exact revision. `save_current_plan` revalidates the complete Weekly Sessions against the current Profile, classifications, taxonomy, rule-pack versions, snapshot hash, and references. User Template updates and deletes require `expectedRevision`; built-in mutation returns `TEMPLATE_READ_ONLY`.

`save_current_plan` is a single atomic replacement of the whole mesocycle: submit one complete plan in one call, never partial fragments. Refresh `inputSnapshotHash` with `get_training_state` immediately before saving whenever training state may have changed. On success it returns only `{ revision, impact, blockerSummary }`; read the stored plan with `get_current_plan` and full validation results with `validate_current_plan`. When revising an existing plan, a skipped Session remains skipped only if its replacement keeps the same id and `status: "skipped"`; re-planning that occurrence requires a new id.

`weeks[].sessions` is the only stored planned-session state. Calendar and next-day results derive `{ domain, phaseId }` references from it. `get_next_training_day` returns the earliest non-skipped session day. Use `update_planned_session` only after explicit user direction: `complete` creates an actual Training History record, `skip` marks that Session in the Current Plan, and `move_occurrence` updates its date and week in the Current Plan.

## Tool errors

Tool failures return `{ error, code }`, where `error` is the human-readable message and `code` is machine-readable. Plan-write codes and the next step: `REVISION_CONFLICT` (re-read `get_current_plan` and rebase on the latest revision), `INPUT_SNAPSHOT_CHANGED` (call `get_training_state` and revise against the fresh state), `PLAN_HAS_BLOCKERS` (the message is a short summary; call `validate_current_plan` for the full report), `WRITE_BUSY` (the local database was locked; retry the save shortly).

## Validation

Each result has `status: pass | fail | unknown | not_applicable` and `enforcement: blocker | advisory | info`. Only blocker `fail` or blocker `unknown` makes the plan invalid.

Use `reasonCode`, `rulePackId`, `ruleVersion`, `subjectRefs`, `evidence`, `missingFacts`, and `confidenceLimit`. `dataGaps` identify the fact path, affected rules, blocking state, and next resolution: `agent_infer`, `user_confirm`, or `add_profile_data`.

Resolve safe inference gaps first. Ask the user only when an unresolved fact is necessary to decide a blocker. Record explicit answers with source `user_confirmed`.

## Deterministic calculations

- `estimate_1rm` accepts an explicit load, unit, and 1–12 repetitions; it is an estimate.
- `calculate_heart_rate_zones` requires an explicit maximum heart rate. Never derive it from age.
- Progression and RPE tools return proposals only.
- Direct sets, indirect muscle participation, Endurance metrics, and heart-rate zones remain separate measurements.
