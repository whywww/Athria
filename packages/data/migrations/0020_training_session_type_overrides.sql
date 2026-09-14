-- Executed transactionally by AthriaRepository.migrateTrainingSessionTypeOverridesV20.
-- Stores user-selected canonical workout domains without mutating provider observations.
INSERT INTO athria_migrations(version, applied_at) VALUES (20, CURRENT_TIMESTAMP);
