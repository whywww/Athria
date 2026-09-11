-- Executed transactionally by AthriaRepository.migratePersonalInformationV17
-- because Profile JSON must be parsed and displayName renamed to preferredName.
INSERT INTO athria_migrations(version, applied_at) VALUES (17, CURRENT_TIMESTAMP);
