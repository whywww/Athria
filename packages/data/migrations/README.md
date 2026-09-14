# SQLite migrations

Migrations are append-only and versioned. `0001_initial.sql` is embedded in the Bun standalone executable by `packages/data/src/index.ts` so an installed application does not depend on loose SQL files.

When adding a migration, update the embedded ordered migration list and add an empty-database plus upgrade-path test. Never edit a migration that has shipped.

Migration `0005_template_library_current_mesocycle.sql` is an append-only marker and schema contract. Its data extraction is implemented transactionally in `AthriaRepository.migratePlanSchemaV4()` because it must parse each user's latest legacy plan JSON, deduplicate templates, preserve activation dates, and convert planned-session snapshots before dropping the legacy plan tables.

Migration `0008_schema_v7_planning_reset.sql` is implemented by `migratePlanningSchemaV7Reset()`. It backs up incompatible planning JSON, clears only planning state, and preserves profiles, preferences, completed training data, imports, and wellness.

Migration `0009_domain_progression_v7_reset.sql` is implemented by `migrateDomainProgressionV7Reset()`. It repeats that backup-and-clear operation only for current plans, planned sessions, and their change history after the v7 domain progression contract changed; profiles, templates, and training history remain intact.

Migration `0012_simplified_storage.sql` is implemented transactionally by `migrateSimplifiedStorageV12()`. It merges the latest legacy scheduling state into the sole Current Plan, migrates profile preferences and recognizable wellness fields, links completed training records to their planned sessions, and then drops the obsolete catalog, preference, proposal, approval, raw-record, planning-history, and migration-backup tables.

Migration `0017_personal_information.sql` is implemented by `migratePersonalInformationV17()`. It renames Profile `displayName` to `preferredName` and initializes optional gender, height, and birth-date fields. Version 17 is used because version 16 already updates the equipment taxonomy.

Migration 16 is implemented transactionally by `migrateEquipmentCatalogV16()`. It maps legacy bands and suspension trainers to the replacement equipment IDs and removes retired equipment IDs from profiles and current-plan classification facts.

Migration `0018_workout_reconciliation.sql` is implemented by `migrateWorkoutReconciliationV18()`. It preserves current training data as provider observations, creates canonical workout and strict plan-match storage, and removes only clearly superseded zero-detail same-source placeholders.

Migration `0019_plan_reconciliation_ux.sql` is implemented by `migratePlanReconciliationUxV19()`. It adds plan action events and explicit workout-to-plan exclusions, and narrowly marks legacy manual completion placeholders as date-only.

Migration `0020_training_session_type_overrides.sql` is implemented by `migrateTrainingSessionTypeOverridesV20()`. It stores one user-selected domain per canonical workout without mutating or being overwritten by provider observations.
