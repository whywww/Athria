# Mobile runtime boundary

Athria's mobile shells embed the same Rust crates used by desktop and CLI:

```text
Tauri iOS / Android shell
  -> platform document picker and credential adapter
  -> hydrate portable workspace into device-local SQLite
  -> open_workspace_store(WorkspaceId, PlatformDocument, SqliteStore)
  -> AthriaApplication
```

The application and core crates never receive a path, document URI, keyring handle, or localhost URL. The shell owns iOS security-scoped bookmarks or Android document URIs and passes an already-open store to the runtime. Mobile does not spawn a JavaScript runtime.

Cloud documents are portable checkpoints, not live multi-device SQLite databases. A shell copies/hydrates a cloud document to a device-local working database and checkpoints or exports it back using a single-writer policy. Multi-device merge is outside this migration.

Shared-core build targets:

```text
cargo check --target aarch64-apple-ios -p athria-core -p athria-application -p athria-integrations -p athria-store -p athria-runtime
cargo check --target aarch64-linux-android -p athria-core -p athria-application -p athria-integrations -p athria-store -p athria-runtime
```

These checks validate the shared runtime only. Producing signed Tauri mobile packages additionally requires Xcode on macOS or an Android SDK/NDK.
