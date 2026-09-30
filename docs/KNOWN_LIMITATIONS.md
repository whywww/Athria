# MVP limitations

- Native development targets Windows x64 and Apple Silicon macOS. Windows ARM, Intel macOS, Linux, mobile clients, and cross-compilation are future work rather than supported targets. The MSI is unsigned and may trigger SmartScreen. macOS development builds use ad-hoc signing and require the Athria database password on each launch; Athria does not access the macOS Keychain.
- The UI supports English and Simplified Chinese.
- The MVP has no built-in LLM, cloud service, mobile client, or third-party write-back.
- Only the current Plan Schema v7 contracts are retained in the working tree; older contracts remain available through Git history. Runtime writes accept v7 only, and incompatible planning data is cleared during the development cutover so saved plans use authoritative Weekly Sessions and domain progression timelines.
- Exercises are open-world and Athria has no exercise catalog. Every planned exercise carries its own classified facts; a blocker lacking a required trusted fact returns `UNKNOWN`.
- Hevy supports the migrated CSV aliases and preview-before-commit behavior. A current real export remains a release gate.
- Intervals.icu is read-only. Real-account fields, timezone behavior, overlapping sync, and partial failure remain a release gate until temporary credentials are supplied.
- Maximum heart rate must be explicitly entered. Athria does not infer it from age.
- Missing load, RPE, heart-rate, power, recovery, or wellness data remains missing; it is never interpreted as normal.
- Strength and endurance metrics are kept separate. There is no combined fatigue/readiness score, Critical Power, W', PMC, MEV/MAV/MRV, automated medical judgment, or complex periodization generator.
- Core blocker rules cover structure and typed equipment, duration, training-rhythm, and explicit-recovery constraints. Free-text `injuries` and `constraintNotes` are context only (max 10 entries of 200 characters each, one issue per entry, no duplicates). Training-volume balance and similar heuristics remain advisory.
- Strength has a scientific rule pack. Endurance, Sport skill, Mind-body, and Recovery currently have structured components but no domain-specific scientific rules.
- Athria keeps only the latest templates and Current Mesocycle; it provides optimistic revision conflicts, not plan/template history or restore. Explicitly confirmed Agent Profile updates write directly.
- Future planned-session synchronization updates only reconstructable `planned` snapshots. Completed, skipped, and legacy snapshots are intentionally immutable; changing a Mesocycle does not auto-create new sessions.
- The database password gates access inside Athria and unlocks saved connection keys. The `.sqlite3` file itself is not encrypted at rest, so direct file access with a standard SQLite tool is not protected. Resetting the password from the Unlock dialog keeps training data but permanently removes saved connection keys, which must be entered again.
