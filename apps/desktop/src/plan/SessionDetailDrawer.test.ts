import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n";
import type { CalendarSession, CurrentPlan } from "../view-models";
import { SessionDetailDrawer } from "./SessionDetailDrawer";

const session: CalendarSession = {
  id: "easy-run", occurrenceId: "occ-run", revision: 1, scheduledDate: "2026-10-11", order: 0, weekNumber: 1,
  phaseRefs: [], templateRef: null, name: "Easy run", intent: "Keep it easy", durationMinutes: 60,
  recoveryDemand: "low", keySession: false, progressionNote: null, schedulingRationale: null,
  status: "planned", legacySnapshot: false, overrideReason: null, type: null, domain: "endurance",
  prescription: { blocks: [{ type: "step", name: "Easy work", role: "steady", durationSeconds: 3600, notes: "Keep it easy" }] },
};

function render(value: CalendarSession, plan: CurrentPlan | null = null) {
  return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(SessionDetailDrawer, {
    session: value, templates: [], plan, today: "2026-10-08", onClose: () => undefined, onMutated: () => undefined,
  })));
}

describe("SessionDetailDrawer domain presentation", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(["en", "zh-CN"])("shows the session name once inside the prescription card and keeps module names in %s", (language) => {
    vi.stubGlobal("localStorage", { getItem: () => language });
    const html = render({ ...session, name: "游泳课", prescription: { blocks: [
      { type: "step", name: "换气练习", role: "steady", durationSeconds: 1800, rpe: "4" },
    ] } });
    expect(html).not.toContain('class="sd-title"');
    expect(html.match(/<h4>游泳课<\/h4>/g)).toHaveLength(1);
    expect(html).toContain('<div class="rx-panel-copy"><h4>游泳课</h4>');
    expect(html.indexOf('class="sd-date"')).toBeLessThan(html.indexOf('<h4>游泳课</h4>'));
    expect(html).toContain('<section class="sd-section sd-prescription-section"><div class="sd-prescriptions"><article');
    const header = html.match(/<header class="sd-header">[\s\S]*?<\/header>/)?.[0];
    expect(header).toContain('class="sd-date"');
    expect(header).toContain('class="sd-close"');
    expect(html).toContain("换气练习");
    expect(html).toContain("RPE 4");
  });
  it("keeps the title and empty state for a migrated null prescription", () => {
    const html = render({ ...session, prescription: null });
    expect(html).toContain('<div class="rx-panel-copy"><h4>Easy run</h4>');
    expect(html).toContain("No structured prescription is available for this session.");
  });
  it.each(["en", "zh-CN"])("keeps the legacy notice before the date and prescription card in %s", (language) => {
    vi.stubGlobal("localStorage", { getItem: () => language });
    const html = render({ ...session, legacySnapshot: true });
    expect(html).toContain('<div class="rx-panel-copy"><h4>Easy run</h4>');
    expect(html.match(/<h4>Easy run<\/h4>/g)).toHaveLength(1);
    expect(html).toContain('class="sd-section sd-legacy"');
    expect(html.indexOf('class="sd-section sd-legacy"')).toBeLessThan(html.indexOf('class="sd-date"'));
    expect(html).toContain('<section class="sd-section sd-prescription-section"><div class="sd-prescriptions"><article');
    expect(html).toContain("rx-endurance-table");
    expect(html).toContain("Keep it easy");
  });
  it.each(["en", "zh-CN"])("combines date, week and resolved phases without a tag row in %s", (language) => {
    vi.stubGlobal("localStorage", { getItem: () => language });
    const value = { ...session, scheduledDate: "2026-10-12", weekNumber: 2, type: "Swim" };
    const date = language === "zh-CN" ? "星期一 · 2026-10-12 · 第 2 周" : "Monday · 2026-10-12 · Week 2";
    expect(render(value)).toContain(`<p class="sd-date">${date}</p>`);
    const plan: CurrentPlan = {
      planSchemaVersion: "7.0", ownerId: "local-user", title: "Restart", summary: "", effectiveStartDate: "2026-10-05",
      revision: 1, sourceAgent: null, model: null, skillVersion: null, inputSnapshotHash: null, sourceDraftId: null, updatedAt: "2026-10-05T00:00:00Z",
      mesocycle: { durationWeeks: 2, schedule: { kind: "fixed_week", days: [0] }, weeks: [],
        domainProgressions: [{ domain: "endurance", phases: ["Restart", "Progression"].map((name, index) => ({
          id: `phase-${index}`, name, phaseType: "foundation", startWeek: 1, endWeek: 2, focus: "", progression: [],
        })) }],
      },
    };
    for (const count of [1, 2]) {
      const html = render({ ...value, phaseRefs: Array.from({ length: count }, (_, index) => ({ domain: "endurance", phaseId: `phase-${index}` })) }, plan);
      expect(html).toContain(`<p class="sd-date">${date} · ${count === 1 ? "Restart" : "Restart / Progression"}</p>`);
      expect(html).not.toContain('class="sd-meta');
      expect(html).not.toContain(">Swim<");
    }
  });
  it.each(["en", "zh-CN"])("shows only key priority in prescription asides in %s", (language) => {
    vi.stubGlobal("localStorage", { getItem: () => language });
    for (const keySession of [true, false]) {
      const html = render({ ...session, keySession });
      const label = language === "zh-CN" ? (keySession ? "关键训练" : "普通训练") : (keySession ? "Key Session" : "Regular Session");
      const metadata = html.match(/<p class="sd-date">[\s\S]*?<\/p>/)?.[0];
      expect(metadata).not.toContain(label);
      expect(html.split(label)).toHaveLength(keySession ? 2 : 1);
      if (keySession) expect(html.indexOf(label)).toBeLessThan(html.indexOf('class="rx-domain"'));
      expect(html).not.toContain("rx-session-labels");
    }
  });
  it("puts the session domain beside the hour duration rather than in the drawer metadata", () => {
    const html = render(session);
    const aside = html.match(/<span class="rx-panel-aside">[\s\S]*?<span class="rx-panel-meta">1 hr<\/span><\/span>/)?.[0];
    const metadata = html.match(/<p class="sd-date">[\s\S]*?<\/p>/)?.[0];
    expect(aside).toContain('data-domain-icon="endurance"');
    expect(aside).toContain(">Endurance</span>");
    expect(metadata).not.toContain("Endurance");
  });

  it("leaves unknown session domains unlabelled even with endurance content", () => {
    const html = render({ ...session, domain: null, prescription: { blocks: [] } });
    expect(html).not.toContain("data-domain-icon");
    expect(html).toContain('class="rx-panel-meta">1 hr');
  });
});
