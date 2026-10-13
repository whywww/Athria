CREATE TABLE athria_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE connection_secrets (
          source TEXT PRIMARY KEY,
          config TEXT NOT NULL,
          cipher_version INTEGER NOT NULL,
          nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

CREATE TABLE connection_sync_state (owner_id TEXT NOT NULL, source TEXT NOT NULL, last_attempt_at TEXT NOT NULL, last_success_at TEXT, range_start TEXT NOT NULL, range_end TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);

CREATE TABLE current_mesocycles (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL);

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

CREATE TABLE training_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, start_at TEXT NOT NULL, data TEXT NOT NULL);

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


CREATE UNIQUE INDEX connection_sync_owner_source ON connection_sync_state(owner_id, source);

CREATE UNIQUE INDEX imports_owner_source_hash ON import_batches(owner_id, source, content_hash);

CREATE UNIQUE INDEX plan_matches_owner_plan ON plan_workout_matches(owner_id,planned_session_id);

CREATE UNIQUE INDEX plan_matches_owner_workout ON plan_workout_matches(owner_id,training_session_id);

CREATE INDEX planned_session_events_owner_session ON planned_session_events(owner_id,planned_session_id);

CREATE INDEX plan_drafts_owner_updated ON plan_drafts(owner_id, updated_at DESC);

CREATE INDEX session_sources_canonical ON training_session_sources(training_session_id);

CREATE INDEX session_sources_owner_date ON training_session_sources(owner_id,local_date);

CREATE UNIQUE INDEX session_sources_owner_source_external ON training_session_sources(owner_id,source,external_id);


CREATE INDEX sessions_owner_start ON training_sessions(owner_id, start_at);

CREATE UNIQUE INDEX template_dismissals_owner_template ON template_dismissals(owner_id, template_id);

CREATE INDEX templates_owner_updated ON session_templates(owner_id, updated_at DESC);
CREATE INDEX session_sources_owner_source_start ON training_session_sources(owner_id, source, start_at);


CREATE UNIQUE INDEX wellness_owner_day_v12 ON wellness(owner_id, day);

CREATE UNIQUE INDEX workout_plan_exclusions_owner_workout ON workout_plan_exclusions(owner_id,training_session_id);
CREATE TABLE athria_data_version (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT INTO athria_data_version(id, version) VALUES (1, 0);
CREATE TABLE training_memory (owner_id TEXT PRIMARY KEY, content_markdown TEXT NOT NULL CHECK(length(content_markdown) BETWEEN 1 AND 2000), revision INTEGER NOT NULL CHECK(revision >= 1), updated_at TEXT NOT NULL);
CREATE TABLE daily_sync_attempts (owner_id TEXT NOT NULL, source TEXT NOT NULL, local_date TEXT NOT NULL, attempted_at TEXT NOT NULL, PRIMARY KEY(owner_id, source, local_date));
CREATE TABLE plan_review_context (owner_id TEXT PRIMARY KEY, data TEXT NOT NULL);
