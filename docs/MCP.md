# MCP setup

Athria's shared Rust runtime uses the official RMCP 3.x SDK and supports MCP protocol versions `2025-11-25` and `2026-07-28`. The installed desktop executable provides the stable stdio entry point without spawning a JavaScript runtime:

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

The standalone Rust CLI exposes the same runtime without Tauri:

```text
athria doctor --database C:\path\to\athria.sqlite3
athria mcp --database C:\path\to\athria.sqlite3
ATHRIA_MCP_TOKEN=<token> athria serve --database C:\path\to\athria.sqlite3
```

`athria serve` binds to `127.0.0.1:37373` by default and serves MCP HTTP at `/mcp`. Set `ATHRIA_ADDRESS` to another loopback address when needed.

Legacy clients negotiate through `initialize`; `2026-07-28` clients use `server/discover` and per-request protocol metadata. Streamable HTTP remains loopback-only and accepts both legacy sessions and stateless `2026-07-28` requests. Athria advertises only the tools capability.

The Dashboard runtime also exposes JSON-response Streamable HTTP at `http://127.0.0.1:<random-port>/mcp`. It binds only to loopback, validates the Host and Origin headers, and requires `Authorization: Bearer <runtime-token>`. The token is never exposed through MCP tools or written to the database or logs.

## Write boundary

MCP exposes read, calculation, validation, wellness, training-history, template-library, and current-plan tools. State-changing tools include:

- `create_session_template`, `update_session_template`, `delete_session_template`
- `save_current_plan`, `save_next_training_day_sessions`, `update_planned_session`
- `record_training_session`, `set_training_session_plan_match`, `allow_automatic_plan_match`
- `update_manual_training_session`, `remove_manual_training_source`
- `update_wellness`, `update_athlete_profile`

Tool annotations mark reads, calculations, creates, and append-only recording as non-destructive. Updates, replacement saves, deletes, moves, re-links, and other mutations of existing state carry `destructiveHint: true` so MCP hosts can apply an appropriately strong confirmation experience; this metadata does not replace Athria's own validation or confirmation rules.

Template and plan writes are immediate latest-state writes protected by `expectedRevision`. A complete plan proposal must be validated, presented, and explicitly approved before saving; immediately before the write, the Agent re-reads the current plan, training state, and athlete profile and rebases instead of saving if the revision or hashes are stale. Next-day plan writes, planned-session actions, match changes, manual-history changes, and Profile or Wellness updates likewise require the explicit user direction described by their tool contracts. Templates contain a name, one concise intent, and ordered single-domain nodes with required and optional variable keys. They never contain extra notes, use cases, identity ranges, exercises, distance, duration, sets/reps, load, recovery demand, or another executable prescription. Core validates the structure deterministically; it does not recommend dose. Built-ins can be edited (deriving a user-owned replacement with the same ID) or deleted (hiding the code-defined original, which is retained). Confirmed Profile and Wellness updates write directly with snapshot-hash protection.

Profile stores stable Personal Information (`preferredName`, optional `gender`, `heightCm`, and `birthDate`). Weight remains dated Wellness data. The Dashboard's combined `/api/personal-information` read/write contract updates these surfaces atomically; MCP continues to update stable fields through `update_athlete_profile` and dated weight through `update_wellness`.

Use the provider-neutral `packages/skills/athria-training-planner` Skill for the intended workflow. Read `get_training_taxonomy` before writing a template and submit taxonomy IDs only. Save a v7 Current Mesocycle whose schedule expresses rhythm, whose `domainProgressions[]` independently cover the full cycle for every resolved Session domain, and whose complete `weeks[].sessions` hold final dated prescriptions. Effort notation is domain-specific: Strength exercises carry a numeric `targetRpe` (1–10, optional `targetRir`), while Endurance steps carry relative `heartRateZone` labels such as `Zone 1–2`. `templateRef` is optional provenance and never fills a Session. Validate and resolve blocker-relevant gaps before saving. `save_current_plan` atomically replaces the whole mesocycle in one call and returns only `{ revision, impact, blockerSummary }`; MCP tool errors carry a machine-readable `code` (for example `REVISION_CONFLICT`, `INPUT_SNAPSHOT_CHANGED`, `PLAN_HAS_BLOCKERS`, `WRITE_BUSY`).

Every tool publishes an `outputSchema`. Successful calls return the original JSON serialization in `content[0].text` and the same value in `structuredContent.result`; tool execution errors retain `isError: true` and the JSON `{ error, code }` text shape. `validate_current_plan` is the only plan-validation tool, and `evaluate_progression` is the canonical progression evaluator.

## Xunji records

Athria's Xunji integration is read-only. The user imports the Skill exported by Xunji in **Dashboard → Devices → Import from Xunji**. Athria extracts only the API key, stores it in Windows Credential Manager, and synchronizes the latest 90 days into the local database. The pasted Skill text and API key are never exposed through MCP.

Agents can discover `get_xunji_sync_status` and `list_xunji_training_sessions` directly from the MCP tool descriptions. Hosts that support installable Skills may additionally install `packages/skills/athria-xunji-records`; connecting the MCP server alone does not automatically install a `SKILL.md` file.
