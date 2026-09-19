import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";

const address = "127.0.0.1:37374";
const url = `http://${address}/mcp`;
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const executable = resolve("target/debug/examples", process.platform === "win32" ? "conformance_server.exe" : "conformance_server");
const cli = resolve("node_modules/@modelcontextprotocol/conformance/dist/index.js");

const build = spawnSync(cargo, ["build", "-p", "athria-mcp", "--features", "conformance", "--example", "conformance_server"], {
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(executable, [address], {
  stdio: ["ignore", "inherit", "inherit"],
});

function waitForPort() {
  return new Promise((resolveReady, reject) => {
    const deadline = Date.now() + 90_000;
    const attempt = () => {
      const socket = connect({ host: "127.0.0.1", port: 37374 });
      socket.once("connect", () => { socket.destroy(); resolveReady(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error("conformance server did not start"));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

let exitCode = 0;
try {
  await waitForPort();
  for (const scenario of ["server-initialize", "tools-list", "dns-rebinding-protection"]) {
    const result = spawnSync(process.execPath, [cli, "server", "--url", url, "--scenario", scenario, "--spec-version", "2025-11-25"], { encoding: "utf8" });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const windowsLibuvExit = process.platform === "win32" && result.status === 0xc0000409;
    const checksPassed = output.includes("0 failed, 0 warnings");
    if (result.error) throw result.error;
    if (result.status !== 0 && !(windowsLibuvExit && checksPassed)) exitCode = result.status ?? 1;
  }
} finally {
  server.kill();
}
process.exitCode = exitCode;
