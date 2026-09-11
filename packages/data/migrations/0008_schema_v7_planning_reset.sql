-- The executable performs this migration transactionally in
-- AthriaRepository.migratePlanningSchemaV7Reset so it can back up JSON from
-- whichever legacy planning tables are present before clearing incompatible
-- Template and Current Mesocycle records.
--
-- Preserved: profile, preferences, completed sessions, imports and wellness.
-- Cleared after backup: templates, current mesocycle and planned-session state.
INSERT OR IGNORE INTO athria_migrations(version, applied_at) VALUES (8, CURRENT_TIMESTAMP);
