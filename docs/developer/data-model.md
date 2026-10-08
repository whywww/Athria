# Data Model

Athria distinguishes stable context, dated facts, reusable structures, intended training, and actual training. Choose the model by what the data means.

| Model | Purpose |
| --- | --- |
| Athlete Profile | Stable facts, goals, training settings, and constraints |
| Wellness | Dated measurements with per-field provenance |
| Training Memory | Revisable summary of experience and capability |
| Session Template | Reusable single-domain structure without executable dose |
| Current Plan | One editable mesocycle and its complete Weekly Sessions |
| Planned Session | Scheduled occurrence and prescription snapshot |
| Training History | Actual canonical workouts assembled from source observations |

## Athlete Profile

| Field | Type / public range | Meaning |
| --- | --- | --- |
| `timezone` | Timezone string | Basis for local dates and freshness; default `Asia/Hong_Kong` |
| `goals` | String array | Training intent; default `["general_fitness"]` |
| `usualSessionMinutes` | Integer, 15–240 | Regular-session target; default 60, not a maximum |
| `trainingRhythm` | Discriminated object | Fixed weekdays, flexible weekly frequency, or a day interval |
| `equipment` | Taxonomy ID array | Available resources, not free-form exercise names |
| `explicitRecoveryDays` | Integer 1–7 or null | Minimum date gap between high-demand sessions; advisory |
| `mesocycleDurationWeeks` | Integer, 1–8 | Preferred new-cycle length; default 8, not the plan schema's maximum |
| `raceDays` | Up to 50 `{date, sport}` entries | Date is `YYYY-MM-DD`; sport is 1–80 characters |
| `injuries`, `constraintNotes` | Up to 10 entries each, 1–200 characters each | Injuries describe the factual why; constraints describe movement restrictions. One issue per entry, no duplicates |
| `unitSystem` | `metric` or `imperial` | Display preference; explicit load units still matter |

Untouched defaults are not user-confirmed facts. Injuries and constraint notes are advisory text, not executable safety rules. Body weight belongs to Wellness.

### Training rhythm

| Kind | Fields | Semantics |
| --- | --- | --- |
| `fixed_week` | `days`: unique integers 0–6 | 0 = Monday, 6 = Sunday |
| `flexible_week` | `minDaysPerWeek`, `targetDaysPerWeek`, `maxDaysPerWeek`: integers 1–7 | Minimum ≤ target ≤ maximum |
| `interval` | `intervalDays`: integer 1–30 | Date spacing from the effective start |

Count distinct training dates, not sessions. Two sessions on one day count as one training day.

**Example — Profile fragment:** Monday/Wednesday/Friday availability and a three-day recovery gap.

```json
{
  "trainingRhythm": { "kind": "fixed_week", "days": [0, 2, 4] },
  "usualSessionMinutes": 60,
  "explicitRecoveryDays": 3
}
```

Monday and Thursday are three days apart; this does not require three intervening rest days.

## Current Plan

Weekly Sessions are authoritative executable content. Templates and progression notes cannot fill omitted prescriptions.

| Field | Type / public range | Meaning |
| --- | --- | --- |
| `planSchemaVersion` | `"7.0"` | Current accepted plan contract |
| `effectiveStartDate` | `YYYY-MM-DD` | Start of plan week 1 |
| `revision` | Integer | Stored plan version; writes use its expected revision |
| `inputSnapshotHash` | String | Context freshness token, not a plan revision |
| `mesocycle.durationWeeks` | Integer, 1–52 | Actual cycle length |
| `mesocycle.schedule` | Training-rhythm object | Planned rhythm, checked against Profile |
| `mesocycle.weeks` | Week objects | Complete sessions; week numbers cover 1 through duration |
| `mesocycle.domainProgressions` | One entry per represented session domain | Each timeline covers the full cycle without gaps/overlaps |
| `mesocycle.adjustmentRules` | `{trigger, action, rationale}` entries | Written guidance, not executable adjustment policy |
| `target` | Optional object | Primary goal, supporting/maintenance goals, and coordination intent |

