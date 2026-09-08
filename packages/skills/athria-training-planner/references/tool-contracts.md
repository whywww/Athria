# Athria tool contracts

## Template and current-plan lifecycle

`get_training_state` returns the `inputSnapshotHash` required by `save_current_plan`. `get_training_taxonomy` returns the Plan Schema version, domains, Strength vocabularies, allowed fact sources, and the AI hard-confidence threshold.

A v4 Current Plan contains `planSchemaVersion: "4.0"`, title, summary, explicit `effectiveStartDate`, a complete `mesocycle`, optimistic `revision`, snapshot hash, and Agent provenance. Runtime APIs do not accept v2/v3 plan writes.

The mesocycle contains a sparse natural-week `weeklyStructure`: include training days only, with unique weekday values and one or more template IDs per entry. The same day may reference multiple templates. Phases remain contiguous across the complete duration.

Templates are independent latest-state resources managed with `list/get/create/update/delete_session_template`. The Current Mesocycle contains template IDs, never embedded templates. Each template has `components[]`; a Strength component uses `{ kind: "strength", exercises }`, while other or unclassified components use `{ kind: "duration_only", notes }`.

Each exercise has `id`, `displayName`, nullable `canonicalKey`, its prescription, and a classification descriptor. Every classification fact includes `value`, `source`, `confidence`, `evidence`, and `taxonomyVersion`. The absence of a canonical key is valid.

Profile `trainingDays` use Monday = 0 through Sunday = 6. An empty list means flexible days. `strengthConstraints` contains typed canonical-exercise exclusions and movement-pattern prohibitions. `constraintNotes` are not enforced by Core.

Create or update templates before saving a plan that references them. `save_current_plan` revalidates against the current Profile, classifications, taxonomy, rule-pack versions, snapshot hash, and referenced templates, then replaces the prior Current Mesocycle. Updates and deletes require `expectedRevision`. Use `preview_session_template_change`; when future planned snapshots are affected, pass `futureSessionPolicy: keep | update`. Completed, skipped, and legacy snapshots remain unchanged.

## Validation

Each result has `status: pass | fail | unknown | not_applicable` and `enforcement: blocker | advisory | info`. Only blocker `fail` or blocker `unknown` makes the plan invalid.

Use `reasonCode`, `rulePackId`, `ruleVersion`, `subjectRefs`, `evidence`, `missingFacts`, and `confidenceLimit`. `dataGaps` identify the fact path, affected rules, blocking state, and next resolution: `agent_infer`, `user_confirm`, or `add_profile_data`.

Resolve safe inference gaps first. Ask the user only when an unresolved fact is necessary to decide a blocker. Record explicit answers with source `user_confirmed`.

## Deterministic calculations

- `estimate_1rm` accepts an explicit load, unit, and 1–12 repetitions; it is an estimate.
- `calculate_heart_rate_zones` requires an explicit maximum heart rate. Never derive it from age.
- Progression and RPE tools return proposals only.
- Direct sets, indirect muscle participation, Endurance metrics, and heart-rate zones remain separate measurements.
