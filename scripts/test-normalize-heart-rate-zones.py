"""Regression tests for the offline database conversion."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing

spec = importlib.util.spec_from_file_location("zone_conversion", Path(__file__).with_name("normalize-heart-rate-zones.py"))
conversion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(conversion)


def session(zone="Zone 1–3", domain="endurance", activity="Run"):
    step = {"type": "step", "name": "Easy", "role": "steady", "heartRateZone": zone}
    return {"type": activity, "domain": domain, "prescription": {"blocks": [step,
        {"type": "repeat", "work": dict(step, heartRateZone="Z2"),
         "recovery": dict(step, heartRateZone="Zone 1")}]}}


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.addCleanup(self.directory.cleanup)
        self.database = Path(self.directory.name) / "athria.sqlite3"
        self.backup = Path(self.directory.name) / "backup.sqlite3"
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.executescript("""
                CREATE TABLE current_mesocycles(owner_id TEXT, data TEXT);
                CREATE TABLE plan_drafts(id TEXT, owner_id TEXT, data TEXT, base_plan_revision INTEGER, draft_revision INTEGER, updated_at TEXT);
                CREATE TABLE plan_draft_weeks(draft_id TEXT, week_number INTEGER, data TEXT);
                CREATE TABLE current_planned_sessions(data TEXT, revision INTEGER, updated_at TEXT);
                CREATE TABLE plan_review_context(owner_id TEXT, data TEXT);
                CREATE TABLE athria_data_version(id INTEGER, version INTEGER);
                INSERT INTO athria_data_version VALUES (1, 9);
                CREATE TABLE athria_migrations(version INTEGER);
                INSERT INTO athria_migrations VALUES (36);
                CREATE TABLE training_sessions(data TEXT);
            """)
            document = {"revision": 4, "updatedAt": "original", "sessions": [session(),
                session("do not change", "strength", "StrengthTraining"),
                session("do not change", "sport_skill", "Tennis"),
                session("do not change", "functional", "FunctionalTraining"),
                session("do not change", "endurance", "Yoga"),
                {"type": "Rowing", "domain": "endurance", "prescription": {"blocks": [{"id": "legacy-strength", "sets": 3, "heartRateZone": "unrelated"}]}}],
                "heartRateZoneSeconds": {"Z2": 900}, "heartRateZone": "unrelated"}
            connection.execute("INSERT INTO current_mesocycles VALUES ('a', ?)", (json.dumps(document),))
            connection.execute("INSERT INTO plan_drafts VALUES ('valid','a','{}',4,2,'original')")
            connection.execute("INSERT INTO plan_drafts VALUES ('stale','a','{}',3,2,'original')")
            connection.execute("INSERT INTO plan_draft_weeks VALUES ('stale',1,?)", (json.dumps({"sessions": [session()]}),))
            connection.execute("INSERT INTO current_planned_sessions VALUES (?,7,'original')", (json.dumps(dict(session(), revision=7, planRevision=4, status="completed")),))
            connection.execute("INSERT INTO plan_review_context VALUES ('a',?)", (json.dumps({"committedPlanRevision": 4, "pendingChanges": ["keep"]}),))
            connection.execute("INSERT INTO training_sessions VALUES (?)", (json.dumps({"heartRateZoneSeconds": {"1": 123}, "prescription": session()["prescription"]}),))

    def dump(self, database=None):
        with closing(sqlite3.connect(database or self.database)) as connection:
            return list(connection.iterdump())

    def test_preview_is_read_only(self):
        before = self.dump()
        result = conversion.convert_database(self.database)
        self.assertEqual(result["zones"], 9)
        self.assertEqual(result["rows"], 3)
        self.assertEqual(self.dump(), before)
        self.assertFalse(self.backup.exists())

    def test_conversion_backup_scope_revisions_and_idempotence(self):
        before = self.dump()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            original = json.loads(connection.execute("SELECT data FROM current_mesocycles").fetchone()[0])
            training = connection.execute("SELECT data FROM training_sessions").fetchone()[0]
        result = conversion.convert_database(self.database, apply=True, backup=self.backup)
        self.assertEqual(result["zones"], 9)
        self.assertEqual(self.dump(self.backup), before)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            raw = connection.execute("SELECT data FROM current_mesocycles").fetchone()[0]
            plan = json.loads(raw)
            self.assertEqual(plan["revision"], 5)
            self.assertEqual(plan["sessions"][0]["prescription"]["blocks"][0]["heartRateZone"], "1-3")
            repeat = plan["sessions"][0]["prescription"]["blocks"][1]
            self.assertEqual(repeat["work"]["heartRateZone"], "2")
            self.assertEqual(repeat["recovery"]["heartRateZone"], "1")
            self.assertEqual(plan["sessions"][1:], original["sessions"][1:])
            self.assertEqual(plan["heartRateZoneSeconds"], original["heartRateZoneSeconds"])
            self.assertEqual(plan["heartRateZone"], "unrelated")
            self.assertEqual(connection.execute("SELECT data FROM training_sessions").fetchone()[0], training)
            self.assertEqual(connection.execute("SELECT base_plan_revision,draft_revision FROM plan_drafts WHERE id='valid'").fetchone(), (5, 3))
            self.assertEqual(connection.execute("SELECT base_plan_revision,draft_revision FROM plan_drafts WHERE id='stale'").fetchone(), (3, 3))
            snapshot = json.loads(connection.execute("SELECT data FROM current_planned_sessions").fetchone()[0])
            self.assertEqual(snapshot["revision"], 8)
            self.assertEqual(snapshot["planRevision"], 4)
            self.assertEqual(snapshot["status"], "completed")
            context = json.loads(connection.execute("SELECT data FROM plan_review_context").fetchone()[0])
            self.assertEqual(context, {"committedPlanRevision": 5, "pendingChanges": ["keep"]})
            self.assertEqual(connection.execute("SELECT version FROM athria_data_version").fetchone()[0], 10)
            self.assertEqual(connection.execute("SELECT version FROM athria_migrations").fetchone()[0], 36)
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        after = self.dump()
        self.assertEqual(conversion.convert_database(self.database, apply=True)["zones"], 0)
        self.assertEqual(self.dump(), after)

    def test_unrecognized_value_aborts_before_writes(self):
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE plan_draft_weeks SET data=?", (json.dumps({"sessions": [session("Zone 6")]}),))
        before = self.dump()
        with self.assertRaisesRegex(ValueError, r"plan_draft_weeks.*heartRateZone"):
            conversion.convert_database(self.database, apply=True, backup=self.backup)
        self.assertEqual(self.dump(), before)

    def test_failure_after_updates_rolls_back_everything(self):
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE plan_review_context SET data='{broken'")
        before = self.dump()
        with self.assertRaises(json.JSONDecodeError):
            conversion.convert_database(self.database, apply=True, backup=self.backup)
        self.assertEqual(self.dump(), before)
        self.assertEqual(self.dump(self.backup), before)

    def test_legacy_conversion_and_invalid_ranges(self):
        for value, expected in [("Z2", "2"), ("Zone 1–3", "1-3"), ("zone 1 — 5", "1-5"), ("2", "2")]:
            self.assertEqual(conversion.normalize_zone(value, "step"), expected)
        for value in ["0", "6", "Zone 5-1", "2-2", "1-6", "easy", "", None, 2]:
            with self.assertRaises(ValueError):
                conversion.normalize_zone(value, "step")


if __name__ == "__main__":
    unittest.main()
