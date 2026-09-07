# Athria

Athria is local-first training infrastructure for Windows x64. The MVP combines a Tauri 2 and React Dashboard with a standalone Bun TypeScript service, SQLite/Drizzle persistence, deterministic training calculations, and MCP v2.

The application does not contain an LLM. External Agents can read state, calculate metrics, validate plans, and save drafts. Only the user can approve a draft or profile proposal in the Dashboard; approval creates an immutable version.

## MVP scope

- Windows x64 and English UI
- unsigned MSI (Windows SmartScreen may warn)
- fresh database at `%LOCALAPPDATA%\Athria\data\athria.sqlite3`
- Hevy CSV preview before commit and read-only Intervals.icu sync
- strength and endurance metrics with explicit data quality and formula versions
- stdio and authenticated loopback Streamable HTTP MCP
- no Node, Bun, Python, Rust, Docker, or external database required after installation

Existing pre-v0.1 databases are intentionally not migrated. The old data directory is cleared only during an explicitly scheduled final cutover after replacement acceptance.

## Source development

The repository uses a pnpm-compatible workspace and Bun for the service runtime and scripts. A portable Bun can be placed at `.tools\bun\bun-windows-x64\bun.exe`.

```powershell
bun install
bun run typecheck
bun run test
bun run dev
```

`bun run dev` loads the development-only Tauri configuration, then starts Vite, the Tauri debug application, and the TypeScript service in watch mode. It does not compile the service sidecar or build an MSI. Debug startup finds Bun from `ATHRIA_BUN`, then the repository's portable Bun, then `PATH`. The default Tauri configuration contains no development URL, so release executables cannot fall back to the Vite localhost server.

If Bun is not on `PATH`, start the root script with the portable runtime instead: `.\.tools\bun\bun-windows-x64\bun.exe run dev`. `ATHRIA_BUN` controls which Bun executable Tauri uses for the managed development service after the root script starts.

Use `bun run build:app` to compile the standalone service and build `apps/desktop/src-tauri/target/release/athria.exe` without an installer. Use `bun run release:msi` only for release and installation validation; it produces the MSI under `apps/desktop/src-tauri/target/release/bundle/msi`. `bun run build:desktop` remains an alias for the MSI release command.

Native desktop builds additionally require Rust, Microsoft Visual C++ Build Tools, and the Windows SDK. These build-time tools are not installed on user machines. Installed release builds do not require Bun or any other development runtime.

## Runtime commands

```text
Athria.exe                 Open the Dashboard and managed local service
Athria.exe mcp             Run MCP v2 over stdio (stdout is JSON-RPC only)
athria-service.exe serve   Run the loopback service
athria-service.exe doctor  Print local diagnostics
athria-service.exe backup  Create a backup ZIP
athria-service.exe restore BACKUP_PATH EMPTY_TARGET_DIR
```

See [MCP setup](docs/MCP.md), [backup and restore](docs/BACKUP.md), [known limitations](docs/KNOWN_LIMITATIONS.md), the [development plan](docs/DEVELOPMENT_PLAN.md), and the [current artifact record](docs/RELEASE.md).

Athria supports training planning and record analysis. It does not diagnose injuries, make medical decisions, or certify that a workout is medically safe.
