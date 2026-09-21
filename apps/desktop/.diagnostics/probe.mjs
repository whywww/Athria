import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ChangePasswordModal, DatabaseGate, DatabaseSwitchModal, MoreAgentsModal, NewProfileModal, RequirePasswordModal } from "../src/App";
import { RecoveryHelpModal } from "../src/overview";
import { TemplateEditorModal, emptyTemplate } from "../src/plan/TemplateEditorModal";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
const css = readFileSync(join(src, "styles.css"), "utf8") + "\n" + readFileSync(join(src, "plan", "calendar.css"), "utf8");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const noop = () => {};
const agent = (kind, name, over = {}) => ({
  agent: kind, name, available: true, configPath: `C:\\Users\\me\\.${kind}\\config.json`, skillsPath: `C:\\Program Files\\Athria\\skills`,
  mcp: { status: "installed" }, skills: { status: "installed" }, ...over,
});

const MODALS = [
  ["change-password", renderToStaticMarkup(createElement(ChangePasswordModal, { value: { currentPassword: "", password: "", confirmation: "" }, error: undefined, busy: false, onChange: noop, onClose: noop, onSubmit: noop }))],
  ["require-password", renderToStaticMarkup(createElement(RequirePasswordModal, { value: "", error: undefined, busy: false, onChange: noop, onClose: noop, onSubmit: noop }))],
  ["new-profile", renderToStaticMarkup(createElement(NewProfileModal, { target: "C:\\profiles\\fresh.sqlite3", error: undefined, busy: false, onClose: noop, onSubmit: noop }))],
  ["db-switch", renderToStaticMarkup(createElement(DatabaseSwitchModal, { preview: { path: "C:\\profiles\\backup.sqlite3", counts: { workouts: 12, templates: 3, plans: 2 }, includesCredentials: false }, error: undefined, busy: false, onClose: noop, onSubmit: noop }))],
  ["db-gate", (() => {
    const client = new QueryClient();
    client.setQueryData(["vault-status"], { databaseUuid: "id", databasePath: "C:\\profiles\\active.sqlite3", initialized: false, locked: false, remembered: false, legacySources: [] });
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(DatabaseGate)));
  })()],
  ["recovery", renderToStaticMarkup(createElement(RecoveryHelpModal, { onClose: noop }))],
  ["more-agents", (() => {
    const client = new QueryClient();
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MoreAgentsModal, { agents: [agent("codex", "Codex"), agent("claude-code", "Claude Code")], onClose: noop })));
  })()],
  ["template", renderToStaticMarkup(createElement(TemplateEditorModal, { value: { template: emptyTemplate("strength"), mode: "create" }, taxonomy: undefined, error: undefined, busy: false, onChange: noop, onClose: noop, onSave: noop }))],
  ["drawer", `<div class="sd-backdrop"><div class="sd-sheet" role="dialog"><header class="sd-header"><div class="sd-header-text"><h2 class="sd-title">Lower Strength A</h2><p class="sd-date">Mon, 21 Sep</p></div><button type="button" class="sd-close" aria-label="Close session details">×</button></header><div class="sd-meta"><span class="sd-meta-item">Week 2</span><span class="sd-meta-item">Build</span></div><div class="sd-body"><section class="sd-section"><h3 class="sd-eyebrow">Prescription</h3><p>Back squat 4 × 5 @ RPE 7</p></section><section class="sd-section"><h3 class="sd-eyebrow">Base template</h3><span class="sd-template-name">Lower Strength A</span></section></div><footer class="sd-actions"><div class="sd-actions-row"><button type="button" class="sd-action secondary">Skip</button><button type="button" class="sd-action">Complete</button></div></footer></div></div>`],
];

const BACKDROP = `<div class="shell" style="display:block;padding:24px"><section class="card"><div class="card-heading"><h2>Some Background Content</h2></div><p>The frosted panel should blur this text and its card edges. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.</p><p>The frosted panel should blur this text and its card edges. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore.</p></section><section class="card"><div class="card-heading"><h2>Another Card</h2></div><p>The frosted panel should blur this text and its card edges. Excepteur sint occaecat cupidatat non proident.</p></section></div>`;

