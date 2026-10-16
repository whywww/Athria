# Plan Adjustment

Agent adjustment has one conversational entry point: get_plan_adjustment_context supplies commit-to-today evidence boundaries and Profile changes, and the Agent evaluates the complete latest Profile, history, Wellness, and conversation.

The deterministic policy below belongs to App reminder checks. It invites the user to review a plan with their Agent; it neither dispatches the Agent nor changes the plan or grants approval.

## Inputs and outputs

| Field | Meaning |
| --- | --- |
| `trigger` | Internal Core/App check kind; not an MCP or Skill choice |
| `reasons` | Reason code, severity, evidence axis, references, and affected scope |
| `hardOverrides` | Conditions forcing required review |
| `dataGaps` | Unresolved evidence, not normal recovery/performance |
| `reviewStatus` | Decision from the precedence table |
| `recommendedScope` | `none`, `workout`, `week`, or `plan` |
| `currentPlanRevision`, `inputSnapshotHash`, `profileHash` | Assessment freshness context |
| `suggestedReadWindow` | Legacy auxiliary hint (1 or 3); not a date-query contract |
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

At all scopes, sessions before reviewDate and every non-planned session are protected: they cannot be added, removed, changed, or moved across weeks. Below plan scope, cycle duration, schedule, domain progression, and plan metadata also remain unchanged.

Core scope validation reports violations such as `MISSING_SCOPE_TARGET`, `CHANGE_OUTSIDE_RECOMMENDED_SCOPE`, and `HISTORICAL_SESSION_CHANGED`. The combined application validator requires both plan and scope validation to pass.

**MCP boundary:** there is no dedicated scope-validation tool. Draft commit runs ordinary plan validation but does not automatically apply the minimum-change validator. Agents preserve this policy during drafting.

## Current evidence coverage

The application adapter derives session outcomes, key-session persistence, unmatched workouts, and validator-backed Profile conflicts. It does not supply performance issues, explicit health limitations, interruption counts, or inferred next-week infeasibility.

Next-week feasibility is currently supplied as feasible. Wellness present in the review window yields normal recovery status; absence yields unknown. This is record coverage, not physiological readiness. Full former Profiles are not retained. The application now records net changes to plan-related Profile fields since the last formal plan commit and exposes them through `get_plan_adjustment_context.profileChanges`; the deterministic preference-change signal is still not inferred from these textual changes. The Agent compares the full latest Profile and plan, using changes as attention hints without reducing the weight of unchanged preferences.

The full Core policy describes supported structured evidence; MCP review does not automatically detect every condition. Its current goal modalities also do not separately model the new mobility/functional domains; do not assume domain classification alone establishes goal drift.

## Applying a review

On the first opening of each local Monday–Sunday week, the desktop reviews the previous complete Monday–Sunday week to assess whether this week's plan needs adjustment. A first opening on Tuesday or later still reviews that same previous week. Current-week training is excluded, and unresolved sessions on the previous Sunday count as unresolved evidence. These checks remain internal to the App; MCP exposes no review trigger. A reminder only asks the user to speak with their Agent, whose adjustment evidence period is always the formal-commit-to-today window unless the user specifies another period.

The desktop waits for active training sync and queried data to settle, then stores the successful review, local week, and dismissal in browser local storage keyed by database UUID. Failed requests do not mark the week reviewed. Reopening or refreshing data in the same week checks fresh Profile/plan conflicts without repeating the weekly review; the initial weekly result remains available until dismissed or its plan/Profile context changes. A new local week starts a new review. Dismissing a condition-change or other non-weekly notice also persists per database in browser local storage, keyed by notice identity (reason, affected domain, severity tier); it stays silent across data updates and reopenings while its text and tier are unchanged, and a severity escalation shows it once more. Weekly notices keep their week-scoped cadence instead. This state is per device, not portable database state. Automatic checks run while the app is open, independent of the selected page. Profile-related notices use “Plan conditions changed”; weekly notices refer to last week's execution and this week's plan. Plan-write validation still runs on every write, and assessment never changes the plan automatically.

Inspect targeted evidence, propose the smallest supported change, validate, show details, obtain approval, refresh context, and commit through [write policy](write-policy.md#plan-approval-and-commit). Profile approval does not authorize plan rewriting.

Reminder identity includes reason codes, plan revision, Profile hash, and state snapshot hash. Acknowledgement suppresses unchanged soft context only. Changed context reopens it; hard overrides bypass acknowledgement. Acknowledgement never edits or approves the plan.

Authority: [Core assessment](../../crates/athria-core/src/adjustment.rs), [scope validator](../../crates/athria-core/src/scope_diff.rs), [application evidence](../../crates/athria-application/src/adjustment.rs), and [reminders](../../crates/athria-core/src/reminder.rs).

## Agent adjustment history and persisted diff

Generic adjustment requests use the last successful `commit_plan_draft` date through today in the current Profile timezone, inclusive. The no-argument MCP `get_plan_adjustment_context` returns this evidence period and freshness hashes without a decision or trigger. App reminder cadence does not affect it. Explicit paired `from`/`to` queries align sessions, summary, and Wellness. Do not pool a multiweek history into the four-session weekly thresholds.

Schema v32 adds database/owner-isolated `plan_review_context`, carrying only the formal commit anchor and net changes to goals, preference, regular session duration, rhythm, equipment, injuries, movement constraints, recovery spacing, cycle duration, and race dates. Shared Profile writes update the diff transactionally. Only successful formal plan commits reset it; replay, failure, draft saves, workout operations, and review reads do not. A→B→C retains A→C, while reverting to A removes that field.

Existing databases have incomplete tracking until their first formal commit. No old Profile or commit timestamp is invented: read from the plan effective start as fallback, report the limitation, and return no execution history for future starts. Full current Profile remains authoritative. The Agent gives one recommendation based on full current facts, the diff, history, and conversation; no diff or new records does not reject a requested change. App reminder statuses do not decide adjustments. Every proposed change still requires outline approval, detailed approval, freshness checks, and atomic commit.
