# Validation and recovery

## Tool errors

Tool failures return `{ error, code }`, where `error` is the human-readable message and `code` is machine-readable. Draft codes and the next step: `DRAFT_REVISION_CONFLICT` (read the draft summary and affected week, then rebase and retry only the rejected session), `DRAFT_INCOMPLETE` (submit every missing week), `REVISION_CONFLICT` (re-read `get_current_plan` and rebase), `INPUT_SNAPSHOT_CHANGED` (call `get_training_state` and revise), `PLAN_HAS_BLOCKERS` (call `validate_plan_draft` for the full report), `HISTORICAL_SESSION_PROTECTED` (resubmit protected occurrences unchanged; see below), and `WRITE_BUSY` (retry shortly).

`HISTORICAL_SESSION_PROTECTED` means an occurrence before today in the Profile timezone, or a completed/skipped occurrence, was changed, moved, removed, or added retroactively. Resubmit those occurrences exactly as read; never restore or rewrite them. If plan metadata must change, create a `new` draft and copy historical weeks unchanged. A successor cycle passes only when it starts today or later, after the current plan's last day, and contains no earlier sessions.

## Validation

Each result has `status: pass | fail | unknown | not_applicable` and `enforcement: blocker | advisory | info`. Only blocker `fail` or blocker `unknown` makes the plan invalid.

Draft validation and commit exclude historical and completed/skipped occurrences from Profile-dependent and per-session training-rule checks, so old conflicts from a changed Profile do not block adjusting future work; those sessions still count for plan structure and domain/phase coverage. Direct saves and desktop adjustment reminders still validate the complete Current Plan.

Use `reasonCode`, `rulePackId`, `ruleVersion`, `subjectRefs`, `evidence`, `missingFacts`, and `confidenceLimit`. `dataGaps` identify the fact path, affected rules, blocking state, and next resolution: `agent_infer`, `user_confirm`, or `add_profile_data`.

Resolve safe inference gaps first. Ask the user only when an unresolved fact is necessary to decide a blocker. Record explicit answers with source `user_confirmed`.

## Uncertain commit

After commit, the draft and its weeks are deleted; Current Plan retains the Athria-managed `sourceDraftId`. There is no commit replay or historical receipt. If a commit response is lost or times out, call `get_current_plan` first: a matching `sourceDraftId` confirms success. If the draft still exists, refresh the draft, plan revision, and training context before deciding whether to retry. If the draft is absent and the source ID does not match, the outcome is uncertain (a later formal commit may have replaced the marker); do not infer success or failure, or automatically recreate and submit a replacement. Reading or submitting a deleted draft returns `DRAFT_NOT_FOUND`.