const MEASURE = `
const q = (s) => document.querySelector(s);
const cs = (s) => { const el = q(s); return el ? getComputedStyle(el) : null; };
const pick = (s, props) => { const style = cs(s); if (!style) return null; const out = {}; for (const p of props) out[p] = style[p]; return out; };
const panel = ".connection-modal";
const out = {
  scrim: pick(".modal-backdrop", ["backdropFilter", "backgroundColor", "animationName", "animationDuration"]),
  backdropIsGlass: null,
  panel: pick(panel, ["backdropFilter", "backgroundColor", "borderRadius", "borderTopColor", "maxHeight", "animationName", "display", "flexDirection", "overflow"]),
  header: pick(panel + " > header", ["position", "justifyContent", "padding", "borderBottomWidth", "backgroundColor", "flexGrow"]),
  h2: pick(panel + " h2", ["fontSize", "fontWeight", "color", "letterSpacing"]),
  sub: pick(panel + " header p", ["fontSize", "color", "lineHeight", "marginTop"]),
  close: pick(".modal-close", ["borderRadius", "backgroundColor", "borderTopWidth", "width", "height"]),
  body: pick(panel + " .modal-body", ["overflowY", "padding", "flexGrow"]),
  bodyScrolls: null,
  actions: pick(panel + " .modal-actions", ["borderTopColor"]),
  input: pick(panel + " input", ["backgroundColor"]),
  secondary: pick(panel + " button.secondary", ["backgroundImage"]),
  drawer: { sheet: pick(".sd-sheet", ["backgroundColor", "backdropFilter", "borderLeftColor"]), backdrop: pick(".sd-backdrop", ["backgroundColor", "backdropFilter"]), close: pick(".sd-close", ["borderRadius", "backgroundColor"]) },
  gateCode: pick(".gate-database-location code", ["backgroundColor", "borderTopColor"]),
  recoveryRow: pick(".recovery-help-signals li", ["backgroundColor", "borderTopColor"]),
};
const bodyEl = q(panel + " .modal-body");
if (bodyEl) out.bodyScrolls = bodyEl.scrollHeight > bodyEl.clientHeight + 1;
const hd = q(panel + " > header");
const bt = q(panel + " .modal-body");
if (hd && bt) out.headerOverlapsBodyText = hd.getBoundingClientRect().bottom > bt.getBoundingClientRect().top + bt.scrollTop;
out.layout = (() => { const p = q(panel); if (!p) return null; const r = p.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })();
document.getElementById("measure-out").textContent = JSON.stringify(out);
`;

mkdirSync(join(here, "shots"), { recursive: true });
const results = {};
for (const [name, markup] of MODALS) {
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body style="background:#f5f5f7">${BACKDROP}${markup}<pre id="measure-out" style="position:fixed;left:-9999px"></pre><script>${MEASURE}</script></body></html>`;
  const file = join(here, `${name}.html`);
  writeFileSync(file, page);
  const args = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1440,1000", "--virtual-time-budget=1500", `--user-data-dir=${join(here, `profile-${name}`)}`, `--screenshot=${join(here, "shots", `${name}.png`)}`, "--dump-dom", `file:///${file.replace(/\\/g, "/")}`];
  const run = spawnSync(CHROME, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const dom = run.stdout ?? "";
  const match = dom.match(/<pre id="measure-out"[^>]*>([\s\S]*?)<\/pre>/);
  try {
    results[name] = match ? JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : { error: `no measure-out (status ${run.status})`, stderr: (run.stderr ?? "").slice(0, 300) };
  } catch (error) {
    results[name] = { error: `parse failed: ${error.message}`, raw: (match?.[1] ?? "").slice(0, 300) };
  }
}
writeFileSync(join(here, "measurements.json"), JSON.stringify(results, null, 2));
rmSync(join(here, "smoke.mjs"), { force: true });
for (const [name, value] of Object.entries(results)) {
  const c = value.close, p = value.panel;
  console.log(`${name}: panelFilter=${p?.backdropFilter ?? "n/a"} radius=${p?.borderRadius ?? "n/a"} h2=${value.h2?.fontSize ?? "n/a"}/${value.h2?.fontWeight ?? "n/a"} closeRadius=${c?.borderRadius ?? "n/a"} headerPos=${value.header?.position ?? "n/a"} bodyOverflow=${value.body?.overflowY ?? "n/a"} bodyScrolls=${value.bodyScrolls ?? "n/a"} anim=${p?.animationName ?? "n/a"}${value.error ? ` ERROR=${value.error}` : ""}`);
}
