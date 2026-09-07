# MVP limitations

- Windows x64 is the only supported target. The MSI is unsigned and may trigger SmartScreen.
- The UI is English-only.
- The MVP has no built-in LLM, cloud service, mobile client, or third-party write-back.
- Existing pre-v0.1 data is not migrated; final acceptance starts with an empty v0.1 database.
- The exercise catalog is intentionally small. Unknown movements fail validation instead of being guessed.
- Hevy supports the migrated CSV aliases and preview-before-commit behavior. A current real export remains a release gate.
- Intervals.icu is read-only. Real-account fields, timezone behavior, overlapping sync, and partial failure remain a release gate until temporary credentials are supplied.
- Maximum heart rate must be explicitly entered. Athria does not infer it from age.
- Missing load, RPE/RIR, heart-rate, power, recovery, or wellness data remains missing; it is never interpreted as normal.
- Strength and endurance metrics are kept separate. There is no combined fatigue/readiness score, Critical Power, W', PMC, MEV/MAV/MRV, automated medical judgment, or complex periodization generator.
- Core hard rules cover structure and explicit user constraints. Training-volume growth and similar heuristics may only be advisory.
- Formal plan versions and confirmed Profile changes require Dashboard approval. MCP cannot bypass it.
