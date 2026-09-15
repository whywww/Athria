import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { Help } from "./App";

// Help embeds McpSetup, which reads its status through React Query and needs a provider context.
function renderHelp(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Help)));
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
  });

  it("names MCP in the agent connection card title", () => {
    expect(renderHelp()).toContain("Connect Athria to Your AI Agent through MCP");
  });

  it("explains AI and training terms in the glossary", () => {
    const html = renderHelp();
    expect(html).toContain("Model Context Protocol");
    expect(html).toContain("Mesocycle");
    expect(html).toContain("RPE / RIR");
    expect(html).toContain("Heart rate zone");
  });
});
