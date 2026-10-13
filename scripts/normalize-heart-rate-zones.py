"""One-time conversion of endurance prescriptions; never used by the app.

Preview: python scripts/normalize-heart-rate-zones.py DATABASE
Apply:   python scripts/normalize-heart-rate-zones.py DATABASE --apply --backup BACKUP
Close Athria before applying. Unrecognized values abort the whole transaction.
"""
import argparse
import json
from pathlib import Path
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone


CANONICAL = re.compile(r"(?:[1-5]|1-[2-5]|2-[3-5]|3-[4-5]|4-5)")
TABLES = ("current_mesocycles", "current_planned_sessions", "plan_drafts", "plan_draft_weeks")


def activity_domains():
    # Use the repository's authoritative activity aliases for this offline tool.
    source = (Path(__file__).resolve().parents[1] / "crates/athria-core/src/training_type.rs").read_text(encoding="utf-8")
    definitions = source.split("pub const TYPES:", 1)[1].split("];", 1)[0]
    domains = {}
    for kind, domain, aliases in re.findall(r'\("([^"]+)", "([^"]+)", &\[([^\]]+)\]\)', definitions):
        for alias in [kind, *re.findall(r'"([^"]+)"', aliases)]:
            domains[re.sub(r"[^a-z0-9]", "", alias.lower())] = domain
    if not domains:
        raise ValueError("Cannot read canonical activity types")
    return domains


TYPE_DOMAINS = activity_domains()


def is_endurance(session):
    kind = session.get("type") or session.get("sport") or ""
    token = re.sub(r"[^a-z0-9]", "", kind.lower()) if isinstance(kind, str) else ""
    return TYPE_DOMAINS.get(token, session.get("domain")) == "endurance"


def normalize_zone(value, path):
    if not isinstance(value, str):
        raise ValueError(f"{path}: expected a zone string, got {value!r}")
    zone = re.sub(r"^(?:zone\s*|z\s*)", "", value.strip(), flags=re.IGNORECASE)
    zone = re.sub(r"\s*[-\u2013\u2014]\s*", "-", zone)
    if not CANONICAL.fullmatch(zone):
        raise ValueError(f"{path}: unrecognized heartRateZone {value!r}")
    return zone


def normalize_document(document, path):
    changed = 0

    def step(value, location):
        nonlocal changed
        if not isinstance(value, dict) or value.get("type") != "step":
            raise ValueError(f"{location}: expected an endurance step")
        if "heartRateZone" in value:
            normalized = normalize_zone(value["heartRateZone"], location + ".heartRateZone")
            if normalized != value["heartRateZone"]:
                value["heartRateZone"] = normalized
                changed += 1

    def walk(value, location):
        if isinstance(value, dict):
            if "prescription" in value:
                if is_endurance(value) and value["prescription"] is not None:
                    prescription = value["prescription"]
                    if not isinstance(prescription, dict) or not isinstance(prescription.get("blocks"), list):
                        raise ValueError(f"{location}.prescription: expected blocks")
                    for index, block in enumerate(prescription["blocks"]):
                        block_path = f"{location}.prescription.blocks[{index}]"
                        if block.get("type") == "repeat":
                            step(block.get("work"), block_path + ".work")
                            if "recovery" in block:
                                step(block["recovery"], block_path + ".recovery")
                        elif block.get("type") == "step":
                            step(block, block_path)
                        # Some old drafts contain strength-shaped blocks under
                        # an endurance session. Leave that unrelated data alone.
                # Never recurse into prescriptions of other domains.
            for key, child in value.items():
                if key != "prescription":
                    walk(child, location + "." + key)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, f"{location}[{index}]")

    walk(document, path)
    return changed


