import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it, vi } from "vitest";
import { applyDatabaseVersion } from "./database-version";

describe("database version refresh", () => {
  it("invalidates application data only when the database changes", () => {
    const client = new QueryClient();
    client.setQueryData(["profile"], { preferredName: "Old" });
    client.setQueryData(["database-version"], { databaseUuid: "one", dbVersion: 1 });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const first = applyDatabaseVersion(client, null, { databaseUuid: "one", dbVersion: 1 });
    applyDatabaseVersion(client, first, { databaseUuid: "one", dbVersion: 1 });
    expect(invalidate).not.toHaveBeenCalled();

    applyDatabaseVersion(client, first, { databaseUuid: "one", dbVersion: 2 });
    expect(client.getQueryState(["profile"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["database-version"])?.isInvalidated).toBe(false);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
