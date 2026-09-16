import { spawnSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Backup } from "./src/App";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const card = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Backup)));

const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./src/styles.css"><style>
body { overflow: visible !important; height: auto !important; }
.verify-shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); gap: 14px; padding: 26px 0 26px 20px; background: var(--app-background); }
.verify-main { padding: 18px 28px 54px 0; }
</style></head><body><div class="verify-shell"><aside></aside><div class="verify-main">${card}</div></div><script>
const rect = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
const button = document.querySelector(".backup-create-row > button");
const toggle = document.querySelector(".backup-credentials-toggle");
const note = document.querySelector(".backup-credentials-note");
const data = { button: rect(button), toggle: rect(toggle), note: rect(note), toggleRightOfButton: toggle.getBoundingClientRect().left >= button.getBoundingClientRect().right, noteBelowToggle: note.getBoundingClientRect().top >= toggle.getBoundingClientRect().bottom - 1, toggleText: document.querySelector(".backup-credentials-toggle span").textContent, noteText: note.textContent, noteFont: getComputedStyle(note).fontSize + " " + getComputedStyle(note).color };
const pre = document.createElement("pre");
pre.id = "measurements";
pre.style.cssText = "position:fixed;left:-9999px;top:0";
pre.textContent = JSON.stringify(data, null, 2);
document.body.appendChild(pre);
</script></body></html>`;
writeFileSync("verify-backup-row.html", html);

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const url = "file:///C:/Users/tclre/Documents/HAILEY/Athria-repo/apps/desktop/verify-backup-row.html";
const common = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1180,1300", "--virtual-time-budget=3000"];

const shot = spawnSync(chrome, [...common, "--screenshot=C:/Users/tclre/Documents/HAILEY/Athria-repo/apps/desktop/verify-backup-row-1180.png", url], { encoding: "utf8" });
console.log("screenshot status:", shot.status, (shot.stderr || "").trim().slice(-200));
console.log("png exists:", existsSync("verify-backup-row-1180.png"), existsSync("verify-backup-row-1180.png") ? statSync("verify-backup-row-1180.png").size + " bytes" : "");

const dom = spawnSync(chrome, [...common, "--dump-dom", url], { encoding: "utf8" });
const match = dom.stdout.match(/<pre id="measurements"[^>]*>([\s\S]*?)<\/pre>/);
if (match) {
  const decoded = match[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  console.log("MEASUREMENTS:\n" + decoded);
} else {
  console.log("no measurements found; stdout sample:", dom.stdout.slice(0, 400));
}
