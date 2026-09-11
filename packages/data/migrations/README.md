# SQLite migrations

Migrations are append-only and versioned. `0001_initial.sql` is embedded in the Bun standalone executable by `packages/data/src/index.ts` so an installed application does not depend on loose SQL files.

When adding a migration, update the embedded ordered migration list and add an empty-database plus upgrade-path test. Never edit a migration that has shipped.

Migration `0005_template_library_current_mesocycle.sql` is an append-only marker and schema contract. Its data extraction is implemented transactionally in `AthriaRepository.migratePlanSchemaV4()` because it must parse each user's latest legacy plan JSON, deduplicate templates, preserve activation dates, and convert planned-session snapshots before dropping the legacy plan tables.

Migration `0008_schema_v7_planning_reset.sql` is implemented by `migratePlanningSchemaV7Reset()`. It backs up incompatible planning JSON, clears only planning state, and preserves profiles, preferences, completed training data, imports, and wellness.

Migration `0009_domain_progression_v7_reset.sql` is implemented by `migrateDomainProgressionV7Reset()`. It repeats that backup-and-clear operation only for current plans, planned sessions, and their change history after the v7 domain progression contract changed; profiles, templates, and training history remain intact.
