# MCP Interface

Athria exposes local context, deterministic calculations, planning, and bounded writes to AI clients. Discover exact inputs, required fields, annotations, and output schemas through runtime `tools/list`. The compiled source is [contract.json](../../crates/athria-mcp/contract.json); do not infer arguments from these summaries.

## Connection and results

The local runtime supports stdio (`athria mcp`) and Streamable HTTP (`athria serve`, `/mcp`). HTTP is loopback-only and requires `ATHRIA_MCP_TOKEN`. Select an isolated database with `--database` or `ATHRIA_DATABASE_PATH`; desktop connection setup supplies the appropriate client configuration.

Successful calls expose `structuredContent.result` and a JSON text representation. Tool failures set `isError: true` and return a JSON text object containing `code` and `error`. Inspect the tool result, not only transport success.

## Context and facts

| Tool | Use |
| --- | --- |
| `get_database_context` | Identify the absolute database path used by this MCP session |
| `get_data_source_status` | Check local source connections and freshness in Profile timezone without credentials |
| `get_athlete_profile` | Read stable confirmed context and its update hash |
| `get_training_memory` | Read the current experience/capability portrait and revision |
| `get_training_state` | Read the state snapshot and `inputSnapshotHash` |
| `list_training_sessions` | Read canonical actual history and target snapshot hashes |
| `get_training_summary` | Read recent metrics separated by domain |
| `list_wellness` | Read dated measurements and per-field provenance |
| `get_wellness_day` | Read one day and its update hash; an absent day uses `new` |
| `list_xunji_training_sessions` | Read locally synchronized SynFit/Xunji history and freshness |
| `get_xunji_sync_status` | Read SynFit/Xunji connection and synchronization status |
| `update_athlete_profile` | Apply an approved Profile patch with its expected hash |
| `update_wellness` | Apply approved values to one day with its snapshot guard |
| `update_training_memory` | Replace the concise portrait with revision protection |

Source reads do not fetch live external records. Connections owns synchronization. Hevy status may be returned for existing data; it does not mean new import is available.

## Taxonomy and templates

| Tool | Use |
| --- | --- |
| `get_training_taxonomy` | Read versioned vocabularies and fact-confidence requirements |
| `list_session_templates` | List available built-in and local archetypes |
| `get_session_template` | Read one archetype |
| `create_session_template` | Create a local archetype, including a derivation of a built-in |
| `update_session_template` | Revise a local archetype with its expected revision |
| `delete_session_template` | Explicitly delete an unreferenced local template or hide a built-in |

Templates carry structure, not executable dose. See [data model](data-model.md) and [taxonomy](training-taxonomy.md).

## Deterministic calculations

These tools do not write data.

| Tool | Use |
| --- | --- |
| `calculate_training_metrics` | Calculate metrics from local Training History |
| `estimate_1rm` | Estimate 1RM with the versioned Epley formula |
| `calculate_heart_rate_zones` | Calculate five zones from explicit maximum heart rate |
| `evaluate_progression` | Evaluate double progression from prescription and completion evidence |
| `evaluate_rpe_autoregulation` | Evaluate load adjustment from target and actual RPE |

## Current Plan and drafts

| Tool | Use |
| --- | --- |
| `get_current_plan` | Read the single editable mesocycle; may return null |
| `get_plan_adjustment_review` | Read reasons, scope, overrides, gaps, and freshness without editing |
| `create_plan_draft` | Start a metadata-only new draft or clone Current Plan |
| `list_plan_drafts` | Locate persisted draft summaries |
| `get_plan_draft` | Read a draft summary or one requested week |
| `upsert_plan_draft_week` | Atomically replace a complete week with draft revision protection |
| `validate_plan_draft` | Assemble and check the draft without changing Current Plan |
| `commit_plan_draft` | After detailed approval, validate and atomically replace Current Plan |
| `discard_plan_draft` | Discard an open draft with revision protection |

For approval checkpoints and freshness handling, follow [write policy](write-policy.md#plan-writes). For adjustment scope, follow [plan adjustment policy](plan-adjustment-policy.md).

## Scheduled training

| Tool | Use |
| --- | --- |
| `get_next_training_day` | Find the first scheduled day with unresolved training on or after the supplied date |
| `list_planned_sessions` | Read occurrences, optionally within a date range |
| `validate_next_training_day_sessions` | Check a proposed next-day write without saving |
| `save_next_training_day_sessions` | Append or replace complete prescriptions on that day |
| `update_planned_session` | Complete, skip, restore, or move an occurrence after approval |

Next-day workflow: read the day and revision, construct complete prescriptions, validate, show and approve the change, then save. Use the required `clientRequestId` for request identity. If the day or revision changes, refresh and revise the proposal.

## Actual history and matching

| Tool | Use |
| --- | --- |
| `record_training_session` | Record actual facts; Core/store reconciliation selects any plan match |
| `update_manual_training_session` | Correct start time or duration of a workout containing a manual source |
| `remove_manual_training_source` | Remove only the manual observation, preserving synced sources |
| `override_training_session_plan_match` | Apply an explicit user-directed match correction or intentional exclusion |
| `allow_automatic_plan_match` | Remove an intentional exclusion and permit automatic matching again |

History workflow: record user-supplied facts, let Athria reconcile, and use a correction tool only for an explicit user decision. Existing-workout edits require the target `snapshotHash` as `expectedSnapshotHash`; matching corrections may also require the plan revision. See [matching policy](write-policy.md#plan-and-history-matching).

## Skill handshake

| Tool | Use |
| --- | --- |
| `report_skill_version` | Report the loaded Skill's literal name, version, and content hash |

Athria injects the handshake into exported Skills for clients such as Claude Desktop whose installed Skill lists it cannot inspect. Call it when the Skill first runs. Reports are recorded only when a report location is configured; they never alter training data or require training-write approval.

## Failure recovery

| Failure | Response |
| --- | --- |
| Revision or input snapshot conflict | Re-read the affected state, rebase, revalidate, and renew approval for changed proposals |
| Draft based on an older plan | Create a fresh draft and rebase; do not just replace the revision token |
| Incomplete draft or plan blockers | Complete missing weeks or resolve blocker failures/unknowns before retrying |
| Missing/in-use template | Refresh references or choose a valid template operation; never synthesize a missing version |
| Next day changed, no next day, or no current plan | Refresh planning context and choose the appropriate workflow |
| Invalid input or unsupported schema | Read `tools/list` and current schemas; correct the request |
| Write busy | Retry after the competing write; refresh guards if state changed |

Stable application error codes are defined in [Core errors](../../crates/athria-core/src/error.rs). Validation interpretation belongs to [Core rules](core-rules.md); a transport success or advisory pass is not proof of a successful save.
