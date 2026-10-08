# Training Classification

Athria separates activity identity from training domain. Use `type` to identify the activity, `subtype` to retain a source variant, and `domains` to group its training role.

## Classification fields

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | String or null | Standard activity type when recognized; otherwise the original source value |
| `subtype` | String or null | Normalized source variant; does not independently determine matching eligibility |
| `domains` | Domain ID array | History classification derived from type: one domain when recognized, otherwise empty |

Two activities in `endurance` are not necessarily the same activity. `Run` and `Ride` remain different types. Subtype does not make two recognized, equal types ineligible for matching; dates, time, and other evidence still matter.

Automatic plan matching requires the same recognized type on both sides. An unknown type does not become eligible merely because its text or broad domain resembles a planned activity. Source deduplication is a separate operation with its own evidence checks.

## Type-to-domain mapping

| Domain | Standard types |
| --- | --- |
| `strength` | `StrengthTraining` |
| `endurance` | `Swim`, `Run`, `Ride`, `Rowing`, `Hike`, `Walk` |
| `sport_skill` | `Tennis`, `TableTennis`, `Badminton`, `Padel`, `Pickleball`, `Squash`, `Racquetball`, `Basketball` |
| `mind_body` | `Yoga`, `Pilates` |
| `mobility` | `Mobility` |
| `functional` | `FunctionalTraining` |

`recovery` is a source alias for `Mobility`, not a seventh domain. It is distinct from `recoveryDemand` (a session's recovery demand) and `explicitRecoveryDays` (spacing guidance).

Authority: [training_type.rs](../../crates/athria-core/src/training_type.rs) and [domain IDs](../../crates/athria-core/src/vocab.rs).

## Source normalization

Classification compares lowercase ASCII alphanumeric tokens. Case, spaces, hyphens, and punctuation do not distinguish aliases.

| Source type | Stored type | Derived subtype | Domain |
| --- | --- | --- | --- |
| `WeightTraining` | `StrengthTraining` | null | `strength` |
| `TrailRun` | `Run` | `trailrun` | `endurance` |
| `VirtualRide` | `Ride` | `virtualride` | `endurance` |
| `OpenWaterSwim` | `Swim` | `openwaterswim` | `endurance` |
| `HIIT` or `HighIntensityIntervalTraining` | `FunctionalTraining` | `hiit` | `functional` |
| `Recovery` | `Mobility` | `recovery` | `mobility` |
| `UnlistedActivity` | `UnlistedActivity` | null | No domain |

Standard types produce no derived subtype. Plain synonyms `weighttraining`, `running`, `cycling`, `hiking`, and `walking` also produce null. Other recognized variants retain their token, except `highintensityintervaltraining`, which derives `hiit`.

A nonblank explicit subtype takes precedence over the derived subtype and uses the same token normalization. Null or blank permits alias derivation; null does not mean the activity type is unknown. An explicit subtype does not change domain.

**Example — History classification fragment:** explicit subtype wins.

```json
{
  "input": { "type": "TrailRun", "subtype": "Mountain Trail" },
  "normalized": { "type": "Run", "subtype": "mountaintrail", "domains": ["endurance"] }
}
```

**Example — Unknown-type fragment:** supplied domains cannot override classification.

```json
{
  "input": { "type": "UnlistedActivity", "domains": ["strength"] },
  "normalized": { "type": "UnlistedActivity", "subtype": null, "domains": [] }
}
```

## Model-specific behavior

| Model | Behavior |
| --- | --- |
| Training History | Nonblank type takes priority over legacy `sport`. The parser normalizes type/subtype and recomputes domains |
| Weekly Session / next-day prescription | Normalizes type/subtype aliases and resolves one scalar session domain from type, or an explicit domain when type is unknown. Components have no domain |
| Stored Planned Session | Retains type/subtype and the scalar domain from the occurrence snapshot. Phase references use only that domain |
| Session Template | One explicit domain, without a type/subtype pair. Nodes describe structure, not executable dose |

Both plan sessions and History records have at most one whole-session domain. A functional session can contain strength and endurance prescriptions without classifying its components separately. Unknown activity types on planned sessions may retain an explicitly supplied domain; History continues to derive classification from activity type.

Template nodes use domain-specific roles/variables. Functional templates currently use endurance-style roles/variables; mobility uses down-regulation, mobility, and easy-movement roles. This does not establish a functional scientific rule pack.

**Current schema limitation:** `schemas/v7/session-template.json` still describes the older recovery-based domain set. The runtime template parser accepts the six domains above. For mobility/functional templates, consult the [runtime parser](../../crates/athria-core/src/schema/template.rs) and the live tool contract; the standalone template schema is not yet aligned.

## Exercise facts

Activity identity is separate from exercise classification. Athria has no closed exercise catalog; planned strength exercises carry their own facts.

| Fact | Meaning |
| --- | --- |
| `primaryMovement` | Main mechanical pattern |
| `primaryMuscles` | Direct muscle participation |
| `secondaryMuscles` | Indirect participation, not equivalent to direct sets |
| `equipment` | Equipment alternatives for the exercise |

Facts contain `value`, `source`, `confidence` (0–1), `evidence`, `taxonomyVersion`, and optional `conflicts`. Public sources are `structured_source`, `exact_alias`, `ai_inferred`, and `user_confirmed`; internal contracts also allow `catalog` and `migration`.

For a hard check, a value must be present. Conflicts prevent trust unless the source is user-confirmed. AI inference additionally requires nonempty evidence and confidence ≥0.9 in the current contract. Equipment and primary-muscle lists must be nonempty to count as resolved. Read the current threshold/version from taxonomy rather than maintaining a client copy.

Use taxonomy IDs, not translated labels. A familiar exercise name alone cannot clear a blocker. See [Core rules](core-rules.md).

## Legacy data

The [v30 migration](../../crates/athria-store/src/migration_v30.rs) converts recovery domains/prescriptions to mobility and normalizes actual records. Legacy plan types come from matched actual records when available, otherwise from explicit name aliases. Ambiguous or unrecognized names remain unclassified; do not infer from broad domain alone.

Migration preserves workout identities and increments affected plan/template/draft revisions. Refresh guards after migration. Runtime parsing is not a general free-text name classifier.
