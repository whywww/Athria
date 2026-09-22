# Repository workflow

- After modifying application code, run the relevant tests only: `pnpm test` and `pnpm typecheck`, plus `cargo test` when Rust code changed.
- Do not rebuild the desktop app as part of handing work back; the user builds it themselves.
- Report the test results in the final response instead of a build artifact path.
