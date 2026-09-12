import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrimaryPageHeader } from "./components";

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
