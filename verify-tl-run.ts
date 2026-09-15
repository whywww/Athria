import { spawnSync } from "node:child_process";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const url = "file:///C:/Users/tclre/Documents/HAILEY/Athria-repo/verify-tl-header.html";
const common = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1180,900", "--virtual-time-budget=3000"];

const shot = spawnSync(chrome, [...common, "--screenshot=C:/Users/tclre/Documents/HAILEY/Athria-repo/verify-tl-1180.png", url], { encoding: "utf8" });
console.log("screenshot status:", shot.status, (shot.stderr || "").trim().slice(-200));

const dom = spawnSync(chrome, [...common, "--dump-dom", url], { encoding: "utf8" });
console.log("dump-dom status:", dom.status);
const m = dom.stdout.match(/<pre id="measurements">([\s\S]*?)<\/pre>/);
if (m) {
  const decoded = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  console.log("MEASUREMENTS:\n" + decoded);
} else {
  console.log("no measurements found; stdout sample:", dom.stdout.slice(0, 600));
}
