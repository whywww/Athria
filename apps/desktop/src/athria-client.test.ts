import { describe, expect, it, vi } from "vitest";
import { TauriAthriaClient } from "./athria-client";

describe("AthriaClient", () => {
  it("routes application requests through Tauri IPC", async () => {
    const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({ ownerId: "local-user" }));
    const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => invoke(command, args) as Promise<T>;
    const client = new TauriAthriaClient(call);
    await expect(client.request("/api/profile", { method: "PUT", body: JSON.stringify({ ownerId: "local-user" }) })).resolves.toEqual({ ownerId: "local-user" });
    expect(invoke).toHaveBeenCalledWith("athria_request", { method: "PUT", path: "/api/profile", body: { ownerId: "local-user" } });
  });
});
