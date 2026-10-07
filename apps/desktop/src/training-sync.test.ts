import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { syncTrainingAppsDaily, type VaultStatus } from "./api";
import { applyDailyTrainingSync, DailyTrainingSyncCoordinator, isTrainingSyncBusy, withTrainingSync } from "./training-sync";
import { notify, notifyError } from "./toasts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./toasts", () => ({ notify: vi.fn(), notifyError: vi.fn() }));

const vault: VaultStatus = { databaseUuid: "a", databasePath: "a.sqlite3", initialized: true, locked: false, remembered: true, canRemember: true, legacySources: [] };

describe("daily training sync", () => {
  it("waits for setup and unlock, runs once per database, and permits a new database", async () => {
    const coordinator = new DailyTrainingSyncCoordinator();
    const run = vi.fn(async () => {});
    await coordinator.start({ ...vault, initialized: false }, run);
    await coordinator.start({ ...vault, locked: true }, run);
    expect(run).not.toHaveBeenCalled();
    await coordinator.start(vault, run);
    await coordinator.start(vault, run);
    expect(run).toHaveBeenCalledTimes(1);
    await coordinator.start({ ...vault, databaseUuid: "b" }, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejected attempt on query refresh", async () => {
    const coordinator = new DailyTrainingSyncCoordinator();
    const run = vi.fn(async () => { throw new Error("offline"); });
    await expect(coordinator.start(vault, run)).rejects.toThrow("offline");
    await coordinator.start(vault, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rechecks persisted daily state on reopening from the tray, but never while already running", async () => {
    const coordinator = new DailyTrainingSyncCoordinator();
    let resolve!: () => void;
    const run = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const first = coordinator.start(vault, run);
    await coordinator.start(vault, run, true);
    expect(run).toHaveBeenCalledTimes(1);
    resolve();
    await first;
    const reopened = coordinator.start(vault, run, true);
    expect(run).toHaveBeenCalledTimes(2);
    resolve();
    await reopened;
  });

  it("calls the backend coordinator without a user-selected range", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ results: [] });
    await syncTrainingAppsDaily();
    expect(invoke).toHaveBeenCalledWith("sync_training_apps_daily");
  });

  it("refreshes training views and retains source-specific failure details", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    const error = "Offline";
    const result = { sync: { status: "partial" }, failedDates: [{ date: "2026-10-07", failures: [{ activityId: "1", reason: "invalid" }] }] };
    await applyDailyTrainingSync(client, { results: [{ source: "intervals", result }, { source: "xunji", error }] });
    expect(client.getQueryData(["sync-feedback", "intervals"])).toEqual({ source: "intervals", result });
    expect(client.getQueryData(["sync-feedback", "xunji"])).toEqual({ source: "xunji", error });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Intervals.icu"), "warning");
    expect(notifyError).toHaveBeenCalledWith(expect.stringContaining(error));
    expect(invalidate.mock.calls.map(([filter]) => filter?.queryKey?.[0])).toEqual(["intervals-status", "xunji-status", "sessions", "summary", "state", "wellness", "calendar", "next-training-day"]);
    client.clear();
  });

  it("leaves views alone when all sources were skipped", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await applyDailyTrainingSync(client, { results: [] });
    expect(invalidate).not.toHaveBeenCalled();
    client.clear();
  });

  it("shares busy state with manual controls, isolates databases, and clears it after errors", async () => {
    await expect(withTrainingSync("a", ["intervals"], async () => {
      expect(isTrainingSyncBusy("a", "intervals")).toBe(true);
      expect(isTrainingSyncBusy("a", "xunji")).toBe(false);
      expect(isTrainingSyncBusy("b", "intervals")).toBe(false);
      return "done";
    })).resolves.toBe("done");
    expect(isTrainingSyncBusy("a", "intervals")).toBe(false);
    await expect(withTrainingSync("a", ["xunji"], async () => {
      expect(isTrainingSyncBusy("a", "xunji")).toBe(true);
      throw new Error("offline");
    })).rejects.toThrow("offline");
    expect(isTrainingSyncBusy("a", "xunji")).toBe(false);
  });
});
