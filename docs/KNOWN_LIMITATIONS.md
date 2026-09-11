# MVP limitations

- Native development targets Windows x64 and Apple Silicon macOS. Windows ARM, Intel macOS, Linux, and cross-compilation are unsupported. The MSI is unsigned and may trigger SmartScreen; macOS debug builds use ad-hoc signing and a rebuilt binary may prompt again for Keychain access.
- The UI is English-only.
- The MVP has no built-in LLM, cloud service, mobile client, or third-party write-back.
- Plan Schema v2–v6 files are retained as historical format documentation. Runtime writes accept v7 only; this development cutover backs up and clears incompatible planning data so saved plans use authoritative Weekly Sessions and domain progression timelines.
- The exercise catalog is intentionally small, but exercises are open-world. Missing catalog membership never fails by itself; only a blocker that lacks a required trusted fact returns `UNKNOWN`.
- Hevy supports the migrated CSV aliases and preview-before-commit behavior. A current real export remains a release gate.
- Intervals.icu is read-only. Real-account fields, timezone behavior, overlapping sync, and partial failure remain a release gate until temporary credentials are supplied.
- Maximum heart rate must be explicitly entered. Athria does not infer it from age.
- Missing load, RPE/RIR, heart-rate, power, recovery, or wellness data remains missing; it is never interpreted as normal.
- Strength and endurance metrics are kept separate. There is no combined fatigue/readiness score, Critical Power, W', PMC, MEV/MAV/MRV, automated medical judgment, or complex periodization generator.
- Core blocker rules cover structure and typed user constraints. Free-text `constraintNotes` are context only. Training-volume balance and similar heuristics remain advisory.
- Strength has a scientific rule pack. Endurance, Sport skill, Mind-body, and Recovery currently have structured components but no domain-specific scientific rules.
- Athria keeps only the latest templates and Current Mesocycle; it provides optimistic revision conflicts, not plan/template history or restore. Confirmed Profile changes still require Dashboard approval.
- Future planned-session synchronization updates only reconstructable `planned` snapshots. Completed, skipped, and legacy snapshots are intentionally immutable; changing a Mesocycle does not auto-create new sessions.
- A pending Profile change proposal is bound to the Profile snapshot hash captured at creation time. Any Profile change — including a schema migration such as the v10 `priority`→`preference` upgrade — invalidates pending proposals with `INPUT_SNAPSHOT_CHANGED` (409). There is no reject/cancel API, so an invalidated proposal must be re-proposed against the current Profile. This mirrors the existing optimistic-concurrency design for normal Profile edits; the data-layer migration deliberately does not recompute `base_snapshot_hash`, because that application-layer invariant (`stableHash(getProfile())`) lives in `@athria/core` and forcing the persistence layer to depend on it would invert the sibling layering and embed a fragile hash contract inside a migration.
