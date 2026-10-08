# Overview

Athria organizes local training data for a desktop dashboard and external AI clients. It has no built-in model or chat service.

## Application framework

```text
React dashboard -> Tauri IPC --+
                              +-> Application -> Core / Store / Integrations
AI client       -> MCP -------+                         |
                                                    SQLite
```

Core owns calculations, schemas, validation, and adjustment policy. Application services coordinate reads, write checks, reconciliation, and persistence. UI and MCP call the same services; Skills define how Agents use them.

Put business rules in the shared boundary. Do not implement a second validator or matching algorithm in UI code or prompts.

The desktop app and MCP open the selected SQLite file directly. Saves commit to that file; there is no cloud replica or cross-device merge.

## Project structure

| Location | Responsibility |
| --- | --- |
| `apps/desktop/src` | React views, editors, and client view models |
| `apps/desktop/src-tauri` | Native shell, IPC, connections, and desktop orchestration |
| `crates/athria-core` | Schemas, classification, metrics, schedules, and policies |
| `crates/athria-application` | Shared use cases and store interface |
| `crates/athria-store` | SQLite, source observations, canonical workouts, and matching |
| `crates/athria-integrations` | External-source normalization |
| `crates/athria-mcp`, `crates/athria-runtime` | MCP contracts/transports and runtime entry points |
| `crates/athria-vault`, `crates/athria-skills` | Credential protection and Skill distribution |
| `packages/skills` | Agent workflows |
| `schemas`, `scripts`, `docs` | Public contracts, tooling, and documentation |

The Rust workspace contains the crates. The Tauri shell is a separate package.

## Development workflow

Use `ATHRIA_DATABASE_PATH` for isolated data. Never test against personal training databases or commit databases, credentials, imports, or generated artifacts.

After application changes, run `pnpm test` and `pnpm typecheck`; also run `cargo test` when Rust changes. Do not rebuild the desktop app for handoff.

See [contributor setup](../../README.md#potential-contributors) for prerequisites and [write policy](write-policy.md#local-data-and-access) for database access and backup behavior.
