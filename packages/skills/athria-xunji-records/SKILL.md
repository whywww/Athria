---
name: athria-xunji-records
description: Read and explain training records previously synced from 训记/Xunji into the user's local Athria database. Use when the user asks for their Xunji workouts, sets, RPE, cardio, heart-rate summaries, or Xunji sync freshness; do not use for writing records back to Xunji.
---

# Athria Xunji Records

Use Athria's local, normalized Xunji data. Never ask for, retrieve, display, or handle the user's Xunji API key.

## Workflow

1. Call `get_xunji_sync_status` to establish whether Xunji is connected and when the local data was last synchronized.
2. Call `list_xunji_training_sessions` with the smallest date window that satisfies the request.
3. Clearly distinguish fields returned from synchronized Xunji records from calculations or interpretations.
4. Treat missing RPE, heart rate, duration, load, or distance as unavailable rather than zero.
5. If there is no successful sync, or the requested dates fall outside the synchronized range, ask the user to open Athria → Devices → Import from Xunji and use **Sync now**.

## Boundaries

- These tools read Athria's local database; they do not query Xunji live.
- Do not claim the data is current beyond the returned `lastSuccessAt` and date range.
- Do not write, delete, or propose changes to Xunji records. Athria's first Xunji integration is read-only.
- Raw Xunji payloads and credentials are not available through MCP.