def collect_changes(connection):
    changes = []
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table in TABLES:
        if table not in tables:
            continue
        for row in connection.execute(f"SELECT rowid AS _rowid, * FROM {table}"):
            document = json.loads(row["data"])
            count = normalize_document(document, f"{table}[{row['_rowid']}]")
            if count:
                changes.append((table, row, document, count))
    return changes, tables


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def apply_changes(connection, changes, tables):
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    plan_revisions = {}
    drafts = set()
    for table, row, document, _ in changes:
        assignments = ["data=?"]
        if table == "current_mesocycles":
            plan_revisions[row["owner_id"]] = document["revision"]
            document["revision"] += 1
            document["updatedAt"] = now
            if "revision" in row.keys():
                assignments.append("revision=revision+1")
            if "updated_at" in row.keys():
                assignments.append("updated_at=?")
        elif table == "current_planned_sessions":
            if isinstance(document.get("revision"), int):
                document["revision"] += 1
            if "updatedAt" in document:
                document["updatedAt"] = now
            if "revision" in row.keys():
                assignments.append("revision=revision+1")
            if "updated_at" in row.keys():
                assignments.append("updated_at=?")
        elif table == "plan_drafts":
            drafts.add(row["id"])
        elif table == "plan_draft_weeks":
            drafts.add(row["draft_id"])
        parameters = [encode(document)]
        if "updated_at=?" in assignments:
            parameters.append(now)
        parameters.append(row["_rowid"])
        connection.execute(f"UPDATE {table} SET {', '.join(assignments)} WHERE rowid=?", parameters)

    for owner, revision in plan_revisions.items():
        if "plan_drafts" in tables:
            drafts.update(row[0] for row in connection.execute(
                "SELECT id FROM plan_drafts WHERE owner_id=? AND base_plan_revision=?", (owner, revision)))
            connection.execute("UPDATE plan_drafts SET base_plan_revision=base_plan_revision+1 WHERE owner_id=? AND base_plan_revision=?", (owner, revision))
        if "plan_review_context" in tables:
            row = connection.execute("SELECT data FROM plan_review_context WHERE owner_id=?", (owner,)).fetchone()
            if row:
                context = json.loads(row[0])
                if context.get("committedPlanRevision") == revision:
                    context["committedPlanRevision"] = revision + 1
                    connection.execute("UPDATE plan_review_context SET data=? WHERE owner_id=?", (encode(context), owner))
    for draft in drafts:
        connection.execute("UPDATE plan_drafts SET draft_revision=draft_revision+1, updated_at=? WHERE id=?", (now, draft))
    connection.execute("UPDATE athria_data_version SET version=version+1 WHERE id=1")


def convert_database(database, *, apply=False, backup=None):
    database = Path(database).resolve(strict=True)
    connection = sqlite3.connect(database.as_uri() + ("?mode=rw" if apply else "?mode=ro"), uri=True)
    connection.row_factory = sqlite3.Row
    try:
        changes, tables = collect_changes(connection)
        if apply and changes:
            if backup is None:
                raise ValueError("--backup is required when applying changes")
            backup = Path(backup).resolve()
            if backup == database or backup.exists():
                raise ValueError("Backup must be a new file separate from the database")
            # SQLite backup includes committed WAL data; copying the file does not.
            with closing(sqlite3.connect(backup)) as destination:
                connection.backup(destination)
            connection.execute("BEGIN IMMEDIATE")
            try:
                changes, tables = collect_changes(connection)
                apply_changes(connection, changes, tables)
                if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError("SQLite integrity check failed")
                remaining, _ = collect_changes(connection)
                if remaining:
                    raise ValueError("Noncanonical endurance zones remain")
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        return {"applied": apply, "rows": len(changes), "zones": sum(item[3] for item in changes),
                "tables": {table: sum(item[3] for item in changes if item[0] == table) for table in TABLES},
                "backup": str(backup) if apply and changes else None}
    finally:
        connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup", type=Path)
    arguments = parser.parse_args()
    print(json.dumps(convert_database(arguments.database, apply=arguments.apply, backup=arguments.backup), ensure_ascii=False))
