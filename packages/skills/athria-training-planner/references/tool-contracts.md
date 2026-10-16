# Athria tool contracts

## Planning preflight context

`get_database_context` returns the normalized absolute `databasePath` used by the current MCP session. It is the first planning-context read. The user must confirm that path before any athlete data is read. Re-read it immediately before committing; a changed path invalidates every earlier confirmation.

`get_data_source_status` returns `asOf`, the Profile timezone and local date, and fixed entries for Intervals.icu, Xunji, and Hevy. API entries use `kind: "api_sync"`, expose `connected` and `syncedToday`, and retain non-secret historical sync timestamps after disconnection. Hevy uses `kind: "file_import"`, `lastImportAt`, and `importedToday`; it is never described as connected or subject to daily API sync. The tool never returns credentials. Asking the user to use Athria → Connections does not authorize the Agent to synchronize or import data itself.

Database confirmation, outline confirmation, and detailed-plan confirmation are distinct. Only outline confirmation permits persistent draft writes. Only detailed-plan confirmation permits `commit_plan_draft`.

## Adjustment evidence windows and Profile changes

`get_plan_adjustment_context` contains `committedAt`, `committedPlanRevision`, `trackingStartedAt`, `trackingComplete`, `timezone`, inclusive local `from`/`to` dates, `hasExecutionWindow`, and `profileChanges`, plus `currentPlanRevision`, `profileHash`, and `inputSnapshotHash`. It accepts no arguments and returns no `reviewStatus`, recommended scope, reasons, or trigger. `hasExecutionWindow` describes whether the default date range has started; only the history query establishes whether records exist. Each change contains `field`, `before`, `after`, `firstChangedAt`, and `lastChangedAt`. Changes are net values since the last successful formal draft commit: A→B→C becomes A→C, and A→B→A removes the change. App and MCP Profile updates share tracking; only a successful `commit_plan_draft` resets it. Failed or repeated submissions, drafts, workout operations, and read-only reviews do not reset it.

When tracking is incomplete, the original commit date and older changes are unknown. The window falls back to the Current Plan's `effectiveStartDate` through today. A future start yields `hasExecutionWindow: false`; do not issue reversed-date queries. Complete latest Profile remains the authority for every field: the diff does not confer extra weight or replace unchanged goals, preferences, or constraints.

`list_training_sessions`, `get_training_summary`, and `list_wellness` accept paired `from` and `to` dates (YYYY-MM-DD), inclusive in the current Profile timezone. Both dates are required when either is supplied; invalid dates and reversed ranges fail. Explicit dates override `days`; omitting both preserves legacy rolling-day behavior. Use the same dates across all evidence reads. The Agent gives one recommendation from this evidence and the conversation. App weekly checks are separate reminders; they do not select the Agent's evidence dates, dispatch an Agent, or authorize writes. No diff or new records is not a reason to reject a requested change.

## Template and current-plan lifecycle

`get_training_state` returns the `inputSnapshotHash` required by `commit_plan_draft`. `get_training_taxonomy` returns the Plan Schema version, domains, Strength vocabularies, allowed fact sources, and the AI hard-confidence threshold.

`get_plan_adjustment_context` is read-only and is the single adjustment evidence entry point. Always read the full latest Profile and the matching history; changes alone do not prescribe an adjustment. The Agent decides whether to preserve, monitor, or propose a minimum necessary change, then obtains outline and detailed approval before commit.

A v7 Current Plan contains `planSchemaVersion: "7.0"`, title, summary, explicit `effectiveStartDate`, a complete `mesocycle`, optimistic `revision`, snapshot hash, and Agent provenance. Create a persistent draft with its metadata, then submit each complete week with `upsert_plan_draft_week`; runtime APIs do not accept older plan writes.

The mesocycle contains exactly one rhythm-only schedule matching Profile `trainingRhythm`: fixed weekday numbers, flexible day-count bounds, or interval days. It contains no templates, rotations, or prescription generation. `domainProgressions[]` contains exactly one entry for every resolved domain present in Weekly Sessions. Each domain's phases independently and contiguously cover the complete week-based duration.

