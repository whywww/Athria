# Athria Developer Docs

Reference for Athria's data contracts, training classification, and behavior. Start with the concept you are changing, then check the rules that govern its writes.

## Concepts

| Page | What you will learn |
| --- | --- |
| [Overview](overview.md) | Shared framework, project structure, and development workflow |
| [Data model](data-model.md) | Key fields and boundaries between facts, templates, plans, and history |
| [Training classification](training-taxonomy.md) | Type/subtype/domain mappings, normalization, and exercise facts |

## Rules and policies

| Page | What you will learn |
| --- | --- |
| [Core rules](core-rules.md) | Validation conditions, verdicts, and current domain coverage |
| [Plan adjustment](plan-adjustment-policy.md) | Review decisions, evidence, and permitted change scope |
| [Write policy](write-policy.md) | Approval, concurrency guards, draft commits, and matching corrections |

## MCP reference

[MCP interface](mcp.md) lists tools, connection behavior, and workflows. Exact arguments are defined by runtime `tools/list` and the [compiled contract](../../crates/athria-mcp/contract.json).

## Reading conventions

- **Schema contract:** fields, types, ranges, and document refinements.
- **Runtime rule:** a check performed by Core, application services, or storage.
- **Agent policy:** conversation and approval behavior specified by [Athria Skills](../../packages/skills). A tool cannot verify that the conversation occurred.
- **Current limitation:** a concept not fully implemented across all layers.

JSON examples marked **fragment** are partial objects, not complete requests. Public ranges come from [v7 schemas](../../schemas/README.md); runtime behavior comes from the linked implementation. Existing defaults do not imply user confirmation.

Related: [Contributor setup](../../README.md#potential-contributors), [known limitations](../KNOWN_LIMITATIONS.md), and [data sync guide](../DATA_SYNC.md). Update these pages when the corresponding contract changes.
