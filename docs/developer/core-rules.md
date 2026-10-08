# Core Rules

A document can have a valid JSON shape and still be an invalid plan. Schemas check shape and refinements; Core evaluates training rules; application services check ownership, references, freshness, and persistence.

## Validation result

| Field | Meaning |
| --- | --- |
| `valid` | False when any blocker has fail or unknown status |
| `results` | Rule records: reason code, enforcement, status, subjects, evidence, and missing facts |
| `dataGaps` | Missing facts, affected subjects, blocking flag, and suggested resolution |
| `coverage` | Resolved/total hard checks and movement, muscle, and equipment facts |
| `inputHash` | Hash of validation inputs and rule/taxonomy versions; not a write snapshot token |
| `validatedAt` | Evaluation timestamp |

Statuses are `pass`, `fail`, `unknown`, and `not_applicable`. Enforcement is `blocker`, `advisory`, or `info`. Advisory failure does not itself prevent saving. A resolved hard check may have failed; coverage is not a pass percentage.

**Example — Rule-result fragment:** unresolved equipment prevents saving.

```json
{
  "reasonCode": "EXERCISE_EQUIPMENT",
  "enforcement": "blocker",
  "status": "unknown",
  "missingFacts": ["classification.equipment"]
}
```

Resolve the fact named in the accompanying data gap. Do not clear an unknown by guessing.

## Structure and constraint rules

| Reason code | Condition / result | Resolution |
| --- | --- | --- |
| `COMPONENT_IDS` | Blocker: IDs unique within each session | Rename duplicates in that session |
| `EXERCISE_IDS` | Blocker: strength exercise IDs unique across all components of a session | Use distinct IDs across that session |
| `MESOCYCLE_SCHEDULE` | Schedule evidence emitted as a blocker pass after schema parsing | Fix malformed schedules at the schema boundary |
| `PROFILE_TRAINING_RHYTHM` | Blocker for invalid dates/frequency or fixed/interval parameter mismatch; flexible parameter-only mismatch is advisory | Align dates and schedule with Profile |
| `SESSION_DOMAIN_MISSING` | Info unknown plus a nonblocking gap when the whole session has no domain | Supply the activity type or an explicit session domain |
| `SESSION_STRENGTH_PRESCRIPTION` | Blocker: a strength session must contain a strength prescription | Supply executable strength work |
| `DOMAIN_PROGRESSION` | Blocker: unique domains exactly cover session domains; phases cover weeks 1–duration without gaps/overlaps | Correct timelines or phase bounds |
| `EXERCISE_EQUIPMENT` | Blocker: trusted nonempty alternatives include an available Profile ID; unresolved facts are unknown | Resolve classification or choose available equipment |

Schema refinements also require session IDs unique across the cycle, order unique within a date, all numbered weeks present, dates within their plan weeks, and valid phase references. These fail before the Core result list; not every failure has a rule reason code.

### Training rhythm conditions

- `fixed_week`: schedule weekdays equal Profile weekdays. Core also compares distinct weekdays across all sessions; it does not enforce a session on every listed weekday in every week.
- `flexible_week`: every plan week has a distinct-date count within Profile minimum/maximum. Valid counts with different schedule parameters yield advisory failure.
- `interval`: the first training date is the effective start; consecutive distinct dates are exactly intervalDays apart; schedule parameters match.

Multiple sessions on one date count once.

### Equipment trust

Facts require a value and no unresolved conflicts, except user-confirmed facts can resolve conflicting sources. AI facts additionally require confidence ≥0.9 and nonblank evidence in the current contract. Empty equipment lists are unresolved.

Equipment is an alternatives list: `["barbell", "dumbbell"]` passes when Profile contains either ID. Both are not required. See [exercise facts](training-taxonomy.md#exercise-facts).

## Advisory and informational rules

| Reason code | Condition |
| --- | --- |
| `STRENGTH_VOLUME_DISTRIBUTION` | Info: direct sets, indirect participations, and movement totals |
| `STRENGTH_PUSH_PULL_BALANCE` | Advisory: horizontal/vertical push versus pull totals |
| `STRENGTH_KNEE_HINGE_BALANCE` | Advisory: squat+lunge versus hinge totals |
| `STRENGTH_EFFORT_RPE` | Advisory fail when a strength exercise lacks targetRpe; not applicable with no strength exercises |
| `ENDURANCE_EFFORT_ZONE` | Advisory fail when an endurance step, including repeated work/recovery, lacks a nonempty heartRateZone |
| `ADJACENT_HIGH_DEMAND_SESSIONS` | Advisory fail for distinct high-demand dates ≤1 day apart when no explicit recovery gap is set |
| `EXPLICIT_RECOVERY_INTERVAL` | Advisory fail when the closest high-demand date gap is below explicitRecoveryDays |

Balance ratios pass between 0.5 and 2 inclusive. Both sides zero means not applicable. One side zero fails only when the other has at least four sets. These are heuristics, not optimal-volume prescriptions.

Recovery checks run only with at least two distinct high-demand dates. Duration relative to usualSessionMinutes has no Core blocker; Agents must obtain acceptance of noticeably longer/shorter sessions during planning.

**Example:** push = 8 and pull = 4 passes at ratio 2; push = 9 and pull = 4 produces advisory failure. Monday/Tuesday high-demand sessions with a three-day explicit gap also produce advisory failure, not a save blocker.

## Prescription support

Components have no domain. Their prescription kind describes the content: `strength`, `endurance`, `sport_skill`, `mind_body`, `mobility`, `functional`, or `duration_only`. A session owns one domain, used for progression, calendar presentation, and session counts. Content blocks may have different prescription kinds, such as a mobility cooldown inside a strength session. Strength sessions require at least one strength prescription; exercise classification checks run on every strength prescription.

Strength has a scientific rule pack; the other five domains have no separate scientific packs. Free-text injuries/constraints are context, not medical validation.

## Metrics and calculations

History strength metrics include strength and functional records, excluding warmup sets. Endurance metrics include endurance records only. Empty domains do not cause inference from populated sets or distance.

Raw strength volume sums recorded load × reps; different load units require normalization before comparison. Indirect participation is not equivalent to direct sets. Metrics retain quality gaps; partial totals are not complete evidence.

Core owns Epley 1RM, explicit-max-HR zones, double progression, and RPE autoregulation. Missing actual RPE cannot authorize a load adjustment; maximum HR is not derived from age. Athria provides no unified readiness score or medical clearance.

Authority: [validation](../../crates/athria-core/src/validation.rs), [plan refinements](../../crates/athria-core/src/schema/plan.rs), [metrics](../../crates/athria-core/src/metrics.rs), and [golden fixtures](../../crates/athria-core/tests/fixtures).