`weeks[]` is the authoritative prescription. It contains every week exactly once and every session has a stable ID, real `scheduledDate`, within-day `order`, optional versioned `templateRef`, name, intent, duration, recovery demand, key-session flag, one complete prescription, and optional progression or scheduling notes. Dates must fall in their numbered week and inside the plan. Session IDs are unique across the plan. Same-day sessions are ordered independently. Each session has one activity `type` and one scalar `domain`; a recognized type determines its domain. If the activity type is unknown, an explicit session domain may preserve the known classification. Each session directly owns one `prescription` with domain-specific `blocks[]`; do not send `components`. Warm-up, main work, and cooldown belong inside its blocks. New writes require a non-null prescription; migrated empty sessions may read as null. Phase references and domain progressions use the whole session domain.

Each domain phase has a free-text `name`, shared `phaseType`, inclusive week range, focus, and concise progression strategies (each a single short sentence, at most about 120 characters so it stays within two display lines). Exact weekly load, volume, distance, RPE, or complexity belongs in Weekly Session prescriptions and `progressionNote`, not in a second progression metrics table. Domains must never be collapsed into a synthetic cross-sport load score.

Templates are independent single-domain generic structures managed with `list/get/create/update/delete_session_template`. Call `get_training_taxonomy` first and submit taxonomy IDs only. A Template contains a name, one concise intent, and ordered `nodes`; each node has a role, optional name, required `variables`, optional `optionalVariables`, and an `optional: true` flag only when the node itself is optional. It never contains extra notes, use cases, identity ranges, executable prescription fields, or defaults. Built-ins can be edited, deriving a user-owned replacement with the same ID, or deleted, which only hides the code-defined original. A Weekly Session may cite a versioned `templateRef` as provenance, but its one complete prescription and dose are authoritative; later Template updates never change Sessions.

Each exercise has `id`, `displayName`, nullable `canonicalKey`, its prescription, and a classification descriptor. Every classification fact includes `value`, `source`, `confidence`, `evidence`, and `taxonomyVersion`. The absence of a canonical key is valid.

Effort notation follows the domain. Every Strength exercise carries a numeric `targetRpe` on the 1–10 scale, the only effort notation for strength; every Endurance step, including repeat work and recovery, carries a relative `heartRateZone` string such as `"2"` or `"1-3"` (displayed as `Zone 2` or `Zone 1-3`). Values must be single digits from 1 to 5 or strictly ascending ranges using an ASCII hyphen, without prefixes or whitespace. Zone values are relative to the athlete's own heart-rate baseline and require no stored maximum heart rate; the free-text `rpe` field on endurance steps is secondary context, never the primary notation. `validate_plan_draft` reports `STRENGTH_EFFORT_RPE` and `ENDURANCE_EFFORT_ZONE` as advisories when the notation is missing.

Profile `trainingRhythm` is a required discriminated union and is Core-enforced. `fixed_week.days` uses Monday=0 through Sunday=6 and must match the plan's fixed weekdays. `flexible_week` supplies `minDaysPerWeek <= targetDaysPerWeek <= maxDaysPerWeek`; map those values to the plan schedule's corresponding `*SessionsPerWeek` fields, while counting distinct scheduled dates as training days. `interval.intervalDays` must match the plan cadence. Multiple sessions on one date count as one training day. Profile does not contain fixed Strength or Endurance weekly quotas; derive each week's domain mix from goals, `preference`, history, recovery, and phase. After calling `get_athlete_profile`, read the free-text `preference` field (a short one-line user preference) as advisory reference when shaping that mix. `strengthConstraints` is removed; Core no longer performs canonical-exercise exclusion or movement-pattern prohibition checks. `explicitRecoveryDays` is the suggested minimum day gap between high-recovery-demand sessions. Recovery spacing is advisory and never blocks writes. User-initiated moves may override training rhythm; assess any deviation during the next adjustment review. `injuries` capture known injuries or diagnoses (the factual why) and `constraintNotes` capture movement-level restrictions (the what); notes may be derived from injuries but must not restate the diagnosis. Both are advisory context only: at most 10 entries of up to 200 characters each, one issue per entry, no duplicates.

