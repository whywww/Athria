# Athria Plan Schema v3 contracts

These JSON Schema files are generated from the Zod 4 source of truth in `packages/schemas/src/index.ts`.

Run `bun run schema:export` whenever a public contract changes. V3 plans use sparse natural-week schedules, open exercises, component domains, classified facts, and rule-level `UNKNOWN`; `mixed` is not part of the plan taxonomy.
