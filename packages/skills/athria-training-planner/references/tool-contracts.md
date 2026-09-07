# Athria tool contracts

## Draft lifecycle

`get_training_state` returns the `inputSnapshotHash` required by `save_plan_draft`. A draft contains:

- `id` and `clientRequestId`: unique strings; reuse `clientRequestId` only when retrying the same logical save.
- `title`, `summary`, a complete `mesocycle`, and one or more expanded dated sessions.
- `inputSnapshotHash`: copied unchanged from the state used to plan.
- ISO-8601 `createdAt` and `updatedAt` with an explicit timezone offset.
- nullable `sourceAgent`, `model`, and `skillVersion` provenance.

The mesocycle includes `durationWeeks`, exactly seven unique `weeklyStructure` day entries, labeled `sessionTemplates`, contiguous `phases` covering the complete duration, and structured `adjustmentRules` with a trigger, action, and rationale. Weekly rest days use a null `templateId`.

Each plan session needs an ID, name, modality, intent, timezone-aware start, duration, hard-session flag, matching `templateId` and `phaseId`, notes, and exercises. Each strength exercise uses a catalog `exerciseKey`, sets, a rep range, optional target RPE, rest time, and optional display notes. Do not supply a load unless history or the user provides it.

Athlete profile `trainingDays` values use Monday = 0 through Sunday = 6 and constrain days only, never times. An empty list means flexible days. Recovery hours, constraints, and excluded exercises are Agent-managed facts and must be changed through a profile proposal; `availability` time windows and profile-level maximum heart rate are not supported.

`save_plan_draft` never creates a formal plan. Athria revalidates both the mesocycle structure and its expanded sessions, stores them idempotently, and returns the validation. The user approves a valid draft in the Dashboard, which creates a new immutable version.

## Validation

- `hard`: a failed result blocks formal approval. Fix it or explain the contradictory constraint.
- `soft`: advisory training-science guidance. Discuss it; do not claim it is an objective prohibition.
- `info`: evidence, method limitations, or a data gap.

Use `reasonCode`, `ruleVersion`, `messageArgs`, and `evidence` instead of pattern-matching natural-language messages.

## Deterministic calculations

- `estimate_1rm` accepts an explicit load, `kg` or `lb`, and 1–12 repetitions. The output is an estimate, not a measured maximum.
- `calculate_heart_rate_zones` requires an explicit maximum heart rate. Never derive it from age.
- Progression and RPE tools return a proposal only; they do not modify a plan or session.
- Strength volume, endurance duration/distance/pace, and heart-rate zones remain separate metrics.
