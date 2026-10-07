import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { builtinTemplateText, displayBuiltinTemplate, errorText, exerciseName, LANGUAGE_STORAGE_KEY, LanguageProvider, readLanguage, saveLanguage, systemLanguage, T, translate, weekdayName } from "./i18n";
import { PrimaryPageHeader } from "./components";
import { formatDuration, formatRaceDateShort, formatTimezoneLabel } from "./view-models";
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

  it("greets without an athlete name in simplified Chinese", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    const html = renderToStaticMarkup(createElement(LanguageProvider, null,
      createElement("div", null,
        createElement(PrimaryPageHeader, { preferredName: "", subtitle: "训练说明" }),
        createElement(PrimaryPageHeader, { preferredName: "  ", subtitle: "训练说明" }),
      )));
    expect(html.match(/你好！/g)).toHaveLength(2);
    expect(html).not.toContain("运动员");
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

  it("translates the Intervals.icu API key hint around its linked brand name", () => {
    expect(translate("Find your API key and Athlete ID in", "en")).toBe("Find your API key and Athlete ID in");
    expect(translate("→ Settings → Developer Settings.", "en")).toBe("→ Settings → Developer Settings.");
    expect(translate("Find your API key and Athlete ID in", "zh-CN")).toBe("在");
    expect(translate("→ Settings → Developer Settings.", "zh-CN")).toBe("的“设置 → 开发者设置”中找到 API 密钥和运动员 ID。");
  });

  it("translates the SynFit Skill connection instructions", () => {
    const instruction = "In SynFit, go to Me → Data Export and Import → Training → Copy Training Skill, then paste it above.";
    expect(translate(instruction, "en")).toBe(instruction);
    expect(translate(instruction, "zh-CN")).toBe("在训记中，前往“我的 → 数据导出和导入 → 训练 → 复制训练数据 Skill”，然后粘贴到上方。");
  });

  it("translates the remaining dashboard, profile, settings, and template labels", () => {
    expect(translate("Connected", "zh-CN")).toBe("已连接");
    expect(translate("Save template", "zh-CN")).toBe("保存模板");
    expect(translate("Edit template", "zh-CN")).toBe("编辑模板");
    expect(translate("Add node", "zh-CN")).toBe("添加环节");
    expect(translate("Complete these template details", "zh-CN")).toBe("填写模板详情");
    expect(translate("this mesocycle", "zh-CN")).toBe("本训练周期");
    expect(translate("from last week", "zh-CN")).toBe("较上周");
    expect(translate("Marathon", "zh-CN")).toBe("马拉松");
    expect(translate("Strength & Resistance", "zh-CN")).toBe("力量与阻力训练");
    expect(translate("Treadmill", "zh-CN")).toBe("跑步机");
    expect(translate("Shoulder External Rotation", "zh-CN")).toBe("肩外旋");
    expect(translate("Always Require Password", "zh-CN")).toBe("始终要求输入密码");
    expect(translate("Require Password", "zh-CN")).toBe("要求输入密码");
    expect(translate("Updating…", "zh-CN")).toBe("正在更新…");
    expect(translate("Weight", "zh-CN")).toBe("体重");
    expect(translate("I prefer a varied mix of training styles.", "zh-CN")).toBe("我喜欢多种训练方式的组合。");
    expect(translate("A reusable abstract structure for a type of training that defines what the training should include without fixing specific exercises, sets or loads.", "zh-CN")).toContain("一类训练的可复用抽象结构");
    expect(translate("Marathon", "en")).toBe("Marathon");
  });

  it("localizes the display name for a timezone while retaining its offset", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    function ZoneLabel() { return createElement("span", null, formatTimezoneLabel("Asia/Hong_Kong")); }
    const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(ZoneLabel)));
    expect(html).toContain("香港标准时间 (GMT+08:00)");
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
    renderToStaticMarkup(createElement(LanguageProvider, null, createElement(T, null, "Save")));
    vi.unstubAllGlobals();
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
