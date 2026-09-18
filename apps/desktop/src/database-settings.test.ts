import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { Backup } from "./App";

describe("database settings", () => {
  it("presents database switching and password settings without the old restore section", () => {
    const client = new QueryClient();
    client.setQueryData(["backup-doctor"], { databasePath: "C:\\profiles\\active.sqlite3" });
    client.setQueryData(["vault-status"], { databaseUuid: "database-id", databasePath: "C:\\profiles\\active.sqlite3", initialized: true, locked: false, remembered: true, legacySources: [] });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Backup)));
    expect(html).toContain("Manage database");
    expect(html).toContain("All your data is stored in one portable database.");
    expect(html).toContain("Switch database");
    expect(html).toContain("Edit Password Settings");
    expect(html).toContain("Require password on startup");
    expect(html).not.toContain("Restore a Backup");
    expect(html).not.toContain("Choose backup");
    expect(html).not.toMatch(/>Copy<\/button>/);
  });
});
