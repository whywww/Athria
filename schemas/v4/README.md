# Athria Plan Schema v4 contracts

These JSON Schema files are generated from the Zod source of truth in `packages/schemas/src/index.ts`.

V4 separates reusable `session-template` resources from the single latest `current-plan`. A Current Mesocycle references template IDs, includes an explicit effective start date, and uses optimistic revisions without retaining plan or template history. V2 and v3 remain available only as historical format documentation.

Run `bun run schema:export` whenever a public contract changes.
