-- Executed transactionally by AthriaRepository.migrateSimplifiedStorageV12.
-- Merges the latest plan/profile/wellness state before permanently removing
-- duplicate, historical, proposal, approval, raw-record and catalog tables.
INSERT INTO athria_migrations(version, applied_at) VALUES (12, CURRENT_TIMESTAMP);
