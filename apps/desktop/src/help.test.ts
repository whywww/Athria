import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Help } from "./App";

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
    expect(html).toContain("RPE / RIR");
    expect(html).toContain("Heart rate zone");
  });
});
