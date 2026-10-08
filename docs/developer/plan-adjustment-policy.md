# Plan Adjustment

Review evaluates whether the current plan needs attention. It does not edit the plan, and its result is not user approval.

## Inputs and outputs

| Field | Meaning |
| --- | --- |
| `trigger` | `weekly_review`, `profile_change`, or `user_request` |
| `reasons` | Reason code, severity, evidence axis, references, and affected scope |
| `hardOverrides` | Conditions forcing required review |
| `dataGaps` | Unresolved evidence, not normal recovery/performance |
| `reviewStatus` | Decision from the precedence table |
| `recommendedScope` | `none`, `workout`, `week`, or `plan` |
| `currentPlanRevision`, `inputSnapshotHash`, `profileHash` | Assessment freshness context |
| `suggestedReadWindow` | 1 normally; 3 for strong evidence or targeted evidence needs |
| `targetedEvidenceNeeds` | Follow-up evidence to inspect instead of unrelated history |

Evidence axes are adherence, key sessions, schedule feasibility, health/recovery, Profile mismatch, and performance per domain. Two performance domains are separate axes. Multiple reasons on one axis count once for soft-signal escalation.

## Decision precedence

Apply the first matching condition.

| Condition | Status | Scope / response |
| --- | --- | --- |
| Any hard override | `review_required` | Highest affected scope; inspect the conflict |
| Any strong reason, or soft reasons on ≥2 independent axes | `review_recommended` | Highest affected scope; propose the minimum supported change |
| Any other reason or data gap | `watch` | None; monitor unless the user explicitly requests change |
| No reasons or gaps | `keep` | None; preserve the plan |

Severity is `info`, `soft`, `strong`, or `hard`. Missing evidence does not create a soft signal by itself.

### Weekly evidence

| Evidence | Result |
| --- | --- |
| Exactly four sessions, three completed, no missed key session | Soft adherence deviation with no change scope |
| Exactly four sessions, at most two completed | Soft low-completion reason, week scope |
| Missed key session | Soft, week scope; strong at ≥2 persistence windows |
| Domain performance issue | Soft, week scope; strong at ≥2 persistence windows |
| Recovery issue | Soft health/recovery signal, week scope |
| Unknown performance, recovery, or feasibility | Data gap, not an invented issue |
| Unmatched actual workout | Targeted evidence need, not automatic repayment of missed volume |

The adherence conditions are explicit four-session cases, not general percentage thresholds. Persistence refers to supplied review windows, not two consecutive days.

**Example:** three of four completions with no key miss yields `watch / none`. A missed key session plus a recovery issue affects two axes and yields `review_recommended / week`.

## Hard overrides

| Wire value | Condition | Typical scope |
| --- | --- | --- |
| `EXPLICIT_HEALTH_LIMITATION` | Structured evidence explicitly limits training | Week; plan if phase intent is invalidated |
| `TRAINING_INTERRUPTION_SEVEN_DAYS` | Interruption ≥7 days | Week; plan if phase intent is invalidated |
| `NEXT_WEEK_STRUCTURALLY_INFEASIBLE` | Feasibility evidence identifies a conflict | Supplied minimum scope |
| `PROFILE_CONSTRAINT_CONFLICT` | Structural rhythm or equipment conflict | Equipment: week unless structural; structural rhythm: plan |
| `GOAL_PLAN_INTENT_DRIFT` | Structural goal modality absent from plan modalities | Plan |
| `RACE_TARGET_PLAN_INTENT_DRIFT` | Structural race modality absent from plan modalities | Plan |

General-fitness and other goals alone do not establish structural drift. Duration preference creates no hard conflict. Recovery spacing, nonstructural rhythm differences, and preference changes can remain soft Profile reasons.

**Example:** a seven-day interruption forces required review. Scope rises from week to plan only when evidence also invalidates the phase intent.

## Minimum-change scope

| Scope | Permitted proposal |
| --- | --- |
| `none` | No session or plan-content changes |
| `workout` | Target session IDs only; requires a nonempty target list |
| `week` | Target weeks, including focus; requires a nonempty week list |
| `plan` | Future content and structure when justified |

At all scopes, sessions before reviewDate and every non-planned session are protected: they cannot be added, removed, changed, or moved across weeks. Below plan scope, cycle duration, schedule, domain progression, adjustment rules, and plan metadata also remain unchanged.

Core scope validation reports violations such as `MISSING_SCOPE_TARGET`, `CHANGE_OUTSIDE_RECOMMENDED_SCOPE`, and `HISTORICAL_SESSION_CHANGED`. The combined application validator requires both plan and scope validation to pass.

**MCP boundary:** there is no dedicated scope-validation tool. Draft commit runs ordinary plan validation but does not automatically apply the minimum-change validator. Agents preserve this policy during drafting.

## Current evidence coverage

The application adapter derives session outcomes, key-session persistence, unmatched workouts, and validator-backed Profile conflicts. It does not supply performance issues, explicit health limitations, interruption counts, or inferred next-week infeasibility.

Next-week feasibility is currently supplied as feasible. Wellness present in the review window yields normal recovery status; absence yields unknown. This is record coverage, not physiological readiness. Former Profile preferences are not retained in saved plans, so preference-change detection is not reconstructed.

The full Core policy describes supported structured evidence; MCP review does not automatically detect every condition. Its current goal modalities also do not separately model the new mobility/functional domains; do not assume domain classification alone establishes goal drift.

## Applying a review

On the first opening of each local Monday–Sunday week, the desktop reviews the previous complete Monday–Sunday week to assess whether this week's plan needs adjustment. A first opening on Tuesday or later still reviews that same previous week. Current-week training is excluded, and unresolved sessions on the previous Sunday count as unresolved evidence. Explicit MCP `weekly_review` uses the same completed-week window; `user_request` can inspect the current week and excludes pending sessions scheduled for today.

The desktop waits for active training sync and queried data to settle, then stores the successful review, local week, and dismissal in browser local storage keyed by database UUID. Failed requests do not mark the week reviewed. Reopening or refreshing data in the same week checks fresh Profile/plan conflicts without repeating the weekly review; the initial weekly result remains available until dismissed or its plan/Profile context changes. A new local week starts a new review. This state is per device, not portable database state. Automatic checks run while the app is open, independent of the selected page. Profile-related notices use “Plan conditions changed”; weekly notices refer to last week's execution and this week's plan. Plan-write validation still runs on every write, and assessment never changes the plan automatically.

Inspect targeted evidence, propose the smallest supported change, validate, show details, obtain approval, refresh context, and commit through [write policy](write-policy.md#plan-approval-and-commit). Profile approval does not authorize plan rewriting.

Reminder identity includes reason codes, plan revision, Profile hash, and state snapshot hash. Acknowledgement suppresses unchanged soft context only. Changed context reopens it; hard overrides bypass acknowledgement. Acknowledgement never edits or approves the plan.

Authority: [Core assessment](../../crates/athria-core/src/adjustment.rs), [scope validator](../../crates/athria-core/src/scope_diff.rs), [application evidence](../../crates/athria-application/src/adjustment.rs), and [reminders](../../crates/athria-core/src/reminder.rs).