Weeks are seven-day windows from `effectiveStartDate`, not necessarily calendar Monday–Sunday. Session dates must lie within their numbered window.

### Weekly Session fields

| Field | Type / public range | Meaning |
| --- | --- | --- |
| `id` | String | Unique across the mesocycle |
| `type`, `subtype` | String or null | Activity identity; see [classification](training-taxonomy.md) |
| `scheduledDate`, `order` | Date; integer 0–50 | Position; order is unique per date within a week |
| `status` | `planned` or `skipped` | Intended state, not an actual workout record |
| `durationMinutes` | Integer, 1–240 | Session estimate; independent of Profile's target |
| `recoveryDemand` | `low`, `normal`, `high` | Spacing input; default `normal` |
| `keySession` | Boolean | Priority work for adjustment review |
| `templateRef` | Versioned reference or null | Optional provenance; never supplies missing content |
| `domain` | Single session domain | Derived from recognized type, or explicit when type is unknown |
| `components` | Component array | Each has an ID, name, and complete prescription; no domain field |

A progression entry has a domain and phases. A phase has an ID unique within that domain, inclusive `startWeek`/`endWeek`, `phaseType`, `focus`, and written `progression`. Progression domains must exactly match resolved session domains.

## Templates and prescriptions

Templates contain `id`, `name`, `intent`, one domain, and nodes. Nodes specify roles and variables, not sets, loads, or final dose. Required and optional variables cannot overlap.

References use `{source: "builtin", id, catalogVersion}` or `{source: "user", id, revision}`. They must resolve at write time. Editing a template does not rewrite sessions. Customize a built-in through a local derivation; hiding it does not delete its original definition.

**Example — Session fragment:** the reference is provenance, while the component supplies dose.

```json
{
  "type": "Run",
  "subtype": null,
  "templateRef": { "source": "builtin", "id": "builtin.easy-run", "catalogVersion": "example-version" },
  "components": [
    {
      "id": "easy",
      "name": "Easy run",
      "domain": { "value": "endurance", "source": "user_confirmed", "confidence": 1, "evidence": "Confirmed running session", "taxonomyVersion": "strength-2.0" },
      "prescription": { "kind": "endurance", "segments": [{ "type": "step", "name": "Steady", "role": "steady", "durationSeconds": 1800, "heartRateZone": "Z2" }] }
    }
  ]
}
```

The reference version is illustrative; use a version actually returned by Athria. See [prescription support](core-rules.md#prescription-support) for domain/kind combinations.

## Planned occurrences and actual history

An occurrence carries `planRevision`, `scheduledDate`, `phaseRefs`, and a prescription snapshot. Status is `planned`, `completed`, `unrecorded`, or `skipped`. Phase references match the single session domain and resolve against progression timelines. Resolved and legacy snapshots are protected during future synchronization.

History records type, subtype, derived domains, `startAt`, `endAt`, `durationMinutes`, timezone, and `timePrecision` (`exact` or `date_only`). Preserve date-only precision; do not present an estimate as exact.

`sources` retains source identities. Canonical workouts combine observations to avoid double-counting. `planMatch` is derived; `isPlanMatchExcluded` preserves an intentional unplanned decision. Removing a manual source must not remove synchronized observations. See [matching policy](write-policy.md#matching-and-history).

## Wellness and Training Memory

Wellness uses `day` and `fields`; each field retains its value, source, and update timestamp. Its read snapshot hash protects updates. Missing values stay missing; zero and null are not interchangeable.

Training Memory uses `contentMarkdown`, revision, and `updatedAt`. It is a current portrait, not a raw log or replacement for confirmed facts. Runtime writes require nonblank content of at most 2,000 characters and the expected revision.

Definitions: [public schemas](../../schemas/v7), [runtime parsers](../../crates/athria-core/src/schema), and [application services](../../crates/athria-application/src/app.rs).
