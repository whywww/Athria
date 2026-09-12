CREATE TABLE planned_session_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  planned_session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_date TEXT,
  to_date TEXT,
  reason_code TEXT,
  reason_note TEXT,
  revision_before INTEGER NOT NULL,
  revision_after INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX planned_session_events_owner_session ON planned_session_events(owner_id, planned_session_id);

CREATE TABLE workout_plan_exclusions (
  owner_id TEXT NOT NULL,
  training_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX workout_plan_exclusions_owner_workout ON workout_plan_exclusions(owner_id, training_session_id);
