import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { ConnectionAutoSyncSwitch, saveConnectionAutoSync } from "./connection-auto-sync";
import type { IntervalsConnectionStatus, XunjiConnectionStatus } from "./view-models";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("connection daily auto sync", () => {
  it("renders accessible on and off switches and disables changes while locked", () => {
    const client = new QueryClient();
    for (const source of ["intervals", "xunji"] as const) {
      const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ConnectionAutoSyncSwitch, { source, enabled: false, locked: true })));
      expect(html).toContain('role="switch"');
      expect(html).toContain('aria-label="Daily automatic sync"');
      expect(html).toContain('aria-checked="false"');
      expect(html).toContain('disabled=""');
    }
    const on = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ConnectionAutoSyncSwitch, { source: "intervals", enabled: true, locked: false })));
    expect(on).toContain('aria-checked="true"');
    expect(on).not.toContain('disabled=""');
    client.clear();
  });

  it("saves immediately without credentials and updates only the selected app", async () => {
    const client = new QueryClient();
    const intervals: IntervalsConnectionStatus = { configured: true, locked: false, dailyAutoSync: true, athleteId: "123", sync: null };
    const xunji: XunjiConnectionStatus = { configured: true, locked: false, dailyAutoSync: true, sync: null };
    client.setQueryData(["intervals-status"], intervals);
    client.setQueryData(["xunji-status"], xunji);
    vi.mocked(invoke).mockResolvedValueOnce({ dailyAutoSync: false });
    await saveConnectionAutoSync(client, "intervals", false);
    expect(invoke).toHaveBeenLastCalledWith("set_connection_daily_auto_sync", { source: "intervals", enabled: false });
    expect(client.getQueryData(["intervals-status"])).toEqual({ ...intervals, dailyAutoSync: false });
    expect(client.getQueryData(["xunji-status"])).toEqual(xunji);
    client.clear();
  });

  it("keeps the saved state after a rejected change", async () => {
    const client = new QueryClient();
    const xunji: XunjiConnectionStatus = { configured: true, locked: false, dailyAutoSync: true, sync: null };
    client.setQueryData(["xunji-status"], xunji);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("save failed"));
    await expect(saveConnectionAutoSync(client, "xunji", false)).rejects.toThrow("save failed");
    expect(client.getQueryData(["xunji-status"])).toEqual(xunji);
    client.clear();
  });
});
