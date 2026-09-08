# MVP limitations

- Native development targets Windows x64 and Apple Silicon macOS. Windows ARM, Intel macOS, Linux, and cross-compilation are unsupported. The MSI is unsigned and may trigger SmartScreen; macOS debug builds use ad-hoc signing and a rebuilt binary may prompt again for Keychain access.
- The UI is English-only.
- The MVP has no built-in LLM, cloud service, mobile client, or third-party write-back.
- Plan Schema v2/v3 files are retained as historical format documentation. Runtime writes accept v4 only; the v5 database migration imports the latest approved legacy plan into the template library and Current Mesocycle, then removes active legacy plan history.
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
