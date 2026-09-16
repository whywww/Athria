// Visual + geometry verification for the Profile Race Days module.
// Renders real components via SSR, screenshots them with headless Chrome,
// and asserts that Race Days aligns with the Training Rhythm column.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentManagedDetails, EditableProfileBoard, ProfileBoard } from "./src/App";
import type { AthleteProfile } from "./src/view-models";

const ROOT = "C:/Users/tclre/Documents/HAILEY/Athria-repo";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const css = readFileSync(`${ROOT}/apps/desktop/src/styles.css`, "utf8");

const shift = (offset: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

const baseProfile = (raceDays: AthleteProfile["raceDays"]): AthleteProfile => ({
  ownerId: "local-user", preferredName: "Athlete", gender: null, heightCm: null, birthDate: null,
  timezone: "Asia/Hong_Kong", goals: ["general_fitness", "improve_endurance"],
  preference: "I prefer a varied mix of training styles with morning sessions.",
  maxSessionMinutes: 90, trainingRhythm: { kind: "flexible_week", targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 },
  equipment: [], injuries: [], constraintNotes: [], explicitRecoveryDays: null, mesocycleDurationWeeks: 8, unitSystem: "metric", raceDays,
});

const shell = (content: ReactNode, extra?: ReactNode) => createElement("div", { className: "shell" },
  createElement("aside", null),
  createElement("main", { className: "primary-main" },
    createElement("header", { className: "primary-page-header" },
      createElement("div", null, createElement("h1", null, "Hi, Athlete!"), createElement("p", null, "Your training preferences — saved for the long term and built into every plan."))),
    content,
    extra ?? null,
  ),
);

const card = (editing: boolean, body: ReactNode, extra?: ReactNode) => shell(
  createElement("div", { className: "profile-page" },
    createElement("section", { className: `card profile-board ${editing ? "is-editing" : ""}` },
      createElement("div", { className: "card-heading" },
        createElement("h2", null, createElement("span", { className: "profile-card-title" }, createElement("span", null, "Training Profile", createElement("small", null, "Your training setup and preferences")))),
        createElement("div", { className: "profile-actions" }, createElement("button", { className: "secondary compact edit-button" }, "Edit"))),
      body,
    ),
  ),
  extra,
);

const agentCard = (profile: AthleteProfile) => createElement("section", { className: "card profile-suggestions" },
  createElement("div", { className: "card-heading" }, createElement("h2", null, createElement("span", { className: "profile-card-title" }, createElement("span", null, "Agent Suggestions", createElement("small", null, "Personalized guidance based on your profile"))))),
  createElement(AgentManagedDetails, { profile }),
);

const inputStub = () => undefined;
const editorBoard = (profile: AthleteProfile, draft: { date: string; sport: string; custom: string }, draftValid: boolean) => createElement(EditableProfileBoard, {
  profile, form: profile,
  setForm: inputStub as never,
  customGoal: "", setCustomGoal: inputStub as never,
  availableGoals: ["general_fitness", "improve_endurance"], setAvailableGoals: inputStub as never,
  toggleList: inputStub as never, toggleTrainingDay: inputStub as never,
  raceDraft: draft, setRaceDraft: inputStub as never, raceDraftValid: draftValid,
  addRaceDay: inputStub as never, removeRaceDay: inputStub as never,
});

const html = (title: string, selectors: Record<string, string>, nodes: ReactNode[]) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head>
<body>
<div id="root">${nodes.map((node) => renderToStaticMarkup(node)).join("")}</div>
<pre id="measurements" style="display:none"></pre>
<script>
window.addEventListener("load", () => {
  const out = {};
  for (const [key, selector] of Object.entries(${JSON.stringify(selectors)})) {
    const element = document.querySelector(selector);
    if (!element) { out[key] = null; continue; }
    const rect = element.getBoundingClientRect();
    out[key] = { left: +rect.left.toFixed(2), top: +rect.top.toFixed(2), width: +rect.width.toFixed(2), height: +rect.height.toFixed(2), bottom: +rect.bottom.toFixed(2) };
  }
  document.getElementById("measurements").textContent = JSON.stringify(out);
});
</script>
</body>
</html>`;

interface Measurement { left: number; top: number; width: number; height: number; bottom: number }
interface Check { label: string; pass: boolean; detail: string }
const checks: Check[] = [];
const push = (label: string, pass: boolean, detail: string) => checks.push({ label, pass, detail });

const run = (name: string, width: number, height: number, documentHtml: string, selectors: Record<string, string>, texts: string[] = [], geometry?: (m: Record<string, Measurement>) => void) => {
  const file = `${ROOT}/verify-race-${name}.html`;
  writeFileSync(file, documentHtml);
  const url = `file:///${file}`;
  const common = ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${width},${height}`, "--virtual-time-budget=3000"];
  const shot = spawnSync(CHROME, [...common, `--screenshot=${ROOT}/verify-race-${name}.png`, url], { encoding: "utf8" });
  push(`${name}: screenshot`, shot.status === 0, `status=${shot.status}`);
  const dom = spawnSync(CHROME, [...common, "--dump-dom", url], { encoding: "utf8" });
  push(`${name}: dump-dom`, dom.status === 0, `status=${dom.status}`);
  const raw = dom.stdout.match(/<pre id="measurements"[^>]*>([\s\S]*?)<\/pre>/)?.[1]?.trim() ?? "";
  const decoded = raw.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  let measurements: Record<string, Measurement> = {};
  try { measurements = JSON.parse(decoded) as Record<string, Measurement>; } catch { push(`${name}: measurements parsed`, false, decoded.slice(0, 160)); }
  for (const text of texts) push(`${name}: contains "${text}"`, dom.stdout.includes(text), "");
  if (geometry) geometry(measurements);
};

const raceDaysMulti = [{ date: shift(-120), sport: "10K" }, { date: shift(12), sport: "Marathon" }, { date: shift(45), sport: "Trail Run" }];

// 1. Readonly empty state.
run("readonly-empty", 1180, 900,
  html("Race Days — empty", { goals: ".profile-goals-panel", preferences: ".profile-summary-item", rhythmInner: ".profile-rhythm-summary > div:first-child", rhythm: ".profile-rhythm-summary", race: ".race-days-summary", stack: ".profile-column-stack" },
    [card(false, createElement(ProfileBoard, { profile: baseProfile([]), equipmentCategories: [] }), agentCard(baseProfile([])))]),
  { goals: ".profile-goals-panel", preferences: ".profile-summary-item", rhythmInner: ".profile-rhythm-summary > div:first-child", rhythm: ".profile-rhythm-summary", race: ".race-days-summary", stack: ".profile-column-stack" },
  ["No upcoming races", "Training Rhythm", "Max Session Length", "Mesocycle Length"],
  (m) => {
    push("empty: race below rhythm", m.race.top >= m.rhythmInner.bottom - 1, `race.top=${m.race.top} rhythmInner.bottom=${m.rhythmInner.bottom}`);
    push("empty: race left aligned with rhythm", Math.abs(m.race.left - m.rhythmInner.left) < 2, `race.left=${m.race.left} rhythmInner.left=${m.rhythmInner.left}`);
    push("empty: race width matches rhythm", Math.abs(m.race.width - m.rhythmInner.width) < 2, `race.width=${m.race.width} rhythmInner.width=${m.rhythmInner.width}`);
  });

// 2. Readonly single race with countdown chip.
run("readonly-single", 1180, 900,
  html("Race Days — single", { race: ".race-days-summary", rhythmInner: ".profile-rhythm-summary > div:first-child" },
    [card(false, createElement(ProfileBoard, { profile: baseProfile([{ date: shift(12), sport: "Marathon" }]), equipmentCategories: [] }))]),
  { race: ".race-days-summary", rhythmInner: ".profile-rhythm-summary > div:first-child" },
  ["Race Days", "Marathon", "race-countdown"],
  (m) => {
    push("single: race below rhythm", m.race.top >= m.rhythmInner.bottom - 1, `race.top=${m.race.top} rhythmInner.bottom=${m.rhythmInner.bottom}`);
    push("single: race left aligned with rhythm", Math.abs(m.race.left - m.rhythmInner.left) < 2, `race.left=${m.race.left} rhythmInner.left=${m.rhythmInner.left}`);
  });

// 3. Readonly multiple races: nearest upcoming + "+N more".
run("readonly-multi", 1180, 900,
  html("Race Days — multi", { race: ".race-days-summary" },
    [card(false, createElement(ProfileBoard, { profile: baseProfile(raceDaysMulti), equipmentCategories: [] }), agentCard(baseProfile(raceDaysMulti)))]),
  { race: ".race-days-summary" },
  ["+1 more scheduled", "Marathon", "Race Focus"]);

// 4. Editor with races listed and a disabled Add button.
const editorProfile = baseProfile(raceDaysMulti);
run("editor-default", 1180, 1400,
  html("Race Days — editor", { rpmHeading: ".profile-rhythm-editor .profile-editor-heading", options: ".profile-rhythm-options", race: ".race-days-editor", stack: ".profile-column-stack" },
    [card(true, editorBoard(editorProfile, { date: "", sport: "Marathon", custom: "" }, false))]),
  { rpmHeading: ".profile-rhythm-editor .profile-editor-heading", options: ".profile-rhythm-options", race: ".race-days-editor", stack: ".profile-column-stack" },
  ["Race Days", "+ Add race", "Other…", "Trail Run", "10K"],
  (m) => {
    push("editor: race below rhythm options", m.race.top >= m.options.bottom - 1, `race.top=${m.race.top} options.bottom=${m.options.bottom}`);
    push("editor: race left aligned with rhythm heading", Math.abs(m.race.left - m.rpmHeading.left) < 2, `race.left=${m.race.left} heading.left=${m.rpmHeading.left}`);
    push("editor: race width matches rhythm options", Math.abs(m.race.width - m.options.width) < 2, `race.width=${m.race.width} options.width=${m.options.width}`);
  });

// 5. Editor with the free-text "Other…" input revealed.
run("editor-other", 1180, 1400,
  html("Race Days — editor other", { race: ".race-days-editor" },
    [card(true, editorBoard(editorProfile, { date: "2027-06-01", sport: "__other__", custom: "Spartan Race" }, true))]),
  { race: ".race-days-editor" },
  ["Spartan Race", "Race name", "+ Add race"]);

let failures = 0;
for (const check of checks) {
  if (!check.pass) failures += 1;
  console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.label}${check.detail ? `  (${check.detail})` : ""}`);
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
