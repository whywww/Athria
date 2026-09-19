# Athria workout tool contracts

## Planned-session state

`weeks[].sessions` is the only stored planned-session state. Calendar and next-day results derive completion from the workout match rather than storing `completed` in the Current Plan.

Use `update_planned_session` only after explicit user direction:

- `complete` creates a date-only manual Training History record and match.
- `skip` marks that occurrence skipped in the Current Plan.
- `restore` reverses a skip.
- `move_occurrence` changes the occurrence date and week.

All actions require the current plan revision. On `REVISION_CONFLICT`, re-read the exact planned occurrence, show any changed proposal, and obtain approval again.

`validate_next_training_day_sessions` checks a bounded next-day addition without writing. `save_next_training_day_sessions` requires the validated complete addition plus fresh plan/state identifiers. Validation is not permission to save.

## Training History and matching

Normal Training History ↔ Current Plan matching belongs to Athria's deterministic reconciliation algorithm. Never infer or send a `plannedSessionId` while calling `record_training_session`.

Call `override_training_session_plan_match` only after the user explicitly identifies, corrects, replaces, or rejects a particular workout match. A non-null `plannedSessionId` applies the exact user-directed same-day override. A null value marks the workout intentionally unplanned and excludes it from later automatic matching.

`allow_automatic_plan_match` is the only reversal of an intentionally-unplanned decision. Use it only when the user explicitly asks to return that workout to deterministic automatic matching.

`update_manual_training_session` changes only the exact start time or duration of a canonical workout containing a manual source. `remove_manual_training_source` removes only that manual source; synchronized observations remain.

## Freshness and writes

Immediately before any write, re-read the record or plan state that supplies its revision or hash. A stale proposal must be rebased and shown again; do not retry a changed write under the earlier approval.

Every write is bounded to the exact workout action the user approved. If fulfilling the request needs changes to the complete cycle structure or progression, stop and hand off to the training planner.
