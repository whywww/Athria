import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { checkSkillUpdates, installSkillUpdate, setSkillAutoUpdate, type SkillUpdateStatus } from "./api";
import { SkillUpdates, skillUpdateButtonLabel, formatSkillCheckTime, skillUpdateQueryKey } from "./skill-updates";
import { LanguageProvider, translate } from "./i18n";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const status: SkillUpdateStatus = { automatic: true, keyConfigured: true, currentVersion: "0.1.0", source: "bundled", phase: "idle", availableVersion: null, latestVersion: null, upgradeRequired: false, lastAttempt: null, lastSuccess: null, error: null, syncFailures: [], claudeInstallRequired: false };
function render(value: SkillUpdateStatus) {
  const client = new QueryClient(); client.setQueryData(skillUpdateQueryKey, value);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SkillUpdates)));
}

describe("Skill updates", () => {
  it("renders only a description, version, last check, action and automatic switch", () => {
    const html = render(status);
    expect(html).toContain("Automatically get skill updates compatible with your Athria version.");
    expect(html).toContain("Version"); expect(html).toContain("0.1.0");
    expect(html).toContain("Last checked"); expect(html).toContain("Not checked yet");
    expect(html).toContain('aria-checked="true"'); expect(html).toContain("Automatic updates");
    expect(html).not.toContain("Included with Athria");
    expect(render({ ...status, automatic: false })).not.toContain('aria-checked="true"');
  });
  it("replaces the check button with a single compatible-update button", () => {
    const html = render({ ...status, availableVersion: "0.1.1", latestVersion: "0.2.0", upgradeRequired: true });
    expect(html).toContain("Update to 0.1.1"); expect(html).not.toContain("Check for updates");
    expect(html.match(/class="secondary compact"/g)).toHaveLength(1);
    expect(html).not.toContain("Newer Skills require");
    expect(render({ ...status, upgradeRequired: true })).toContain("Check for updates");
  });
  it("never renders raw errors, bottom status or synchronization hints", () => {
    const html = render({ ...status, error: "PRIVATE backend error", syncFailures: ["PRIVATE locked directory"], claudeInstallRequired: true, lastSuccess: 1 });
    for (const text of ["PRIVATE", "Update error details", "<details", 'role="alert"', 'role="status"', "some agents", "Claude", "up to date", "Skills are ready"]) expect(html).not.toContain(text);
  });
  it("uses the button alone for progress and disables unavailable updates", () => {
    for (const [phase, label] of [["checking", "Checking…"], ["downloading", "Downloading…"], ["installing", "Installing…"]] as const) {
      const html = render({ ...status, phase });
      expect(html).toContain(label); expect(html).toContain('disabled=""');
      expect(translate(label, "zh-CN")).not.toBe(label);
    }
    const html = render({ ...status, keyConfigured: false });
    expect(html).toContain('disabled=""'); expect(html).not.toContain("not configured");
    expect(skillUpdateButtonLabel(status, "checking")).toBe("Checking…");
  });
  it("puts the switch in its own row between the heading and footer", () => {
    const html = render(status);
    expect(html).toMatch(/class="skill-auto-update-row"><span>Automatic updates<\/span><button[^]*?role="switch"/);
    expect(html.indexOf('class="skill-auto-update-row"')).toBeGreaterThan(html.indexOf('class="skill-update-actions"'));
    expect(html.indexOf('class="skill-update-metadata"')).toBeGreaterThan(html.indexOf('role="switch"'));
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Automatically keep");
    expect(html).toContain('aria-label="Automatic updates"');
  });
  it("renders the requested Chinese title and short local date without seconds", () => {
    const timestamp = new Date(2025, 9, 7, 9, 32).getTime() / 1000;
    expect(formatSkillCheckTime(timestamp, "zh-CN")).toBe("2025年10月7日 09:32");
    expect(formatSkillCheckTime(timestamp, "en")).toContain("2025");
    expect(render({ ...status, lastAttempt: timestamp })).toContain(formatSkillCheckTime(timestamp, "en"));
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    try {
      const client = new QueryClient(); client.setQueryData(skillUpdateQueryKey, { ...status, lastAttempt: timestamp });
      const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(QueryClientProvider, { client }, createElement(SkillUpdates))));
      expect(html).toContain("技能更新"); expect(html).toContain("自动获取适用于当前 Athria 的技能更新。");
      expect(html).toContain("自动更新"); expect(html).toContain("版本"); expect(html).toContain("2025年10月7日 09:32");
    } finally {
      vi.unstubAllGlobals();
      renderToStaticMarkup(createElement(LanguageProvider, null));
    }
  });
  it("uses Today only for the same local calendar day", () => {
    const now = new Date(2026, 9, 7, 12, 0);
    const today = new Date(2026, 9, 7, 10, 10).getTime() / 1000;
    expect(formatSkillCheckTime(today, "zh-CN", now)).toBe("今天 10:10");
    expect(formatSkillCheckTime(today, "en", now)).toBe("Today 10:10");
    const yesterday = new Date(2026, 9, 6, 23, 59).getTime() / 1000;
    expect(formatSkillCheckTime(yesterday, "zh-CN", now)).toBe("2026年10月6日 23:59");
  });
  it("sends explicit background policy and package identity, never an install URL", async () => {
    vi.mocked(invoke).mockResolvedValue(status);
    await checkSkillUpdates(true); expect(invoke).toHaveBeenLastCalledWith("check_skill_updates", { background: true });
    await checkSkillUpdates(); expect(invoke).toHaveBeenLastCalledWith("check_skill_updates", { background: false });
    await setSkillAutoUpdate(false); expect(invoke).toHaveBeenLastCalledWith("set_skill_auto_update", { automatic: false });
    await installSkillUpdate("0.1.1"); expect(invoke).toHaveBeenLastCalledWith("install_skill_update", { version: "0.1.1" });
  });
});
