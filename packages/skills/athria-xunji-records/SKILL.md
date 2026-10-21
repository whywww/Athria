---
name: athria-xunji-records
description: Read and explain training records previously synced from 训记/Xunji into the user's local Athria database. Use when the user asks for their Xunji workouts, sets, RPE, cardio, heart-rate summaries, or Xunji sync freshness; do not use for writing records back to Xunji.
---

# Athria Xunji Records

Use Athria's local, normalized Xunji data. Never ask for, retrieve, display, or handle the user's Xunji API key.

## Language

Use the requested language or the latest substantive user message; brief approval does not switch it. Preserve quoted/source text, unchanged content, field names, IDs, enums, numbers, and notation.

## Workflow

1. For connection/status questions, call `get_xunji_sync_status`. For records, call `list_xunji_training_sessions` directly; its `sync` reports local synchronization freshness. Query status separately only if connection state is needed.
2. Use paired inclusive `from`/`to` dates in Profile timezone for a specific period, or `days` for a rolling window (default 30). Explicit dates override days; never send only one date. Choose the smallest window that answers the question.
3. Clearly distinguish fields returned from synchronized Xunji records from calculations or interpretations.
4. Treat missing RPE, heart rate, duration, load, or distance as unavailable rather than zero.
5. If there is no successful sync, or the requested dates fall outside the synchronized range, ask the user to open Athria → Connections (连接) → SynFit (训记) and use **Sync now (立即同步)**.

## Boundaries

- These tools read Athria's local database; they do not query Xunji live.
- Do not claim the data is current beyond the returned `lastSuccessAt` and date range.
- Do not write, delete, or propose changes to Xunji records. Athria's first Xunji integration is read-only.
- Raw Xunji payloads and credentials are not available through MCP.
