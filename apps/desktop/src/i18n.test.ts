import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { builtinTemplateText, displayBuiltinTemplate, errorText, exerciseName, LANGUAGE_STORAGE_KEY, LanguageProvider, readLanguage, saveLanguage, systemLanguage, T, translate, weekdayName } from "./i18n";
import { PrimaryPageHeader } from "./components";
import { formatDuration, formatRaceDateShort } from "./view-models";
import { formatShortDate } from "./plan/view";

describe("desktop language", () => {
  it("uses simplified Chinese for eligible system locales and otherwise English", () => {
    expect(systemLanguage("zh-CN")).toBe("zh-CN");
    expect(systemLanguage("zh-SG")).toBe("zh-CN");
    expect(systemLanguage("zh-Hant-TW")).toBe("en");
    expect(systemLanguage("en-US")).toBe("en");
  });

  it("reads an explicit device preference and ignores invalid saved values", () => {
    expect(readLanguage({ getItem: (key) => key === LANGUAGE_STORAGE_KEY ? "zh-CN" : null })).toBe("zh-CN");
    expect(readLanguage({ getItem: () => "fr" })).toBe(systemLanguage());
    expect(readLanguage({ getItem: () => { throw new Error("storage disabled"); } })).toBe(systemLanguage());
  });

  it("saves the selected language as a device preference", () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
    saveLanguage("zh-CN", storage);
    expect(readLanguage(storage)).toBe("zh-CN");
    saveLanguage("en", storage);
    expect(readLanguage(storage)).toBe("en");
  });

  it("renders translated UI text while keeping the athlete name", () => {
    const storage = { getItem: () => "zh-CN", setItem: () => {} };
    vi.stubGlobal("localStorage", storage);
    const html = renderToStaticMarkup(createElement(LanguageProvider, null,
      createElement("div", null,
        createElement(T, null, "Save"),
        createElement(PrimaryPageHeader, { preferredName: "Hailey", subtitle: "训练说明" }),
      )));
    expect(html).toContain("保存");
    expect(html).toContain("你好，Hailey！");
    expect(html).toContain("训练说明");
    expect(formatRaceDateShort("2026-09-24")).toContain("9月24日");
    expect(formatShortDate("2026-09-24")).toContain("9月24日");
    expect(formatDuration(65)).toBe("1 小时 5 分钟");
    vi.unstubAllGlobals();
    renderToStaticMarkup(createElement(LanguageProvider, null, createElement(T, null, "Save")));
  });

  it("falls back to English and formats localized weekdays", () => {
    expect(translate("Save", "zh-CN")).toBe("保存");
    expect(translate("Untranslated label", "zh-CN")).toBe("Untranslated label");
    expect(weekdayName(0, "zh-CN", "short")).toContain("周");
    expect(errorText(new Error("NO_CURRENT_PLAN: There is no current plan."), "zh-CN")).toContain("没有当前计划");
    expect(errorText(new Error("Opaque service error"), "zh-CN")).toBe("Opaque service error");
  });

  it("localizes built-ins but keeps user templates and unknown exercises unchanged", () => {
    const builtin = { origin: "builtin", id: "builtin.easy-run", name: "Easy Run", intent: "Aerobic base", nodes: [{ name: "Easy start" }] };
    const user = { ...builtin, origin: "user" };
    expect(builtinTemplateText(builtin, "zh-CN").name).toBe("轻松跑");
    expect(displayBuiltinTemplate(builtin, "zh-CN").nodes[0]?.name).toBe("轻松开始");
    expect(displayBuiltinTemplate(user, "zh-CN")).toEqual(user);
    expect(exerciseName("romanian_deadlift", "Romanian Deadlift", "zh-CN")).toBe("罗马尼亚硬拉");
    expect(exerciseName(null, "我自己的动作", "zh-CN")).toBe("我自己的动作");
    expect(exerciseName("not_in_catalog", "原始动作", "zh-CN")).toBe("原始动作");
  });
});
