import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Help } from "./App";
import { LanguageProvider } from "./i18n";

function renderHelp(): string {
  return renderToStaticMarkup(createElement(Help));
}

describe("Help", () => {
  it("answers the three setup questions", () => {
    const html = renderHelp();
    expect(html).toContain("How do I create a new plan?");
    expect(html).toContain("How do I import my training data?");
    expect(html).toContain("How do I back up my data and sync it with my own cloud?");
  });

  it("renders the FAQ as collapsed accordions", () => {
    const html = renderHelp();
    expect((html.match(/class="faq-item"/g) ?? []).length).toBe(3);
    expect(html).toContain("Plans are created by your connected AI agent.");
    expect(html).toContain("Connect an agent in Settings under AI Agents");
  });

  it("no longer carries the MCP connection section", () => {
    const html = renderHelp();
    expect(html).not.toContain("Connect Athria to Your AI Agent");
    expect(html).not.toContain("mcp-card");
  });

  it("explains AI and training terms in the glossary", () => {
    const html = renderHelp();
    expect(html).toContain("Model Context Protocol");
    expect(html).toContain("e.g., Claude, ChatGPT");
    expect(html).toContain("Mesocycle");
    expect(html).toContain("Rates how hard a set felt");
    expect(html).toContain("Heart rate zone");
  });

  it("translates the template explanation in the glossary", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(Help)));
    expect(html).toContain("可重复使用的单领域模式");
    expect(html).toContain("模板仅定义结构");
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
    renderToStaticMarkup(createElement(LanguageProvider, null, createElement(Help)));
    vi.unstubAllGlobals();
  });
});
