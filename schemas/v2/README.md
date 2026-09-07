# Athria Windows MCP MVP contracts

These JSON Schema files are generated from the Zod 4 source of truth in `packages/schemas/src/index.ts`.

Run `bun run schema:export` and commit the resulting diff whenever a public contract changes. Datetimes require explicit offsets, unknown object fields are rejected, and weight units are explicit.
