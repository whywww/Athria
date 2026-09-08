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

MCP exposes read, calculation, validation, candidate-search, template-library, and current-plan tools. Plan-related state-changing tools are:

- `create_session_template`, `update_session_template`, `delete_session_template`
- `save_current_plan`
- `propose_profile_update`

Template and plan writes are immediate latest-state writes protected by `expectedRevision`. A template or plan edit that affects future planned snapshots requires `futureSessionPolicy: keep | update`. Core blocker failures and unknowns, missing/cross-owner templates, and stale LLM snapshots are rejected. Template deletion additionally requires an explicit user request and is blocked while the Current Mesocycle references it. MCP still cannot directly change the confirmed Profile.

Use the provider-neutral `packages/skills/athria-training-planner` Skill for the intended workflow. Save templates first, then save a v4 Current Mesocycle that references their IDs. Validate and resolve blocker-relevant gaps before saving. The natural week remains sparse and plans never accept or emit `mixed`.

## Xunji records

Athria's Xunji integration is read-only. The user imports the Skill exported by Xunji in **Dashboard → Devices → Import from Xunji**. Athria extracts only the API key, stores it in Windows Credential Manager, and synchronizes the latest 90 days into the local database. The pasted Skill text and API key are never exposed through MCP.

Agents can discover `get_xunji_sync_status` and `list_xunji_training_sessions` directly from the MCP tool descriptions. Hosts that support installable Skills may additionally install `packages/skills/athria-xunji-records`; connecting the MCP server alone does not automatically install a `SKILL.md` file.
