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

## Approval boundary

MCP exposes read, calculation, validation, and candidate-search tools. Its only state-changing tools are:

- `save_plan_draft`
- `propose_profile_update`

Neither tool can create a formal plan version or change the confirmed Profile. The user must open the Dashboard, review the diff and validation evidence, and approve. Approval revalidates in a database transaction and rejects hard violations, stale snapshots, and non-pending proposals.

Use the provider-neutral `packages/skills/athria-training-planner` Skill for the intended workflow: read state, identify gaps, compose a structured mesocycle plus expanded dated sessions, validate and revise, show uncertainty and diff, save a draft, then direct the user to Dashboard approval. New drafts must include duration, seven-day weekly structure, labeled session templates, contiguous phases, and structured adjustment rules.

## Xunji records

Athria's Xunji integration is read-only. The user imports the Skill exported by Xunji in **Dashboard → Devices → Import from Xunji**. Athria extracts only the API key, stores it in Windows Credential Manager, and synchronizes the latest 90 days into the local database. The pasted Skill text and API key are never exposed through MCP.

Agents can discover `get_xunji_sync_status` and `list_xunji_training_sessions` directly from the MCP tool descriptions. Hosts that support installable Skills may additionally install `packages/skills/athria-xunji-records`; connecting the MCP server alone does not automatically install a `SKILL.md` file.
