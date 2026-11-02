# Data Model

Athria stores a workspace as a single SQLite file. The schema is a thin relational shell around JSON documents: columns carry only what the app queries and guards (identity, owner, dates, status, revision counters), while each row's complete business document lives as camelCase JSON in a `data` column — the same shapes returned by the API and MCP tools.

This is the field dictionary for the current SQLite schema version **41** and plan contract **8.0**. Writable opens accept only schema 41; older and future versions are rejected without modification. Read-only backup previews accept only schema 41 and never migrate. A fresh database is created directly at this schema. It describes the current application contract, not the values present in every existing database row.

Column declarations live in the [store schema directory](../../crates/athria-store/src/schema) and [store.rs](../../crates/athria-store/src/store.rs); public JSON ranges come from the [v8 schemas](../../schemas/v8) and runtime normalization from the linked Rust sources.

## Conventions

- Column names use snake_case; JSON uses camelCase. Unless annotated `INTEGER`, columns are `TEXT`; `?` means SQL NULL is allowed; `PK` and `UQ` mark primary keys and unique indexes.
- Athlete-scoped tables carry `owner_id` (default `local-user`). Timestamps are ISO-8601 UTC strings; dated facts use local `YYYY-MM-DD`.
- Only `plan_draft_weeks.draft_id` has a declared SQL foreign key; every other relationship is maintained by application code.
- Writes run in `BEGIN IMMEDIATE` transactions; backups are consistent single-file snapshots.
- Write-only guards such as `expectedRevision`, `expectedProfileHash`, `expectedSnapshotHash`, and `clientRequestId` are request inputs, not stored model fields.
- A field returned by an API is not necessarily an independently stored column; reads derive values from several tables (see [Planned occurrences](#planned-occurrences-read-model)).
- Nullable means an explicit `null` is supported; optional means the key may be absent.
- The database file is plain SQLite; only connection secrets are encrypted at rest (see `connection_secrets`).

## Table groups

| Group | Tables | Holds |
| --- | --- | --- |
| Athlete and training content | `profiles`, `wellness`, `training_memory`, `current_mesocycles`, `plan_drafts`, `plan_draft_weeks`, `session_templates`, `template_dismissals`, `training_sessions`, `training_session_sources` | Profile, dated Wellness, Training Memory, the Current Plan and its drafts, templates, and actual training history |
| Matching and plan review | `plan_workout_matches`, `workout_plan_exclusions`, `planned_session_events`, `plan_review_context` | Links and audit between planned sessions and actual workouts, plus the plan-adjustment baseline |
| Integrations and imports | `connection_secrets`, `connection_sync_state`, `daily_sync_attempts`, `import_batches` | Connections, encrypted secrets, sync state and gates, and file imports |
| Database and vault metadata | `vault_meta`, `athria_migrations`, `athria_data_version` | Vault format and key wrapping, schema bookkeeping, and the data change counter |

## Athlete and training content

### `profiles` — Athlete Profile

One row per athlete: stable facts, goals, training settings, and constraints.

**SQL columns** — queried and guarded by the app:

| Column | Explanation |
| --- | --- |
| `owner_id` | Owner; PK |
| `data` | Complete Profile JSON (below) |
| `updated_at` | Last write, UTC timestamp |

**`data` JSON (camelCase)** — the complete document returned by the API:

```text
profiles.data
├─ ownerId, preferredName: identity and display
├─ gender, heightCm, birthDate: personal information
├─ timezone, unitSystem: date basis and display units
├─ goals, preference: training intent
├─ trainingRhythm, usualSessionMinutes: rhythm and session target
├─ mesocycleDurationWeeks, explicitRecoveryDays: cycle and recovery settings
├─ equipment: available resources (taxonomy IDs)
├─ raceDays[]: dated target events
└─ injuries[], constraintNotes[]: advisory constraints
```

#### Profile fields

| Field | Type / public range | Meaning |
| --- | --- | --- |
| `ownerId` | String | Owner; default `local-user` |
| `preferredName` | String | Display name; default `Athlete` |
| `gender` | `female`, `male`, `non_binary`, `prefer_not_to_say`, or null | Personal information |
| `heightCm` | Number or null | Height in centimeters |
| `birthDate` | Date string or null | Birth date |
| `timezone` | Timezone string | Basis for local dates and freshness; default `Asia/Hong_Kong` |
| `goals` | String array | Training intent; default `["general_fitness"]` |
| `preference` | String | Free-text training preference; default empty string |
| `usualSessionMinutes` | Integer, 15–240 | Regular-session target; default 60, not a maximum |
| `trainingRhythm` | Discriminated object | Fixed weekdays, flexible weekly frequency, or a day interval |
| `equipment` | Taxonomy ID array | Available resources, not free-form exercise names |
| `explicitRecoveryDays` | Integer 1–7 or null | Minimum date gap between high-demand sessions; advisory |
| `mesocycleDurationWeeks` | Integer, 1–8 | Preferred new-cycle length; default 8, not the plan schema's maximum |
| `raceDays` | Up to 50 `{date, sport}` entries | Date is `YYYY-MM-DD`; sport is 1–80 characters |
| `injuries`, `constraintNotes` | Up to 10 entries each, 1–200 characters each | Injuries describe the factual why; constraints describe movement restrictions. One issue per entry, no duplicates |
| `unitSystem` | `metric` or `imperial` | Display preference; explicit load units still matter |

Untouched defaults are not user-confirmed facts. Injuries and constraint notes are advisory text, not executable safety rules. Body weight belongs to Wellness. Plan-relevant changes are tracked by `plan_review_context`.

#### Training rhythm

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

### `wellness` — dated measurements

One row per athlete per day; each stored field keeps its own value, source, and update timestamp.

**SQL columns** — queried and guarded by the app:

| Column | Explanation |
| --- | --- |
| `owner_id` | Owner |
| `day` | Local date `YYYY-MM-DD` |
| `data` | Wellness JSON (below) |
| `updated_at` | Last write |

Unique per `(owner_id, day)`.

**`data` JSON (camelCase)** — the complete document returned by the API:

```text
wellness.data
├─ ownerId, day, updatedAt: record identity and local day
└─ fields: partial object; absent keys stay absent
   └─ <key>: { value, source, updatedAt }
```

Each present `fields.<key>` carries its own `value`, `source` (`intervals_icu`, `user`, `llm`, `athria`), and `updatedAt`. Missing values stay missing; zero and null are not interchangeable, and a user patch with null clears the stored field. Read snapshot hashes are concurrency guards, not additional measurement fields.

#### Wellness fields

Every value below is nullable; missing keys remain absent.

`subjectiveFatigue` is the stored 0–100 rating. Old internal Wellness field names are rejected. ICU payloads still use `fatigue`; the importer maps those external grades to the current rating without altering new low scores.

| Field key | Value type / runtime range | Unit / meaning |
| --- | --- | --- |
| `restingHeartRateBpm` | Nonnegative number | Resting bpm |
| `hrvRmssdMs`, `hrvSdnnMs` | Nonnegative numbers | HRV, milliseconds |
| `sleepSeconds` | Integer 0–86,400 | Sleep duration, seconds; manual entries take priority |
| `sleepScore` | Number 0–100 | Perceived sleep quality; manual entries take priority |
| `avgSleepingHeartRateBpm` | Nonnegative number | Sleeping bpm |
| `weightKg` | Positive number | Kilograms |
| `bodyFatPercent` | Number 0–100 | Body fat percentage |
| `vo2maxMlKgMin` | Nonnegative number | mL/kg/min |
| `spo2Percent` | Number 0–100 | Oxygen saturation percentage |
| `stepsCount` | Nonnegative integer | Steps |
| `respirationRpm` | Nonnegative number | Breaths per minute |
| `subjectiveFatigue` | Number 0–100 | Subjective fatigue; ICU grades import as 0/25/50/75/100; manual entries take priority |
| `readiness` | Integer 0–100 | Athria morning estimate displayed the following day, calculated from this day's wellness; see [readiness.md](readiness.md) |
| `atl`, `ctl` | Nonnegative finite numbers | ICU-calculated acute/chronic training load; Athria does not calculate the time constants |
| `form` | Signed finite number | `ctl - atl`, load points/day |

Athria calculates the score from the E-day wellness record and stores it on that record for display on D=E+1, so today's displayed readiness represents health status through the previous day. Cardiac recovery, sleep and subjective fatigue form three dimensions. A cardiac dimension with a valid personal baseline can independently provide a limited estimate; otherwise both sleep and subjective recovery are required. Recent session-RPE statistics are available without a mature baseline. Comparable overall or activity-group load series use historical percentiles and progressive evidence weights; ATL/CTL is an exclusive fallback. Dates without workouts count as zero, while missing fields remain unknown. Load deductions are attenuated when capped wellness is below 70 and stop at 45 or below, with at most 15 points deducted. Missing dimensions are omitted with weights normalized, and severe fatigue/sleep signals cap the final score. See [the full algorithm and validation policy](readiness.md).

Records additionally carry an optional, Athria-managed top-level `readinessAssessment` with `algorithmVersion`, `assessmentDay`, `score`, `status`, component scores, `baseScore`, `loadAdjustment`, `loadMethod`, `trainingLoad` (recent statistics, group comparisons, support weights and wellness attenuation), `scoreCap`, `dataQuality`, baseline fields/counts and `missingReasons`. It is derived metadata, not an editable wellness field. Raw record parsing discards supplied metadata; write paths regenerate it. Writable opens backfill assessments using the current calculation rules, while read-only inspection never writes. Numeric scores are absent without usable cardiac recovery unless both sleep and subjective recovery are available; cardiac-only estimates are always limited and identify their signal coverage. Missing inputs are omitted rather than scored as zero. The assessment retains missing reasons. Wellness, canonical training/RPE and profile timezone changes atomically recompute the owner's cached assessments; stable results do not change timestamps. Overview displays the previous day's persisted score and its breakdown without duplicating the formula; `assessmentDay` is the display day.

### `training_memory` — agent portrait

One row per athlete: the agent-maintained current portrait of experience and capability, not a raw log or replacement for confirmed facts.

| Column | Explanation |
| --- | --- |
| `owner_id` | Owner; PK |
| `content_markdown` | Markdown content, 1–2,000 characters |
| `revision` (INTEGER) | Optimistic counter, ≥ 1 |
| `updated_at` | Last write |

Reads map the four columns directly to `ownerId`, `contentMarkdown`, `revision`, and `updatedAt` — there is no JSON `data` column. Runtime writes require nonblank content of at most 2,000 characters and the expected revision.

### `current_mesocycles` — Current Plan

One row per athlete: the committed plan. Weekly Sessions are authoritative executable content; templates and progression notes cannot fill omitted prescriptions.

**SQL columns** — queried and guarded by the app:

| Column | Explanation |
| --- | --- |
| `owner_id` | Owner; PK |
| `data` | Complete plan document (below), including every Weekly Session |

A commit replaces the whole document in one transaction, guarded by the JSON `revision` and `inputSnapshotHash`. Revision and update time are stored only in JSON.

**`data` JSON (camelCase)** — the complete document returned by the API. The following sections describe nested levels of this document, not separate database tables:

```text
Current Plan
├─ Plan metadata: title, effectiveStartDate, revision, ...
├─ target: goals and coordination
└─ mesocycle: cycle arrangement
   ├─ durationWeeks, schedule
   ├─ domainProgressions[]: domain timelines and phases[]
   └─ weeks[]: numbered weeks
      ├─ weekNumber, focus
      └─ sessions[]: individual Weekly Sessions
         └─ prescription: executable training content
```

#### Plan metadata

| Field | Type / public range | Meaning |
| --- | --- | --- |
| `planSchemaVersion` | `"8.0"` | Current accepted plan contract |
| `ownerId` | String | Owner; default `local-user` |
| `title`, `summary` | String | Plan title and description; summary defaults to empty string |
| `effectiveStartDate` | `YYYY-MM-DD` | Start of plan week 1 |
| `revision` | Integer | Stored plan version; writes use its expected revision |
| `updatedAt` | Timestamp string | Last plan update; also stored in the SQL row |
| `sourceAgent`, `model`, `skillVersion` | String or null | Plan-generation provenance |
| `inputSnapshotHash` | String or null | Context freshness token, not a plan revision |
| `sourceDraftId` | String or null | Athria-managed ID of the most recent formally committed draft; daily operations preserve it |

#### `target` — goals and coordination (optional)

`target` is an optional top-level object: the primary goal, supporting and maintenance goals, and coordination intent.

| Object / field | Complete fields / types | Meaning |
| --- | --- | --- |
| `primaryGoal` | `label`: string; optional nullable strings `baseline`, `testDate` | Primary goal; `testDate` is descriptive text, not the schedule's date validator |
| `supporting[]`, `maintenance[]` | `label`: string; optional `detail`: string | Supporting and maintenance goals |
| `coordinationStrategy` | Optional string | Coordination explanation |

#### `mesocycle` — cycle arrangement

| Field | Type / public range | Meaning |
| --- | --- | --- |
| `durationWeeks` | Integer, 1–52 | Actual cycle length |
| `schedule` | Training-rhythm object | Planned rhythm, checked against Profile |
| `domainProgressions` | One entry per represented session domain | Each timeline covers the full cycle without gaps/overlaps |
| `weeks` | Week objects | Complete sessions; week numbers cover 1 through duration |

#### `mesocycle.domainProgressions[]` — progression timelines

Each entry tracks one session domain across the whole cycle.

| Object / field | Complete fields / types | Meaning |
| --- | --- | --- |
| Progression | `domain`: domain ID; `phases`: phase array | Domain timeline |
| Phase | `id`, `name`: strings; `startWeek`, `endWeek`: integers; `phaseType`: enum; `focus`: string; `progression`: string array | Phase types: `foundation`, `progression`, `deload`, `peak`, `test`, `recovery` |

A phase has an ID unique within that domain, inclusive `startWeek`/`endWeek`, `phaseType`, `focus`, and written `progression`. Progression domains must exactly match resolved session domains. These timelines explain cycle-level progression; each session's prescription supplies its executable training content.

#### `mesocycle.weeks[]` — numbered weeks

Each `mesocycle.weeks[]` object contains one complete numbered week:

| Field | Type | Meaning |
| --- | --- | --- |
| `weekNumber` | Integer | Week number within the cycle |
| `focus` | String or null | Weekly training focus |
| `sessions` | Weekly Session array | Complete individual sessions for this week |

Weeks are seven-day windows from `effectiveStartDate`, not necessarily calendar Monday–Sunday. Session dates must lie within their numbered window.

#### `mesocycle.weeks[].sessions[]` — Weekly Sessions

Each `mesocycle.weeks[].sessions[]` object describes one planned training session:

| Field | Type / public range | Meaning |
| --- | --- | --- |
| `id` | String | Unique across the mesocycle |
| `name`, `intent` | String | Session label and training purpose |
| `type`, `subtype` | String or null | Activity identity; see [classification](training-taxonomy.md) |
| `scheduledDate`, `order` | Date; integer 0–50 | Position; order is unique per date within a week |
| `status` | `planned` or `skipped` | Intended state, not an actual workout record |
| `durationMinutes` | Integer, 1–240 | Session estimate; independent of Profile's target |
| `recoveryDemand` | `low`, `normal`, `high` | Spacing input; default `normal` |
| `keySession` | Boolean | Priority work for adjustment review |
| `templateRef` | Versioned reference or null | Optional provenance; never supplies missing content |
| `domain` | Single session domain | Derived from recognized type, or explicit when type is unknown |
| `prescription` | One structured prescription | Domain-specific `blocks[]`; null only for sessions without executable content |
| `progressionNote`, `schedulingRationale` | String or null | Session-specific progression and scheduling explanation |

#### `prescription` — executable training content

The owning session's `domain` selects the prescription structure. Every prescription uses `blocks[]`; it contains neither `kind` nor a duplicate `domain`. Optional fields stay absent unless supplied; nullable fields may explicitly contain null. New writes require a non-null prescription; sessions without executable content may read as null.

| Session domain | Complete prescription fields | `blocks[]` content |
| --- | --- | --- |
| `strength` | `blocks[]` | Strength exercises with sets, reps, load, classification, and rest |
| `endurance` | `blocks[]` | Steps and repeat blocks, including work/recovery steps |
| `sport_skill` | `sessionType`, `blocks[]` | Sport blocks; session type is `practice`, `match`, or `competition` |
| `mobility` | `blocks[]` | Mobility blocks |
| `mind_body` | `blocks[]` | Mind-body blocks |
| `functional` | `blocks[]` | Functional blocks |

There is no duration-only prescription format. Simple sessions still have a domain and at least the intended activity represented as a block.

#### Strength exercise fields

| Field | Type / presence | Meaning / default |
| --- | --- | --- |
| `id`, `displayName` | Strings | Exercise identity within the session and display label |
| `canonicalKey` | String or null | Canonical exercise key, if recognized |
| `classification` | Object | Classification facts below |
| `sets` | Integer | Prescribed set count |
| `repsMin`, `repsMax` | Integers | Repetition range; maximum ≥ minimum |
| `targetRpe` | Number or null | Target effort for exercise sets |
| `restSeconds` | Integer | Prescribed rest in seconds; default 90 |
| `referenceLoad` | Number or null | Reference load, rather than actual completed load |
| `referenceLoadUnit` | `kg`, `lb`, or null | Explicit reference-load unit |
| `tempo` | Optional string or null | Tempo notation |
| `alternatives` | Optional string array | Alternative exercise names |

`classification` contains six facts: `primaryMovement`, `primaryMuscles`, `secondaryMuscles`, `equipment`, `impact`, and `laterality`. Movement is a taxonomy ID or null; muscle/equipment values are taxonomy ID arrays; impact is `low`, `moderate`, `high`, or null; laterality is `bilateral`, `unilateral`, `alternating`, or null.

| Fact field | Type | Meaning |
| --- | --- | --- |
| `value` | Fact-specific value | Classification result |
| `source` | Enum | `catalog`, `structured_source`, `exact_alias`, `ai_inferred`, `user_confirmed`, or `migration` |
| `confidence` | Number | Confidence in classification |
| `evidence` | String | Supporting explanation |
| `taxonomyVersion` | String | Normalized to the current taxonomy version |
| `conflicts` | Optional array of `{source, value, evidence}` | Alternative source assertions; `value` retains the conflicting value |

#### Endurance segments

An endurance `blocks[]` entry is either a step (`type: "step"`) or a repeat (`type: "repeat"`).

**Step fields**

| Field | Type / presence | Meaning |
| --- | --- | --- |
| `type` | `"step"` | Identifies a step block |
| `name` | String | Step label |
| `role` | Enum | `warm_up`, `steady`, `work`, `recovery`, `cool_down` |
| `durationSeconds` | Optional positive integer | Target duration, seconds |
| `distanceMeters` | Optional positive number | Target distance, meters |
| `pace` | Optional string | Pace target notation |
| `heartRateZone` | Optional string: `1`–`5` or an ascending range such as `1-3` | Stored without a prefix; displayed as `Zone 2` or `Zone 1-3`; missing zone guidance remains advisory |
| `powerWatts`, `cadence` | Optional strings | Target notation, including ranges; these are not numeric actual-history metrics |
| `rpe`, `talkTest` | Optional strings | Secondary effort guidance; step RPE is text, unlike numeric session/set RPE |

**Repeat fields**

| Field | Type / presence | Meaning |
| --- | --- | --- |
| `type` | `"repeat"` | Identifies a repeat block |
| `name` | String | Repeat label |
| `repetitions` | Integer | Number of repetitions |
| `work` | Step | Repeated step, using the full step shape |
| `recovery` | Optional step | Recovery step, using the full step shape |

#### Other blocks

| Kind | Complete block fields | Meaning |
| --- | --- | --- |
| `sport_skill` | Required `name`: string, `role`: enum; optional `durationMinutes`: positive integer, `intensity`: string, `instructions`: string | Role: `preparation`, `technical`, `tactical`, `small_sided_game`, `match`, `competition`, `conditioning`, `cool_down` |
| `mobility`, `mind_body`, `functional` | Required `name`: string; optional `durationMinutes`: positive integer, `instructions`: string | Named activities with optional duration and instructions |

**Example — Session fragment:** the reference is provenance, while the session prescription supplies dose.

```json
{
  "type": "Run",
  "subtype": null,
  "templateRef": { "source": "builtin", "id": "builtin.easy-run", "catalogVersion": "example-version" },
  "domain": "endurance",
  "prescription": { "blocks": [{ "type": "step", "name": "Steady", "role": "steady", "durationSeconds": 1800, "heartRateZone": "2" }] }
}
```

The reference version is illustrative; use a version actually returned by Athria. See [prescription support](core-rules.md#prescription-support) for domain-specific structures.

### `plan_drafts` / `plan_draft_weeks` — in-progress plans

Persisted drafts support cross-conversation continuation; they are not executable plans. A header row holds metadata, and each submitted week is one row.

| Column (`plan_drafts`) | Explanation |
| --- | --- |
| `id` | Draft id; PK |
| `owner_id` | Owner |
| `data` | Draft header/mesocycle metadata without stored-plan `revision`, `updatedAt`, write-only `expectedRevision`, or `mesocycle.weeks` |
| `base_plan_revision` (INTEGER) | Plan revision the draft was based on |
| `input_snapshot_hash` | Context hash at draft creation |
| `draft_revision` (INTEGER) | Optimistic draft counter |
| `created_at`, `updated_at` | Timestamps |

| Column (`plan_draft_weeks`) | Explanation |
| --- | --- |
| `draft_id` | PK part; FK → `plan_drafts.id` with delete cascade (the schema's only declared foreign key) |
| `week_number` (INTEGER) | PK part; plan week number |
| `data` | One complete week (`weekNumber`, `focus`, `sessions[]`), using the Weekly Session shape above |

Draft row metadata is exposed as `id`, `ownerId`, `data`, `basePlanRevision`, `inputSnapshotHash`, `draftRevision`, `createdAt`, and `updatedAt`. Every stored draft is editable and uncommitted. New drafts may be incomplete; weeks are stored separately and assembled when validating or committing. A successful commit saves Current Plan with `sourceDraftId`, resets the review context, and deletes the submitted draft and its weeks in the same transaction. Discarding also deletes the draft and its weeks, with owner and revision checks. Other drafts are retained. There is no stored status, commit result, or replay record. See [draft application logic](../../crates/athria-application/src/app.rs) and [draft persistence](../../crates/athria-store/src/store.rs).

### `session_templates` — reusable structures

User-owned single-domain structures (including derived replacements of built-ins). Structure only: no sets, loads, or final dose.

**SQL columns** — queried and guarded by the app:

| Column | Explanation |
| --- | --- |
| `id` | Template id; PK |
| `owner_id` | Owner; UQ `(owner_id, id)` |
| `data` | Template JSON without `id` (below) |
| `revision` (INTEGER) | Optimistic counter; update/delete require `expectedRevision` |
| `created_at`, `updated_at` | Timestamps |

**`data` JSON (camelCase)** — the complete document returned by the API:

```text
session_templates.data
├─ name, intent: template label and purpose
├─ domain: single session domain
└─ nodes[]: structure slots for that domain
   ├─ role, optional name: node identity
   ├─ variables[], optionalVariables[]: variable slots to fill
   ├─ optional: whether the node may be dropped
   └─ strength nodes: movementPatternIds[], targetMuscleIds[], matchPolicy
```

Templates contain `id`, `name`, `intent`, one domain, and nodes. References use `{source: "builtin", id, catalogVersion}` or `{source: "user", id, revision}` and must resolve at write time. Editing a template does not rewrite sessions; customize a built-in through a local derivation, and hiding it does not delete its original definition.

#### Template fields

| Object | Complete fields / types | Storage behavior |
| --- | --- | --- |
| Template | `id`, `name`, `intent`: strings; `domain`: domain ID; `nodes[]` | User row `data` contains `name`, `intent`, `domain`, `nodes`; `id` is the SQL key |
| User read metadata | `origin: "user"`, `revision`: integer | Added from storage; SQL also retains owner and creation/update timestamps |
| Built-in read metadata | `origin: "builtin"`, `catalogVersion`: string | Catalog data, not a user template row |
| Every node | `role`: domain-specific enum; `variables`: unique variable-ID array; optional `name`: string, `optional`: boolean, `optionalVariables`: unique variable-ID array | Required and optional variables must not overlap |
| Strength node additions | Optional `movementPatternIds[]`, `targetMuscleIds[]`, `matchPolicy: "all"` | At least one nonempty movement/muscle list is required |

Domains are `strength`, `endurance`, `sport_skill`, `mobility`, `functional`, and `mind_body`. Node roles and variable vocabularies are returned by the taxonomy and defined in [template.rs](../../crates/athria-core/src/schema/template.rs); they describe slots to fill, not executable dose.

### `template_dismissals` — hidden built-ins

Built-in templates the user hid. Deleting a built-in only hides it; the code-defined original is not deleted.

| Column | Explanation |
| --- | --- |
| `owner_id` | Owner |
| `template_id` | Hidden built-in template id |
| `created_at` | Timestamp |

Unique per `(owner_id, template_id)`.

### `training_sessions` — canonical actual workouts

One row per actual workout: the canonical history assembled from source observations.

**SQL columns** — queried and guarded by the app:

| Column | Explanation |
| --- | --- |
| `id` | Canonical session id; PK |
| `owner_id` | Owner |
| `start_at` | Start timestamp; query mirror of JSON `startAt` |
| `data` | Complete session JSON (below) |

Canonical workout JSON and history responses omit singular `source`/`externalId` fields and `missingFields`, representing provenance through ordered `sources[]`. Original identities remain in `training_session_sources`.

**`data` JSON (camelCase)** — the complete document returned by the API:

```text
training_sessions.data
├─ id, ownerId: session identity and owner
├─ type, subtype, domains: normalized activity classification
├─ name, startAt, durationMinutes: actual workout facts
├─ rpe, sessionRpe: whole-session effort
├─ trainingLoad, powerLoad, hrLoad, paceLoad, intensity: source API metrics
├─ status, timezone, timePrecision: status and time evidence
├─ plannedSessionId, sources[]: plan association and provenance
├─ planMatch, isPlanMatchExcluded: plan matching, rebuilt on read
└─ strengthSets[], endurance: actual training evidence
```

Actual training has no embedded planned `prescription` — intended dose is in the plan; actual evidence is in strength sets and endurance details. Read enrichment in [sessions.rs](../../crates/athria-store/src/sessions.rs) reconstructs matches, source summaries, and exclusions from their tables.

#### History fields

| Field | Type / default | Meaning |
| --- | --- | --- |
| `id`, `ownerId` | Strings; owner defaults to `local-user` | Session identity and owner |
| `type`, `subtype` | String or null | Normalized activity classification |
| `domains` | Domain-ID array | Derived from type; at most one whole-session domain |
| `name` | String | Actual workout label |
| `startAt` | String | Start timestamp; respect `timePrecision` |
| `durationMinutes` | Integer | Actual session duration, minutes |
| `rpe` | Integer 1–10 or null | Whole-session perceived effort |
| `sessionRpe` | Nonnegative number or null | Always `rpe × durationMinutes`; null when `rpe` is null |
| `trainingLoad`, `powerLoad`, `hrLoad`, `paceLoad`, `intensity` | Nonnegative numbers or null | Source API metrics; runtime accepts supplied values only for `intervals`/`xunji`; preserve source meaning |
| `status` | `completed` | Actual-history status |
| `timezone` | String or null | Source/session timezone |
| `plannedSessionId` | String or null | Plan association field; authoritative read match comes from matching records |
| `timePrecision` | `exact` or `date_only`; default `exact` | Precision of actual time evidence |
| `sources[]` | `{source, externalId}` array | Representative base record first; individual metrics may come from other sources. Rebuilt from source rows on canonical reads |
| `planMatch` | `{plannedSessionId, method}` or null | Rebuilt from match rows; method `auto` or `manual` |
| `isPlanMatchExcluded` | Boolean; default false | Rebuilt from exclusion rows |
| `strengthSets[]` | Array; default `[]` | Actual completed strength sets |
| `endurance` | Object or null | Actual endurance summary |

Session-level `rpe` is a nullable integer 1–10, separate from strength-set RPE. `sessionRpe` is a derived nullable nonnegative number, always calculated as `rpe × durationMinutes` (null when `rpe` is null); it is never imported — parsing ignores a supplied value and manual/MCP writes reject the field. Intervals imports map only `icu_rpe` to `rpe`, treating invalid source values as missing, and each valid imported RPE replaces the current canonical value in write order; missing or invalid source RPE preserves it. Session `rpe` stores only its latest value — there is no rating history — and both API imports and manual writes can modify it.

API-only metrics `trainingLoad`, `powerLoad`, `hrLoad`, `paceLoad`, and `intensity` map to Intervals fields `icu_training_load`, `power_load`, `hr_load`, `pace_load`, and `icu_intensity`. They preserve nonnegative finite values, including zero and decimals; intensity is unscaled and may exceed 100. Missing or invalid source values become null. Manual and MCP writes reject these fields, while reads include them; canonical merging preserves available values per field, preferring Intervals.

`endAt` is neither a stored session field nor a SQLite column; a computed end time is an estimate when start precision is date-only. Preserve date-only precision; do not present an estimate as exact.

#### Actual strength sets

| Field | Type / presence | Meaning / default |
| --- | --- | --- |
| `exerciseRaw` | String | Original exercise label; default empty string |
| `exerciseKey`, `movement` | String or null | Canonical exercise and movement classification |
| `primaryMuscles[]`, `secondaryMuscles[]` | String arrays | Classified muscle IDs; default `[]` |
| `setIndex` | Integer | Set ordering; default 0 |
| `setType` | String | Source set category; default `normal` |
| `weight` | Number or null | Actual load |
| `weightUnit` | `kg`, `lb`, or null | Actual load unit |
| `reps`, `rpe` | Numbers or null | Completed repetitions and set-level perceived effort |
| `leftWeight`, `rightWeight` | Optional nullable numbers | Side-specific actual loads |
| `durationSeconds` | Optional nullable number | Actual set duration, seconds |
| `restSeconds`, `plannedRestSeconds` | Optional nullable numbers | Actual and planned rest, seconds |

Optional source set values are retained when present; the runtime parser does not infer absent side loads or rest. Public schema validation and adapter normalization remain distinct from this permissive stored-set normalization.

#### Actual endurance details

| Field | Type / default | Unit / meaning |
| --- | --- | --- |
| `distanceMeters` | Number or null | Meters |
| `averageHeartRate`, `maxHeartRate` | Numbers or null | Beats per minute |
| `averagePowerWatts`, `maxPowerWatts` | Numbers or null | Watts |
| `heartRateZoneSeconds` | Map of zone keys to numbers; default `{}` | Seconds spent in each source zone; keys retain source notation |

### `training_session_sources` — per-source observations

One row per source record, linked to its canonical workout; keeps per-source identity and prevents double counting.

| Column | Explanation |
| --- | --- |
| `id` | Observation row id; PK (separate from the canonical session id) |
| `owner_id` | Owner |
| `training_session_id` | Canonical session this observation belongs to |
| `source`, `external_id` | Importer identity; shared with `owner_id` in UQ `(owner_id, source, external_id)` |
| `local_date` | Source-local date |
| `start_at` | Observation start timestamp |
| `data` | Source observation payload |
| `created_at`, `updated_at` | Timestamps |

Canonical workouts combine observations to avoid double-counting; `sources[]` retains source identities per canonical session. Removing a manual source must not remove synchronized observations. See [matching policy](write-policy.md#matching-and-history).

## Matching and plan review

### `plan_workout_matches` — planned ↔ actual links

One-to-one links between a Weekly Session and the actual workout that fulfilled it.

| Column | Explanation |
| --- | --- |
| `id` | PK |
| `owner_id` | Owner; UQ `(owner_id, planned_session_id)` and `(owner_id, training_session_id)` |
| `planned_session_id` | Weekly Session id |
| `training_session_id` | Canonical session id |
| `method` | `auto` or `manual` |
| `confidence` (INTEGER) | Stored as a rounded integer |
| `algorithm_version` | Matcher version |
| `evidence` | JSON supplied by the matching operation, not a fixed workout schema |
| `matched_at` | Timestamp |

See [matching policy](write-policy.md#matching-and-history).

### `workout_plan_exclusions` — intentional unplanned decisions

Actual workouts excluded from plan matching.

| Column | Explanation |
| --- | --- |
| `owner_id` | Owner |
| `training_session_id` | Canonical session id |
| `created_at` | Timestamp |

Unique per `(owner_id, training_session_id)`.

### `planned_session_events` — action audit trail

Audit rows for planned-session actions; they are not a separate prescription store.

| Column | Explanation |
| --- | --- |
| `id` | PK |
| `owner_id` | Owner |
| `planned_session_id` | Weekly Session id |
| `action` | `complete`, `skip`, `restore`, or `move_occurrence` |
| `from_date`?, `to_date`? | Move context, when applicable |
| `reason_code`? | `schedule`, `recovery`, `health`, `travel`, `equipment_weather`, `preference`, or `other` |
| `reason_note`? | Free-text reason |
| `revision_before`, `revision_after` (INTEGER) | Plan revisions around the action |
| `created_at` | Timestamp |

### `plan_review_context` — adjustment baseline

One row per athlete: the committed-plan baseline plus net Profile changes since, used by plan-adjustment reviews.

**SQL columns** — queried and guarded by the app:

| Column | Explanation |
| --- | --- |
| `owner_id` | Owner; PK |
| `data` | Context JSON (below) |

**`data` JSON (camelCase)** — the complete document returned by the API:

```text
plan_review_context.data
├─ committedAt, committedPlanRevision: last confirmed plan commit
├─ trackingStartedAt, trackingComplete: change-tracking state
└─ profileChanges[]: net Profile changes since baseline
   ├─ field, before, after: what changed
   └─ firstChangedAt, lastChangedAt: first and most recent change
```

#### Review-context JSON

| Field | Type | Meaning |
| --- | --- | --- |
| `committedAt` | Timestamp or null | Last confirmed plan commit; null if none |
| `committedPlanRevision` | Integer or null | Confirmed revision |
| `trackingStartedAt` | Timestamp | Start of tracked changes |
| `trackingComplete` | Boolean | Whether tracking started from a confirmed commit |
| `profileChanges[]` | Array | Net changes since baseline; reverting to baseline removes the entry |
| Change `field` | String | Profile field name |
| Change `before`, `after` | Field-specific JSON values | Baseline and current values |
| Change `firstChangedAt`, `lastChangedAt` | Timestamps | First and most recent change |

Tracked Profile fields are `goals`, `preference`, `usualSessionMinutes`, `trainingRhythm`, `equipment`, `injuries`, `constraintNotes`, `explicitRecoveryDays`, `mesocycleDurationWeeks`, and `raceDays`. A confirmed plan commit resets this context; writes bump the data-version counter. See [review_context.rs](../../crates/athria-store/src/review_context.rs).

### Planned occurrences (read model)

Current occurrences are read projections, not separately persisted prescription snapshots. [planned.rs](../../crates/athria-store/src/planned.rs) combines Weekly Sessions in `current_mesocycles.data` with plan matches and actual workouts. The prescription is the owning Weekly Session's prescription. Phase references match the single session domain and resolve against progression timelines. Resolved session content is protected by plan-write policy.

The projection reuses the Weekly Session fields and adds:

| Field | Type | Derivation |
| --- | --- | --- |
| `occurrenceId` | String | `plan:<scheduledDate>`; sessions on the same date share this day identity |
| `ownerId`, `planRevision` | String; integer | Plan owner and revision |
| `weekNumber` | Integer | Containing plan week |
| `phaseRefs[]` | `{domain, phaseId}` | Progression phase covering this week |
| `status` | `planned`, `completed`, `skipped` | Stored planned/skipped state plus matching |
| `displayState` | `scheduled`, `completed`, `unrecorded`, `skipped` | Unmatched past scheduled dates display as unrecorded; this is not a stored session status |
| `completedTrainingSessionId` | String or null | Matched actual workout ID |
| `completedAt` | Timestamp string or null | Derived from actual `startAt + durationMinutes`; does not add precision to date-only records |
| `completionSource` | `manual`, `import`, or null | Import if any matched workout source is non-manual |
| `match` | `{plannedSessionId, method}` or null | `method`: `auto` or `manual` |
| `createdAt`, `updatedAt` | Timestamp strings | Both currently use plan `updatedAt`, not independent occurrence timestamps |
| `exerciseOverrides`, `notes`, `overrideReason` | Array; string; string or null | Current projection returns `[]`, `""`, null; not independently stored overrides |

Planned-session `status` is overridden to `completed` when a matched actual workout exists.

## Integrations and imports

The store accepts producer-owned JSON here; diagnostics can evolve with adapters and should not be treated as a fixed public training schema. Integration config, credential payloads, sync errors, and imported diagnostics are source-specific JSON, not training-prescription fields.

### `connection_secrets` — encrypted secrets

One encrypted envelope per source; API keys are never stored outside it.

| Column | Explanation |
| --- | --- |
| `source` | Integration id; PK |
| `config` | Non-secret JSON config: Intervals has `athleteId` (string); Xunji starts with `{}`. Both support `dailyAutoSync` (boolean, default true when absent) |
| `cipher_version` (INTEGER) | Envelope version |
| `nonce`, `ciphertext` | Encrypted secret material |
| `updated_at` | Timestamp |

See [vault](../../crates/athria-vault/src/lib.rs), [connection handlers](../../apps/desktop/src-tauri/src/lib.rs), and [daily sync](../../apps/desktop/src-tauri/src/daily_sync.rs).

### `connection_sync_state` — latest sync metadata

**SQL columns** — queried and guarded by the app:

| Column | Explanation |
| --- | --- |
| `owner_id` | Owner; UQ `(owner_id, source)` |
| `source` | Integration id |
| `last_attempt_at`, `last_success_at`? | Attempt and success timestamps |
| `range_start`, `range_end` | Synced range |
| `status` | Sync status |
| `data` | Source-specific results (below) |

Reads map the columns to `ownerId`, `source`, `lastAttemptAt`, `lastSuccessAt`, `rangeStart`, `rangeEnd`, `status`, and `data`.

**`data` JSON (camelCase)** — source-specific results:

| Source `data` payload | Current producer fields |
| --- | --- |
| Intervals | `activities: {added, updated}`, `wellnessCount`, `errors`; optional `errorRanges`, `failedDates[]: {date, failures}`, `undatedFailures` |
| Xunji | `successfulDays`, `failedDays`, `records`, `normalizationFailures`, `errors`; early failure uses day counts and error entries without all success-path fields |

### `daily_sync_attempts` — daily sync gate

At most one automatic attempt per owner, source, and local date, independently of sync success.

| Column | Explanation |
| --- | --- |
| `owner_id` | Owner; PK part |
| `source` | Integration id; PK part |
| `local_date` | Local date; PK part |
| `attempted_at` | Attempt timestamp |

### `import_batches` — file imports

Imported file batches (for example Hevy) with parser diagnostics.

**SQL columns** — queried and guarded by the app:

| Column | Explanation |
| --- | --- |
| `id` | PK |
| `owner_id` | Owner; UQ `(owner_id, source, content_hash)` |
| `source` | Import source |
| `content_hash` | Prevents duplicate source imports; not a workout identity |
| `file_name` | Imported file name |
| `parser_version` | Parser identifier |
| `status` | Import status |
| `data` | Parser diagnostics (below) |
| `created_at` | Timestamp |

Reads use `id`, `ownerId`, `source`, `contentHash`, `fileName`, `parserVersion`, `status`, `data`, and `createdAt`.

**`data` JSON (camelCase)** — parser diagnostics:

| Import `data` payload | Current producer fields |
| --- | --- |
| File-import (Hevy) | `counts: {rows, sessions, sets, validRows, invalidRows}` (integers), `errors[]: {line, message}`, `unknownColumns[]` (strings) from the parser preview |
| Xunji | `added`, `updated`, `sync` (the saved sync-state object) |

## Database and vault metadata

### `vault_meta` — vault format and key wrapping

| Column | Explanation |
| --- | --- |
| `id` (INTEGER) | PK; constrained to 1 |
| `database_uuid` | Unique database identity |
| `format_version` (INTEGER) | Vault format version |
| `kdf_algorithm`, `kdf_memory_kib` (INTEGER), `kdf_iterations` (INTEGER), `kdf_parallelism` (INTEGER), `salt`? | Key-derivation parameters |
| `wrap_nonce`?, `wrapped_master_key`? | Encrypted master key |
| `check_nonce`?, `check_ciphertext`? | Passphrase check value |
| `updated_at` | Timestamp |

Single row: vault format and key-wrapping metadata for the encrypted connection secrets.

### `athria_migrations` — schema bookkeeping

Applied schema versions.

| Column | Explanation |
| --- | --- |
| `version` (INTEGER) | Applied version; PK |
| `applied_at` | Timestamp |

Writable opens accept only schema 41; automatic database upgrades are not supported. Read-only opens require schema 41. Other versions are rejected without conversion.

### `athria_data_version` — change counter

Monotonic counter used to detect data changes cheaply.

| Column | Explanation |
| --- | --- |
| `id` (INTEGER) | PK; constrained to 1 |
| `version` (INTEGER) | Current data version |

Insert/update/delete on 18 of the 21 tables — all except `athria_migrations`, `athria_data_version`, and `daily_sync_attempts` — bumps this counter through 54 SQL triggers.

Definitions: [public schemas](../../schemas/v8), [runtime parsers](../../crates/athria-core/src/schema), and [application services](../../crates/athria-application/src/app.rs); implementation details remain authoritative in the linked sources.

Schema 41 creates the current structure directly. The version table contains only the current schema version; no historical data migrations run. The template list uses `(owner_id, updated_at DESC)` and source history uses `(owner_id, source, start_at)`. Template content is described by `session-template.json`; full user and built-in read responses use `session-template-read.json`. Profile writes enforce the numeric ranges and fixed-week day constraints in `athlete-profile.json`; historical reads remain permissive, and updating an invalid legacy profile requires correcting its invalid values.

Sleep dates use the evening date: sleep from D to D+1 is stored on D for manual/API entries. ICU sleep fields (`sleepSeconds`, `sleepScore`, `avgSleepingHeartRateBpm`) are converted from the source wake date to the previous evening at import; all other fields keep their source date. UI charts and highlights use stored dates directly.

Sleep dates are stored using the current evening-date convention. Database opens do not shift dates or convert historical data.
