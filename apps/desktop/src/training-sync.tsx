import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getVaultStatus, syncTrainingAppsDaily, type DailyTrainingSyncResponse, type VaultStatus } from "./api";
import { notify, notifyError } from "./toasts";
import { tr } from "./i18n";
import type { ConnectionSource } from "./view-models";

const active = new Map<string, number>();
const listeners = new Set<() => void>();
const key = (databaseUuid: string, source: ConnectionSource) => `${databaseUuid}:${source}`;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = () => listeners.forEach((listener) => listener());

export function useTrainingSyncBusy(databaseUuid: string, source: ConnectionSource): boolean {
  return useSyncExternalStore(subscribe, () => isTrainingSyncBusy(databaseUuid, source), () => false);
}

export function isTrainingSyncBusy(databaseUuid: string, source: ConnectionSource): boolean {
  return Boolean(active.get(key(databaseUuid, source)));
}

export async function withTrainingSync<T>(databaseUuid: string, sources: ConnectionSource[], work: () => Promise<T>): Promise<T> {
  const keys = sources.map((source) => key(databaseUuid, source));
  keys.forEach((key) => active.set(key, (active.get(key) ?? 0) + 1));
  publish();
  try { return await work(); }
  finally {
    keys.forEach((key) => {
      const count = (active.get(key) ?? 1) - 1;
      if (count) active.set(key, count); else active.delete(key);
    });
    publish();
  }
}

export async function refreshTrainingViews(client: QueryClient): Promise<void> {
  await Promise.all(["intervals-status", "xunji-status", "sessions", "summary", "state", "wellness", "calendar", "next-training-day"].map((name) => client.invalidateQueries({ queryKey: [name] })));
}

// Query refreshes do not restart sync. Explicit window activation rechecks the backend's daily records.
export class DailyTrainingSyncCoordinator {
  private readonly started = new Set<string>();
  private readonly running = new Set<string>();

  async start(vault: VaultStatus, run: () => Promise<void>, activated = false): Promise<void> {
    if (!vault.initialized || vault.locked || this.running.has(vault.databaseUuid) || (!activated && this.started.has(vault.databaseUuid))) return;
    this.started.add(vault.databaseUuid);
    this.running.add(vault.databaseUuid);
    try { await run(); }
    finally { this.running.delete(vault.databaseUuid); }
  }
}

export async function applyDailyTrainingSync(client: QueryClient, response: DailyTrainingSyncResponse): Promise<void> {
  for (const entry of response.results) {
    client.setQueryData(["sync-feedback", entry.source], entry);
    if (entry.error) {
      notifyError(`${entry.source === "intervals" ? "Intervals.icu" : tr("SynFit")}: ${entry.error}`);
    } else if (entry.result?.sync?.status !== "success") {
      notify(tr("Automatic sync for {app} did not finish. Check Connections for details.").replace("{app}", entry.source === "intervals" ? "Intervals.icu" : tr("SynFit")), "warning");
    }
  }
  if (response.results.length) await refreshTrainingViews(client);
}

export function DailyTrainingSync() {
  const client = useQueryClient();
  const vault = useQuery({ queryKey: ["vault-status"], queryFn: getVaultStatus });
  const coordinator = useRef(new DailyTrainingSyncCoordinator());
  useEffect(() => {
    if (!vault.data) return;
    const current = vault.data;
    const start = (activated = false) => void coordinator.current.start(current, async () => {
      try {
        const response = await withTrainingSync(current.databaseUuid, ["intervals", "xunji"], syncTrainingAppsDaily);
        if (client.getQueryData<VaultStatus>(["vault-status"])?.databaseUuid === current.databaseUuid) {
          await applyDailyTrainingSync(client, response);
        }
      } catch (error) {
        if (client.getQueryData<VaultStatus>(["vault-status"])?.databaseUuid === current.databaseUuid) notifyError(error);
      }
    }, activated);
    start();
    // Closing Athria hides it in the tray. Reopening still counts as opening the app.
    const activate = () => start(true);
    window.addEventListener("focus", activate);
    return () => window.removeEventListener("focus", activate);
  }, [client, vault.data]);
  return null;
}
