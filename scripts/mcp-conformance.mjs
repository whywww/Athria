import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";

const address = "127.0.0.1:37374";
const url = `http://${address}/mcp`;
const executable = process.platform === "win32" ? "cargo.exe" : "cargo";
const cli = resolve("node_modules/@modelcontextprotocol/conformance/dist/index.js");
const server = spawn(executable, ["run", "-p", "athria-mcp", "--features", "conformance", "--example", "conformance_server", "--", address], {
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
    const result = spawnSync(process.execPath, [cli, "server", "--url", url, "--scenario", scenario, "--spec-version", "2025-11-25"], { stdio: "inherit" });
    if (result.status !== 0) exitCode = result.status ?? 1;
  }
} finally {
  server.kill();
}
process.exitCode = exitCode;
