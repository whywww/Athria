-- Executed transactionally by AthriaRepository.migrateWorkoutReconciliationV18.
-- Splits provider observations from canonical workouts and moves plan completion
-- links into a strict one-to-one relation.
INSERT INTO athria_migrations(version, applied_at) VALUES (18, CURRENT_TIMESTAMP);
