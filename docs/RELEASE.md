# Athria desktop artifacts

Build date: 2026-09-02  
Version: 0.2.0  
Signing: unsigned

## Build workflows

- `bun run dev` runs the Tauri debug application with Vite and the TypeScript service in watch mode. It does not compile or package the sidecar.
- `bun run build:app` compiles the sidecar and produces a directly runnable host-native application without creating an installer.
- `bun run release:msi` compiles the sidecar and creates the MSI. `bun run build:desktop` is retained as a compatibility alias.
- `bun run release:native` creates an MSI on Windows or an app plus DMG on Apple Silicon macOS.

Build output is machine-local under `~/Documents/HAILEY/Athria` by default and can be redirected with `ATHRIA_BUILD_ROOT`. MSI builds are reserved for release and installation validation. The development service locates Bun through `ATHRIA_BUN`, the repository portable runtime, or `PATH`, in that order; installed builds continue to use the bundled sidecar and require no Bun runtime.

## Current artifact

- Legacy file: `$ATHRIA_BUILD_ROOT/target/x86_64-pc-windows-msvc/release/bundle/msi/Athria_0.1.0_x64_en-US.msi`
- Size: 47,149,056 bytes
- SHA-256: `FB321AD29F5CE7F0F2C2F9EA8EFB98BCC9647D7B03682C6A8EFCAA81EE2EA2E3`

The MSI was administratively extracted successfully. The extracted layout contained `athria.exe` and `athria-service.exe`, and its `Athria.exe mcp` entry passed initialization, 22-tool enumeration, stdout-purity, and stderr-silence checks.

This artifact is a development MVP, not a production release. Clean Windows Sandbox/VM install-uninstall-reinstall, real Codex configuration, current Hevy CSV, and temporary Intervals.icu credential validation remain release gates.
