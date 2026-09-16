import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanEmptyState } from "./CurrentPlanPage";

describe("PlanEmptyState", () => {
  it("guides the user through the agent-managed plan flow without template shortcuts", () => {
    const html = renderToStaticMarkup(createElement(PlanEmptyState));
    expect(html).toContain("No current plan");
    expect(html).toContain("Plans are created by your connected AI Agent");
    expect(html).toContain("Connect your AI agent");
    expect(html).toContain("Ask it to build your plan");
    expect(html).toContain("Review it here");
    expect(html).toContain("plan-empty-steps");
    expect(html).not.toContain("Browse templates");
    expect(html).not.toContain("<button");
  });
});
