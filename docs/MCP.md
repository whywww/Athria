# MCP setup

Athria uses the official MCP v2 transports. The installed desktop executable preserves the stable stdio entry point:

```json
{
  "mcp_servers": {
    "athria": {
      "command": "C:\\Program Files\\Athria\\Athria.exe",
      "args": ["mcp"]
    }
  }
}
```

Restart the MCP host after changing its configuration. stdout is reserved for JSON-RPC; diagnostics go to stderr.

The Dashboard-managed service also exposes Streamable HTTP at `http://127.0.0.1:<random-port>/mcp`. It validates the Host header and requires `Authorization: Bearer <token>`. The MCP HTTP token is stored in Windows Credential Manager and is not available through MCP tools.

## Write boundary

MCP exposes read, calculation, validation, wellness, training-history, template-library, and current-plan tools. State-changing tools include:

- `create_session_template`, `update_session_template`, `delete_session_template`
- `save_current_plan`
- `record_training_session`, `update_wellness`, `update_athlete_profile`

Template and plan writes are immediate latest-state writes protected by `expectedRevision`. Templates contain a name, one concise intent, and ordered single-domain nodes with required and optional variable keys. They never contain extra notes, use cases, identity ranges, exercises, distance, duration, sets/reps, load, recovery demand, or another executable prescription. Core validates the structure deterministically; it does not recommend dose. Built-ins are read-only and may be copied. Confirmed Profile and Wellness updates write directly with snapshot-hash protection.

Profile stores stable Personal Information (`preferredName`, optional `gender`, `heightCm`, and `birthDate`). Weight remains dated Wellness data. The Dashboard's combined `/api/personal-information` read/write contract updates these surfaces atomically; MCP continues to update stable fields through `update_athlete_profile` and dated weight through `update_wellness`.

Use the provider-neutral `packages/skills/athria-training-planner` Skill for the intended workflow. Read `get_training_taxonomy` before writing a template and submit taxonomy IDs only. Save a v7 Current Mesocycle whose schedule expresses rhythm, whose `domainProgressions[]` independently cover the full cycle for every resolved Session domain, and whose complete `weeks[].sessions` hold final dated prescriptions. Effort notation is domain-specific: Strength exercises carry a numeric `targetRpe` (1–10, optional `targetRir`), while Endurance steps carry relative `heartRateZone` labels such as `Zone 1–2`. `templateRef` is optional provenance and never fills a Session. Validate and resolve blocker-relevant gaps before saving. `save_current_plan` atomically replaces the whole mesocycle in one call and returns only `{ revision, impact, blockerSummary }`; MCP tool errors carry a machine-readable `code` (for example `REVISION_CONFLICT`, `INPUT_SNAPSHOT_CHANGED`, `PLAN_HAS_BLOCKERS`, `WRITE_BUSY`).

## Xunji records

Athria's Xunji integration is read-only. The user imports the Skill exported by Xunji in **Dashboard → Devices → Import from Xunji**. Athria extracts only the API key, stores it in Windows Credential Manager, and synchronizes the latest 90 days into the local database. The pasted Skill text and API key are never exposed through MCP.

Agents can discover `get_xunji_sync_status` and `list_xunji_training_sessions` directly from the MCP tool descriptions. Hosts that support installable Skills may additionally install `packages/skills/athria-xunji-records`; connecting the MCP server alone does not automatically install a `SKILL.md` file.
