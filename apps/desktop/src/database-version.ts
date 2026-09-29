import type { QueryClient } from "@tanstack/query-core";

export interface DatabaseVersion {
  databaseUuid: string;
  dbVersion: number;
}

export function applyDatabaseVersion(client: QueryClient, previous: DatabaseVersion | null, current: DatabaseVersion): DatabaseVersion {
  if (previous && (previous.databaseUuid !== current.databaseUuid || previous.dbVersion !== current.dbVersion)) {
    void client.invalidateQueries({ predicate: (query) => !["database-version", "agent-integrations", "mcp-status"].includes(String(query.queryKey[0])) });
  }
  return current;
}