Profile `usualSessionMinutes` is the target duration for regular sessions, allowing reasonable variation, not a ceiling. Validation does not impose a maximum or emit `MAX_SESSION_DURATION`. The planner must obtain explicit acceptance of noticeably longer or shorter sessions before outline approval and show those exceptions again for detailed approval; activity type alone does not grant an exception.

Profile also owns stable Personal Information: `preferredName`, optional `gender`, `heightCm`, and `birthDate`. Weight is never a Profile field; read the dated Wellness `weightKg` field instead. Wellness is read-only through MCP; users record weight in the Athria app.

Create a user Template before committing a plan that references its exact revision. `commit_plan_draft` revalidates the complete Weekly Sessions against the current Profile, classifications, taxonomy, rule-pack versions, snapshot hash, and references. User Template updates and deletes require `expectedRevision`; built-in originals cannot be updated directly (derive one first with `create_session_template`), while deleting a built-in only hides it and needs no `expectedRevision`.

`commit_plan_draft` is a single atomic replacement of the whole mesocycle. Persisted drafts support cross-conversation continuation: use `list_plan_drafts` to locate one and `get_plan_draft` to read metadata or a single week. Refresh `inputSnapshotHash` with `get_training_state` immediately before committing. `validate_plan_draft` returns the full report; committed plans remain readable with `get_current_plan`. When revising an existing plan, a skipped Session remains skipped only if its replacement keeps the same id and `status: "skipped"`; re-planning that occurrence requires a new id.

For an adjustment, also re-read `get_current_plan` and `get_athlete_profile` immediately before saving. If the plan revision, snapshot hash, or profile hash differs from the adjustment context, discard its freshness assumption, call `get_plan_adjustment_context` again, and rebase. Never bypass `REVISION_CONFLICT` or `INPUT_SNAPSHOT_CHANGED`.

## Tool errors

Tool failures return `{ error, code }`, where `error` is the human-readable message and `code` is machine-readable. Draft codes and the next step: `DRAFT_REVISION_CONFLICT` (refresh the draft and rebase the week), `DRAFT_INCOMPLETE` (submit every missing week), `REVISION_CONFLICT` (re-read `get_current_plan` and rebase), `INPUT_SNAPSHOT_CHANGED` (call `get_training_state` and revise), `PLAN_HAS_BLOCKERS` (call `validate_plan_draft` for the full report), and `WRITE_BUSY` (retry shortly).

## Validation

Each result has `status: pass | fail | unknown | not_applicable` and `enforcement: blocker | advisory | info`. Only blocker `fail` or blocker `unknown` makes the plan invalid.

Use `reasonCode`, `rulePackId`, `ruleVersion`, `subjectRefs`, `evidence`, `missingFacts`, and `confidenceLimit`. `dataGaps` identify the fact path, affected rules, blocking state, and next resolution: `agent_infer`, `user_confirm`, or `add_profile_data`.

Resolve safe inference gaps first. Ask the user only when an unresolved fact is necessary to decide a blocker. Record explicit answers with source `user_confirmed`.

## Deterministic calculations

- `estimate_1rm` accepts an explicit load, unit, and 1–12 repetitions; it is an estimate.
- `calculate_heart_rate_zones` requires an explicit maximum heart rate. Never derive it from age.
- Progression and RPE tools return proposals only.
- Direct sets, indirect muscle participation, Endurance metrics, and heart-rate zones remain separate measurements.


After commit, the draft and its weeks are deleted; Current Plan retains the Athria-managed `sourceDraftId`. There is no commit replay or historical receipt. If a commit response is lost or times out, call `get_current_plan` first: a matching `sourceDraftId` confirms success. If the draft still exists, refresh the draft, plan revision, and training context before deciding whether to retry. If the draft is absent and the source ID does not match, the outcome is uncertain (a later formal commit may have replaced the marker); do not infer success or failure, or automatically recreate and submit a replacement. Reading or submitting a deleted draft returns `DRAFT_NOT_FOUND`.
