import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Action = "dev" | "service" | "debug" | "app" | "release" | "msi";

interface HostBuild {
  platform: "windows" | "macos";
  rustTarget: "x86_64-pc-windows-msvc" | "aarch64-apple-darwin";
  bunTarget: "bun-windows-x64-baseline" | "bun-darwin-arm64";
  sidecarName: string;
  nativeDependency: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(projectRoot, "apps", "desktop");
const tauriRoot = join(desktopRoot, "src-tauri");
const bunExecutable = process.execPath;
const buildRoot = resolve(projectRoot, "..", "Athria");
const binariesRoot = join(buildRoot, "binaries");
const frontendDist = join(buildRoot, "frontend");
const cargoTargetRoot = join(buildRoot, "target");
const temporaryRoot = join(buildRoot, "tmp");
const bunWorkingRoot = join(temporaryRoot, "bun-work");

function hostBuild(): HostBuild {
  if (process.platform === "win32" && process.arch === "x64") {
    return {
      platform: "windows",
      rustTarget: "x86_64-pc-windows-msvc",
      bunTarget: "bun-windows-x64-baseline",
      sidecarName: "athria-service-x86_64-pc-windows-msvc.exe",
      nativeDependency: "@tauri-apps+cli-win32-x64-msvc@",
    };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      platform: "macos",
      rustTarget: "aarch64-apple-darwin",
      bunTarget: "bun-darwin-arm64",
      sidecarName: "athria-service-aarch64-apple-darwin",
      nativeDependency: "@tauri-apps+cli-darwin-arm64@",
    };
  }
  throw new Error(`Unsupported Athria desktop host: ${process.platform}/${process.arch}. Supported hosts are Windows x64 and macOS ARM64.`);
}

function assertNativeDependencies(host: HostBuild): void {
  const bunStore = join(projectRoot, "node_modules", ".bun");
  const entries = existsSync(bunStore) ? readdirSync(bunStore) : [];
  if (!entries.some((entry) => entry.startsWith(host.nativeDependency))) {
    throw new Error(`Dependencies for ${host.platform}/${process.arch} are not installed. Run \"bun install --force\" on this machine and try again.`);
  }
}

function run(command: string[], environment: Record<string, string> = {}, cwd = projectRoot): void {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...environment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`${command[0]} exited with code ${result.exitCode}`);
}

function environment(host: HostBuild): Record<string, string> {
  const rustCandidates = [join(homedir(), ".cargo", "bin"), "/opt/homebrew/opt/rustup/bin"];
  const rustBin = rustCandidates.find((directory) => existsSync(join(directory, host.platform === "windows" ? "cargo.exe" : "cargo")));
  const pathEntries = [dirname(bunExecutable), ...(rustBin ? [rustBin] : []), process.env.PATH ?? ""];
  return {
    ATHRIA_BUN: bunExecutable,
    CARGO_TARGET_DIR: cargoTargetRoot,
    PATH: pathEntries.join(delimiter),
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
  };
}

function buildService(host: HostBuild): void {
  mkdirSync(binariesRoot, { recursive: true });
  mkdirSync(temporaryRoot, { recursive: true });
  rmSync(bunWorkingRoot, { recursive: true, force: true });
  mkdirSync(bunWorkingRoot, { recursive: true });
  try {
    run([
      bunExecutable,
      "build",
      "--compile",
      `--target=${host.bunTarget}`,
      join(projectRoot, "apps", "service", "src", "main.ts"),
      "--outfile",
      join(binariesRoot, host.sidecarName),
    ], environment(host), bunWorkingRoot);
  } finally {
    rmSync(bunWorkingRoot, { recursive: true, force: true });
  }
}

function tauri(host: HostBuild, args: string[], includeSidecar = true): void {
  mkdirSync(frontendDist, { recursive: true });
  mkdirSync(cargoTargetRoot, { recursive: true });
  mkdirSync(temporaryRoot, { recursive: true });
  const configOverride = JSON.stringify({
    build: { frontendDist: relative(tauriRoot, frontendDist).replaceAll("\\", "/") },
    bundle: { externalBin: includeSidecar ? [relative(tauriRoot, join(binariesRoot, "athria-service")).replaceAll("\\", "/")] : [] },
  });
  const buildEnvironment = environment(host);
  if (host.platform === "macos" && args.some((argument) => argument.includes("dmg"))) buildEnvironment.CI ??= "true";
  run([bunExecutable, "run", "--cwd", desktopRoot, "tauri", ...args, "--config", configOverride, "--target", host.rustTarget], buildEnvironment);
}

const action = (process.argv[2] ?? "") as Action;
if (!["dev", "service", "debug", "app", "release", "msi"].includes(action)) {
  throw new Error("Usage: bun run scripts/desktop-build.ts <dev|service|debug|app|release|msi>");
}

const host = hostBuild();
assertNativeDependencies(host);

if (action === "service") buildService(host);
else if (action === "dev") tauri(host, ["dev", "--features", "dev-service", "--config", "src-tauri/tauri.dev.conf.json"], false);
else {
  if (action === "msi" && host.platform !== "windows") throw new Error("release:msi is available only on Windows x64. Use release:native on macOS.");
  buildService(host);
  if (action === "debug") tauri(host, host.platform === "macos" ? ["build", "--debug", "--bundles", "app"] : ["build", "--debug", "--no-bundle"]);
  if (action === "app") tauri(host, host.platform === "macos" ? ["build", "--bundles", "app"] : ["build", "--no-bundle"]);
  if (action === "release") tauri(host, ["build", "--bundles", host.platform === "macos" ? "app,dmg" : "msi"]);
  if (action === "msi") tauri(host, ["build", "--bundles", "msi"]);
}
