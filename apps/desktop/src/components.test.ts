import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState, PrimaryPageHeader } from "./components";

describe("EmptyState", () => {
  it("renders a title with an optional description", () => {
    const withDescription = renderToStaticMarkup(createElement(EmptyState, { title: "No connections yet", description: "Choose one of the available connections below to get started." }));
    expect(withDescription).toContain('<div class="empty-state"><strong>No connections yet</strong><p>Choose one of the available connections below to get started.</p></div>');
    const titleOnly = renderToStaticMarkup(createElement(EmptyState, { title: "No templates yet." }));
    expect(titleOnly).toContain('<div class="empty-state"><strong>No templates yet.</strong></div>');
  });
});

describe("PrimaryPageHeader", () => {
  it("renders the preferred name and optional actions", () => {
    const markup = renderToStaticMarkup(createElement(PrimaryPageHeader, {
      preferredName: "Hailey",
      subtitle: "Page subtitle",
      actions: createElement("button", null, "Edit"),
    }));
    expect(markup).toContain("Hi, Hailey!");
    expect(markup).toContain("Page subtitle");
    expect(markup).toContain("Edit");
  });

  it("falls back to Athlete when no preferred name is available", () => {
    const markup = renderToStaticMarkup(createElement(PrimaryPageHeader, { subtitle: "Page subtitle" }));
    expect(markup).toContain("Hi, Athlete!");
  });
});
