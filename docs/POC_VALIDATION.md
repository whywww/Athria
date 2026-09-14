# POC validation status

Updated: 2026-09-02

## Passed

- The pre-rewrite behavioral baseline was captured before implementation work began.
- pnpm-compatible workspace, Zod contracts, pure Core, Drizzle/Bun SQLite, application services, integrations, MCP, and React Dashboard are implemented.
- Bun standalone Windows x64 sidecar compiles and starts without an installed Bun runtime.
- SQLite opens with WAL, foreign keys, busy timeout, and schema migrations.
- The same service executable supports loopback HTTP and stdio MCP entry points.
- Real stdio MCP initialize and tool-list smoke test passed with stdout containing JSON-RPC only.
- Loopback health, bearer-protected API, state read, and backup smoke tests passed.
- Loopback Host and Origin rejection return 403; a missing bearer token returns 401. Trusted Tauri CORS preflight returns 204 before bearer authentication and actual API responses carry the matching allow-origin header.
- Backup/restore creates and validates standalone SQLite copies, rejects invalid Athria databases, and does not modify the selected restore source.
- Tauri starts the sidecar, passes its health gate, and removes the sidecar when the desktop window closes.
- Native release compilation and unsigned Windows x64 MSI generation pass.
- MSI administrative extraction succeeds and contains the desktop executable plus standalone sidecar; `Athria.exe mcp` runs successfully from the extracted installation layout.
- The compiled `Athria.exe mcp` exposes 22 tools; stdout purity and stderr silence pass the release smoke test.
- TypeScript type checking and 63 migrated Vitest cases pass. Old full-plan auto-generation behavior was intentionally not copied.
- With 10,000 sessions, state derivation completed in 452.19 ms and plan validation in 12.55 ms on the development host.

## Open release gates

- Install/uninstall/reinstall smoke test in a clean Windows Sandbox or VM.
- Run the real Codex workflow through the installed `Athria.exe mcp` and Dashboard approval.
- Validate current Hevy CSV and temporary Intervals.icu credentials when supplied by the user.
- Execute the final fresh-start cutover only after all replacement gates pass.

If Bun packaging fails in a later dependency combination, retain the TypeScript packages and public contracts and replace only the sidecar packaging runtime. Do not broaden the Dashboard scope to work around a failed Phase 0 gate.
