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
    client.setQueryData(["vault-status"], { databaseUuid: "database-id", databasePath: "C:\\profiles\\active.sqlite3", initialized: true, locked: false, remembered: true, canRemember: true, legacySources: [] });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Backup)));
    expect(html).toContain("Manage database");
    expect(html).toContain("All your data is stored in one portable database.");
    expect(html).toContain("Switch Database");
    expect(html).toContain("Edit Password Settings");
    expect(html).toContain("Always Require Password");
    expect(html).toContain('class="section-heading"');
    expect(html).toContain('class="section-actions"');
    expect(html).toContain("Create Profile");
    expect(html).not.toContain("on disk");
    expect(html).not.toContain("Restore a Backup");
    expect(html).not.toContain("Choose backup");
    expect(html).not.toMatch(/>Copy<\/button>/);
  });

  it("shows the macOS password policy without remembered-password actions", () => {
    const client = new QueryClient();
    client.setQueryData(["backup-doctor"], { databasePath: "/Users/test/athria.sqlite3" });
    client.setQueryData(["vault-status"], { databaseUuid: "database-id", databasePath: "/Users/test/athria.sqlite3", initialized: true, locked: false, remembered: false, canRemember: false, legacySources: [] });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Backup)));
    expect(html).toContain("Athria asks for it each time it starts.");
    expect(html).not.toContain("Always Require Password");
    expect(html).not.toContain("Keychain cleanup");
  });
});
