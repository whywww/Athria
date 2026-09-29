import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { App, DatabaseRecovery, previewRecoverySelection } from "./App";

function render(client: QueryClient, element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, element));
}

describe("database startup recovery", () => {
  it("shows the failed path and error with both recovery choices", () => {
    const html = render(new QueryClient(), createElement(DatabaseRecovery, {
      status: { ready: false, databasePath: "C:\\profiles\\missing.sqlite3", error: "The configured database file does not exist." },
    }));
    expect(html).toContain("C:\\profiles\\missing.sqlite3");
    expect(html).toContain("The configured database file does not exist.");
    expect(html).toContain("Choose existing database");
    expect(html).toContain("Create new database");
  });

  it("does not mount the data dependent shell while recovery is needed", () => {
    const client = new QueryClient();
    client.setQueryData(["startup-status"], { ready: false, databasePath: "C:\\missing.sqlite3", error: "unavailable" });
    const html = render(client, createElement(App));
    expect(html).toContain("Choose a database to continue");
    expect(html).not.toContain("Main navigation");
    expect(client.getQueryCache().find({ queryKey: ["profile"] })).toBeUndefined();
  });

  it("leaves recovery open when the file dialog is cancelled", async () => {
    let previewed = false;
    const selected = await previewRecoverySelection(async () => null, async () => { previewed = true; throw new Error("unexpected"); });
    expect(selected).toBeUndefined();
    expect(previewed).toBe(false);
  });

  it("surfaces a preview failure without selecting a database", async () => {
    await expect(previewRecoverySelection(async () => "C:\\invalid.sqlite3", async () => {
      throw new Error("Unsupported schema");
    })).rejects.toThrow("Unsupported schema");
  });
});
