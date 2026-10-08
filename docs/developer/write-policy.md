# Write Policy

Use shared application services for writes. Approval, optimistic concurrency, and validation solve different problems; none replaces the others.

## Operation guards

| Operation | Agent policy | Runtime guard / behavior |
| --- | --- | --- |
| Profile patch | Approve the exact diff | `confirmed` and current `expectedProfileHash` |
| Wellness update | Approve values for that day | Nested update has confirmation and `expectedSnapshotHash`; absent day uses `"new"` |
| Template create/update | Approve the operation | Schema/reference checks; update has `expectedRevision` |
| Template deletion | Explicit deletion request | `confirmedExplicitRequest`; applicable revision and in-use checks |
| Draft week replacement | Approve outline before drafting | `expectedDraftRevision`; replaces a complete week |
| Plan commit | Approve complete detailed plan | Confirmation, draft/plan revisions, state snapshot, and plan validation |
| Next-day append/replace | Approve complete prescriptions | `clientRequestId`, scheduled day, plan revision, and validation |
| Occurrence complete/skip/restore/move | Approve the action | Nested action carries applicable confirmation/revision guards |
| Manual-history edit / matching correction | Approve exact correction | Confirmation, target snapshot hash, and plan revision where required |
| Record actual training | Use user-supplied actual facts | Record schema and reconciliation; no blanket confirmation field |
| Training Memory | Consolidate meaningful evidence or correction | `expectedRevision`; profile Skill requires no separate prior approval |
| Skill version report | Report loaded literal metadata | No training-data write or training approval |

Use the [MCP contract](../../crates/athria-mcp/contract.json) for exact argument nesting. Do not invent confirmation parameters. Runtime flags assert approval; they cannot verify the conversation.

## Guard semantics

| Guard | Read from | Protects |
| --- | --- | --- |
| Profile hash | Profile snapshot | Stable context being patched |
| Wellness/workout snapshot hash | Target day or workout | Exact object being corrected |
| Template / Memory revision | Target object | Object version |
| Draft revision | Draft summary / week write result | Draft contents |
| Plan revision | Current Plan / occurrence context | Editable plan state |
| Input snapshot hash | Training State | Context used for the proposal |

Validation inputHash is not inputSnapshotHash. Draft revision is not plan revision.

**Example — Profile patch fragment:**

```json
{
  "patch": { "usualSessionMinutes": 75 },
  "expectedProfileHash": "<profileHash from the current read>",
  "confirmed": true
}
```

A stale hash requires a fresh read and reconstructed diff. Do not attach a newer token to an old proposal without reviewing changes.

<a id="plan-writes"></a>

## Plan approval and commit

1. Confirm the database path; inspect relevant Profile, Memory, history, Wellness, state, and source freshness.
2. Approve an outline before creating/resuming a draft. New drafts have metadata without weeks; current-plan drafts clone the editable plan.
3. Write complete weeks and validate. Resolve blocker failures and unknowns.
4. Show all prescriptions, progression, findings, unusual-duration exceptions, and replacement impact. Obtain detailed approval; outline approval is insufficient.
5. Re-read database path, plan revision, state snapshot, and Profile hash. Rebase/revalidate and renew approval when relevant context or the proposal changed.
6. Commit atomically with current guards and confirmation.

**Example — Draft commit fragment:**

```json
{
  "draftId": "<draft ID>",
  "expectedDraftRevision": 4,
  "expectedPlanRevision": 7,
  "inputSnapshotHash": "<current state snapshot>",
  "confirmed": true
}
```

Revision values are illustrative. Profile-hash comparison and database-path approval are Agent duties, not extra commit arguments.

Runtime commit checks draft/base revisions, references, and current plan validation, then saves atomically. Replaying a committed draft returns its recorded result. Discarding an open draft leaves Current Plan untouched. A changed base plan requires a fresh draft and rebase.

Drafts persist work without changing Current Plan. Resuming across conversations repeats the planning checkpoints.

## Templates and occurrences

Template edits do not rewrite Weekly Sessions. Referenced local templates cannot be deleted. Built-in deletion hides an original; customization creates a local derivation.

Next-day writes change intended training, not actual History. A skipped occurrence stays skipped when its replacement retains its ID and status; re-planning it needs a new ID. Completed snapshots are not silently replaced.

<a id="plan-and-history-matching"></a>

## Matching and history

Athria performs normal matching deterministically. An Agent must not choose a planned-session ID when recording a workout. Equal domains alone are insufficient: recognized types distinguish activities; subtype does not independently disqualify a match.

| User-directed correction | Meaning |
| --- | --- |
| Override with a planned-session ID | Apply the exact same-day relation specified by the user |
| Override with null | Mark intentionally unplanned and exclude automatic matching |
| Allow automatic matching | Clear exclusion; the matcher still decides the relation |

Existing-workout edits use its current snapshot hash. Removing a manual source preserves synchronized observations. Completing an occurrence adds a manual actual workout; it does not authorize invented performance.

## Memory exception

Memory is a revisable portrait, separate from confirmed Profile/Wellness facts. The profile Skill permits meaningful evidence-based updates without separate prior approval. Skip unchanged meaning; re-read and merge on conflict; report the saved change briefly.

## Local data and access

MCP has no arbitrary file/SQL access, database deletion, or secret-reading tools. External synchronization is read-only and initiated by desktop Connections. Hevy import is currently unavailable.

The password gates Athria access and protects connection keys; SQLite is not encrypted at rest. Stop Athria and connected clients before a single-file backup. Cloud folders do not merge concurrent edits across devices. External AI clients may send read data to their providers.

Authority: [application services](../../crates/athria-application/src/app.rs), [planner Skill](../../packages/skills/athria-training-planner/SKILL.md), [profile Skill](../../packages/skills/athria-athlete-profile/SKILL.md), and [workout Skill](../../packages/skills/athria-workout/SKILL.md).
