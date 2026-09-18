import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(projectRoot, "apps", "desktop");
const tauriRoot = join(desktopRoot, "src-tauri");
const tauriCli = join(desktopRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const buildRoot = resolve(projectRoot, "..", "Athria");
const frontendDist = join(buildRoot, "frontend");
const cargoTargetRoot = resolve(process.env.ATHRIA_CARGO_TARGET_DIR ?? join(buildRoot, "target"));
const temporaryRoot = join(buildRoot, "tmp");

function hostBuild() {
  if (process.platform === "win32" && process.arch === "x64") {
    return {
      platform: "windows",
      rustTarget: "x86_64-pc-windows-msvc",
    };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      platform: "macos",
      rustTarget: "aarch64-apple-darwin",
    };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return { platform: "linux", rustTarget: "x86_64-unknown-linux-gnu" };
  }
  throw new Error(`Unsupported Athria desktop host: ${process.platform}/${process.arch}. Supported hosts are Windows x64, macOS ARM64 and Linux x64.`);
}

function run(command, environment = {}, cwd = projectRoot) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, ...environment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command[0]} exited with code ${result.status}`);
}

function environment(host) {
  const rustCandidates = [join(homedir(), ".cargo", "bin"), "/opt/homebrew/opt/rustup/bin"];
  const rustBin = rustCandidates.find((directory) => existsSync(join(directory, host.platform === "windows" ? "cargo.exe" : "cargo")));
  const pathEntries = [...(rustBin ? [rustBin] : []), process.env.PATH ?? ""];
  const executablePath = pathEntries.join(delimiter);
  return {
    CARGO_TARGET_DIR: cargoTargetRoot,
    PATH: executablePath,
    ...(host.platform === "windows" ? { Path: executablePath } : {}),
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
  };
}

function tauri(host, args) {
  mkdirSync(frontendDist, { recursive: true });
  mkdirSync(cargoTargetRoot, { recursive: true });
  mkdirSync(temporaryRoot, { recursive: true });
  const configOverride = JSON.stringify({
    build: { frontendDist: relative(tauriRoot, frontendDist).replaceAll("\\", "/") },
  });
  const buildEnvironment = environment(host);
  if (host.platform === "macos" && args.some((argument) => argument.includes("dmg"))) buildEnvironment.CI ??= "true";
  if (!existsSync(tauriCli)) throw new Error('Tauri CLI is not installed. Run "pnpm install" and try again.');
  run([process.execPath, tauriCli, ...args, "--config", configOverride, "--target", host.rustTarget], buildEnvironment, desktopRoot);
}

const action = process.argv[2] ?? "";
if (!["dev", "debug", "app", "release", "msi"].includes(action)) {
  throw new Error("Usage: node scripts/desktop-build.mjs <dev|debug|app|release|msi>");
}

const host = hostBuild();

if (action === "dev") tauri(host, ["dev", "--config", "src-tauri/tauri.dev.conf.json"]);
else {
  if (action === "msi" && host.platform !== "windows") throw new Error("release:msi is available only on Windows x64. Use release:native on macOS or Linux.");
  if (action === "debug") tauri(host, host.platform === "macos" ? ["build", "--debug", "--bundles", "app"] : ["build", "--debug", "--no-bundle"]);
  if (action === "app") tauri(host, host.platform === "macos" ? ["build", "--bundles", "app"] : ["build", "--no-bundle"]);
  if (action === "release") tauri(host, ["build", "--bundles", host.platform === "macos" ? "app,dmg" : host.platform === "linux" ? "appimage,deb" : "msi"]);
  if (action === "msi") tauri(host, ["build", "--bundles", "msi"]);
}
