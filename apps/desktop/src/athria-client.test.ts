import { describe, expect, it, vi } from "vitest";
import { HttpAthriaClient, TauriAthriaClient } from "./athria-client";

describe("AthriaClient", () => {
  it("routes application requests through Tauri IPC", async () => {
    const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({ ownerId: "local-user" }));
    const fallbackRequest = vi.fn();
    const fallback = { async request<T>(): Promise<T> { return fallbackRequest() as T; } };
    const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => invoke(command, args) as Promise<T>;
    const client = new TauriAthriaClient(call, fallback);
    await expect(client.request("/api/profile", { method: "PUT", body: JSON.stringify({ ownerId: "local-user" }) })).resolves.toEqual({ ownerId: "local-user" });
    expect(invoke).toHaveBeenCalledWith("athria_request", { method: "PUT", path: "/api/profile", body: { ownerId: "local-user" } });
    expect(fallbackRequest).not.toHaveBeenCalled();
  });

  it("keeps backup preview on the platform compatibility adapter", async () => {
    const invoke = vi.fn((_command: string, _args?: Record<string, unknown>) => Promise.resolve(undefined));
    const fallbackRequest = vi.fn(async () => ({ compatible: true }));
    const fallback = { async request<T>(): Promise<T> { return fallbackRequest() as Promise<T>; } };
    const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => invoke(command, args) as Promise<T>;
    const client = new TauriAthriaClient(call, fallback);
    await expect(client.request("/api/system/backup/preview", { method: "POST", body: "{}" })).resolves.toEqual({ compatible: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("preserves HTTP error messages in the compatibility client", async () => {
    const response = new Response(JSON.stringify({ error: { message: "Revision changed." } }), { status: 409, headers: { "Content-Type": "application/json" } });
    const client = new HttpAthriaClient(async () => ({ baseUrl: "http://127.0.0.1:1", token: "token" }), vi.fn(async () => response));
    await expect(client.request("/api/profile")).rejects.toThrow("Revision changed.");
  });
});
