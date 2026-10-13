CREATE TABLE athria_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE connection_credentials (owner_id TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL, exported_at TEXT NOT NULL);

CREATE TABLE connection_secrets (
          source TEXT PRIMARY KEY,
          config TEXT NOT NULL,
          cipher_version INTEGER NOT NULL,
          nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

CREATE TABLE connection_sync_state (owner_id TEXT NOT NULL, source TEXT NOT NULL, last_attempt_at TEXT NOT NULL, last_success_at TEXT, range_start TEXT NOT NULL, range_end TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);

CREATE TABLE current_mesocycles (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE plan_drafts (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, data TEXT NOT NULL,
          base_plan_revision INTEGER NOT NULL, input_snapshot_hash TEXT NOT NULL,
          draft_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );

CREATE TABLE plan_draft_weeks (
          draft_id TEXT NOT NULL, week_number INTEGER NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(draft_id, week_number),
          FOREIGN KEY(draft_id) REFERENCES plan_drafts(id) ON DELETE CASCADE
        );

CREATE TABLE import_batches (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL, content_hash TEXT NOT NULL, file_name TEXT NOT NULL, parser_version TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE plan_workout_matches (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, planned_session_id TEXT NOT NULL,
          training_session_id TEXT NOT NULL, method TEXT NOT NULL, confidence INTEGER NOT NULL,
          algorithm_version TEXT NOT NULL, evidence TEXT NOT NULL, matched_at TEXT NOT NULL
        );

CREATE TABLE planned_session_events (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, planned_session_id TEXT NOT NULL,
          action TEXT NOT NULL, from_date TEXT, to_date TEXT, reason_code TEXT, reason_note TEXT,
          revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL, created_at TEXT NOT NULL
        );

CREATE TABLE profiles (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE session_templates (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE template_dismissals (
          owner_id TEXT NOT NULL, template_id TEXT NOT NULL, created_at TEXT NOT NULL
        );

CREATE TABLE training_session_sources (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, training_session_id TEXT NOT NULL,
          source TEXT NOT NULL, external_id TEXT NOT NULL, local_date TEXT NOT NULL,
          start_at TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );

CREATE TABLE training_session_type_overrides (
          owner_id TEXT NOT NULL, training_session_id TEXT NOT NULL,
          domain TEXT NOT NULL CHECK(domain IN ('strength','endurance','sport_skill','mind_body','recovery')),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(owner_id, training_session_id)
        );

CREATE TABLE training_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, modality TEXT NOT NULL, start_at TEXT NOT NULL, data TEXT NOT NULL);

CREATE TABLE vault_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          database_uuid TEXT NOT NULL UNIQUE,
          format_version INTEGER NOT NULL,
          kdf_algorithm TEXT,
          kdf_memory_kib INTEGER,
          kdf_iterations INTEGER,
          kdf_parallelism INTEGER,
          salt TEXT,
          wrap_nonce TEXT,
          wrapped_master_key TEXT,
          check_nonce TEXT,
          check_ciphertext TEXT,
          updated_at TEXT NOT NULL
        );

CREATE TABLE wellness (owner_id TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE workout_plan_exclusions (
          owner_id TEXT NOT NULL, training_session_id TEXT NOT NULL, created_at TEXT NOT NULL
        );

CREATE UNIQUE INDEX connection_credentials_owner_source ON connection_credentials(owner_id, source);

CREATE UNIQUE INDEX connection_sync_owner_source ON connection_sync_state(owner_id, source);

CREATE UNIQUE INDEX imports_owner_source_hash ON import_batches(owner_id, source, content_hash);

CREATE UNIQUE INDEX plan_matches_owner_plan ON plan_workout_matches(owner_id,planned_session_id);

CREATE UNIQUE INDEX plan_matches_owner_workout ON plan_workout_matches(owner_id,training_session_id);

CREATE INDEX planned_session_events_owner_session ON planned_session_events(owner_id,planned_session_id);

CREATE INDEX plan_drafts_owner_updated ON plan_drafts(owner_id, updated_at DESC);

CREATE INDEX session_sources_canonical ON training_session_sources(training_session_id);

CREATE INDEX session_sources_owner_date ON training_session_sources(owner_id,local_date);

CREATE UNIQUE INDEX session_sources_owner_source_external ON training_session_sources(owner_id,source,external_id);

CREATE UNIQUE INDEX sessions_owner_source_external ON training_sessions(owner_id, source, external_id);

CREATE INDEX sessions_owner_start ON training_sessions(owner_id, start_at);

CREATE UNIQUE INDEX template_dismissals_owner_template ON template_dismissals(owner_id, template_id);

CREATE UNIQUE INDEX templates_owner_id ON session_templates(owner_id, id);

CREATE INDEX training_session_type_overrides_owner ON training_session_type_overrides(owner_id);

CREATE UNIQUE INDEX wellness_owner_day_v12 ON wellness(owner_id, day);

CREATE UNIQUE INDEX workout_plan_exclusions_owner_workout ON workout_plan_exclusions(owner_id,training_session_id);


CREATE TABLE athria_data_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT INTO athria_data_version VALUES (1, 0);
CREATE TABLE training_memory (owner_id TEXT PRIMARY KEY, content_markdown TEXT NOT NULL CHECK(length(content_markdown) BETWEEN 1 AND 2000), revision INTEGER NOT NULL CHECK(revision >= 1), updated_at TEXT NOT NULL);
CREATE TRIGGER athria_version_training_memory_INSERT AFTER INSERT ON training_memory BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_training_memory_UPDATE AFTER UPDATE ON training_memory BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_training_memory_DELETE AFTER DELETE ON training_memory BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
INSERT INTO athria_migrations(version, applied_at) VALUES (27, CURRENT_TIMESTAMP);

UPDATE profiles
SET data = json_remove(
    CASE WHEN json_type(data, '$.usualSessionMinutes') IS NULL
         THEN json_set(data, '$.usualSessionMinutes', json_extract(data, '$.maxSessionMinutes'))
         ELSE data END,
    '$.maxSessionMinutes')
WHERE json_type(data, '$.maxSessionMinutes') IS NOT NULL;
INSERT INTO athria_migrations(version, applied_at) VALUES (28, CURRENT_TIMESTAMP);

CREATE TABLE daily_sync_attempts (owner_id TEXT NOT NULL, source TEXT NOT NULL, local_date TEXT NOT NULL, attempted_at TEXT NOT NULL, PRIMARY KEY(owner_id, source, local_date));
INSERT INTO athria_migrations(version, applied_at) VALUES (29, CURRENT_TIMESTAMP);

ALTER TABLE training_sessions DROP COLUMN modality;
DROP TABLE training_session_type_overrides;
INSERT INTO athria_migrations(version, applied_at) VALUES (30, CURRENT_TIMESTAMP);
CREATE TABLE plan_review_context (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL);
INSERT INTO athria_migrations VALUES (1, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (2, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (3, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (4, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (5, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (6, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (7, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (8, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (9, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (10, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (11, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (12, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (13, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (14, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (15, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (16, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (17, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (18, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (19, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (20, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (21, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (22, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (23, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (24, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (25, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (26, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (31, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (32, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (33, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (34, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (35, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (36, '2026-10-01 12:34:56');
INSERT INTO athria_migrations VALUES (37, '2026-10-01 12:34:56');
CREATE TRIGGER athria_version_connection_credentials_INSERT AFTER INSERT ON connection_credentials BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_connection_credentials_UPDATE AFTER UPDATE ON connection_credentials BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_connection_credentials_DELETE AFTER DELETE ON connection_credentials BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_connection_secrets_INSERT AFTER INSERT ON connection_secrets BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_connection_secrets_UPDATE AFTER UPDATE ON connection_secrets BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_connection_secrets_DELETE AFTER DELETE ON connection_secrets BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_connection_sync_state_INSERT AFTER INSERT ON connection_sync_state BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_connection_sync_state_UPDATE AFTER UPDATE ON connection_sync_state BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_connection_sync_state_DELETE AFTER DELETE ON connection_sync_state BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_current_mesocycles_INSERT AFTER INSERT ON current_mesocycles BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_current_mesocycles_UPDATE AFTER UPDATE ON current_mesocycles BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_current_mesocycles_DELETE AFTER DELETE ON current_mesocycles BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_drafts_INSERT AFTER INSERT ON plan_drafts BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_drafts_UPDATE AFTER UPDATE ON plan_drafts BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_drafts_DELETE AFTER DELETE ON plan_drafts BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_draft_weeks_INSERT AFTER INSERT ON plan_draft_weeks BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_draft_weeks_UPDATE AFTER UPDATE ON plan_draft_weeks BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_draft_weeks_DELETE AFTER DELETE ON plan_draft_weeks BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_import_batches_INSERT AFTER INSERT ON import_batches BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_import_batches_UPDATE AFTER UPDATE ON import_batches BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_import_batches_DELETE AFTER DELETE ON import_batches BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_workout_matches_INSERT AFTER INSERT ON plan_workout_matches BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_workout_matches_UPDATE AFTER UPDATE ON plan_workout_matches BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_workout_matches_DELETE AFTER DELETE ON plan_workout_matches BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_planned_session_events_INSERT AFTER INSERT ON planned_session_events BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_planned_session_events_UPDATE AFTER UPDATE ON planned_session_events BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_planned_session_events_DELETE AFTER DELETE ON planned_session_events BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_profiles_INSERT AFTER INSERT ON profiles BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_profiles_UPDATE AFTER UPDATE ON profiles BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_profiles_DELETE AFTER DELETE ON profiles BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_session_templates_INSERT AFTER INSERT ON session_templates BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_session_templates_UPDATE AFTER UPDATE ON session_templates BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_session_templates_DELETE AFTER DELETE ON session_templates BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_template_dismissals_INSERT AFTER INSERT ON template_dismissals BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_template_dismissals_UPDATE AFTER UPDATE ON template_dismissals BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_template_dismissals_DELETE AFTER DELETE ON template_dismissals BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_training_session_sources_INSERT AFTER INSERT ON training_session_sources BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_training_session_sources_UPDATE AFTER UPDATE ON training_session_sources BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_training_session_sources_DELETE AFTER DELETE ON training_session_sources BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_training_sessions_INSERT AFTER INSERT ON training_sessions BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_training_sessions_UPDATE AFTER UPDATE ON training_sessions BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_training_sessions_DELETE AFTER DELETE ON training_sessions BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_vault_meta_INSERT AFTER INSERT ON vault_meta BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_vault_meta_UPDATE AFTER UPDATE ON vault_meta BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_vault_meta_DELETE AFTER DELETE ON vault_meta BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_wellness_INSERT AFTER INSERT ON wellness BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_wellness_UPDATE AFTER UPDATE ON wellness BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_wellness_DELETE AFTER DELETE ON wellness BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_workout_plan_exclusions_INSERT AFTER INSERT ON workout_plan_exclusions BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_workout_plan_exclusions_UPDATE AFTER UPDATE ON workout_plan_exclusions BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_workout_plan_exclusions_DELETE AFTER DELETE ON workout_plan_exclusions BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_review_context_INSERT AFTER INSERT ON plan_review_context BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_review_context_UPDATE AFTER UPDATE ON plan_review_context BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
CREATE TRIGGER athria_version_plan_review_context_DELETE AFTER DELETE ON plan_review_context BEGIN UPDATE athria_data_version SET version=version+1 WHERE id=1; END;
